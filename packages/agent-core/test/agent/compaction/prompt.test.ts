import { describe, expect, it } from 'vitest';

import {
  formatCompactSummary,
  getCompactPrompt,
  getCompactUserSummaryMessage,
} from '../../../src/agent/compaction/prompt';

// These tests pin kimi-code's compaction prompt / summary formatting to the
// exact strings Claude Code produces (`src/services/compact/prompt.ts`). The
// post-compaction context is byte-for-byte Claude Code's, which is what keeps
// the resumed conversation strictly consistent.

const CONTINUATION =
  'Continue the conversation from where it left off without asking the user any further questions. ' +
  'Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with ' +
  '"I\'ll continue" or similar. Pick up the last task as if the break never happened.';

const BASE_WRAPPER =
  'This session is being continued from a previous conversation that ran out of context. ' +
  'The summary below covers the earlier portion of the conversation.\n\n';

describe('formatCompactSummary', () => {
  it('strips the analysis scratchpad and rewrites the summary envelope', () => {
    expect(formatCompactSummary('<analysis>draft</analysis><summary>real content</summary>')).toBe(
      'Summary:\nreal content',
    );
  });

  it('trims summary content and collapses blank lines', () => {
    expect(formatCompactSummary('<summary>  spaced  </summary>')).toBe('Summary:\nspaced');
    expect(formatCompactSummary('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('trims a bare summary with no tags', () => {
    expect(formatCompactSummary('  plain summary  ')).toBe('plain summary');
  });
});

describe('getCompactUserSummaryMessage', () => {
  it('matches Claude Code manual compaction (no continuation)', () => {
    expect(getCompactUserSummaryMessage('Compacted summary.')).toBe(
      `${BASE_WRAPPER}Compacted summary.`,
    );
  });

  it('matches Claude Code auto compaction (appends continuation with a single newline)', () => {
    expect(getCompactUserSummaryMessage('Compacted summary.', true)).toBe(
      `${BASE_WRAPPER}Compacted summary.\n${CONTINUATION}`,
    );
  });

  it('notes preserved recent messages before the continuation', () => {
    expect(getCompactUserSummaryMessage('Compacted summary.', false, undefined, true)).toBe(
      `${BASE_WRAPPER}Compacted summary.\n\nRecent messages are preserved verbatim.`,
    );
    expect(getCompactUserSummaryMessage('Compacted summary.', true, undefined, true)).toBe(
      `${BASE_WRAPPER}Compacted summary.\n\nRecent messages are preserved verbatim.\n${CONTINUATION}`,
    );
  });

  it('formats the summary before wrapping', () => {
    expect(
      getCompactUserSummaryMessage('<analysis>x</analysis><summary>real</summary>'),
    ).toBe(`${BASE_WRAPPER}Summary:\nreal`);
  });
});

describe('getCompactPrompt', () => {
  const SECTIONS = [
    '1. Primary Request and Intent:',
    '2. Key Technical Concepts:',
    '3. Files and Code Sections:',
    '4. Errors and fixes:',
    '5. Problem Solving:',
    '6. All user messages:',
    '7. Pending Tasks:',
    '8. Current Work:',
    '9. Optional Next Step:',
  ];

  const TRAILER =
    'REMINDER: Do NOT call any tools. Respond with plain text only — ' +
    'an <analysis> block followed by a <summary> block. ' +
    'Tool calls will be rejected and you will fail the task.';

  it('opens with the no-tools preamble and includes all nine sections in order', () => {
    const prompt = getCompactPrompt();
    expect(prompt.startsWith('CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.')).toBe(true);

    let lastIndex = -1;
    for (const section of SECTIONS) {
      const index = prompt.indexOf(section);
      expect(index, section).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it('includes the analysis/summary example envelope and closes with the no-tools trailer', () => {
    const prompt = getCompactPrompt();
    expect(prompt).toContain('<analysis>');
    expect(prompt).toContain('<summary>');
    expect(prompt.endsWith(TRAILER)).toBe(true);
  });

  it('inserts additional instructions before the trailer when provided', () => {
    const prompt = getCompactPrompt('focus on test output');
    expect(prompt).toContain('\n\nAdditional Instructions:\nfocus on test output');
    expect(prompt.endsWith(TRAILER)).toBe(true);
    expect(prompt.indexOf('Additional Instructions:')).toBeLessThan(prompt.indexOf(TRAILER));
  });

  it('omits the additional-instructions block when blank', () => {
    expect(getCompactPrompt('   ')).toBe(getCompactPrompt());
  });
});
