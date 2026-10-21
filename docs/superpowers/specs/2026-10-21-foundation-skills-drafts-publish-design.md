# Foundation: owned skills and plugins bridge, versioned drafts, publish and send plans

Date: 2026-10-21. Status: DRAFT for owner approval. No code until approved.
Follows Phase 3 (growth tools, summary ingest). Foundation for the marketer workflows (SEO and content, weekly report, social calendar, email and lifecycle). Out of scope here: web tools, subagents, the MCP client itself, packaging; each gets its own spec.

## 0. What the owner's machine actually contains (checked 2026-10-21)

- `Growth-Architect-HQ/.claude/skills/`: 145 entries. The 80 `gd-*` skills are plain `SKILL.md` folders whose frontmatter has **only `name` and `description`**. Others (`ads@`, `cro@`, ...) are links into plugin skills.
- `gd-*` bodies do not name tools like `Read` or `Write`. They say "Load first: the active client's `brand.md`, `STRATEGY.md`, `03_Global_Assets/frameworks/quality-operating-standards.md`" and "Fill the Task Brief". So the real compatibility work is **path resolution and a few conventions**, not rewriting tool names.
- `~/.claude/skills/`: 164 entries. `~/.claude/plugins/installed_plugins.json` (version 2) lists plugins as `name@marketplace` with an `installPath`; each has `.claude-plugin/plugin.json`. Plugins carry **hooks, scripts, agents and MCP servers** next to their skills.
- Consequence: three kinds of content, with three different trust levels: the owner's own skills (HQ), skills the owner installed from marketplaces (other authors' prompts), and plugin code (hooks, scripts) that Medjay must never run.

## 1. Skills

### 1.1 Discovery chain (highest priority first; first name wins, collisions are listed)
1. Workspace: `<ws>/skills/`, `<ws>/.claude/skills/`, `<ws>/.agents/skills/`.
2. User: `~/.medjay/skills/`.
3. Linked roots from `workspace.yaml` (`skills.paths: [...]`) or `mdj skill link <path>`: this is how the HQ repo is mounted with no copying.
4. Optional, opt-in: `~/.claude/skills/` and plugin skills of plugins named in `plugins.include: [...]`.

Opt-in for step 4 is a deliberate change from "auto-mount everything": a marketplace plugin's skill is another author's prompt text, and 164 of them at once would also flood the model's tool choice. `mdj skills list` shows every discovered skill with its source and trust label, and one command (`mdj skill link ~/.claude/skills`) turns the whole folder on. Skills from the owner's HQ are labelled `owned`; plugin skills `third_party`.

### 1.2 Format and loading
- A skill is `<dir>/SKILL.md` with YAML frontmatter. Read: `name`, `description`, optional `allowed-tools` / `tools`, `pillars`, `jobs`, `inputs`, `policy_hints`. Unknown keys are kept and ignored. Size cap per skill (default 60 KB), index cap per directory.
- **Progressive disclosure.** The model never gets all 300 descriptions. Two read tools: `skill_search(query)` returns up to 8 matches (name, description, source); `skill_load(name)` returns the body plus a short preamble (section 2.2). `/skills` in the TUI and `mdj skills list` show everything to the human.
- Index cache at `.medjay/skills-index.json` keyed by file size and mtime; re-scanned at the start of every run and by `/skills reload` ("hot-load" without a daemon).

### 1.3 What a skill may and may not do (Ring 1)
A skill supplies prompts, workflows and templates and may **narrow** the toolset for a run (`allowed-tools`). It can never widen it, change `shield.policy.yaml`, or skip `approve` and `strike`. If a skill asks for something the registry does not have, the call fails like any unknown tool and the model is told so.

## 2. Tool names in owned skills (the translation, honestly)

### 2.1 Frontmatter declarations
`allowed-tools` / `tools` entries are translated through this table when present:

