import { readConfigFile, writeConfigFile, type KimiConfig, type OAuthRef } from '@moonshot-ai/agent-core';
import {
  applyManagedKimiCodeConfig,
  applyManagedKimiCodeLogoutConfig,
  KIMI_CODE_PROVIDER_NAME,
  KimiOAuthToolkit,
  resolveKimiCodeOAuthKey,
  resolveKimiCodeOAuthRef,
  type AuthManagedUsageResult,
  type AuthStatus,
  type BearerTokenProvider,
  type FetchSubmitFeedbackResult,
  type KimiHostIdentity,
  type KimiOAuthLoginOptions,
  type ManagedKimiConfigShape,
  type OAuthRefreshOutcome,
} from '@moonshot-ai/kimi-code-oauth';

export interface KimiAuthSubmitFeedbackInput {
  readonly content: string;
  readonly sessionId: string;
  readonly version: string;
  readonly os: string;
  readonly model: string | null;
}

export type KimiAuthLoginOptions = Omit<KimiOAuthLoginOptions, 'provisionConfig'>;

export interface KimiAuthLoginResult {
  readonly providerName: string;
  readonly ok: true;
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
  readonly configPath?: string | undefined;
}

export interface KimiAuthLogoutResult {
  readonly providerName: string;
  readonly ok: true;
}

export interface KimiAuthFacadeOptions {
  readonly homeDir: string;
  readonly configPath: string;
  readonly identity?: KimiHostIdentity | undefined;
  readonly onConfigUpdated?: ((config: KimiConfig) => void) | undefined;
  readonly onRefresh?: ((outcome: OAuthRefreshOutcome) => void) | undefined;
}

type SDKManagedConfig = KimiConfig & ManagedKimiConfigShape;

export class KimiAuthFacade {
  private readonly toolkit: KimiOAuthToolkit<SDKManagedConfig>;

  constructor(private readonly options: KimiAuthFacadeOptions) {
    this.toolkit = new KimiOAuthToolkit<SDKManagedConfig>({
      homeDir: options.homeDir,
      identity: options.identity,
      onRefresh: options.onRefresh,
      configAdapter: {
        configPath: options.configPath,
        read: () => readConfigFile(options.configPath) as SDKManagedConfig,
        write: async (config) => {
          await writeConfigFile(options.configPath, config);
        },
        apply: applyManagedKimiCodeConfig,
        remove: applyManagedKimiCodeLogoutConfig,
      },
    });
  }

  async status(providerName?: string | undefined): Promise<AuthStatus> {
    return this.toolkit.status(providerName, this.resolveRuntimeManagedAuth(providerName).oauthRef);
  }

  async login(
    providerName: string | undefined = KIMI_CODE_PROVIDER_NAME,
    options: KimiAuthLoginOptions = {},
  ): Promise<KimiAuthLoginResult> {
    const auth = this.resolveManagedAuth(providerName);
    const baseUrl = options.baseUrl ?? this.configBaseUrlForLogin(auth.baseUrl);
    const oauthHost = options.oauthHost ?? this.envOAuthHost();
    const result = await this.toolkit.login(providerName, {
      ...options,
      baseUrl,
      oauthHost,
      oauthRef: options.oauthRef ?? this.configOAuthRefForLogin(auth.oauthRef, options, baseUrl),
      provisionConfig: true,
    });
    if (result.provision === undefined) {
      throw new Error('Kimi auth login did not provision model config.');
    }
    const updated = readConfigFile(this.options.configPath);
    this.options.onConfigUpdated?.(updated);
    return {
      providerName: result.providerName,
      ok: true,
      defaultModel: result.provision.defaultModel,
      defaultThinking: result.provision.defaultThinking,
      configPath: result.provision.configPath,
    };
  }

  async logout(providerName?: string | undefined): Promise<KimiAuthLogoutResult> {
    const result = await this.toolkit.logout(
      providerName,
      this.resolveRuntimeManagedAuth(providerName).oauthRef,
    );
    const updated = readConfigFile(this.options.configPath);
    this.options.onConfigUpdated?.(updated);
    return {
      providerName: result.providerName,
      ok: result.ok,
    };
  }

  async getManagedUsage(providerName?: string | undefined): Promise<AuthManagedUsageResult> {
    const auth = this.resolveRuntimeManagedAuth(providerName);
    return this.toolkit.getManagedUsage(providerName, {
      oauthRef: auth.oauthRef,
      baseUrl: auth.baseUrl,
    });
  }

  async submitFeedback(
    input: KimiAuthSubmitFeedbackInput,
    providerName?: string | undefined,
  ): Promise<FetchSubmitFeedbackResult> {
    const auth = this.resolveRuntimeManagedAuth(providerName);
    return this.toolkit.submitFeedback(
      {
        session_id: input.sessionId,
        content: input.content,
        version: input.version,
        os: input.os,
        model: input.model,
      },
      providerName,
      {
        oauthRef: auth.oauthRef,
        baseUrl: auth.baseUrl,
      },
    );
  }

