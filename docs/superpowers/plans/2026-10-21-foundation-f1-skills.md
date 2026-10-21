# Foundation F1: skills discovery, index, tools and commands

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline). Steps use checkbox syntax.

**Goal:** Medjay finds the owner's skills (HQ `gd-*`, workspace, user) without copying them, lists them with their source and trust, and lets the agent search and load them. This is F1 of the Foundation spec; linked read-only roots (F2), drafts (F3), plugins (F4), publish plans (F5) and TUI polish (F6) follow.

**Architecture:** A new pure layer `src/skills/` (parse, discover, translate tool names) with no knowledge of the runtime. `workspace.yaml` gains `skills.paths` and `plugins.*` sections. Two read tools (`skill_search`, `skill_load`) are registered when skills exist. `mdj skills list|show|doctor` and `mdj skill link|unlink` are the human side.

**Tech Stack:** TypeScript, yaml, zod 4, vitest.

**Spec:** [docs/superpowers/specs/2026-10-21-foundation-skills-drafts-publish-design.md](../specs/2026-10-21-foundation-skills-drafts-publish-design.md) sections 1, 2, 8 and decisions D2-D4.

## Global Constraints

- Skills never widen permissions: `allowed-tools` only narrows; the registry and `shield.policy.yaml` decide.
- A skill body is untrusted text unless its root is `owned`; plugin hooks and scripts are never executed (F4).
- `~/.claude/skills` and plugin caches are opt-in (`skills.include_claude_global`, `plugins.include`), not auto-mounted (D2).
- Skill reads: only `SKILL.md`, capped (default 60 KB); no other file of a skill folder is read in F1.
- The model never receives the full skill list: `skill_search` returns at most 8; the human sees all via `mdj skills list`.
- Tests first; one commit per task; trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; push only when the owner says so.

## Tasks

1. **Workspace config** (`src/workspace/schema.ts`): `skills: {paths: [{path, trust: owner|untrusted, name?}], include_claude_global: false}` and `plugins: {paths: [], include: []}`, both optional with defaults; unknown keys still rejected.
2. **Skills layer, parse** (`src/skills/parse.ts`): `parseSkill(text, fallbackName)` returns `{name, description, body, frontmatter, problems}`; frontmatter between `---` lines; missing description is a problem; unknown keys kept.
3. **Skills layer, tool translation** (`src/skills/tools.ts`): `translateTools(declared)` per the spec table (Read, Glob, Grep, WebFetch, WebSearch, Write, Edit, Bash, `mcp__*`); `toolDictionary(text)` returns the one-paragraph dictionary limited to names that occur.
4. **Skills layer, discover** (`src/skills/discover.ts`): `discoverSkills(roots)` walks each root's immediate subfolders for `SKILL.md` (following folder links), applies priority and first-wins, returns `{skills, collisions, problems}`; `defaultRoots(config, {home})`.
5. **Skill tools** (`src/runtime/tools/skills.ts`): `skill_search {query}` and `skill_load {name}`; load returns the body plus the dictionary and a trust note; unknown name gives a clear error.
6. **Wire into runs** (`open.ts`): compute roots from `workspace.yaml`, register the tools when at least one skill exists, add a one-line system prompt rule.
7. **CLI**: `mdj skills list [--source] [--json]`, `mdj skills show <name>`, `mdj skills doctor`, `mdj skill link <path> [--trust owner]`, `mdj skill unlink <path>` (edits `workspace.yaml`, keeps comments, writes a ledger event).
8. **Live check and docs**: link the real HQ repo into the Etlaala workspace, list, load `gd-m09-email-lifecycle-planner` through the agent, SPEC section, commit.

Self-review: spec 1.1 (chain, opt-in), 1.2 (format, search and load, cap), 1.3 (narrow only), 2.1 and 2.2 (table, dictionary), 8 (commands) are covered. Linked read-only roots (spec 3), drafts, plugins and publish plans are later Foundation steps.
