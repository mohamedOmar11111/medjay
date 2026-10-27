import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stringify as toYaml } from "yaml";
import { Ledger } from "../audit/ledger.js";
import { parseModelRef, type SlotName } from "../models/slots.js";
import { DEFAULT_PILLARS, type BusinessType } from "../pillars/catalog.js";
import { VERSION } from "../version.js";
import { WORKSPACE_FILE } from "./errors.js";
import { SCHEMA_VERSION, WorkspaceSchema } from "./schema.js";

export interface InitOptions {
  dir: string;
  id: string;
  name?: string;
  businessType: BusinessType;
  timezone?: string;
  baseCurrency?: string;
  primaryLanguage?: string;
  /** "provider/model" per slot; unspecified slots get the defaults below. */
  models?: Partial<Record<SlotName, string>>;
}

const DEFAULT_MODELS: Record<SlotName, string> = {
  fast: "anthropic/claude-sonnet-5-5", // a local model is opt-in (--fast ollama/<model>), not a default a newcomer must have
  reasoning: "anthropic/claude-sonnet-5-5",
  creative: "anthropic/claude-sonnet-5-5",
};

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

const rate = (note: string) => ({ value: null, low: null, high: null, source: "", note });

export function contextFiles(id: string): Record<string, string> {
  const unitEconomics = {
    currency: "USD",
    cpc: rate("cost per click"),
    landing_page_cvr: rate("landing page conversion rate to lead or chat"),
    lead_to_chat: rate("lead to qualified conversation"),
    chat_to_qualified: rate("conversation to qualified opportunity"),
    qualified_to_deal: rate("qualified opportunity to closed deal"),
    average_deal_value: rate("revenue per deal"),
    gross_margin: rate("gross margin as a fraction, e.g. 0.35"),
  };
  return {
    "context/brand-voice.md": `---\nworkspace: ${id}\nlanguages: []\ndialects: []\nforbidden_phrases: []\n---\n# Brand voice\n\nTone, vocabulary, forbidden phrases, and dialect rules (Khaleeji, Egyptian, MSA, English).\nArabic copy is marked needs-native-review until a human reviewer approves it.\n\nforbidden_phrases (frontmatter) are checked by \`mdj slop check\`. Each entry is a phrase or { phrase, suggestion }.\n`,
    "context/claims.md": `---\nclaims: []\n---\n# Claim register\n\nEvery public number (a percentage, a multiplier, an amount of money) must be a verified claim here\nbefore customer-facing copy that uses it can pass \`mdj slop check\`. Add one entry per claim:\n\n    - id: CLM-001\n      values: ["+31%"]          # every spelling you will use\n      text: Lift in qualified chats\n      source: EXP-088           # where the number comes from\n      date: 2026-10-01\n      status: verified          # or pending: pending claims cannot be published\n\nMove the entries into the \`claims:\` list in the frontmatter above.\n`,
    "context/unit-economics.md": `---\n${toYaml(unitEconomics).trimEnd()}\n---\n# Unit economics\n\nFill the ranges above (value, low, high, source) before running \`mdj simulate\`.\nSimulations refuse to give a point estimate when inputs have no ranges.\nIf you report in several currencies, add dated FX rates here; Medjay never converts silently.\n`,
    "context/offer-matrix.md": `---\nworkspace: ${id}\n---\n# Offers\n\nPackages, price tiers, payment options (for example BNPL), guarantees.\n`,
    "context/seasonal-calendar.md": `---\nworkspace: ${id}\n---\n# Seasonal calendar\n\nRamadan, Eid, national days, summer and other demand windows for this market.\n`,
  };
}

