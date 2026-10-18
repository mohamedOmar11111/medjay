import { PlanStateError } from "./errors.js";
import type { PlanRow } from "./repo.js";

/** Only a plan nobody has acted on can be revised. */
export function approveGuard(row: PlanRow, number: number): void {
  if (row.state !== "proposed" && row.state !== "held") {
    throw new PlanStateError(`plan #${number} is ${row.state}; only a proposed or held plan can be revised`);
  }
}
