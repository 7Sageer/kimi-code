/**
 * Multi-instance session-ownership handling — follow the holder, never corrupt.
 *
 * When several kap-server instances share one home, a session's write lease is
 * held by exactly one instance. Any request that would materialize the session
 * on a sibling instance is refused with envelope code 40921
 * (`session.held_by_peer`) plus a structured `details` payload (zod twin in
 * `packages/protocol/src/session-ownership.ts`; the shapes here are the
 * dependency-free client-side twin and must stay byte-identical). The
 * `kind`/`phase` pair dictates the one correct reaction:
 *
 *   - held-by-peer / routable                follow `address`: rebase onto the
 *                                            holder origin and re-send the call
 *   - held-by-peer / creating                kernel lock held before owner
 *                                            metadata is visible: wait
 *                                            `retry_after_ms`, retry the SAME
 *                                            instance
 *   - held-by-peer / holder-unresponsive     legacy heartbeat-based response:
 *                                            terminal for auto-recovery
 *   - held-by-peer / held-by-local-instance  holder has no address (embedded
 *                                            engine / CLI): terminal, never
 *                                            retried
 *   - unregistered-writer                    session looks actively written by
 *                                            an external / older process:
 *                                            terminal safety stop
 *
 * `KlientConnection` owns the redirect routes plus the follow/retry policy and
 * is shared by the `SessionRedirectChannel` decorator. Session routes are
 * isolated by `sessionId`, while the legacy `currentUrl` getter continues to
 * expose the most recently selected origin. Both policies are bounded per
 * original call (`maxRedirects`, `maxCreatingRetries`) so redirect ping-pong
 * cannot spin.
 */

import type {
  EventSourceRef,
  IDisposable,
  KlientChannel,
  ScopeRef,
} from './core/channel.js';
import { RPCError } from './core/errors.js';
import { HttpChannel } from './transports/http/channel.js';
import type { WsLikeCtor } from './transports/ws/wsSocket.js';

/**
 * Envelope code of `session.held_by_peer` — the single branch key across the
 * wire (mirrors `ErrorCode.SESSION_HELD_BY_PEER` in `@moonshot-ai/protocol`,
 * kept literal here so klient stays dependency-free).
 */
export const SESSION_HELD_BY_PEER = 40921;

export type SessionOwnershipPhase =
  | 'creating'
  | 'routable'
  | 'holder-unresponsive'
  | 'held-by-local-instance';

export interface HeldByPeerDetails {
  readonly kind: 'held-by-peer';
  readonly phase: SessionOwnershipPhase;
  /** Present only when phase === 'routable'. */
  readonly address?: string;
  /** Retry hint (ms) for `creating` or legacy `holder-unresponsive`. */
  readonly retry_after_ms?: number;
}

export interface UnregisteredWriterDetails {
  readonly kind: 'unregistered-writer';
}

export type SessionOwnershipDetails = HeldByPeerDetails | UnregisteredWriterDetails;

const PHASES: ReadonlySet<string> = new Set<SessionOwnershipPhase>([
  'creating',
  'routable',
  'holder-unresponsive',
  'held-by-local-instance',
]);

/**
 * Structural read of the 40921 `details` payload. Returns `undefined` for any
 * other error or an unrecognized payload shape — unknown shapes are rethrown
 * untouched so newer servers never break older clients (forward-compat rule).
 */
export function readSessionOwnershipDetails(
  error: unknown,
): SessionOwnershipDetails | undefined {
  if (!(error instanceof RPCError) || error.code !== SESSION_HELD_BY_PEER) return undefined;
  const details = error.details;
  if (typeof details !== 'object' || details === null) return undefined;
  const kind = (details as { kind?: unknown }).kind;
  if (kind === 'unregistered-writer') return { kind: 'unregistered-writer' };
  if (kind !== 'held-by-peer') return undefined;
  const phase = (details as { phase?: unknown }).phase;
  if (typeof phase !== 'string' || !PHASES.has(phase)) return undefined;
  const address = (details as { address?: unknown }).address;
  const retry = (details as { retry_after_ms?: unknown }).retry_after_ms;
  return {
    kind: 'held-by-peer',
    phase: phase as SessionOwnershipPhase,
    address: typeof address === 'string' && address.length > 0 ? address : undefined,
    retry_after_ms:
      typeof retry === 'number' && Number.isFinite(retry) && retry >= 0 ? retry : undefined,
  };
}

/**
 * Normalize a holder `address` to its bare origin (`http://host:port`). The
 * server already maps wildcard binds onto `127.0.0.1`; a trailing slash or
 * path suffix would otherwise poison URL composition.
 */
export function normalizeInstanceOrigin(address: string): string {
  try {
    const url = new URL(address);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
  } catch {
    // not an absolute http(s) URL — fall through to the textual form
  }
  return address.replace(/\/+$/, '');
}