const POLICY = {
  defaults: { effect: "ask" },
  limits: {
    max_daily_budget_increase_pct: 20,
    max_daily_budget_decrease_pct: 100,
    max_total_spend_cap: { amount: 1000, currency: "USD", period: "day", scope: "workspace" },
    max_new_campaign_daily_budget: 50,
    max_posts_per_day: 5,
  },
  forbidden_actions: [
    "delete_campaign",
    "change_billing",
    "change_payment_method",
    "send_message_to_customers",
    "increase_budget_without_plan",
  ],
  require_two_step_if: { daily_spend_delta_abs_gte: 500, irreversible: true },
  runtime_limits: { max_steps: 12, max_tokens: 150000, max_cost_usd: 1 },
  whatsapp: { approvers: [] },
  rules: [
    // Agent tools that cannot change anything. Writes always go through a plan, which needs approval.
    { action: "read.*", resource: "*", effect: "allow" },
    { action: "draft.*", resource: "*", effect: "allow" },
    { action: "propose.*", resource: "*", effect: "allow" },
    // Changing a context file is the one thing an agent can ask to do to a workspace: a person decides each time.
    { action: "context.*", resource: "*", effect: "ask" },
    { action: "plan.strike", resource: "*", effect: "ask" },
  ],
  circuit_breakers: { grant: null, rules: [] },
};

const POLICY_HEADER = `# Shield policy: spend caps, limits, forbidden actions, approvers, circuit breakers.
# Approvers live here (not in workspace.yaml) so edits are policy-governed and audited.
# Identify a sender without storing the raw phone number, by SHA-256 of the E.164 number
# (sha256: "<64 hex>") or by reference (env: MEDJAY_OWNER_NUMBER, or keychain_ref: owner_number).
# Voice notes can read and draft but can never strike: that rule is engine code, not config.
# runtime_limits cap one agent run. Lowering a cap is free; raising one above the engine default
# (12 steps, 150000 tokens, 1 USD) is recorded in the ledger every time a run starts.
`;

export async function initWorkspace(options: InitOptions): Promise<{ dir: string; files: string[] }> {
  const dir = resolve(options.dir);
  if (await exists(join(dir, WORKSPACE_FILE))) {
    throw new Error(`a workspace already exists at ${dir}; refusing to overwrite`);
  }

  const refs = { ...DEFAULT_MODELS, ...options.models };
  const target = (slot: SlotName) => ({ primary: parseModelRef(refs[slot]) });
  const config = WorkspaceSchema.parse({
    schema_version: SCHEMA_VERSION,
    workspace: {
      id: options.id,
      name: options.name ?? options.id,
      business_type: options.businessType,
      timezone: options.timezone ?? "UTC",
      base_currency: options.baseCurrency ?? "USD",
    },
    localization: { languages: { primary: options.primaryLanguage ?? "en" } },
    models: { slots: { fast: target("fast"), reasoning: target("reasoning"), creative: target("creative") } },
    pillars: { active: DEFAULT_PILLARS[options.businessType] },
  });

  const written: string[] = [];
  const write = async (rel: string, text: string) => {
    const path = join(dir, rel);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, text, "utf8");
    written.push(rel);
  };

  await write(
    WORKSPACE_FILE,
    `# Medjay workspace, schema ${SCHEMA_VERSION}.\n# Never put API keys or phone numbers here: use \`mdj auth set <ref>\` (OS keychain) or MEDJAY_* environment variables.\n${toYaml(config)}`,
  );
  await write("shield.policy.yaml", `${POLICY_HEADER}${toYaml(POLICY)}`);
  for (const [rel, text] of Object.entries(contextFiles(options.id))) await write(rel, text);
  for (const keep of ["tactics/.gitkeep", "data/imports/.gitkeep", "plans/.gitkeep"]) await write(keep, "");
  await write(".gitignore", ".medjay/experiments.db*\n.medjay/gateway/\n");

  await mkdir(join(dir, ".medjay"), { recursive: true });
  await new Ledger(join(dir, ".medjay", "audit-log.jsonl")).append({
    actor: "system",
    event: "workspace.created",
    payload: { workspace: options.id, business_type: options.businessType, medjay_version: VERSION, schema_version: SCHEMA_VERSION },
  });
  written.push(".medjay/audit-log.jsonl");

  return { dir, files: written };
}
