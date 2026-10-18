import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTactics, parseTacticFile, renderIndex, saveTactic, serializeTactic } from "./files.js";
import { TacticSchema, type ExperimentInput, type ResultInput, type Tactic } from "./schema.js";
import { conclude, hypothesize, retire, TacticError } from "./state.js";

const tactic = (over: Record<string, unknown> = {}): Tactic =>
  TacticSchema.parse({
    id: "TACTIC-MENA-019",
    title: "Sticky WhatsApp concierge + BNPL badge on mobile hero",
    pillars: [4, 5, 6],
    jobs: ["experiment", "draft"],
    source: { kind: "practitioner", ref: "https://example.com/post", date: "2026-09-02" },
    state: "unverified",
    tags: { markets: ["KSA", "GCC"], verticals: ["travel"], languages: ["ar"] },
    ...over,
  });

const experiment = (over: Record<string, unknown> = {}): ExperimentInput => ({
  id: "EXP-088",
  hypothesis: "Sticky CTA raises lead-to-qualified-chat by at least 15%",
  metric: "lead_to_qualified_chat_rate",
  baseline: { value: 0.21, range: "2026-09-19..2026-10-16", snapshot_id: "snap_88" },
  design: { type: "before_after", min_sample: 200, duration_days: 14, min_effect: 0.15 },
  ...over,
});

const result = (over: Record<string, unknown> = {}): ResultInput => ({
  confidence: 0.94,
  method: "bayesian",
  sample_size: 312,
  date_range: "2026-10-18..2026-11-01",
  effect: 0.31,
  outcome_source: "crm",
  grading: "outcome",
  caveats: ["Ramadan overlap"],
  ...over,
});

describe("the schema keeps the log honest", () => {
  it("refuses a validated or invalidated tactic that carries no result", () => {
    expect(() => tactic({ state: "validated" })).toThrow(/no tactic is validated without data/);
    expect(() => tactic({ state: "invalidated", experiment: experiment() })).toThrow(/must carry its result/);
  });
  it("refuses a hypothesized tactic with no complete experiment, and an unverified one that already has a result", () => {
    expect(() => tactic({ state: "hypothesized" })).toThrow(/pre-registered experiment/);
    expect(() => tactic({ state: "hypothesized", experiment: experiment({ baseline: undefined }) })).toThrow();
    expect(() => tactic({ result: result() })).toThrow(/no result/);
  });
  it("refuses an experiment without a minimum sample, a duration or a minimum effect", () => {
    for (const missing of ["min_sample", "duration_days", "min_effect"]) {
      const design = { type: "ab", min_sample: 200, duration_days: 14, min_effect: 0.15 } as Record<string, unknown>;
      delete design[missing];
      expect(() => tactic({ state: "hypothesized", experiment: experiment({ design }) }), missing).toThrow();
    }
  });
  it("rejects unknown keys and bad ids", () => {
    expect(() => tactic({ colour: "red" })).toThrow();
    expect(() => tactic({ id: "../etc/passwd" })).toThrow();
  });
});

describe("unverified -> hypothesized", () => {
  it("binds an experiment id and returns a new tactic without touching the old one", () => {
    const before = tactic();
    const after = hypothesize(before, experiment());
    expect(after).toMatchObject({ state: "hypothesized", experiment: { id: "EXP-088" } });
    expect(before.state).toBe("unverified");
  });
  it("refuses a tactic that is not unverified and an incomplete experiment, saying what is missing", () => {
    const hyp = hypothesize(tactic(), experiment());
    expect(() => hypothesize(hyp, experiment())).toThrow(/only an unverified tactic/);
    expect(() => hypothesize(tactic(), experiment({ baseline: { value: 0.2, range: "bad", snapshot_id: "s" } }))).toThrow(TacticError);
    expect(() => hypothesize(tactic(), experiment({ design: { type: "ab", min_sample: 0, duration_days: 14, min_effect: 0.1 } }))).toThrow(/min_sample/);
    expect(() => hypothesize(tactic(), experiment({ baseline: { value: 0.2, range: "2026-10-16..2026-09-19", snapshot_id: "snap_1" } }))).toThrow(/not a valid range/);
  });
});

describe("hypothesized -> validated | invalidated", () => {
  const hyp = () => hypothesize(tactic(), experiment());

  it("validates a big enough, long enough test with decisive confidence, and keeps the evidence", () => {
    const r = conclude(hyp(), result());
    expect(r.outcome).toBe("validated");
    expect(r.tactic).toMatchObject({ state: "validated", result: { effect: 0.31, sample_size: 312, caveats: ["Ramadan overlap"] } });
    expect(r.tactic.experiment!.id).toBe("EXP-088");
  });

  it("invalidates when it is decisively below the minimum effect", () => {
    const r = conclude(hyp(), result({ confidence: 0.05, effect: 0.02 }));
    expect(r.outcome).toBe("invalidated");
    expect(r.tactic.state).toBe("invalidated");
  });

  it("never promotes an underpowered test: small sample or too short stays hypothesized as a directional reading", () => {
    const small = conclude(hyp(), result({ sample_size: 80 }));
    expect(small).toMatchObject({ outcome: "directional", tactic: { state: "hypothesized" } });
    expect((small as { reason: string }).reason).toMatch(/sample 80 is below the pre-registered 200/);
    expect(small.tactic.experiment!.interim).toHaveLength(1);
    const short = conclude(hyp(), result({ date_range: "2026-10-18..2026-10-24" }));
    expect(short.outcome).toBe("directional");
    expect((short as { reason: string }).reason).toMatch(/7 day\(s\) is shorter than the pre-registered 14/);
  });

  it("keeps an inconclusive reading in the grey zone as interim, and a later decisive one can still conclude", () => {
    const grey = conclude(hyp(), result({ confidence: 0.6 }));
    expect(grey).toMatchObject({ outcome: "inconclusive", tactic: { state: "hypothesized" } });
    const later = conclude(grey.tactic, result({ confidence: 0.95, sample_size: 500 }));
    expect(later.outcome).toBe("validated");
    expect(later.tactic.experiment!.interim).toHaveLength(1);
  });

  it("insists grading is proxy exactly when the data came from the platform", () => {
    expect(() => conclude(hyp(), result({ outcome_source: "platform_proxy", grading: "outcome" }))).toThrow(/grading must be "proxy"/);
    expect(() => conclude(hyp(), result({ outcome_source: "crm", grading: "proxy" }))).toThrow(/grading must be "proxy"/);
    const proxy = conclude(hyp(), result({ outcome_source: "platform_proxy", grading: "proxy" }));
    expect(proxy.tactic.result!.grading).toBe("proxy");
  });

  it("refuses an incomplete result and a tactic that is not hypothesized", () => {
    expect(() => conclude(hyp(), { confidence: 0.9 } as never)).toThrow(/result for TACTIC-MENA-019 is incomplete/);
    expect(() => conclude(tactic(), result())).toThrow(/only a hypothesized tactic/);
    const validated = conclude(hyp(), result()).tactic;
    expect(() => conclude(validated, result())).toThrow(/only a hypothesized tactic/);
  });
});

