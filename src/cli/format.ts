import type { CheckStatus, DoctorReport } from "../doctor/checks.js";

const LABEL: Record<CheckStatus, string> = { pass: "PASS", warn: "WARN", fail: "FAIL", skip: "SKIP" };

export function formatDoctor(report: DoctorReport): string {
  const width = Math.max(...report.checks.map((c) => c.name.length));
  const lines = report.checks.flatMap((c) => [
    `${LABEL[c.status]}  ${c.name.padEnd(width)}  ${c.detail}`,
    ...(c.remedy && c.status !== "pass" ? [`      fix: ${c.remedy}`] : []),
  ]);
  const count = (s: CheckStatus) => report.checks.filter((c) => c.status === s).length;
  lines.push("", `${count("pass")} passed, ${count("warn")} warnings, ${count("fail")} failed, ${count("skip")} skipped`);
  return lines.join("\n");
}