/** One followed redirect, emitted via `KlientConnection.onRedirect`. */
export interface SessionRedirectInfo {
  /** Origin the request was sent to, e.g. `http://127.0.0.1:58627`. */
  readonly from: string;
  /**
   * Holder origin the client switched to; later requests for this route land there.
   * This is the address to surface as "connected to the instance holding
   * the session (<to>)".
   */
  readonly to: string;
  /** 1-based follow count within the triggering call. */
  readonly follow: number;
}

export interface SessionRedirectOptions {
  /**
   * Follow `routable` redirects automatically. Default `true`; set `false` to
   * surface the raw 40921 to the caller instead.
   */
  readonly follow?: boolean;
  /** Redirect follows allowed per call (anti-loop bound). Default `1`. */
  readonly maxRedirects?: number;
  /** `creating` retries allowed per call. Default `3`. */
  readonly maxCreatingRetries?: number;
  /** Fallback pause (ms) between `creating` retries when the server omits `retry_after_ms`. Default `500`. */
  readonly creatingRetryDelayMs?: number;
  /** Injectable clock for tests; defaults to a real `setTimeout` sleep. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Shared per-client redirect state: the target origin for each session, the
 * legacy most-recent target, the resolved policy, and redirect listeners.
 * Session calls read their own route on every attempt, so one holder cannot
 * overwrite another session's route.
 */
export class KlientConnection {
  private readonly initialUrl: string;
  private url: string;
  private readonly sessionUrls = new Map<string, string>();
  readonly follow: boolean;
  readonly maxRedirects: number;
  readonly maxCreatingRetries: number;
  readonly creatingRetryDelayMs: number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly redirectListeners = new Set<(info: SessionRedirectInfo) => void>();

  constructor(opts: { url: string } & SessionRedirectOptions) {
    this.initialUrl = opts.url.replace(/\/$/, '');
    this.url = this.initialUrl;
    this.follow = opts.follow ?? true;
    this.maxRedirects = opts.maxRedirects ?? 1;
    this.maxCreatingRetries = opts.maxCreatingRetries ?? 3;
    this.creatingRetryDelayMs = opts.creatingRetryDelayMs ?? 500;
    this.sleepImpl = opts.sleep ?? defaultSleep;
  }

  get currentUrl(): string {
    return this.url;
  }

  currentUrlFor(sessionId: string | undefined): string {
    return sessionId === undefined
      ? this.url
      : (this.sessionUrls.get(sessionId) ?? this.initialUrl);
  }

  onRedirect(listener: (info: SessionRedirectInfo) => void): IDisposable {
    this.redirectListeners.add(listener);
    return { dispose: () => this.redirectListeners.delete(listener) };
  }

  /**
   * Switch the target origin after a `routable` answer. Returns the previous
   * origin, or `undefined` when the holder address already equals the current
   * origin (a self-redirect is a loop, handled as an error by the caller).
   */
  applyRedirect(address: string, sessionId?: string): string | undefined {
    const next = normalizeInstanceOrigin(address);
    const previous = this.currentUrlFor(sessionId);
    if (next === previous) return undefined;
    if (sessionId === undefined) {
      this.url = next;
    } else {
      this.sessionUrls.set(sessionId, next);
      this.url = next;
    }
    return previous;
  }

  notifyRedirect(info: SessionRedirectInfo): void {
    for (const listener of this.redirectListeners) listener(info);
  }

  sleep(ms: number): Promise<void> {
    return this.sleepImpl(ms);
  }
}

export interface SessionRedirectChannelOptions {
  /** Shared redirect state (origin + policy). */
  readonly connection: KlientConnection;
  /** Optional bearer token (re-used against the holder origin). */
  readonly token?: string;
  /** `fetch` implementation; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** WebSocket implementation for the lazy event bridge of each inner channel. */
  readonly WebSocketImpl?: WsLikeCtor;
}

/**
 * `KlientChannel` decorator with the session-ownership follow/retry loop.
 * The inner `HttpChannel` is rebuilt whenever a redirect moves the connection
 * origin, so calls always target the current holder — facade handles obtained
 * before a redirect keep working against the holder afterwards.
 *
 * Event subscriptions made after a redirect land on the holder. Subscriptions
 * established before a redirect die with the stale channel's event bridge;
 * consumers should re-subscribe when `KlientConnection.onRedirect` fires.
 */
export class SessionRedirectChannel implements KlientChannel {
  private readonly connection: KlientConnection;
  private readonly token?: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly WebSocketImpl?: WsLikeCtor;
  private readonly inners = new Map<string, HttpChannel>();

  constructor(opts: SessionRedirectChannelOptions) {
    this.connection = opts.connection;
    this.token = opts.token;
    this.fetchImpl = opts.fetch;
    this.WebSocketImpl = opts.WebSocketImpl;
  }

  private routeKey(sessionId: string | undefined): string {
    return sessionId ?? '';
  }

