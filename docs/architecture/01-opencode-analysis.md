# opencode analysis (reference architecture)

Date: 2026-10-17. Source: shallow clone of `github.com/sst/opencode` (v2.0.31, MIT, Effect-TS monorepo). Three read-only passes by sub-agents that skimmed headers and key sections, not every line. Treat file-level claims as leads to verify before copying any behaviour.

Paths below are relative to `packages/`.

## What opencode is
A coding-agent harness: CLI + TUI + desktop/web apps over one shared server. Relevant to Medjay for its loop, tool, permission, provider, MCP, and markdown-config design. Its TUI (OpenTUI + SolidJS, about 63k lines), desktop, ACP, PTY, and worktree layers are not relevant to v1.

## Agent loop and state
- `core/src/session/runner/llm.ts`: outer loop. Prompts become durable inbox items; one drain runs per session.
- `core/src/session/runner/step.ts`: one model call. Streams events, forks a fiber per tool call, ends with an outcome (Completed, Retry, Continue, RecoverFull, Compacted, OutputLimit).
- State is event-sourced: events appended to a log, projected into SQLite (`session/projector.ts`, `schema/src/session-event.ts`).
- `runner/max-steps.ts`: after a step limit, forces a text-only answer.

## Tools
- `schema/src/tool.ts`: `Tool.Info = {name, description, input, output?, execute(input, ctx), options?}`.
- `core/src/tool.ts`: registry; last registration for a name wins; each request snapshots the effective tools. Registry validates input but does not check permissions; each tool leaf calls the permission service itself.
- Built-ins: read, write, edit, patch, glob, grep, shell, webfetch, websearch, question, skill, subagent, MCP resources.
- Subagents are child sessions, not in-process calls.

## Permissions
- `schema/src/permission.ts`: Rule = `{action, resource, effect: allow|deny|ask}`.
- `core/src/permission.ts`: `findLast` wildcard match, no match means ask. Any deny blocks. Rejection can carry feedback so the model continues (`CorrectedError`). Saved "always" grants per project. Plugin hook `permission.evaluate` can override.
- Shell commands are parsed (tree-sitter) so each sub-command is checked separately.

## Agents, commands, instructions, compaction
- Agents and commands are Markdown files with frontmatter (`config/plugin/agent.ts`, `command.ts`). Modes: primary / subagent / all.
- Discovery scans `.opencode`, `.claude`, `.agents` directories (global and project), so Claude Code skills load.
- Instructions: global `AGENTS.md` plus a walk up from the working directory.
- Compaction: on auto (before a step), on provider context overflow, or manual; keeps a recent token tail.

## Config layers (later overrides earlier)
Managed policy (final authority) -> remote well-known -> global dir -> explicit file -> project dirs -> env content -> system-managed settings.

## Provider layer
- Own protocol layer, not the Vercel AI SDK. `ai/src/protocols/*` (anthropic-messages, openai-chat, openai-responses, openai-compatible-chat, gemini, bedrock-converse, cohere, mistral, others) + `ai/src/providers/*` (about 66 thin wrappers) + `ai/src/route/*` (protocol / endpoint / auth / framing / transport).
- Normalized `LLMEvent` stream (`ai/src/schema/events.ts`): step, text, reasoning, tool-input, tool-call, tool-result, provider-error, usage.
- AI SDK is a compatibility fallback (`core/src/aisdk.ts`).
- Catalog: models.dev format, mirrored at `models.opencode.ai/api.json`; bundled 5.7 MB snapshot + KV cache + periodic refresh (`core/src/models-dev.ts`).
- Cache policy (`ai/src/cache-policy.ts`): up to 4 breakpoints (last tool, first and last system parts, conversation tail); only for protocols that honor inline hints.
- Error classification (`ai/src/provider-error.ts`): tagged reasons, regexes for context-overflow, retryability.
- Credentials (`schema/src/credential.ts`, `core/src/credential/sql.ts`): oauth / key / external; stored as plaintext JSON in SQLite. **Do not copy this; Medjay stores secrets in the OS keychain.**

## Client / server split
- CLI is an HTTP client by default (managed background service, `--server <url>`, or `--standalone` in-process). TUI, `run`, ACP, desktop share sessions and an event stream.
- `run` (non-interactive) is about 30 lines: resolve a server, send a message, subscribe to events, render.

## Plugins, MCP, codemode
- Plugin contract `Plugin.define({id, setup(ctx)})` with per-domain `hook()` and `transform()`. Hooks: aisdk, session, permission, shell, tool (`execute.before` may reject; `execute.after` cannot).
- MCP client (`core/src/mcp/client.ts`): streamable HTTP, stdio, OAuth, prompts, instructions.
- `codemode`: a from-scratch interpreter so the model writes one program calling `tools.x.y()`, avoiding hundreds of tool schemas in context. Deferred for Medjay.

## Decisions for Medjay
| Topic | opencode | Medjay v1 |
|---|---|---|
| Runtime | Effect-TS services, Bun | Plain TypeScript on Node, no Effect |
| Providers | Own protocol layer | Vercel AI SDK + models.dev catalog (verify API before coding) |
| State | Event log -> SQLite projections | SQLite for machine state; Markdown for human files |
| Permissions | allow/deny/ask, last match wins | Same evaluator, plus spend-aware rules and plan binding |
| Tools | `Tool.Info` shape | Same shape |
| Server | Always-on HTTP/SSE service | In-process first; optional daemon for gateway and cron |
| Secrets | Plaintext SQLite | OS keychain |
| UI | Big TUI | Plain CLI rendering of an event stream |

## Files most worth reading when implementing
`schema/src/tool.ts`, `core/src/session/runner/step.ts`, `core/src/session/runner/llm.ts`, `core/src/permission.ts`, `schema/src/permission.ts`, `schema/src/agent.ts`, `core/src/tool.ts` + `core/src/tool/AGENTS.md`, `ai/src/cache-policy.ts`, `ai/src/provider-error.ts`, `core/src/models-dev.ts`, `cli/src/run/noninteractive.ts`, `core/src/config/markdown.ts`.

## Clone note
The clone hit a Windows checkout error (git shows tracked files as deleted) but the files are on disk. Located in the Claude session scratchpad, not in this repo.