  async getCachedAccessToken(
    providerName?: string,
    oauthRef?: OAuthRef | undefined,
  ): Promise<string | undefined> {
    return this.toolkit.getCachedAccessToken(
      providerName,
      this.runtimeOAuthRef(providerName, oauthRef),
    );
  }

  readonly resolveOAuthTokenProvider = (
    providerName: string,
    oauthRef?: OAuthRef | undefined,
  ): BearerTokenProvider => {
    return this.toolkit.tokenProvider(providerName, this.runtimeOAuthRef(providerName, oauthRef));
  };

  private resolveManagedAuth(providerName?: string | undefined): {
    readonly oauthRef?: OAuthRef | undefined;
    readonly baseUrl?: string | undefined;
  } {
    const name = providerName ?? KIMI_CODE_PROVIDER_NAME;
    const config = readConfigFile(this.options.configPath);
    const provider = config.providers[name];
    return {
      oauthRef: provider?.oauth,
      baseUrl: provider?.baseUrl,
    };
  }

  private configBaseUrlForLogin(baseUrl?: string | undefined): string | undefined {
    return process.env['KIMI_CODE_BASE_URL'] ?? baseUrl;
  }

  private configOAuthRefForLogin(
    oauthRef: OAuthRef | undefined,
    options: KimiAuthLoginOptions,
    baseUrl?: string | undefined,
  ): OAuthRef | undefined {
    if (
      options.baseUrl !== undefined ||
      options.oauthHost !== undefined ||
      process.env['KIMI_CODE_BASE_URL'] !== undefined ||
      process.env['KIMI_CODE_OAUTH_HOST'] !== undefined ||
      process.env['KIMI_OAUTH_HOST'] !== undefined
    ) {
      return undefined;
    }
    if (oauthRef !== undefined && oauthRef.key !== this.expectedOAuthKey(oauthRef, baseUrl)) {
      return undefined;
    }
    return oauthRef;
  }

  private configBaseUrlForRuntime(baseUrl?: string | undefined): string | undefined {
    return process.env['KIMI_CODE_BASE_URL'] ?? baseUrl;
  }

  private configOAuthRefForRuntime(
    oauthRef: OAuthRef | undefined,
    baseUrl?: string | undefined,
  ): OAuthRef {
    const expected = this.expectedOAuthRef(oauthRef, baseUrl);
    if (oauthRef === undefined) return expected;
    if (process.env['KIMI_CODE_BASE_URL'] !== undefined || this.envOAuthHost() !== undefined) {
      return expected;
    }
    if (oauthRef.key !== expected.key) return expected;
    return oauthRef;
  }

  private resolveRuntimeManagedAuth(providerName?: string | undefined): {
    readonly oauthRef: OAuthRef;
    readonly baseUrl?: string | undefined;
  } {
    const auth = this.resolveManagedAuth(providerName);
    const baseUrl = this.configBaseUrlForRuntime(auth.baseUrl);
    return {
      oauthRef: this.configOAuthRefForRuntime(auth.oauthRef, baseUrl),
      baseUrl,
    };
  }

  private runtimeOAuthRef(
    providerName: string | undefined,
    oauthRef?: OAuthRef | undefined,
  ): OAuthRef | undefined {
    if ((providerName ?? KIMI_CODE_PROVIDER_NAME) !== KIMI_CODE_PROVIDER_NAME) return oauthRef;
    const auth = this.resolveManagedAuth(providerName);
    const baseUrl = this.configBaseUrlForRuntime(auth.baseUrl);
    return this.configOAuthRefForRuntime(oauthRef ?? auth.oauthRef, baseUrl);
  }

  private expectedOAuthKey(oauthRef: OAuthRef, baseUrl?: string | undefined): string {
    return resolveKimiCodeOAuthKey({
      oauthHost: oauthRef.oauthHost,
      baseUrl,
    });
  }

  private expectedOAuthRef(oauthRef: OAuthRef | undefined, baseUrl?: string | undefined): OAuthRef {
    const envOAuthHost = this.envOAuthHost();
    const hasEnvOverride =
      process.env['KIMI_CODE_BASE_URL'] !== undefined || envOAuthHost !== undefined;
    return resolveKimiCodeOAuthRef({
      oauthHost: hasEnvOverride ? envOAuthHost : oauthRef?.oauthHost,
      baseUrl,
    });
  }

  private envOAuthHost(): string | undefined {
    return process.env['KIMI_CODE_OAUTH_HOST'] ?? process.env['KIMI_OAUTH_HOST'];
  }
}
