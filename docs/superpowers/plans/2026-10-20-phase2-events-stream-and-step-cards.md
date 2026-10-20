# Phase 2: `mdj run --events` stream and live step cards

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline). Steps use checkbox syntax.

**Goal:** The agent's work becomes visible as it happens: the TUI shows one line per step and tool call while the run is going, instead of "Thinking about that..." followed by a final blob.

**Architecture:** The loop (`src/runtime/loop/run.ts`) gains an optional `onEvent` observer. `mdj run --events` / `mdj resume --events` write one JSON object per line to stdout (stdout carries events only; stderr is unchanged). The TUI spawns `run --events`, splits stdout into lines, validates each with a shared schema, renders cards live, and takes the final answer from `run.finished`.

**Tech Stack:** TypeScript, zod 4, Ink, vitest.

**Spec:** [docs/superpowers/specs/2026-10-20-growth-session-and-tools-design.md](../specs/2026-10-20-growth-session-and-tools-design.md) section 4 and 5, build step 2.

## Global Constraints

- stdin stays closed for `run --events` in this phase (permission replies come in Phase 4).
- No secrets in events: step text is the loop's already-redacted text; tool input appears only as a short hash; tool output appears only as a short card summary.
- Events carry whole-step text after redaction, not raw token deltas (a secret split across deltas could not be redacted); this deviates from "text.delta" in the spec on purpose.
- Layers: the event schema lives in `src/run-events.ts` (treated as `shared` by the architecture test) because the runtime emits it and the TUI parses it, and `tui` may not import `runtime`.
- Tests first; one commit per task; trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Push only when the owner says so.

## Tasks

1. **Event schema** (`src/run-events.ts` + test): zod union of `run.started`, `step.started`, `step.text`, `tool.started`, `tool.finished`, `run.finished`; `encodeEvent(e): string` (one line, no raw newlines); `parseEventLine(line): RunEvent | null` (null for non-JSON or invalid, never throws). Architecture test treats the file as `shared`.
2. **Cards** (`src/runtime/loop/cards.ts` + test): `cardFor(tool, input, output, ok, errorKind?) -> {label, summary}` for the four current tools; unknown tools get a generic card; failures say what failed.
3. **Loop emits events** (`run.ts` + `loop.test.ts`): `RunDeps.onEvent?`, called for run start, each step, each text, each tool start/finish, run finish. A throwing observer must not break the run.
4. **CLI flag** (`run-commands.ts` + test): `--events` on `run` and `resume`; stdout only NDJSON; exit codes unchanged; without the flag output is byte-identical to today.
5. **TUI consumes the stream** (`src/tui/ask.ts`, `src/tui/app.tsx`, `src/tui/feed.ts`, tests): `askAgent` spawns `run --events`, buffers partial lines, passes each event to `ctx.onEvent` (app renders a `card` entry per tool), final text and errors come from `run.finished`; model failures still go through `classifyModelFailure`.
6. **`/expand n`** (`commands.ts`, `app.tsx`, test): print the stored detail of card n. Cards store `detail` lines (the card summary plus tool name and call id).
7. **Docs and live check**: SPEC §30.18 paragraph; pty run against the Etlaala workspace on OpenAI; commit.

Self-review: spec section 4 (events, `--events`, child process, read-only stdin) is covered by tasks 1-5; section 5 step cards by 5-6; the decision card, `ask` prompts and growth tools are later phases.
