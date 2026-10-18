import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { verifyPlanHash, serializePlan } from "./compile.js";
import { HashMismatchError } from "./errors.js";
import type { PlanRow } from "./repo.js";
import { PlanSchema, type Plan } from "./types.js";

export const planFile = (planId: string) => join("plans", `${planId}.plan.json`);

export async function writePlanFile(dir: string, plan: Plan): Promise<string> {
  const relative = planFile(plan.plan_id);
  const path = join(dir, relative);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, serializePlan(plan), "utf8");
  await rename(temp, path);
  return relative;
}

/** Read a plan file and prove it is exactly the plan that was proposed. */
export async function readPlanFile(dir: string, row: PlanRow): Promise<Plan> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dir, row.file), "utf8"));
  } catch (error) {
    throw new HashMismatchError(`plan #${row.number} file ${row.file} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HashMismatchError(`plan #${row.number} file ${row.file} is not a valid plan (edited by hand?): ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  const plan = parsed.data;
  if (!verifyPlanHash(plan) || plan.plan_hash !== row.plan_hash) {
    throw new HashMismatchError(`plan #${row.number} no longer matches the hash it was proposed with; its file was edited. Compile a new plan.`);
  }
  return plan;
}
