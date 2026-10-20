import { describe, expect, it } from "vitest";
import { encodeEvent, parseEventLine, type RunEvent } from "./run-events.js";

const finished: RunEvent = {
  type: "run.finished",
  status: "completed",
  steps: 2,
  tokens: { input: 100, output: 20 },
  cost_usd: 0.0014,
  cost_known: true,
  final_text: "Line one\nLine two",
  proposals: 0,
};

describe("run events", () => {
  it("encodes one event as one line, even when the text has newlines", () => {
    const line = encodeEvent(finished);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(parseEventLine(line)).toEqual(finished);
  });

  it("round-trips every event type", () => {
    const events: RunEvent[] = [
      { type: "run.started", run_id: "run_ab12", slot: "reasoning" },
      { type: "step.started", step: 1, max_steps: 12 },
      { type: "step.text", step: 1, text: "Reading the CSV." },
      { type: "tool.started", step: 1, call_id: "c1_1", name: "read_file", class: "read", input_hash: "abc123def456" },
      { type: "tool.finished", step: 1, call_id: "c1_1", name: "read_file", ok: true, label: "Read file", summary: "context/claims.md" },
      { type: "tool.finished", step: 1, call_id: "c1_2", name: "read_file", ok: false, label: "Read file", summary: "not found", error_kind: "failed" },
      finished,
    ];
    for (const e of events) expect(parseEventLine(encodeEvent(e))).toEqual(e);
  });

  it("returns null, without throwing, for anything that is not a valid event", () => {
    expect(parseEventLine("")).toBeNull();
    expect(parseEventLine("not json")).toBeNull();
    expect(parseEventLine('{"type":"nope"}')).toBeNull();
    expect(parseEventLine('{"type":"step.started","step":"one","max_steps":12}')).toBeNull();
    expect(parseEventLine("[1,2,3]")).toBeNull();
  });

  it("ignores unknown extra fields so a newer CLI does not break an older TUI", () => {
    const line = JSON.stringify({ type: "step.started", step: 3, max_steps: 12, future_field: true });
    expect(parseEventLine(line)).toEqual({ type: "step.started", step: 3, max_steps: 12 });
  });
});
