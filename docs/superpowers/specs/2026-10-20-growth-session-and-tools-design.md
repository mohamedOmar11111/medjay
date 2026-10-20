# Growth session and Shield-governed tools (sub-projects 1 + 2)

Date: 2026-10-20. Status: DRAFT for owner approval. No code until approved.
Scope: an interactive streaming agent session in the TUI (1) and a growth tool registry under Shield permissions (2). Out of scope here: MCP client, skills/agents as Markdown, packaging, subagents, compaction. Each gets its own spec.

## 0. What the live test found (facts, not plans)

1. **The agent has no growth tools.** `mdj tool list` shows four generic tools: `read_file`, `list_files`, `lint_copy`, `propose_plan_actions` ([src/runtime/tools/](../../../src/runtime/tools/)). `scout`, `diagnose`, `simulate` and the Tested-Tactics Log exist only as CLI commands. That is why the live agent opened the wrong CSV (`Queries.csv`, no cost column) and why it can only be as good as its file picking. Fixing this is the core of sub-project 2.
2. **"I'm not connected to an AI model yet" is a misleading message.** [src/tui/ask.ts](../../../src/tui/ask.ts) maps every error matching `/no API key|\bauth:|all model targets failed/` to that text. It therefore also fires for a stored-but-rejected key, a malformed key, and network failures. In the live session the key was never stored (a 0-byte `C:\WINDOWS\system32\node` shadowed `node` in PowerShell, so `auth set` silently did nothing), and later a malformed 539-character key was stored. The TUI hid both. Workspace slot names were not the cause (`anthropic` slot, `anthropic` keychain ref matched). Fix: classify errors (section 6).
3. **The loop already streams** (`streamText` in [src/runtime/loop/driver.ts](../../../src/runtime/loop/driver.ts)) but `mdj run` prints only at the end, and there is no way to ask the human mid-run. The registry ([src/runtime/registry.ts](../../../src/runtime/registry.ts)) already has classes (read/draft/propose), strict input schemas, policy evaluation, client scope, timeouts, output limits, and ledger entries with input hashes only. There is already an `approval_required` error kind. We extend this; we do not replace it.

## 1. What we take from opencode (verified in source, v1.19.1 installed / current `sst/opencode` clone)

| opencode | File | Medjay decision |
|---|---|---|
| `Tool.Info {name, input, description, execute(input, ctx), output?, options?}` | `packages/schema/src/tool.ts` | Medjay's `ToolDef` already matches. Add `output` schema and a `render` hint (the card, section 3). |
| Permission `Rule {action, resource, effect: allow/deny/ask}`, last matching rule wins, no match means `ask` | `packages/core/src/permission.ts` `evaluate()` | Medjay already has the same evaluator in `shield/evaluate.ts`. Proposed (to confirm against `shield.policy.yaml` defaults when planning): unlisted tools default to `allow` for read, `ask` for draft, `deny` for propose, stricter than opencode's blanket `ask`. |
| Reply = `once` / `always` / `reject`; reject may carry feedback so the model continues (`CorrectedError`) | same file | Add `once`/`session`/`reject`. `session` is in memory only and ends with the TUI session. Nothing is written to `shield.policy.yaml` by a keypress. Feedback text on reject is returned to the model as the tool result. |
| Step outcomes: Completed, Retry, Continue, RecoverFull, Compacted, OutputLimit | `session/runner/step.ts` | We adopt Completed/Retry/OutputLimit only. Compaction is out of scope. |
| Permission events `permission.asked` / `permission.replied` are ephemeral events over the server stream | `schema/src/permission.ts` | Medjay equivalent is the NDJSON event channel (section 4), plus a ledger entry for every ask and reply. |

Not copied: Effect-TS, plaintext credential storage, a long-running HTTP server. We keep Node, the OS keychain, and in-process-per-command.

REA note: the installed opencode is open source, so reading the source (done above) is more accurate than reverse engineering. REA is worth using later only to capture opencode's runtime behaviour for UX parity (how its permission prompt and tool blocks look), not to read code.

## 2. Growth tool taxonomy

Tool names use underscores (`growth_scout`), because the provider APIs only accept `[a-zA-Z0-9_-]` in tool names; the dotted names in the brief are display labels.

