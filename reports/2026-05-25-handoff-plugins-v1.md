# Handoff — `/plugins` v1 implementation

You're picking up work on the Kimi Code `/plugins` v1 feature. Everything you need is in this file. Read it once, then proceed.

---

## TL;DR

- Branch: `feat/plugins-v1` (already created, two commits landed)
- Spec: `reports/2026-05-25-kimi-plugins-design.md`
- Plan: `reports/2026-05-25-kimi-plugins-plan.md` (the 14-task implementation plan; complete code in each task)
- Next task: **Task 2 — Manifest parser** (use opus; full prompt below)
- Execution method: subagent-driven (one subagent per task, two-stage review after each)
- Model policy: see "Model assignment" below — mechanical tasks → sonnet, judgment tasks → opus

---

## Where we are

`git log feat/plugins-v1 ^main --oneline`:

```
079491d style(agent-core): drop redundant path comments from plugin types
dcd2233 feat(agent-core): add plugin types skeleton
```

T1 (plugin types skeleton) is **complete** — types declared in `packages/agent-core/src/plugin/types.ts`, barrel in `index.ts`, typecheck passing.

Pending tasks 2–14 (see `TaskList` in this session, or read the plan).

---

## Why this handoff exists

`claude-opus-4-7` is currently returning 529 Overloaded on every dispatch. T2 onwards mostly needs opus per the model policy. We stop here to let another session (or this one later) pick up when opus is available.

---

## Model assignment (decided with user)

User wanted opus 4.7 for all subagents. We compromised:

- **sonnet** for mechanical / template tasks: **T1, T8, T10, T11**
- **opus** for judgment-heavy tasks: **T2, T3, T4, T5, T6, T7, T9, T12, T13, T14**

When dispatching via the `Agent` tool, pass `model: "opus"` or `model: "sonnet"`. The opus alias resolves to opus-4.7.

If opus is still overloaded when you resume:
- Try `ScheduleWakeup(delaySeconds=1500..1800, reason="retry opus")`
- Or ask the user whether to drop the task to sonnet

---

## Spec / plan corrections discovered so far

While reviewing T1, the code quality reviewer raised a few points. Apply these going forward:

1. **No `// path/to/file.ts` leading comments in new files** — repo convention. We dropped them in `079491d`.
2. **Optional fields use `field?: T`, not `field?: T | undefined`** — `AGENTS.md` is explicit on this; `skill/types.ts` is older style. The plan's code is already correct here.
3. **`PluginRecognizedFields` uses three-state booleans** (`true | undefined`, never `false`). Intentional. Manager tests rely on this.
4. **`interface.defaultPrompt` accepts `string | readonly string[]`** — Codex schema requires both forms. Don't simplify.

If a future reviewer flags these again, point at this list — they're not bugs.

---

## How to dispatch the next task

The superpowers `subagent-driven-development` skill is the active workflow. Per its protocol, every task gets:

1. **Implementer subagent** — does the work, runs tests, commits, self-reviews
2. **Spec compliance reviewer subagent** — reads code, compares to requirements (do not trust the implementer report)
3. **Code quality reviewer subagent** — reviews diff for code-quality issues
4. (Re-dispatch implementer if reviewers flag real issues, then re-review)
5. Mark TaskUpdate completed; move to next

Prompts to use (templates in `~/.claude/plugins/cache/claude-plugins-official/superpowers/5.1.0/skills/subagent-driven-development/`):
- `implementer-prompt.md`
- `spec-reviewer-prompt.md`
- `code-quality-reviewer-prompt.md`

**Important:** never start the implementer on `main`. The branch `feat/plugins-v1` is already checked out — keep it that way.

**Commit hygiene** (from `AGENTS.md`):
- Conventional Commit titles
- No co-author trailers / no agent identity in messages or PR text
- Create NEW commits per task — do not amend

---

## Ready-to-paste implementer prompt for Task 2

Use `subagent_type: general-purpose`, `model: "opus"`, `name: "impl-t2"`.

