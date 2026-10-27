<p align="center"><img src="docs/assets/logo-mark.jpg" width="280" alt="Medjay Logo" /></p>

# Medjay (`mdj`)

An open, CLI-first, all-model growth-agent harness for marketers. It has two halves:

- **The Shield (harness).** Spend caps, dry-run `.plan.json` diffs, two-step approvals, signed approvals bound to a plan hash, circuit-breaker settings, and a SHA-256 hash-chained audit ledger. Nothing reaches an ad platform without passing it.
- **The Sword (strike).** Finds the money that is leaking, simulates a change before it spends, proposes plans, learns which tactics really work, and watches competitors.

One folder is one client workspace. Medjay never converts currencies silently, never sends anything to an ad platform by itself, and never lets an AI model approve its own work.

> **Status: v0.1.0 release candidate.** Built and tested offline end to end (about 1,000 tests). Not yet tried against live ad accounts, a live WhatsApp relay or a real Google Ads Editor import. See [What is not verified](#what-is-not-verified) before you rely on any export.

## Quickstart

Requires [Node.js](https://nodejs.org) 22.13 or newer. Then, in any terminal:

```bash
npm install -g medjay
mdj
```

That is all. The first time you run `mdj` it asks four things in plain English or Arabic (your business name, what you sell, your currency, a yes), creates your workspace in a `Medjay` folder in your home directory, and tells you to type `/connect` to add your AI model key. The key is typed hidden and stored in your operating system's keychain, never in a file. Next time you run `mdj`, from any folder, it reopens the workspace you used last.

Want to see it work before connecting anything?

```bash
mdj demo                  # the whole loop on a synthetic Saudi travel advertiser, in a temp folder
mdj demo --auto-approve   # the same, approving and exporting the first plan
```

Working from a clone of this repository instead:

```bash
npm install && npm run build && npm link
```

If it does not start:

- **"Medjay needs Node.js 22.13 or newer"**: install the current LTS from https://nodejs.org, open a new terminal, and run `mdj` again. Check with `node --version`.
- **`mdj` is not recognized**: close the terminal and open a new one (the install adds a folder to your PATH). If it still fails, run `npm config get prefix` and make sure that folder is on your PATH.
- **Windows PowerShell says "running scripts is disabled on this system"**: run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or use Command Prompt, or run `mdj.cmd` instead of `mdj`.
- **"OS keychain" fails in `mdj doctor`** (a Linux server, a container, WSL without a keyring): set your key as an environment variable instead, for example `MEDJAY_ANTHROPIC_API_KEY`, `MEDJAY_OPENAI_API_KEY` or `MEDJAY_GOOGLE_API_KEY`. Keys are never written to files.
- **Anything else**: run `mdj doctor` and read the failed line; it says what to do. Please open an issue at https://github.com/mohamedOmar11111/medjay/issues with that output (never paste a key).

Which AI model: bring your own key for Anthropic, OpenAI or Google (`/connect anthropic`, `/connect openai` or `/connect google` in the app, or `mdj auth set <provider>`). A workspace starts on Anthropic's `claude-sonnet-5-5`; setup and `/connect` switch it to the provider whose key you have (`gpt-5.4-mini` for OpenAI, `gemini-2.5-flash` for Google), and `mdj models use <provider> [--model <id>]` does it by hand.

Where things go: new workspaces are created in `~/Medjay` (change it with the `MEDJAY_WORKSPACES` environment variable); the "last workspace" note is kept in `~/.medjay` (`MEDJAY_HOME`). Pass `--workspace <folder>` to any command to use a specific workspace.

Your own workspace, step by step with the commands:

```bash
mdj init my-client --id my-client --business-type agency --timezone Asia/Riyadh --currency SAR --language ar
mdj auth set anthropic          # key goes to the OS keychain (hidden prompt)
mdj doctor --workspace my-client

# put exports in my-client/data/imports/ and describe them in my-client/ingestion.mappings.yaml
mdj scout --workspace my-client       # ingest, normalize, calibrate against CRM truth
mdj diagnose --workspace my-client    # top anomalies, each with source file and date
mdj simulate --workspace my-client --scale-pct 15   # seeded funnel math from context/unit-economics.md
mdj shadow-scout --workspace my-client              # competitor offers from saved pages
mdj                                                  # open the terminal app: ask in plain English or Arabic (needs a terminal)
mdj media list                                       # 20 read-only media-buyer rules over exported CSVs
mdj media run fatigue-call ads.csv --workspace my-client
```

From a finding to a change:

```bash
mdj plan new --from proposals.json     # compiled, policy-checked, deterministic
mdj simulate --plan 1                  # a budget increase needs a passing simulation
mdj approve 1                          # signed with your key, bound to the plan hash
mdj strike 1                           # writes export files; sends nothing to any platform
mdj validate-export 1                  # the files are well formed and still match the plan
mdj verify 1 --observed after.json     # compare what the platform now shows
mdj rollback 1                         # a new plan of exact inverses, same approval path
mdj ledger verify                      # recompute the hash chain
```

## Commands

| Group | Commands |
| --- | --- |
| Setup | `init`, `doctor`, `migrate`, `auth set\|status\|remove`, `models`, `shield check\|hash-number`, `style`, `slop` |
| Data and truth | `scout`, `diagnose`, `simulate`, `shadow-scout` |
| Plans | `plan new\|list\|show`, `diff`, `approve`, `hold`, `reject`, `strike`, `validate-export`, `verify`, `rollback` |
| Agent | `run "<task>"`, `resume <run_id>`, `runs list\|show\|proposals`, `tool list\|call` |
| Learning | `tactics new\|hypothesize\|conclude\|retire\|index\|list\|show` and `tactics promote\|search\|pull` (global vault) |
| Messaging | `bridge simulate-webhook\|run-jobs\|serve` |
| Audit | `ledger verify\|head` |
| Demo | `demo [--auto-approve] [--as-of <date\|now>]` |

`mdj <command> --help` has the details.

## Architecture: two rings

**Ring 0, the immutable Shield.** Nothing an agent, a skill, a pack or an optimizer produces may change these:

- `shield.policy.yaml`: limits, forbidden actions, rules, approvers, run limits, the simulation gate
- the tool registry and its permission classes (read, draft, propose; never write)
- `<untrusted_data>` spotlighting and PII redaction
- credential resolution (OS keychain, or `MEDJAY_*` environment variables)
- the plan compiler, signed approvals, export validation
- the SHA-256 hash-chained ledger

Changing Ring 0 is a human edit that shows up in `git` and in the policy hash.

**Ring 1, the evolving Sword.** Skill prompts, creative templates, diagnostic thresholds and Tested-Tactics Log entries. These can improve over time; they can never widen Ring 0. (`mdj improve`, a human-approved optimizer for Ring 1, is parked for a later milestone and not built.)

Layers (enforced by `test/architecture.test.ts`): `audit`, `models`, `shield`, `store`, `plan`, `ingest`, `analysis`, `runtime` (tools, context builder with input guardrails, agent loop, SQLite run checkpoints), `tactics`, `vault`, `shadow`, `bridge`, `demo`, `cli`.

A workspace:

```
my-client/
  workspace.yaml            business, models, bridge, style, vault consent
  shield.policy.yaml        the Shield
  ingestion.mappings.yaml   how your exports map to Medjay's facts (any CRM, any ad platform)
  context/                  brand-voice, unit-economics, offer-matrix, claims, calendar
  tactics/                  the Tested-Tactics Log (one Markdown file per tactic)
  data/imports/             the dropzone: untrusted data, never configuration
  plans/  exports/          compiled plans and what a strike wrote
  .medjay/                  ledger and local state (SQLite)
```

## Security guarantees

What is enforced in code, and tested:

- **Secrets live in the OS keychain.** Provider keys are read in exactly one module, from the keychain or a `MEDJAY_*` variable. Vendor variables such as `ANTHROPIC_API_KEY` are never read. Keys are not written to files, plans, logs or error messages.
- **The agent loop has no write tools.** The tool set is read, draft and propose. Tools cannot import filesystem, process or network modules, and the loop cannot import plan approve or strike code (architecture tests, checked by mutation).
- **External text is data.** Anything from a CSV cell, a web page, a CRM field or a message is wrapped in a nonce-bound `<untrusted_data>` block; look-alike tags are neutralized. Instruction-like text in ingested data is flagged. On the tests so far this stopped a plausible injection on a local model that was hijacked 2 of 3 times without it; it lowers risk and is not a guarantee. The real defense is that tools cannot write and every change needs a signed approval.
- **Approvals are signed and bound to the plan hash.** A plan edited after approval cannot be struck; policy is re-checked at approval and again at strike; a scale-up needs a passing seeded simulation.
- **Voice cannot approve or change anything.** Over the WhatsApp bridge, an audio note, or any text a provider marks as a transcription, can only ask for reports. `STRIKE <plan> <hash>` must be typed in ASCII (or be a signed button tap) from an allowlisted sender, and the hash must match the plan as it is now.
- **The ledger is tamper-evident.** `.medjay/audit-log.jsonl` is hash-chained; `mdj ledger verify` finds the first break. It is *evident*, not *immutable*: someone with file access can rewrite the whole chain. Record `mdj ledger head` somewhere else (the bridge prints it in every card) to detect that.
- **Nothing leaves a client silently.** Promoting a tactic to the global vault is off by default, builds the record from an allowlist, replaces urls, emails, phone numbers, amounts and ids, and fails if a word from the client, brand or campaign names remains.

## What is not verified

Be honest with your clients about these:

- **Google Ads Editor CSV.** The format follows Google's published column reference but has not been imported into a real account. Negative keywords are removed with `Status: Removed`. Campaign-level negatives (Ad Group empty) are written with `Criterion Type` `Campaign Negative Broad|Phrase|Exact`, which is the form Editor documents for them (ad-group negatives would use `Negative ...`; Medjay does not write those). Confirm in a test account first.
- **Meta.** There is no bulk file, so mutations are exported as dry-run requests (`meta-mutations.json`, budgets in minor units from an explicit currency table). Nothing is ever sent.
- **WhatsApp.** The Cloud API webhook and transport follow Meta's documented formats but have not run against a live number (the 24-hour window and template rules still apply). The Respond.io preset is an assumption. Any other CRM or relay works through configuration: you name the signature header and format and the field pointers.
- **Live connectors** to ad platforms do not exist yet; `strike` writes files for a person to import.
- **Monte Carlo** draws each input independently; real inputs are correlated. The scale-up elasticity is an assumption until estimated from your data.
- **Arabic**: the anti-slop and dialect word lists have been reviewed by one person only.

## Tests

```bash
npm test               # offline and deterministic; builds dist/ once, then runs everything
npm run test:live      # gated: real Gemini and local Ollama prompt-injection tests (costs money, needs keys)
npm run fixtures       # regenerate the synthetic etlaala-ksa dataset (a test checks it byte for byte)
npm run typecheck
```

The synthetic fixture (`fixtures/etlaala-ksa/`) has a bleeding ad set, platform over-attribution against CRM truth, competitor pages, and planted prompt injections. Every number in it is invented.

## Documentation

[`docs/SPEC.md`](docs/SPEC.md) is the product and technical specification; section 30 records what was built, milestone by milestone, including decisions and known limits.

## License

MIT. Copyright (c) 2026 Mohamed Omar.
