# Phase 1: Guide, Suggest, Act (design)

Date: 2026-10-26. Status: approved by Omar in outline; this document is the spec. Builds on v0.1.11.

## Problem

A new workspace has no ad data. The first real test (Gemini, v0.1.10) showed what happens: the agent called
`growth_scout`, the card read `Truth check · failed (failed)`, and the answer was "I cannot answer without ad data.
Export your reports to <path>." A newcomer does not know which reports, from where, or what Medjay can do
meanwhile. The agent has no way to save what it learns about the business, so every discovery question ends with
"edit this Markdown file yourself".

## Goal

Every agent turn follows one pattern, with or without data:

- **Guide.** Say what is ready and what is missing: context files filled or empty, data sources present,
  connections available, and the exact way to add each missing piece.
- **Suggest.** End with up to three concrete next actions the person can pick by typing 1, 2 or 3 (a mix of work
  that needs no data and steps that connect data).
- **Act.** Do the chosen thing now, with the tools that exist: load a skill, save a draft, update context, simulate.

Not in scope: live connectors (Phase 2), executing changes on a platform (Phase 3), new skills.

## Current state (verified in the code, 2026-10-26)

| Piece | State |
|---|---|
| `growth_scout` with an empty dropzone | throws; the card shows `failed (failed)` |
| `growth_diagnose` / `growth_simulate` | require a scout in the same run |
| `growth_simulate` with `spend` and filled unit economics | works without CSVs; `insufficient_inputs` lists missing fields |
| Context templates (`context/unit-economics.md`, `offer-matrix.md`, `brand-voice.md`, `claims.md`) | created by `mdj init`, mostly empty |
| Any agent tool that edits workspace files | none; only `draft_save` writes (to `drafts/`) |
| Tool classes | `read`, `draft`, `propose`; the Shield invariant is that the agent never writes to a platform |
| `ask` policy effect | exists; a run stops with "waiting for a human" and `mdj resume <run> --approve-tool <call>` continues it |
| Inline allow/deny prompt in the TUI | **not built** |
| Suggestions in the TUI | static (by intent), not chosen by the agent |
| Platform export instructions | none |

## Design

### 1. Clean "no data yet" state

- `GrowthPort.scout()` returns `{ status: "no_data_yet", dropzone, files_found: 0, exports_needed: [...] }` when the
  dropzone has no files or there is no mapping yet. It does not throw. A real read error still fails.
- `growth_scout` records the scout for the run in this case too. `growth_diagnose` then returns
  `{ status: "no_data_yet" }` instead of a precondition error.
- `cardFor` renders `no_data_yet` as `Truth check · no data yet`, in a neutral tone, not an error.
- A tool that fails for a reason that is expected state (no data, template not filled) must never use the error
  path.

### 2. `workspace_readiness` (read tool)

One call that gives the Guide step its facts, so the model does not infer them by reading files:

- context files: for each of the four, `empty | partial | ready` with the missing fields (unit economics reuses the
  existing validator; claims, offers and brand voice are `empty` when they hold only the template text);
- data: dropzone file count, newest file date, whether a mapping exists;
- connections: `none` in Phase 1 (the field exists so Phase 2 fills it);
- limits that matter now: daily post cap, spend cap, simulation gate;
- `export_guides`: for each platform the person might use, where to find the report (see 6).

### 3. `context_update` (new tool, class `context`)

Lets the agent save what it learned in chat into the workspace, with the person's approval each time.

- **Scope.** Exactly four files: `context/unit-economics.md`, `context/offer-matrix.md`, `context/brand-voice.md`,
  `context/claims.md`. A path outside that list is refused by schema, not by policy. `workspace.yaml`,
  `shield.policy.yaml`, plans and the ledger can never be reached by this tool.
- **Input.** `{ file, new_text, reason }`. Full replacement of the file, 20 KB maximum (the same cap `growth_context`
  reads). The model sees the current text through `growth_context` / `read_file` first.
- **Validation before anyone is asked.** `unit-economics.md` must parse and every number must pass the existing
  range rules (`value`, `low`, `high`, `source`). `claims.md` and `brand-voice.md` front matter must parse. An invalid
  file is returned to the model as an error; the person is never shown a broken proposal.
- **Policy.** New action `context.update`, resource `context/<file>`. Default effect `ask` (the workspace default is
  already `ask`; this phase also makes `mdj init` write an explicit rule, so it is visible in the file). A workspace may set `allow` or `deny`.
