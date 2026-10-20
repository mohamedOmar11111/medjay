// Turns the text of a failed `mdj run` into a specific reason, so the TUI can say what is actually
// wrong (no key, rejected key, spend cap, network...) instead of one catch-all message.
export type ModelFailureKind = "no_key" | "key_malformed" | "key_rejected" | "quota" | "model_not_found" | "network" | "other";

export interface ModelFailure {
  kind: ModelFailureKind;
  provider?: string;
  detail: string;
}

const PROVIDER = /\b(anthropic|google|openai_compatible|openai|ollama)\//;
// Order matters: a malformed key surfaces as "Cannot connect to API: invalid x-api-key header".
const RULES: Array<[ModelFailureKind, RegExp]> = [
  ["no_key", /no API key for/i],
  ["key_malformed", /invalid (x-api-key|authorization|api[- ]key) header|illegal header|invalid header value/i],
  ["quota", /usage limits?|credit balance|exceeded your current quota|insufficient (quota|funds|credit)|billing/i],
  ["key_rejected", /invalid api key|incorrect api key|invalid x-api-key|authentication[_ ]error|\b401\b|unauthorized/i],
  ["model_not_found", /model[^.\n]{0,60}(does not exist|not found)|not_found_error|model_not_found/i],
  ["network", /cannot connect|fetch failed|ECONN|ENOTFOUND|EHOSTUNREACH|timed? ?out|timeout/i],
];
const FAILURE_SHAPE = /all model targets failed|^failed:|\bauth:|\bconnection:/im;

export function classifyModelFailure(text: string): ModelFailure | null {
  if (!FAILURE_SHAPE.test(text)) return null;
  const provider = PROVIDER.exec(text)?.[1];
  const line = text.split("\n").find((l) => /failed|auth:|connection:/i.test(l)) ?? text;
  const detail = line.replace(/\s+/g, " ").trim().slice(0, 240);
  const found = RULES.find(([, re]) => re.test(text));
  return { kind: found ? found[0] : "other", ...(provider ? { provider } : {}), detail };
}