```
You are implementing **Task 2: Manifest parser** for Kimi Code's `/plugins` v1 feature.

Work from: `/Users/moonshot/code/kimi-code` on branch `feat/plugins-v1` (already
checked out; Task 1 already landed). Use `nvm use 24.15.0` (or equivalent) if
Node's not on 24.15+; `.npmrc` enforces engine-strict.

## Task Description

Implement `parseManifest(pluginRoot)` plus its 13 vitest test cases. Pure parser
— no I/O beyond reading the manifest file and stat'ing referenced paths. The
parser respects: `.kimi-plugin/` precedence over `.codex-plugin/`, path-safety
rules, and a structured diagnostics list.

Follow TDD: write the test file first, run it (FAIL), implement, run it (PASS),
commit.

The full code for both the test file and the implementation — copy-paste
verbatim — lives in `reports/2026-05-25-kimi-plugins-plan.md` under "Task 2".
Read that section in the plan, copy the test file content into
`packages/agent-core/test/plugin/manifest.test.ts`, then copy the implementation
content into `packages/agent-core/src/plugin/manifest.ts`, then update
`packages/agent-core/src/plugin/index.ts` to re-export `parseManifest` and
`ParsedManifestResult`.

## Verify

After implementation:
```
pnpm --filter @moonshot-ai/agent-core test test/plugin/manifest.test.ts
pnpm --filter @moonshot-ai/agent-core typecheck
```
Expected: all 13 cases PASS, typecheck PASS.

## Commit

```
git add packages/agent-core/src/plugin/manifest.ts \
        packages/agent-core/src/plugin/index.ts \
        packages/agent-core/test/plugin/manifest.test.ts
git commit -m "feat(agent-core): parse plugin manifest with kimi+codex fallback"
```

## Context

Task 2 of 14. Task 1 (types) already merged on this branch — your imports from
`./types` will resolve. Tests live in `packages/agent-core/test/` mirroring
`src/` (repo convention; see `test/skill/parser.test.ts`). Use relative imports
in tests (`../../src/plugin/manifest`).

Per `AGENTS.md`: commits must NOT mention agent identity / no co-author lines.
Conventional Commit titles.

## Important Constraints

- Paste the implementation code verbatim from the plan. No improvements, no
  extra error handling, no refactors.
- Tests run with the exact content from the plan. Don't add or remove cases.
- No emojis. No leading `// path/to/file.ts` comments in new files.
- Commit message exactly: `feat(agent-core): parse plugin manifest with kimi+codex fallback`

## Self-Review Before Reporting

- All 13 test cases pass
- No extra files modified beyond the three listed
- `pnpm --filter @moonshot-ai/agent-core typecheck` still passes

## Report Format

- **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
- Files added / modified
- Test runner output: count of passing cases, any unexpected output
- Commit SHA(s)
- Any concerns
```

---

## Spec / code quality reviewer prompts

After T2 implementer finishes, dispatch a spec reviewer (sonnet is fine for spec compliance even on opus-tier tasks) and then a code quality reviewer (opus).

Spec reviewer template — `spec-reviewer-prompt.md`. Fill in:
- "What Was Requested" = paste the same Task 2 description from above (including the verbatim test file and implementation)
- "What Implementer Claims They Built" = the implementer's report
- Verification commands the reviewer should run:
  - `git -C /Users/moonshot/code/kimi-code log --oneline feat/plugins-v1 ^main` (expect one new commit)
  - `git -C /Users/moonshot/code/kimi-code show --stat <new-sha>`
  - `pnpm --filter @moonshot-ai/agent-core test test/plugin/manifest.test.ts`
  - `cat` and diff against expected content
  - `git log -1 --pretty=full <new-sha>` to confirm no co-author / agent identity in message

Code quality reviewer template — `code-quality-reviewer-prompt.md`. Fill in:
- Commit SHAs (BASE = previous head before this task's commits, HEAD = new commit)
- Plan reference: `reports/2026-05-25-kimi-plugins-plan.md` Task 2

Specific to this codebase, ask the reviewer to also check:
- No leading path comments in new files (repo convention)
- Tests use relative imports, not `#/` alias
- Functions / types have single responsibility

---

## Iterating after T2

After T2 lands and reviews pass, continue down the task list in order. The plan's "Task N" sections have full code blocks ready to paste:

