import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'pathe';
import { describe, expect, it } from 'vitest';

import type { Agent } from '../../../src/agent';
import type { ContextMessage } from '../../../src/agent/context/types';
import { buildCompactionAttachments } from '../../../src/agent/compaction/attachments';

function assistantReadCall(path: string): ContextMessage {
  return {
    role: 'assistant',
    content: [],
    toolCalls: [
      {
        type: 'function',
        id: `call_${path}`,
        name: 'Read',
        arguments: JSON.stringify({ path }),
      },
    ],
  };
}

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    planMode: { isActive: false, planFilePath: null } as Agent['planMode'],
    background: { list: () => [] } as unknown as Agent['background'],
    ...overrides,
  } as Agent;
}

describe('buildCompactionAttachments', () => {
  it('returns no attachments when there is nothing to re-inject', async () => {
    const agent = makeAgent({
      planMode: { isActive: false, planFilePath: null } as Agent['planMode'],
    });
    const history: ContextMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ];
    expect(await buildCompactionAttachments(agent, history)).toEqual([]);
  });

  it('re-injects the active plan as a user attachment', async () => {
    const agent = makeAgent({
      planMode: {
        isActive: true,
        planFilePath: '/repo/.kimi/plans/123.md',
      } as Agent['planMode'],
    });
    const history: ContextMessage[] = [];
    const attachments = await buildCompactionAttachments(agent, history);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.role).toBe('user');
    expect((attachments[0]?.content[0] as { text: string }).text).toContain(
      '/repo/.kimi/plans/123.md',
    );
  });

  it('re-injects recently-read files with current content, most recent first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-compact-attach-'));
    try {
      const fileA = join(dir, 'a.ts');
      const fileB = join(dir, 'b.ts');
      writeFileSync(fileA, 'export const a = 1;');
      writeFileSync(fileB, 'export const b = 2;');

      const agent = makeAgent({
        planMode: { isActive: false, planFilePath: null } as Agent['planMode'],
        kaos: {
          readText: async (p: string) =>
            p === fileA ? 'export const a = 1;' : 'export const b = 2;',
        } as unknown as Agent['kaos'],
      });

      // Most recent read is fileB (later in history).
      const history: ContextMessage[] = [assistantReadCall(fileA), assistantReadCall(fileB)];
      const attachments = await buildCompactionAttachments(agent, history);
      expect(attachments).toHaveLength(1);
      const text = (attachments[0]?.content[0] as { text: string }).text;
      expect(text).toContain(fileB);
      expect(text).toContain('export const b = 2;');
      expect(text).toContain(fileA);
      expect(text).toContain('export const a = 1;');
      // fileB (most recent) appears before fileA.
      expect(text.indexOf(fileB)).toBeLessThan(text.indexOf(fileA));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips files that can no longer be read', async () => {
    const agent = makeAgent({
      planMode: { isActive: false, planFilePath: null } as Agent['planMode'],
      kaos: {
        readText: async () => {
          throw new Error('gone');
        },
      } as unknown as Agent['kaos'],
    });
    const history: ContextMessage[] = [assistantReadCall('/missing.ts')];
    expect(await buildCompactionAttachments(agent, history)).toEqual([]);
  });

  it('re-injects running subagent status', async () => {
    const agent = makeAgent({
      background: {
        list: () => [
          { kind: 'agent', agentId: 'agent-1', taskId: 't1', status: 'running', description: 'Explore codebase' },
          { kind: 'process', taskId: 't2', status: 'running', description: 'bash sleep 10' },
        ],
      } as unknown as Agent['background'],
    });
    const attachments = await buildCompactionAttachments(agent, []);
    expect(attachments).toHaveLength(1);
    const text = (attachments[0]?.content[0] as { text: string }).text;
    expect(text).toContain('agent-1');
    expect(text).toContain('Explore codebase');
    // Non-agent tasks are filtered out.
    expect(text).not.toContain('bash sleep 10');
  });

  it('re-injects invoked skill content, deduped by name', async () => {
    const agent = makeAgent({});
    const history: ContextMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Skill A body' }],
        toolCalls: [],
        origin: {
          kind: 'skill_activation',
          activationId: 'a1',
          skillName: 'skill-a',
          trigger: 'user-slash',
        },
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Skill A body again' }],
        toolCalls: [],
        origin: {
          kind: 'skill_activation',
          activationId: 'a2',
          skillName: 'skill-a',
          trigger: 'user-slash',
        },
      },
    ];
    const attachments = await buildCompactionAttachments(agent, history);
    expect(attachments).toHaveLength(1);
    const text = (attachments[0]?.content[0] as { text: string }).text;
    expect(text).toContain('skill-a');
    expect(text).toContain('Skill A body');
    // Deduped — second activation body is not included.
    expect(text).not.toContain('Skill A body again');
  });
});