- **Approval.** The tool pauses the run (existing "waiting for a human" mechanism). The TUI shows the unified diff and
  `[A]llow once / [D]eny`. Allow resumes with `--approve-tool`; deny resumes with a denial result so the agent
  continues and does not retry the same change.
- **After approval.** Previous text is kept as a numbered version under `.medjay/context-history/<file>/`
  (same hash-checked scheme as drafts), the file is replaced atomically, and the ledger gets
  `context.updated { file, sha256_before, sha256_after, reason, run_id }`.
- **Class.** A new tool class `context` is added. The invariant "the agent never writes to a platform" is unchanged
  and gets a test: no tool of class `context` can resolve a path outside the four files. Tests that list the tool
  classes are updated on purpose, not loosened.

### 4. Cold start: simulate before any CSV exists

`growth_simulate` already runs from `spend` plus unit economics. Phase 1 makes that visible and safe:

- When no ad data exists, the result carries `mode: "target_model"` and a plain line: this is a model of your
  numbers, not observed results.
- If unit economics is still the template, the tool returns `template_not_filled` with the missing fields and the
  suggestion to run discovery. It does not return a generic failure.
- The scout-first precondition applies only to analyses of observed data. A target-model simulation needs no scout.

### 5. Guide · Suggest · Act turns

- **System prompt.** A `GUIDE_RULES` block, added when the tools exist: call `workspace_readiness` first when the
  person asks what to do, starts a session or the workspace is not ready; never answer "I cannot" for missing data;
  offer the Guide / Suggest / Act structure; route requests that need no data to the owner's `gd-*` skills and
  `draft_save`.
- **Discovery.** A short, ordered set of questions (what you sell, to whom, price and average order, margin,
  target cost per lead or return, claims you may and may not make, voice). The agent asks two or three at a time,
  and saves answers with `context_update` as it goes, not at the end.
- **`suggest_next` (new read tool).** `{ actions: [{ label, prompt }] }`, at most three, label up to 80
  characters, prompt up to 300. It has no side effects. The run records the validated list in `run.finished` as
  `suggestions`. The TUI shows them as "1. 2. 3." and typing a number sends that prompt as the next message.
  Chosen over parsing numbered lines out of the answer because prose parsing differs by model.
- **Fallback.** If a turn ends without `suggest_next`, the TUI falls back to static suggestions chosen from
  `workspace_readiness` (data present, context empty), never to the old generic list for an empty workspace.

### 6. Export guides

A static catalogue, `src/guide/exports.ts`: for each source (Google Ads, Meta Ads, GA4, Search Console, CRM or
sales CSV, WordPress) the report to export, the date range, the file type and where it goes. **The click paths in
these guides are not verified**: platform menus change, so each entry carries the date it was written, and the
text says "menu names may differ". They are corrected from real use, not guessed more precisely.

## Shield and safety

- `context_update` is the only new write path for the agent and it is allowlisted by file, validated, approved
  per change, versioned and ledgered. It cannot reach policy, workspace config, plans or approvals.
- Approve, strike, rollback, hold, reject stay typed in a terminal. The TUI prompt in this phase approves a
  context change only; it is not a route to approve plans.
- Customer-facing text still goes through the draft copy check; context files are internal.
- No new network access.

## Verification

Offline (must pass before release): unit tests for each task in the plan; a loop test that runs the agent against
a scripted model through: empty workspace -> `workspace_readiness` -> discovery answer -> `context_update` ask ->
allow -> file changed, history version and ledger entry exist -> `growth_simulate` runs -> `suggest_next` recorded.

Live (reported honestly, not claimed from tests): fresh workspace, same script on Gemini and OpenAI, then
Anthropic when that account has credit. Pass means: no `failed` card for expected state, three numbered
options at the end, typing `2` runs option 2, one `context_update` approved from the TUI changes the file.
Whether each model follows the pattern is **unverified until this run**; if one does not, the fix is in the
prompt and tool descriptions, with a test that pins the new wording's tool calls.

## Open questions

1. Denied context change: the agent should not re-propose the same text. Proposed: the denial result includes the
   rejected hash and the tool refuses an identical proposal in the same run.
2. Languages: discovery questions follow the person's language (Arabic or English) like other answers; files are
   written in the language the person used for free text and in English for field names.
3. Line endings in context files: proposed to normalise to LF on write so diffs and hashes are stable across
   Windows and Linux. The drafts store does not normalise today; check whether it should too.
