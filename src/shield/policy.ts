// shield.policy.yaml: spend limits, forbidden actions, rules, approvers, circuit-breaker settings.
// Approvers are identified by a hash or a reference, never by a raw phone number, and live here
// (not in workspace.yaml) so that changing who can approve is itself a policy-governed edit.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ENV_REF_PATTERN, isIsoCurrency, KEYCHAIN_REF_PATTERN } from "../constants.js";
import { findSecretLeaks } from "./secrets.js";

export const POLICY_FILE = "shield.policy.yaml";

/** Engine defaults for one agent run. A policy may lower these freely; raising them is audited. */
export const RUN_LIMIT_DEFAULTS = Object.freeze({ max_steps: 12, max_tokens: 150_000, max_cost_usd: 1 });

const Effect = z.enum(["allow", "deny", "ask"]);
export type Effect = z.infer<typeof Effect>;

export const Rule = z.object({ action: z.string().min(1), resource: z.string().min(1), effect: Effect }).strict();
export type Rule = z.infer<typeof Rule>;

const Sender = z.union([
  z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/, "64 lowercase hex characters") }).strict(),
  z.object({ env: z.string().regex(ENV_REF_PATTERN, "must be a MEDJAY_* variable name") }).strict(),
  z.object({ keychain_ref: z.string().regex(KEYCHAIN_REF_PATTERN) }).strict(),
]);

export const COMMANDS = ["strike", "hold", "cap", "query", "drop"] as const;

const Approver = z
  .object({
    name: z.string().min(1),
    sender: Sender,
    clients: z.array(z.string().min(1)).min(1).default(["*"]),
    can: z.array(z.enum(COMMANDS)).min(1),
  })
  .strict();

export const PolicySchema = z
  .object({
    defaults: z.object({ effect: Effect.default("ask") }).strict().prefault({}),
    limits: z
      .object({
        max_daily_budget_increase_pct: z.number().min(0).max(1000).default(20),
        max_daily_budget_decrease_pct: z.number().min(0).max(100).default(100),
        max_total_spend_cap: z
          .object({
            amount: z.number().positive(),
            currency: z.string().refine(isIsoCurrency, "not a known ISO 4217 currency code"),
            period: z.enum(["day", "week", "month"]),
            scope: z.literal("workspace"),
          })
          .strict()
          .optional(),
        max_new_campaign_daily_budget: z.number().positive().optional(),
      })
      .strict()
      .prefault({}),
    forbidden_actions: z.array(z.string().min(1)).default([]),
    require_two_step_if: z
      .object({
        daily_spend_delta_abs_gte: z.number().positive().optional(),
        irreversible: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    runtime_limits: z
      .object({
        max_steps: z.number().int().min(1).max(100).default(RUN_LIMIT_DEFAULTS.max_steps),
        max_tokens: z.number().int().min(1000).max(2_000_000).default(RUN_LIMIT_DEFAULTS.max_tokens),
        max_cost_usd: z.number().min(0.01).max(100).default(RUN_LIMIT_DEFAULTS.max_cost_usd),
      })
      .strict()
      .prefault({}),
    whatsapp: z.object({ approvers: z.array(Approver).default([]) }).strict().prefault({}),
    rules: z.array(Rule).default([]),
    circuit_breakers: z
      .object({
        grant: z.record(z.string(), z.unknown()).nullable().default(null),
        rules: z.array(z.record(z.string(), z.unknown())).default([]),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;

export class PolicyError extends Error {
  constructor(
    summary: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(
      issues.length === 0 ? summary : `${summary}\n${issues.map((i) => `  - ${i.path || "(root)"}: ${i.message}`).join("\n")}`,
    );
    this.name = "PolicyError";
  }
}

export interface RaisedLimit {
  key: keyof typeof RUN_LIMIT_DEFAULTS;
  default: number;
  configured: number;
}

/** The limits a run will use, and which of them the policy raised above the engine default. */
export function effectiveRunLimits(policy: Policy): { limits: Policy["runtime_limits"]; raised: RaisedLimit[] } {
  const keys = Object.keys(RUN_LIMIT_DEFAULTS) as (keyof typeof RUN_LIMIT_DEFAULTS)[];
  const raised = keys
    .filter((key) => policy.runtime_limits[key] > RUN_LIMIT_DEFAULTS[key])
    .map((key) => ({ key, default: RUN_LIMIT_DEFAULTS[key], configured: policy.runtime_limits[key] }));
  return { limits: policy.runtime_limits, raised };
}

const E164 = /^\+[1-9]\d{7,14}$/;

/** SHA-256 of an E.164 number, for the approvers list. The number itself never goes in a file. */
export function hashE164(number: string): string {
  if (!E164.test(number)) throw new Error(`expected an E.164 number such as +201000000000, got "${number}"`);
  return createHash("sha256").update(number, "utf8").digest("hex");
}

export async function loadPolicy(dir: string): Promise<Policy> {
  const file = join(dir, POLICY_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PolicyError(`${POLICY_FILE} not found in ${dir}`);
    throw error;
  }
  let raw: unknown;
  try {
    raw = parseYaml(text, { uniqueKeys: true });
  } catch (error) {
    throw new PolicyError(`${POLICY_FILE} is not valid YAML`, [
      { path: "", message: error instanceof Error ? error.message.split("\n")[0] ?? "parse error" : "parse error" },
    ]);
  }
  const leaks = findSecretLeaks(raw);
  if (leaks.length > 0) {
    throw new PolicyError(
      `${POLICY_FILE} contains secrets or personal data`,
      leaks.map((leak) => ({
        path: leak.path,
        message:
          leak.reason === "phone_number"
            ? "raw phone number; use { sha256: <hash from `mdj shield hash-number`> } or an env/keychain reference"
            : leak.reason === "key_name"
              ? "key name suggests a secret"
              : "value looks like an API key",
      })),
    );
  }
  const parsed = PolicySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new PolicyError(
      `${POLICY_FILE} is invalid`,
      parsed.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    );
  }
  return parsed.data;
}
