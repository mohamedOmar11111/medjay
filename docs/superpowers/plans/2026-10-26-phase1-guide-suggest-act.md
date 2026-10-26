# Phase 1 plan: Guide, Suggest, Act

Spec: `docs/superpowers/specs/2026-10-26-phase1-guide-suggest-act-design.md`. Release as v0.1.12 when all tasks pass.
Rules for every task: tests first (watch them fail), no step is done until its tests pass, full suite and
`npm run typecheck` before each commit, commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`,
no push without Omar saying so.

## T1. Expected "no data" is not a failure

Files: `src/cli/growth-port.ts`, `src/runtime/tools/growth.ts`, `src/runtime/loop/cards.ts` (+ their tests).

1. Tests: `scout()` on a workspace with an empty dropzone, and on one with files but no mapping, returns
   `status: "no_data_yet"` and lists `exports_needed`; a real read error still throws. `growth_diagnose` after such a
   scout returns `no_data_yet`, not a precondition error. `cardFor("growth_scout", ..., { status: "no_data_yet" })`
   is `Truth check · no data yet` and is not reported as failed.
2. Implement. 3. Run the app test that shows cards (no `failed (failed)` for expected states).

## T2. `workspace_readiness` read tool

Files: new `src/cli/readiness.ts` (adapter, because the runtime cannot import analysis layers), port type in
`src/runtime/tools/growth.ts` or a new `src/runtime/tools/readiness.ts`, registered in `src/runtime/loop/open.ts`.

1. Tests: empty workspace -> four context files `empty`; unit economics with some fields -> `partial` with the
   missing field names; complete -> `ready`; data counts and newest file date; policy limits echoed
   (post cap, spend cap, simulation gate); `connections: []`.
2. Implement reusing `loadUnitEconomics` problems. 3. Card summary: `Workspace check · 2 of 4 context files ready, no data`.

## T3. Export guides

Files: new `src/guide/exports.ts` (+ test). New layer `guide: [shared]` in `test/architecture.test.ts`.

1. Tests: every guide has source, report, date range, file type, destination folder and a `written` date; text
   contains the "menu names may differ" notice; readiness returns the guides.
2. Write the six entries. Mark in the PR/commit that the click paths are unverified.

## T4. `context_update` (class `context`)

Files: new `src/runtime/tools/context-update.ts`, `src/context/store.ts` (history + atomic write; layer
`context: [workspace, shared]`), `src/runtime/registry.ts` (class), `src/shield/invariants.ts` test, `src/workspace/init.ts`
(explicit policy rule), architecture test.

1. Tests (all written before code):
   - schema refuses any path other than the four files, including `../`, absolute paths, case tricks and
     `workspace.yaml` / `shield.policy.yaml`;
   - invalid unit economics (bare number, low > value) and invalid front matter are returned as errors;
   - with the `ask` effect and no approval the run pauses and nothing is written;
   - with approval: file replaced, previous text saved as version N, `sha256_before/after` correct, ledger entry
     `context.updated` written, LF normalised;
   - deny result is returned to the model; an identical proposal in the same run is refused;
   - no tool of class `context` can reach a path outside the four files (property test over generated paths);
   - 20 KB cap.
2. Implement store, tool and class; update the tests that enumerate classes on purpose.

## T5. TUI permission prompt for `ask`

Files: `src/run-events.ts` (new event `permission.requested { call_id, tool, summary, diff? }`),
`src/runtime/loop/run.ts`, `src/runtime/loop/resume.ts` (deny path), `src/cli/run-commands.ts` (`--deny-tool`),
`src/tui/app.tsx`, `src/tui/ask.ts`.

1. Tests: a run that hits an `ask` emits `permission.requested` with the diff and ends `waiting`;
   `mdj resume --approve-tool` writes the change; `--deny-tool` continues with a denial result; the TUI shows the
   diff and `[A]llow once / [D]eny`, `A` resumes with approve, `D` with deny, Esc counts as deny;
   a timeout of 120 s denies; the prompt cannot approve a plan (only `context.update` is offered in this phase).
2. Implement. 3. Live check in a real terminal (reported as unverified until done).

## T6. Cold-start simulate

Files: `src/cli/growth-port.ts`, `src/runtime/tools/growth.ts`, cards.

1. Tests: no data + filled economics + `spend` -> result has `mode: "target_model"` and the notice; template
   economics -> `template_not_filled` with missing fields; no scout needed for target-model runs; with data the
   behaviour is unchanged.
2. Implement.

## T7. `suggest_next` and numbered choices

Files: new `src/runtime/tools/suggest-next.ts`, `src/run-events.ts` (`suggestions` on `run.finished`),
`src/tui/ask.ts`, `src/tui/app.tsx`.

1. Tests: schema (max three; label 80, prompt 300 characters; no control characters); the finished event carries
   the list; the TUI renders `1. 2. 3.` and typing `2` sends prompt 2 as the next message; missing tool call ->
   fallback suggestions chosen from readiness, never the generic list for an empty workspace.
2. Implement.

## T8. Prompt rules

Files: `src/runtime/context/system-prompt.ts` (+ test).

1. Tests: `GUIDE_RULES` present when `workspace_readiness` is registered and absent otherwise; it names the
   tools; it forbids "I cannot answer" for missing data; discovery order is included.
2. Implement. 3. Scripted-model loop test (spec, Verification) in `src/runtime/loop/guide.test.ts`.

## T9. Docs, release, live check

1. `docs/SPEC.md` section "Guide, Suggest, Act" with the limits stated honestly (guides unverified, models
   unverified until run).
2. Bump to 0.1.12, full suite, typecheck, dry-run publish.
3. Live script on a fresh workspace: Gemini, OpenAI (Anthropic when the account has credit). Record per model: cards
   with `failed`, number of options at the end, `2` works, one context change approved. Report failures as found.
4. Omar says push; Omar publishes with his 2-factor code; tag after publish.

## Order and size

T1, T2, T3 first (small, independent, remove the dead end). T4 and T5 together (the approval path). T6, T7, T8 after.
T9 last. Expected: about a day of focused work per two tasks.