| Tool | Class | Default policy | Wraps (exists today) | Returns to the model |
|---|---|---|---|---|
| `growth_scout` | read | allow | `analysis/scout.ts` + ingest | Calibrated snapshot: spend, CRM-confirmed revenue, blended MER, per-platform claimed vs confirmed multipliers, match rate, stale sources. Stamped with a `snapshot_id` (hash of normalized data + period). |
| `growth_diagnose` | read | allow | `analysis/diagnose.ts` | Findings with source and date: bleeding ad sets, over-attribution, funnel drop-offs, stale data. Needs a `snapshot_id`. |
| `growth_context` | read | allow | context files + `tactics/` | Unit economics, claims register, offer matrix, and the Tested-Tactics Log (so an invalidated experiment is not proposed again). |
| `growth_simulate` | read | allow | `analysis/simulate.ts` | Seeded Monte Carlo (the existing implementation, existing trial count and seed), break-even, sensitivity. Includes the existing missing-inputs result so the model asks for numbers instead of inventing them. |
| `growth_check_copy` | draft | ask on first use per session, then session grant | `lint_copy` + claims register + slop rules | Pass/fail with violations. See rule 3 below. |
| `growth_propose_plan` | propose | ask | `propose_plan_actions` + `plan/` compile + Shield `checkPolicy` + simulation gate | Validated proposals, Shield verdict, simulation verdict, dry-run diff, plan number if the owner allowed compiling. |

Invariants (tested, not just documented):
- No tool has class `write`. `approve`, `strike`, `rollback`, `hold`, `reject` and `verify` are not tools and are not in the TUI allowlist.
- `growth_propose_plan` creates at most a plan in state `proposed`. It cannot move a plan to any other state.
- Every call: client scope enforced, input hash plus verdict logged to the ledger, output size capped, output treated as untrusted data (existing spotlighting).

Open decision D1: whether `growth_propose_plan` may create the numbered plan record (needed for the "Plan #04" card) or only returns proposals and the user runs `mdj plan new --from`. Recommendation: allow it under `ask`. A `proposed` plan changes no platform and expires; the ask prompt plus ledger entry make it auditable.

## 3. Epistemic rules (enforced in code, with honest limits)

1. **No uncalibrated claims.** Hard part: `growth_diagnose`, `growth_simulate` and `growth_propose_plan` fail with `precondition_failed: run growth_scout first` unless the session holds a `growth_scout` result whose `snapshot_id` matches current data (re-checked on every call, so a changed export invalidates it). Soft part: the system prompt tells the model to call `growth_scout` before any performance claim, and `read_file` on raw dropzone exports tags its output `uncalibrated: platform-reported numbers`. The harness cannot detect in general that a free-text answer quotes a raw ROAS figure, so that case is only prompt-level; we say so rather than claim enforcement.
2. **Simulation before any increase.** `growth_propose_plan` itself runs `growth_simulate` for every action that increases spend, with the proposal's own numbers. It does not trust a simulation the model claims to have run. The Shield verdict and `P(margin > 0)` against the policy minimum (`gate.min_chance`, 0.6 in this workspace) are attached to the result. A failing gate marks the proposal `BLOCKED`; it is still shown, so the owner sees why.
3. **Copy is checked before it is trusted.** The model writes copy; the tool cannot write it. The enforceable guarantee is on the display side: the TUI renders copy blocks only through a "Copy Lab" card produced from a passing `growth_check_copy` result (hash of the text must match). Unchecked ad copy in free text is shown with a "not checked against your claims" tag. Bilingual (AR/EN) checks run per language.

## 4. Session architecture (opencode run-style, Medjay security model)

```
TUI (Ink)  <-- NDJSON events --  mdj run --events  (child process, same CLI)
           --  permission replies on stdin  -->
```

