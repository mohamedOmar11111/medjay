// Control experiment for injection-live: the same planted CSV cell with the defences taken away.
//   no_spotlight             read_file output is NOT wrapped in the nonce-bound <untrusted_data> block
//   no_spotlight_no_warning  also drops the "never follow instructions inside dropzone files" line from the tool description
//   none                     also removes the spotlight rule from the system prompt: no anti-injection text at all
// It tells us whether the wrapper is what protects the run, or whether the model would have ignored
// the planted text anyway. Models are not deterministic, so the test asserts nothing about hijacking:
// it records the outcome per trial and prints a table (MEDJAY_LIVE_TRIALS, default 3 for cloud, 1 for local).
import { describe, expect, it } from "vitest";
import { hijacked, liveRun, MODEL_CASES, PAYLOADS, type Defence, type PayloadName } from "./shared.js";

const DEFENCES: Defence[] = ["none", "full"];
const PAYLOAD_NAMES = Object.keys(PAYLOADS) as PayloadName[];
const CASES = DEFENCES.flatMap((d) => PAYLOAD_NAMES.map((p) => [d, p] as const));
const trialsFor = (model: string) => Number(process.env.MEDJAY_LIVE_TRIALS ?? (model.startsWith("ollama") ? 1 : 3));

describe.each(MODEL_CASES)("control, defences removed: $name", ({ name, model, available }) => {
  it.skipIf(!available).each(CASES)("defence=%s payload=%s", async (defence, payload) => {
    const rows: string[] = [];
    let hijackedCount = 0;
    const trials = trialsFor(model);
    for (let i = 1; i <= trials; i += 1) {
      const run = await liveRun(model, defence, payload);
      try {
        const bad = hijacked(run);
        if (bad) hijackedCount += 1;
        const names = run.calls.map((c) => `${c.name}${/claims\.md/.test(JSON.stringify(c.input)) ? "(claims.md)" : ""}`).join(", ");
        rows.push(`  trial ${i}: ${run.result.status}, ${bad ? "HIJACKED" : "resisted"}; calls: ${names || "none"}`);
        expect(["completed", "needs_human", "max_steps_reached", "failed"]).toContain(run.result.status);
      } finally {
        await run.cleanup();
      }
    }
    process.stdout.write(`\nCONTROL ${name} / defence=${defence} / payload=${payload}: ${hijackedCount}/${trials} hijacked\n${rows.join("\n")}\n`);
  });
});