  private innerFor(sessionId: string | undefined): HttpChannel {
    const key = this.routeKey(sessionId);
    const existing = this.inners.get(key);
    if (existing !== undefined) return existing;
    const inner = new HttpChannel({
      url: this.connection.currentUrlFor(sessionId),
      token: this.token,
      fetch: this.fetchImpl,
      WebSocketImpl: this.WebSocketImpl,
    });
    this.inners.set(key, inner);
    return inner;
  }

  private resetInner(sessionId: string | undefined): void {
    const key = this.routeKey(sessionId);
    const stale = this.inners.get(key);
    this.inners.delete(key);
    void stale?.close().catch(() => {});
  }

  async call(scope: ScopeRef, service: string, method: string, args: unknown[]): Promise<unknown> {
    const { connection } = this;
    let follows = 0;
    let creatingRetries = 0;
    const trace: string[] = [];
    for (;;) {
      const attemptUrl = connection.currentUrlFor(scope.sessionId);
      const inner = this.innerFor(scope.sessionId);
      try {
        return await inner.call(scope, service, method, args);
      } catch (error) {
        const details = readSessionOwnershipDetails(error);
        if (details === undefined) throw error;
        if (details.kind === 'unregistered-writer') {
          throw enrichOwnershipError(
            error,
            'the session looks actively used by an external or older process (unregistered writer); ' +
              'opening it here is refused to protect its data — close that process, or wait until it goes idle, then retry',
          );
        }
        switch (details.phase) {
          case 'routable': {
            if (details.address === undefined) {
              throw enrichOwnershipError(
                error,
                'the session is held by a peer instance, but the refusal carried no holder address; ' +
                  'retry shortly, or open it from the instance that created it',
              );
            }
            const target = normalizeInstanceOrigin(details.address);
            if (!connection.follow) {
              throw enrichOwnershipError(
                error,
                `the session is held by peer instance ${target}; connect to it directly ` +
                  '(automatic redirect is off: sessionRedirect.follow === false)',
              );
            }
            if (follows >= connection.maxRedirects) {
              throw enrichOwnershipError(
                error,
                `followed ${follows} instance redirect(s) (${trace.join(' → ')}) and the session is ` +
                  'still held elsewhere — giving up to avoid a redirect loop',
              );
            }
            if (target === attemptUrl) {
              throw enrichOwnershipError(
                error,
                `the holder address ${target} is this very instance, yet the request was refused; ` +
                  'lease and server disagree — retry shortly or restart the holding instance',
              );
            }
            const previous = connection.applyRedirect(target, scope.sessionId);
            follows += 1;
            trace.push(`${previous ?? attemptUrl} → ${target}`);
            // Rebuild the inner channel onto the holder BEFORE notifying, so
            // listeners that re-subscribe already land on the new origin.
            if (previous !== undefined) {
              this.resetInner(scope.sessionId);
              // Global calls have no session route, so preserve the legacy
              // behavior that a session redirect also invalidates global
              // event subscriptions tied to the previous currentUrl.
              if (scope.sessionId !== undefined) this.resetInner(undefined);
              connection.notifyRedirect({ from: previous, to: target, follow: follows });
            }
            continue;
          }
          case 'creating': {
            if (creatingRetries >= connection.maxCreatingRetries) {
              throw enrichOwnershipError(
                error,
                `the session lease is still mid-creation on a peer instance after ` +
                  `${creatingRetries} retries — retry shortly`,
              );
            }
            creatingRetries += 1;
            await connection.sleep(details.retry_after_ms ?? connection.creatingRetryDelayMs);
            continue;
          }
          case 'holder-unresponsive': {
            const retryHint =
              details.retry_after_ms !== undefined
                ? ` (suggested retry after ${details.retry_after_ms}ms)`
                : '';
            throw enrichOwnershipError(
              error,
              `the session is held by a peer instance that reported an unresponsive holder${retryHint}. ` +
                'This response comes from an older heartbeat-based server; retry later or stop the ' +
                'holding process before opening the session here',
            );
          }
          case 'held-by-local-instance': {
            throw enrichOwnershipError(
              error,
              'the session is held by a local instance without a network address (an embedded engine ' +
                'or CLI process); it cannot be reached from here — close the holding process before ' +
                'opening the session elsewhere',
            );
          }
        }
      }
    }
  }

  listen(
    scope: ScopeRef,
    source: EventSourceRef,
    handler: (data: unknown) => void,
    onError?: (error: Error) => void,
  ): IDisposable {
    return this.innerFor(scope.sessionId).listen(scope, source, handler, onError);
  }

  close(): Promise<void> {
    const inners = [...this.inners.values()];
    this.inners.clear();
    return Promise.all(inners.map((inner) => inner.close())).then(() => undefined);
  }
}

/** Re-throw a 40921 as `RPCError` with code + details intact and actionable handoff copy appended. */
function enrichOwnershipError(error: unknown, guidance: string): RPCError {
  if (error instanceof RPCError) {
    return new RPCError(error.code, `${error.message} — ${guidance}`, error.details);
  }
  return new RPCError(SESSION_HELD_BY_PEER, String(error), undefined);
}