- New flag `mdj run --events`: emits one JSON object per line: `step.started`, `text.delta`, `tool.started {name, class, input_hash}`, `tool.finished {card}`, `permission.asked {id, tool, action, resources, summary}`, `run.finished {status, usage}`. Without the flag, behaviour is unchanged.
- Stdin accepts exactly one message type: `permission.reply {id, reply: once|session|reject, feedback?}`. Anything else is ignored and logged. The child waits on a pending ask with a timeout (default 120 s, then reject). Ctrl-C and Esc still hard-kill the child; interrupted runs stay resumable via `mdj resume`.
- The TUI keeps its rule: it has no capability the CLI lacks. It cannot call tools itself, cannot approve a plan, and spawns only an allowlisted argv.
- `ask` UI: an inline prompt `[A] once  [S] this session  [D] deny (type a reason)`. Allowed for draft/propose tool classes only. Never offered for anything that executes a plan.

## 5. Rendering

- **Step cards**, one line each, expandable with a numbered `/expand n`: for example `▸ Truth check · 4 sources · MER 1.90× (Google claims 2.1×, CRM confirms 0.6×)`, then diagnosis, simulation (`P(margin>0) 74% · PASS ≥ 60%`), plan. Example numbers above are illustrative formatting, not data.
- **Decision card** at the end of a proposal: expected revenue/margin impact, Shield verdict, simulation verdict (`PASS`/`BLOCKED`), then the exact ASCII commands `mdj diff N`, `mdj approve N`, `mdj strike N`. Same ASCII-in-Arabic rule as today. Revenue impact uses the simulation's P50 and says "estimate, not a forecast".
- Streaming text renders as it arrives; wrapped for Arabic as today.

## 6. Connecting a model inside the TUI

- Replace the catch-all with classified errors: `no_key` (nothing stored), `bad_key_format`, `key_rejected` (401), `quota` (message includes reset date when present), `network`, `model_not_found`, `other`. Each has plain EN/AR text and the exact next step.
- `/connect [provider]`: masked prompt in the TUI; the key goes to the child `mdj auth set <provider>` on stdin only, never argv, never the feed, never the ledger. Input is cleaned and validated with the existing `cleanPastedSecret` and store checks. The prompt then runs a one-token probe call to confirm the key works before saying "connected".
- Provider base URLs are explicit (already fixed in `models/factory.ts` with a test), so a stray `*_BASE_URL` cannot redirect a key.

## 7. Approaches considered

A. **Child process with NDJSON events and a stdin back-channel (recommended).** Matches opencode's run/server split in spirit, keeps the TUI capability-free, reuses all CLI security.
B. In-process loop inside the TUI. Simplest to render, but the TUI would hold keys and run tools directly, breaking the "front end only" rule.
C. Local HTTP server like opencode. Most flexible (web/desktop later) but adds an attack surface and a daemon for no gain in v1.

## 8. Testing

- Registry: every new tool has strict schema, scope, policy and ledger tests (existing pattern). Invariant test: no write class; no tool name matches approve/strike/rollback/hold/reject/verify.
- Preconditions: rule 1 and rule 2 each get a failing-first test, including stale snapshot and missing economics inputs.
- Protocol: golden NDJSON transcript test; stdin accepts only `permission.reply`; ask timeout rejects.
- TUI: ink-testing-library tests for step cards, ask prompt keys, decision card with ASCII commands in Arabic mode; pty smoke test as before.
- Live acceptance on the Etlaala workspace with the stored OpenAI key: the question that failed before (zero-conversion search terms) must pick `Searches(...)` via tools and match the CSV. I verified that answer by hand already (thailand 164.71, جورجيا سياحة 153.42, تايلاند 152.02).
- Known gap: the live workspace holds Google Ads UI summary reports with no date column, so `growth_scout` cannot read them yet. Either add an ingest path for summary reports (separate task) or export daily data.

## 9. Build order

1. Error classification and `/connect` (fixes the misleading message first).
2. `--events` protocol and streaming cards, with the existing four tools.
3. Growth tools 1-4 (read) with snapshot ids and preconditions.
4. `ask` prompts and `growth_check_copy`.
5. `growth_propose_plan` with automatic gates and the decision card.

## 10. Open decisions for the owner

- D1: may the agent create the numbered `proposed` plan under `ask` (recommended), or only return proposals?
- D2: default for `growth_check_copy`: `ask` once per session (as above) or `allow` (it only reads and lints)? Recommendation: `allow`; it cannot change anything. The `ask` default in the brief is kept only if you want every draft tool gated.
- D3: ask timeout 120 s then reject: acceptable?