| Skill says | Medjay tool | Class | Note |
|---|---|---|---|
| `Read` | `read_file` | read | |
| `Glob` | `list_files` | read | |
| `Grep` | `search_files` (new, small) | read | The brief mapped Grep to `growth_context`; that tool returns the owner's economics and tactics, not search results, so a plain workspace text search is added instead. |
| `WebFetch`, `WebSearch` | `web_fetch`, `web_search` | read | Web tools spec; until then the entry is reported as "not available yet". |
| `Write`, `Edit` | `draft_save`, `draft_edit` | draft | Only into the drafts store (section 3). |
| `Bash` and any shell | **never mapped** | | Dropped and shown as `stripped: shell`. If the skill's purpose is an analysis, the model uses `growth_*`; if it is a platform change, `growth_propose_plan` (Phase 4). |
| `mcp__*` tools | read-only MCP client (later spec) | read | Write-capable MCP tools stay unreachable except through a plan. |
| anything else | not mapped | | Listed in `mdj skills show <name>` as a warning. |

### 2.2 Prose and the tool dictionary
The `gd-*` skills mention no tool names, but many third-party skills do, in prose ("use Read to open..."). Medjay does not rewrite those files. `skill_load` prepends a one-paragraph **tool dictionary** ("in this skill, 'Read' means `read_file`; 'Write' means `draft_save`; shell commands are not available") limited to names that actually occur in the skill. The model reads the original text plus the dictionary. This is a convention, not enforcement: the registry (class, policy, scope) remains the only thing that decides what runs.

### 2.3 Paths the skill assumes
`gd-*` skills point at `brand.md`, `icp.md`, `offers.md`, `STRATEGY.md` and `03_Global_Assets/frameworks/quality-operating-standards.md`. With HQ linked as a root named `hq`, those resolve to `hq:03_Global_Assets/...`. Medjay adds `skill_load` preamble lines mapping "the active client's brand file" to the client workspace's `context/` files where they exist, and otherwise says plainly that the file is missing instead of letting the model invent it.

## 3. Linked roots: read-only access outside the workspace

The run scope today is the client workspace plus its dropzone. A linked root adds a **named, read-only mount**:
- declared only in `workspace.yaml` or by `mdj skill link`; recorded in the ledger;
- every path is resolved with `realpath` and must stay inside the root (no `..`, no symlink escape);
- a denylist always applies (`.env`, `*.pem`, `*.key`, `credentials*`, `.git/`, `node_modules/`, anything under a directory named `secrets`);
- text from a linked root is **untrusted by default** (spotlighted like dropzone data) unless the root is declared `trust: owner`; the HQ root would be `owner`.

## 4. Versioned drafts store

For the marketer workflows the agent must be able to write a brief, a report or a calendar without being able to write anywhere else.
- Location: `<ws>/drafts/<workflow>/<slug>/v1.md`, `v2.md`... **Never overwrites**; every save is a new version.
- Tools (class `draft`): `draft_save {workflow, slug, kind, text}` (kind: `internal | ad_copy | email | social | page | report`), `draft_read`, `draft_list`, `draft_diff {a, b}`.
- Safety: path parts are slugs only; extensions limited to `.md`; size cap per version; max versions per slug; no executable content types; every save writes a ledger entry with the hash and size (not the text).
- Copy kinds (`ad_copy | email | social | page`) are linted with the existing claims and anti-slop checks when saved; the result is stored beside the version (`vN.check.json`) and shown on the card. `internal` and `report` are not linted.
- Default policy: `allow` for `draft_*` inside the store, because the store is sandboxed and versioned, nothing leaves Medjay, and it is reversible by deleting a file. This is a decision for the owner (D1).
- A human review step is unchanged: nothing in `drafts/` is sent anywhere by itself.

## 5. Publish and send plan actions

