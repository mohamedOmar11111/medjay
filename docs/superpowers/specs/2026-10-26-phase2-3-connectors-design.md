# Phases 2 and 3: live connectors, then acting through plans (design)

Date: 2026-10-26. Status: direction approved by Omar (priority order below); details here are the proposal to
review before Phase 2 starts. Phase 1 (guide, suggest, act) comes first because connecting an account is
itself a guided flow.

## Why MCP

Omar already runs MCP servers for Google Ads, Meta Ads, WordPress and Supermetrics. MCP is the one interface
that lets Medjay reach all of them without writing and maintaining a client for every ad platform's API.
Medjay becomes an **MCP client**; the user (or a preset) says which servers a workspace may use.

Dependency: `@modelcontextprotocol/sdk` (MIT, 1.32.2 on npm at the time of writing). Before adding it, a
spike must confirm it runs on Node 22.13+ under ESM on Windows, supports both stdio and streamable HTTP, and adds
an acceptable install size (the unpacked package is about 4.5 MB). If it fails the spike, fall back to a small
client over the same JSON-RPC messages.

Priority order (Omar, 2026-10-26): (1) Google Ads, then GA4 and Search Console; (2) WordPress; (3) Meta Ads and
Respond.io.

## Phase 2: read-only connectors

### Rules that do not bend

- **Read only.** Phase 2 can never call a tool that changes anything on a platform, even if the server offers one
  (`update_campaign_budget`, `create_campaign`, `send_message` ...). Each connector has an explicit allowlist of
  tool names; anything not on it is not callable and not shown to the model.
- **Nothing is installed or started silently.** A stdio server is a program on the person's computer. Adding one
  shows the exact command and arguments and asks for a typed yes. Medjay never downloads or installs a server.
- **Credentials only in the keychain.** The connector config holds credential names, never values (same as model
  keys). Environment passed to a server process is an explicit list, not the whole environment.
- **Server output is untrusted text.** It goes through the same spotlighting, redaction and size caps as other
  tool results, and cannot instruct the agent.
- **One workspace, one client.** A connector belongs to a workspace and can only read the accounts that workspace
  lists (`accounts:`). A mismatch is refused, not warned.
- **Everything is logged** to the ledger: connector name, tool, argument fingerprint, byte count, timing.

### Config (in `workspace.yaml`, validated)

```yaml
connectors:
  - name: google-ads
    transport: { type: stdio, command: "...", args: ["..."] }   # or { type: http, url: "https://..." }
    credentials: [google-ads-token]          # keychain names
    accounts: ["123-456-7890"]               # the only accounts this workspace may read
    allow_tools: [execute_gaql, list_accessible_accounts]
    sync: { into: data/imports, every: manual }
```

### Two ways the data is used

1. **Sync to the dropzone.** `mdj connect sync google-ads` calls the allowlisted read tools, writes the results as
   normal import files (with the source, account, time and tool recorded next to each), and the existing
   ingest, mapping, scout and diagnose run on them unchanged. This keeps calibration, the CRM truth check, the
   data fingerprint and every analysis exactly as they are, and a live pull is reproducible from its saved files.
2. **Ask on demand.** The allowlisted tools are also registered for the agent as `mcp_<server>_<tool>`
   (class `read`), for questions the saved data cannot answer. Results are not ingested unless the person syncs.

### Guided connect

`/connect` (TUI) and `mdj connect add <preset>`: choose a source, see what it will read and what it will never do,
confirm the command, store credentials in the keychain, run a test read, and show the first result. Presets are
data files (`src/connectors/presets/*.json`), each stating the server, the exact allowlist, and what was verified.
A preset is only listed as "tested" after a real run against a real account; otherwise it is labelled "untested".

### Verification and honesty

Offline: a fake MCP server (stdio and HTTP) in the test suite proves the allowlist, the account limit, the
credential handling, output caps, the ledger entries, and that a write tool is unreachable by every path.
Live: each preset is run once against Omar's real account and reported as it is. Servers Medjay has not run
against are never described as supported.

## Phase 3: acting through plans

Nothing in Phase 3 bypasses the Shield. A connector never acts because the agent asked; it acts only when an
**approved plan** is struck.

- **Executors** are configured per action type and are off by default. Example: `executors: { publish_post:
  wordpress, add_negative_keyword: google-ads }`.
- **Strike with a live executor** (a) re-checks the policy and the approval hash, (b) reads the live state and
  refuses if it no longer matches what the plan assumed (the precondition), (c) performs only the allowlisted write
  tool for that action type, (d) reads back and records the result, (e) writes the inverse so `rollback` works
  where the platform allows it. Where it cannot be undone (a published post), the plan was already two-step.
- **Order of enablement**, lowest risk first: WordPress post as `draft`; negative keywords; pausing a campaign;
  budget changes (gated by the simulation and the percentage limits); publish; anything that sends a message to
  customers last and only with its own caps.
- Daily post cap and every limit in `shield.policy.yaml` apply to live execution exactly as to export files.
- Export-file mode stays available for every action, so a person can always apply a plan by hand.

## Risks

- MCP servers differ in quality and safety; Medjay can enforce its own allowlist and caps but cannot make a
  third-party server correct. Presets say what was tested.
- Platform API quotas and auth expiry (Google Ads developer token, Meta token lifetime) will cause failures that
  must show as clear, specific messages with the one thing to do.
- A stdio server inherits the user's machine. The typed confirmation and the explicit environment list reduce the
  risk but do not remove it; this is stated in the connect screen.
