import type { Agent } from '..';
import type { ContextMessage } from '../context/types';
import { estimateTokens } from '../../utils/tokens';

/**
 * Post-compact attachments re-injected after the summary, mirroring Claude
 * Code's behavior of re-surfacing important context (recently-read files,
 * active plan) that would otherwise be lost when the history is replaced.
 *
 * The exact content is session-specific (it cannot be byte-identical to Claude
 * Code's), but the structure — summary followed by attachment user messages —
 * matches so the agent retains the same kind of context after compaction.
 */

const MAX_FILE_ATTACHMENTS = 5;
const MAX_TOKENS_PER_FILE = 5_000;
const TOTAL_FILE_TOKEN_BUDGET = 50_000;
const TOTAL_SKILLS_TOKEN_BUDGET = 25_000;

const FILE_READ_TOOL_NAMES = new Set(['Read', 'ReadMedia', 'read', 'read_media']);

const ATTACHMENT_ORIGIN = { kind: 'injection' as const, variant: 'compaction_attachment' };

export async function buildCompactionAttachments(
  agent: Agent,
  compactedHistory: readonly ContextMessage[],
): Promise<ContextMessage[]> {
  const fileAttachments = await buildFileAttachments(agent, compactedHistory);
  return [
    ...buildPlanAttachment(agent),
    ...buildSubagentAttachment(agent),
    ...buildSkillAttachment(compactedHistory),
    ...fileAttachments,
  ];
}

function buildSkillAttachment(compactedHistory: readonly ContextMessage[]): ContextMessage[] {
  const seen = new Set<string>();
  const blocks: string[] = [];
  let totalTokens = 0;
  for (const message of compactedHistory) {
    const origin = message.origin;
    if (origin?.kind !== 'skill_activation') continue;
    if (seen.has(origin.skillName)) continue;
    seen.add(origin.skillName);
    const text = message.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('');
    if (text.trim().length === 0) continue;
    const block = `<skill name="${origin.skillName}">\n${text}\n</skill>`;
    totalTokens += estimateTokens(block);
    if (totalTokens > TOTAL_SKILLS_TOKEN_BUDGET) break;
    blocks.push(block);
  }
  if (blocks.length === 0) return [];
  return [
    makeAttachment(
      'The following skills were invoked earlier and are re-included after compaction:\n\n' +
        blocks.join('\n\n'),
    ),
  ];
}

function buildSubagentAttachment(agent: Agent): ContextMessage[] {
  const tasks = agent.background.list(true).filter((task) => task.kind === 'agent');
  if (tasks.length === 0) return [];
  const lines = tasks.map((task) => {
    const label = 'agentId' in task ? (task as { agentId: string }).agentId : task.taskId;
    return `- ${label} (${task.status}): ${task.description}`;
  });
  return [
    makeAttachment(
      'The following subagents are still active after compaction. Do not respawn them;\n' +
        'retrieve their results when ready:\n' +
        lines.join('\n'),
    ),
  ];
}

function buildPlanAttachment(agent: Agent): ContextMessage[] {
  const planMode = agent.planMode;
  if (!planMode.isActive) return [];
  const planFilePath = planMode.planFilePath;
  const header = planFilePath
    ? `Plan mode is active. The current plan file is: ${planFilePath}`
    : 'Plan mode is active.';
  return [makeAttachment(`${header}\n\nContinue to follow the plan. Do not implement without an approved plan.`)];
}

async function buildFileAttachments(
  agent: Agent,
  compactedHistory: readonly ContextMessage[],
): Promise<ContextMessage[]> {
  const paths = collectRecentReadPaths(compactedHistory, MAX_FILE_ATTACHMENTS);
  if (paths.length === 0) return [];

  const blocks: string[] = [];
  let totalTokens = 0;
  for (const path of paths) {
    if (totalTokens >= TOTAL_FILE_TOKEN_BUDGET) break;
    const content = await readFileCapped(agent, path, MAX_TOKENS_PER_FILE);
    if (content === null) continue;
    const block = `<file path="${path}">\n${content}\n</file>`;
    totalTokens += estimateTokens(block);
    blocks.push(block);
  }

  if (blocks.length === 0) return [];
  return [
    makeAttachment(
      'The following files were read recently and are re-included after compaction for continuity:\n\n' +
        blocks.join('\n\n'),
    ),
  ];
}

function collectRecentReadPaths(history: readonly ContextMessage[], limit: number): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  // Walk from the most recent message backward.
  for (let i = history.length - 1; i >= 0 && paths.length < limit; i--) {
    const message = history[i];
    if (message === undefined || message.role !== 'assistant') continue;
    for (const toolCall of message.toolCalls) {
      if (!FILE_READ_TOOL_NAMES.has(toolCall.name)) continue;
      const path = extractPath(toolCall.arguments);
      if (path === null || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
      if (paths.length >= limit) break;
    }
  }
  return paths;
}

function extractPath(args: string | null): string | null {
  if (args === null) return null;
  try {
    const parsed = JSON.parse(args) as { path?: unknown; file_path?: unknown };
    const value = parsed.path ?? parsed.file_path;
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function readFileCapped(agent: Agent, path: string, maxTokens: number): Promise<string | null> {
  try {
    const content = await agent.kaos.readText(path);
    if (estimateTokens(content) <= maxTokens) return content;
    // Truncate by characters (rough) to fit the token cap, keeping the head.
    const approxChars = maxTokens * 4;
    return `${content.slice(0, approxChars)}\n[... truncated for compaction; re-read the file if you need the rest]`;
  } catch {
    return null;
  }
}

function makeAttachment(text: string): ContextMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: ATTACHMENT_ORIGIN,
  };
}
