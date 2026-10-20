// The stream `mdj run --events` writes, one JSON object per line. The runtime emits these, the CLI
// encodes them, and the terminal app parses them to show the agent's work as it happens. It lives at
// the top of src (a "shared" file) because the runtime and the app may not import each other.
//
// Nothing secret travels here: step text is already redacted, tool input appears only as a short hash,
// and tool output appears only as a short card summary.
import { z } from "zod";

const Tokens = z.object({ input: z.number(), output: z.number() });

export const RunEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.started"), run_id: z.string(), slot: z.string() }),
  z.object({ type: z.literal("step.started"), step: z.number().int(), max_steps: z.number().int() }),
  z.object({ type: z.literal("step.text"), step: z.number().int(), text: z.string() }),
  z.object({ type: z.literal("tool.started"), step: z.number().int(), call_id: z.string(), name: z.string(), class: z.string(), input_hash: z.string() }),
  z.object({
    type: z.literal("tool.finished"),
    step: z.number().int(),
    call_id: z.string(),
    name: z.string(),
    ok: z.boolean(),
    label: z.string(),
    summary: z.string(),
    error_kind: z.string().optional(),
  }),
  z.object({
    type: z.literal("run.finished"),
    status: z.string(),
    steps: z.number().int(),
    tokens: Tokens,
    cost_usd: z.number(),
    cost_known: z.boolean(),
    final_text: z.string(),
    proposals: z.number().int(),
    pending: z.object({ call_id: z.string(), tool: z.string() }).optional(),
    error: z.object({ kind: z.string(), message: z.string() }).optional(),
  }),
]);

export type RunEvent = z.infer<typeof RunEventSchema>;

/** One event as one line (JSON never contains a raw newline), ending in a newline. */
export const encodeEvent = (event: RunEvent): string => `${JSON.stringify(event)}\n`;

/** The event on a line, or null when the line is not a valid event. Never throws. */
export function parseEventLine(line: string): RunEvent | null {
  const text = line.trim();
  if (text === "") return null;
  try {
    const parsed = RunEventSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