describe("validated -> retired", () => {
  it("retires a validated tactic, keeps its result, and nothing else can be retired", () => {
    const validated = conclude(hypothesize(tactic(), experiment()), result()).tactic;
    const retired = retire(validated, "Ramadan only", "2026-11-20");
    expect(retired).toMatchObject({ state: "retired", retired: { reason: "Ramadan only", date: "2026-11-20" }, result: { effect: 0.31 } });
    expect(() => retire(tactic(), "x", "2026-11-20")).toThrow(/only a validated tactic/);
    expect(() => retire(retired, "x", "2026-11-20")).toThrow(/only a validated tactic/);
    const invalidated = conclude(hypothesize(tactic(), experiment()), result({ confidence: 0.02, effect: 0 })).tactic;
    expect(() => retire(invalidated, "x", "2026-11-20")).toThrow(/only a validated tactic/);
  });
});

describe("files", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "medjay-tactics-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips frontmatter and keeps the playbook text", () => {
    const t = conclude(hypothesize(tactic(), experiment()), result()).tactic;
    const text = serializeTactic(t, "# Playbook\n\nPut the badge above the fold.\n");
    const back = parseTacticFile(text);
    expect(back.tactic).toEqual(t);
    expect(back.body).toContain("Put the badge above the fold.");
  });

  it("saves atomically under tactics/<id>.md and loads everything back", async () => {
    await saveTactic(dir, tactic(), "# one\n");
    await saveTactic(dir, tactic({ id: "TACTIC-MENA-020", title: "Second" }), "");
    const { tactics, problems } = await loadTactics(dir);
    expect(problems).toEqual([]);
    expect(tactics.map((t) => t.tactic.id)).toEqual(["TACTIC-MENA-019", "TACTIC-MENA-020"]);
  });

  it("reports a broken file, a mismatched file name and a duplicate id, without rewriting any of them", async () => {
    await mkdir(join(dir, "tactics"), { recursive: true });
    await writeFile(join(dir, "tactics", "broken.md"), "no frontmatter here", "utf8");
    await writeFile(join(dir, "tactics", "lying.md"), serializeTactic(tactic(), ""), "utf8");
    await writeFile(join(dir, "tactics", "TACTIC-MENA-019.md"), serializeTactic(tactic(), ""), "utf8");
    await writeFile(join(dir, "tactics", "validated-no-data.md"), `---\n${serializeTactic(tactic(), "").split("---")[1]!.replace("state: unverified", "state: validated")}---\n`, "utf8");
    const { tactics, problems } = await loadTactics(dir);
    expect(tactics.map((t) => t.file)).toEqual(["TACTIC-MENA-019.md"]);
    expect(problems.map((p) => p.file).sort()).toEqual(["broken.md", "lying.md", "validated-no-data.md"]);
    expect(problems.find((p) => p.file === "lying.md")!.message).toMatch(/name it TACTIC-MENA-019.md/);
    expect(problems.find((p) => p.file === "validated-no-data.md")!.message).toMatch(/without data/);
    expect(await readFile(join(dir, "tactics", "broken.md"), "utf8")).toBe("no frontmatter here");
  });

  it("returns an empty log when there is no tactics folder", async () => {
    expect(await loadTactics(dir)).toEqual({ tactics: [], problems: [] });
  });

  it("renders an index grouped by state, with invalidated ideas marked do-not-propose", () => {
    const validated = conclude(hypothesize(tactic(), experiment()), result()).tactic;
    const bad = conclude(hypothesize(tactic({ id: "TACTIC-X-001", title: "Bad idea" }), experiment({ id: "EXP-1" })), result({ confidence: 0.02, effect: 0 })).tactic;
    const index = renderIndex([validated, bad, tactic({ id: "TACTIC-Y-002", title: "Fresh | pipe" })]);
    expect(index).toMatch(/## Validated \(1\)/);
    expect(index).toMatch(/## Invalidated \(do not propose again\) \(1\)/);
    expect(index).toMatch(/\| TACTIC-MENA-019 \| .* \| effect 31%, confidence 0.94, n=312, crm \|/);
    expect(index).toContain("Fresh / pipe");
    expect(index).toMatch(/^<!-- generated/);
  });
});