| Task | Model | Notes |
|------|-------|-------|
| T3 — installed.json store | opus | Reads/writes `~/.kimi-code/plugins/installed.json` with atomic write. Plan has full code + tests. |
| T4 — PluginManager | opus | Largest task. Reads installed.json, parses each manifest, exposes mutators + read API. Has its own test file. |
| T5 — Superpowers compat shim | opus | Synthesizes bootstrap for the `superpowers` plugin. Wires into PluginManager. |
| T6 — PluginsBootstrapInjector | opus | New file in `agent/injection/`, registered alongside PlanModeInjector. Touches `agent/index.ts` to add `pluginBootstraps`. |
| T7 — Wire PluginManager into KimiCore + Session | opus | Modifies `rpc/core-impl.ts` and `session/index.ts`. Integration test. |
| T8 — CoreAPI plugin RPC types | sonnet | Type-only changes to `rpc/core-api.ts`. |
| T9 — Implement plugin RPCs in KimiCore | opus | Adds method implementations to `KimiCore` class. Has roundtrip test. |
| T10 — SDK RPC exports | sonnet | Mirror the six methods in `node-sdk/src/rpc.ts`. |
| T11 — /plugins slash command | sonnet | Single entry in `BUILTIN_SLASH_COMMANDS`. |
| T12 — plugins-status-panel | opus | New TUI component. Two render functions. |
| T13 — /plugins dispatch | opus | Switch-case + handlePluginsCommand in `kimi-tui.ts`. |
| T14 — Acceptance + changeset + PR | opus | Run end-to-end against `/Users/moonshot/code/superpowers`; verify brainstorming auto-triggers on "Let's make a react todo list"; run `gen-changesets`; push and `gh pr create`. |

Every task in the plan has:
- Files to create/modify
- The exact code to paste
- The exact test code (if any)
- The exact commands to run
- The exact commit message

Trust the plan. If something doesn't match the codebase, escalate to the user — don't improvise.

---

## Final-stage review

After all 14 tasks land, dispatch one final code-reviewer subagent over the whole diff:

```
git -C /Users/moonshot/code/kimi-code log feat/plugins-v1 ^main --oneline
git -C /Users/moonshot/code/kimi-code diff main...feat/plugins-v1 --stat
```

Then use `superpowers:requesting-code-review` skill's template with BASE=`main` and HEAD=`feat/plugins-v1`. Look specifically at:
- Did the brainstorming auto-trigger test actually fire? (the spec's hard acceptance criterion)
- No secret execution path (grep for `require(|child_process|vm\.|worker_threads|import\(`)
- All four PR-spanning concerns from the spec §5 hold

Then `superpowers:finishing-a-development-branch` to open the PR.

---

## Memory / user preferences worth honoring

Loaded from `~/.claude/projects/-Users-moonshot-code-kimi-code/memory/`:
- **Minimal fix**: only essential changes; no piggyback refactors
- **Prompt restraint**: when editing prompts/descriptions, only touch the target; no renames; no copying entire reference implementations
- **Options with context**: when presenting choices to the user, mention how other tools handle the equivalent
- **No accent-color left border**: relevant only for UI work (not this branch)
- **Branch-local notes**: this file itself is a branch-local note; that's fine
- **Engineering notes default location**: not relevant unless the user asks for notes specifically

`AGENTS.md` constraints:
- pnpm 10, Node ≥ 24.15
- `import ... from '#/...'` inside `packages/agent-core/src/`
- Conventional commits
- Run `gen-changesets` (default `minor`) at task T14 — one entry covers the whole feature
- Tests live under `packages/agent-core/test/` mirroring `src/`, suffix `*.test.ts`

---

## Known issue: T1 spec-review false-positive

When you read prior transcript: the T1 spec reviewer flagged two "extra comments" in `types.ts`. Those comments were in the plan; my spec-reviewer prompt was just trimmed. They were legitimately part of the requirement (then removed in `079491d` for repo-convention reasons, unrelated). When iterating spec reviewers, paste the plan's task section as the "What Was Requested" — don't paraphrase.

---

## When done

- Tasks 2–14 each get a commit on `feat/plugins-v1`
- Final task does `gen-changesets`, pushes, opens PR via `gh pr create`
- Update `TaskList` to mark every task completed
- Report back: PR URL, final test status, any deviations from plan
