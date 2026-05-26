// apps/vis/server/src/lib/agent-record-types.ts
// Single source of truth: everything below comes from agent-core directly.
// Do NOT add local interfaces that duplicate upstream shapes.

export type {
  AgentRecord,
  AgentRecordEvents,
  AgentRecordOf,
  AgentConfigUpdateData,
  CompactionBeginData,
  CompactionResult,
  PermissionApprovalResultRecord,
  PermissionMode,
  UsageRecordScope,
  ToolStoreUpdate,
  LoopRecordedEvent,
  ContextMessage,
  PromptOrigin,
} from '@moonshot-ai/agent-core';
export { AGENT_WIRE_PROTOCOL_VERSION } from '@moonshot-ai/agent-core';
export type { Message, ContentPart, ToolCall, TokenUsage } from '@moonshot-ai/kosong';

// ── vis-only DTOs ──────────────────────────────────────────────────────────

export interface ApiError {
  error: string;
  code:
    | 'NOT_FOUND'
    | 'BAD_REQUEST'
    | 'UNAUTHORIZED'
    | 'READ_ERROR'
    | 'PARSE_ERROR'
    | 'DELETE_ERROR'
    | 'UNSUPPORTED_PROTOCOL';
}

export type SessionHealth =
  | 'ok'
  | 'broken_state'
  | 'broken_main_wire'
  | 'missing_main_wire'
  | 'unsupported_protocol';

export interface SessionSummary {
  sessionId: string;
  sessionDir: string;
  workDir: string;
  title: string | null;
  lastPrompt: string | null;
  isCustomTitle: boolean;
  createdAt: number;
  updatedAt: number;
  agentCount: number;
  mainAgentExists: boolean;
  mainWireRecordCount: number;
  wireProtocolVersion: string | null;
  health: SessionHealth;
}

export interface AgentInfo {
  agentId: string;
  type: 'main' | 'sub' | 'independent';
  parentAgentId: string | null;
  homedir: string;
  wireExists: boolean;
  wireRecordCount: number;
  wireProtocolVersion: string | null;
}

export interface SessionDetail {
  sessionId: string;
  /** Canonical on-disk session directory. Routes derive agent wire paths
   *  from this rather than the mutable `homedir` field inside `state.json`,
   *  which can drift after fork/rename. */
  sessionDir: string;
  workDir: string;
  state: unknown; // 原样透传，前端按 state.json 真实形状渲染
  agents: AgentInfo[];
}

export type WireLine = { _lineNo: number } & {
  // structural unification with AgentRecord; preserves discriminant
  [K in keyof import('@moonshot-ai/agent-core').AgentRecordEvents]: import('@moonshot-ai/agent-core').AgentRecordOf<K> & {
    _lineNo: number;
  };
}[keyof import('@moonshot-ai/agent-core').AgentRecordEvents];

export interface WireResponse {
  sessionId: string;
  agentId: string;
  protocolVersion: string;
  metadata: { protocolVersion: string; createdAt: number };
  records: readonly WireLine[];
  warnings: string[];
}

export interface AgentNode extends AgentInfo {
  children: AgentNode[];
}

export interface AgentTreeResponse {
  sessionId: string;
  tree: AgentNode[];
}