Anything that leaves Medjay is a **plan action**, approved and struck in the terminal, exactly like ad changes.
- New action types in the plan schema: `publish_post {site, post_ref, status}`, `send_email {list_ref, template_ref, schedule}`, `schedule_social {channel, draft_ref, at}`. Each references a draft version by hash, so what is approved is exactly what is sent.
- Shield: new risk classes (`publish`, `send`), default `require_approval`; `send_email` and mass sends additionally `two_step`. Per-day caps (emails, posts) in `shield.policy.yaml`.
- No live connectors exist yet: `strike` writes an **export artifact** (WordPress REST payload, email list file, social calendar CSV) validated against the draft hash, as ad changes do today. Live sends arrive with the MCP step.
- The model can only call `growth_propose_plan` (Phase 4). `approve`, `strike`, `rollback` are never tools and are not in the TUI.

## 6. Plugins

Read from a plugin's `.claude-plugin/plugin.json` and its folders:
- **Used:** `skills/` (as skills), `commands/*.md` (as TUI shortcuts `/plugin:name`, text only), `agents/*.md` (stored as subagent personas for the subagent spec), `mcpServers` (queued for the MCP spec, forced to read-only classification, version-pinned per the existing rule).
- **Never used:** `hooks`, `scripts`, `bin`, settings, anything that executes. `mdj plugins list` prints "ignored: hooks (n), scripts (n)" so the owner can see what Medjay did not run.
- Sources: `plugins.paths: [...]` in `workspace.yaml`, and `installed_plugins.json` for names listed in `plugins.include`.

## 7. Threat model

| Risk | Control |
|---|---|
| Prompt injection inside a skill, command or linked file | Text is untrusted unless `owned`; spotlighting; Ring 0 policy decides actions regardless of text |
| Typosquatted or colliding skill names | Collisions listed; first-wins order is fixed and visible; `third_party` label |
| Plugin hooks or scripts executing | Never run; reported |
| Path escape via links or `..` | `realpath` containment; denylist; read-only mounts |
| Secrets in linked roots | Denylist; redaction pass on all tool output (existing) |
| Context flooding by hundreds of skills | Search and load tools; no bulk index in the prompt |
| A skill pushing the agent past its limits | `allowed-tools` only narrows; policy deny wins; run limits unchanged |

## 8. Commands and UI

`mdj skills list [--source ...]`, `mdj skills show <name>` (source, trust, mapped tools, warnings, size), `mdj skill link <path> [--trust owner]`, `mdj skill unlink <path>`, `mdj plugins list`, `mdj skills doctor` (collisions, missing referenced files, unmapped tools). TUI: `/skills`, `/skill <name>`. Live cards: `Skill · gd-m09-email-lifecycle-planner (owned)`.

## 9. Testing

Fixtures: a mini HQ with `gd-*`-shaped skills; a fake plugin with hooks and scripts; a symlink escape; a denylisted file. Tests: discovery order and collisions; frontmatter parsing with unknown keys; translation table including the stripped shell case; `skill_load` preamble contents; realpath containment; draft versioning never overwrites; lint on copy kinds; plan actions reference draft hashes and fail on drift; architecture test for the new layer boundaries. Live check: link the real HQ repo, load `gd-m09-email-lifecycle-planner`, produce a sequence draft for Etlaala, view it with `/skills` and the drafts store.

## 10. Build order

F1 skills discovery, index, `skills list/show/link/doctor`, `skill_search`, `skill_load` with the dictionary. F2 linked roots in the run scope. F3 drafts store and tools. F4 plugin manifest reading (skills, commands, agents, MCP definitions, ignore-report). F5 publish and send plan actions with export artifacts. F6 TUI `/skills`, `/skill`, cards, docs.

## 11. Decisions for the owner

- **D1:** `draft_*` default `allow` (recommended) or `ask`?
- **D2:** Skills from `~/.claude/skills` and plugin caches opt-in (recommended) or auto-mounted?
- **D3:** `Grep` maps to a new `search_files` tool (recommended) rather than `growth_context`.
- **D4:** HQ declared `trust: owner` so its files are treated as your own words (recommended for HQ only).
- **D5:** First publish/send action types to build: `publish_post` (WordPress) first, then `send_email`, then `schedule_social`.
