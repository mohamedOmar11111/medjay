// suggest_next: how the agent offers the owner up to three next steps, to pick by typing 1, 2 or 3. It does
// nothing itself: the run records the validated list and the terminal app shows it. Chosen over reading
// numbered lines out of the answer text because prose differs from model to model.
//
// Text is limited to printable characters so a label can never move the cursor, ring the bell or fake a line.
import { z } from "zod";
import { defineTool, type ToolDef } from "../registry.js";

export const MAX_SUGGESTIONS = 3;
export const MAX_LABEL = 80;
export const MAX_PROMPT = 300;

// no C0/C1 controls, DEL, or the Unicode line and paragraph separators
const PRINTABLE = /^[^\u0000-\u001f\u007f-\u009f\u2028\u2029]+$/;
const text = (max: number) => z.string().trim().min(1).max(max).regex(PRINTABLE, "must be one line of printable text");

export const SuggestionSchema = z.object({ label: text(MAX_LABEL), prompt: text(MAX_PROMPT) }).strict();
export type NextSuggestion = z.infer<typeof SuggestionSchema>;

export const suggestNextTool = defineTool({
  name: "suggest_next",
  description:
    "End your answer by offering the owner up to three concrete next steps, as a mix of work you can do now with what you have and the one thing that would unlock more. Each has a short label the owner reads (up to 80 characters) and the full request you would act on if they pick it (up to 300 characters, written as the owner would say it). Plain text on one line, no formatting. Write your whole answer in the same turn and call this at the same time: calling it ends your turn, so anything you want the owner to read must already be written. It changes nothing.",
  class: "read",
  input: z.object({ actions: z.array(SuggestionSchema).min(1).max(MAX_SUGGESTIONS) }).strict(),
  execute: async ({ actions }) => ({ actions }),
  trustOf: () => "trusted",
}) as unknown as ToolDef;
