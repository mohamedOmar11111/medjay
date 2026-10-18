// The command grammar. A command is the WHOLE message: embedded or chained text ("please STRIKE 4
// ..." or "STRIKE 4 x; DROP 5") is unknown, so a command can never be smuggled inside other text.
import type { COMMANDS } from "../shield/policy.js";
import { canVoiceTrigger } from "../shield/invariants.js";

export type Permission = (typeof COMMANDS)[number];

export type Command =
  | { kind: "status" | "pulse" | "scout" | "diagnose" | "help" | "pause_all" | "resume" }
  | { kind: "simulate" | "hold" | "drop"; plan: number }
  | { kind: "strike"; plan: number; hash: string; code?: string }
  | { kind: "strike_incomplete"; plan: number }
  | { kind: "cap_unsupported" }
  | { kind: "unknown" };

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const ascii = (t: string) => t.replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d)));

/** Arabic matching key: no diacritics or tatweel, one alef, single spaces. */
const arabicKey = (t: string) =>
  t
    .normalize("NFKC")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/\s+/g, " ")
    .trim();

/** Read and status aliases only. Approvals (STRIKE) have none: they are typed in ASCII. */
const ARABIC_ALIASES: Record<string, Command> = {
  [arabicKey("حالة")]: { kind: "status" },
  [arabicKey("نبض")]: { kind: "pulse" },
  [arabicKey("فحص")]: { kind: "scout" },
  [arabicKey("تشخيص")]: { kind: "diagnose" },
  [arabicKey("إيقاف الكل")]: { kind: "pause_all" },
};

const PLAN = String.raw`#?(\d{1,6})`;
const STRIKE = new RegExp(String.raw`^STRIKE\s+${PLAN}\s+([0-9A-F]{8,64})(?:\s+(\d{6}))?$`, "i");
const STRIKE_PARTIAL = new RegExp(String.raw`^STRIKE\s+${PLAN}(?:\s+[0-9A-F]{0,7})?$`, "i");
const HOLD_DROP = new RegExp(String.raw`^(HOLD|DROP)\s+${PLAN}$`, "i");
const SIMULATE = new RegExp(String.raw`^SIMULATE\s+${PLAN}$`, "i");
const CAP = /^CAP\s/i;

export function parseCommand(raw: string): Command {
  // Approval verbs are matched on the text exactly as typed: no Unicode folding, so full-width or
  // look-alike letters and Arabic-Indic digits can never spell STRIKE, HOLD or DROP.
  const typed = raw.trim().replace(/\s+/g, " ");
  const strike = STRIKE.exec(typed);
  if (strike) return { kind: "strike", plan: Number(strike[1]), hash: (strike[2] as string).toLowerCase(), ...(strike[3] ? { code: strike[3] } : {}) };
  const partial = STRIKE_PARTIAL.exec(typed);
  if (partial) return { kind: "strike_incomplete", plan: Number(partial[1]) };
  const holdDrop = HOLD_DROP.exec(typed);
  if (holdDrop) return { kind: (holdDrop[1] as string).toLowerCase() as "hold" | "drop", plan: Number(holdDrop[2]) };

  const alias = ARABIC_ALIASES[arabicKey(raw)];
  if (alias) return alias;

  const text = ascii(raw.normalize("NFKC")).trim().replace(/\s+/g, " ");
  switch (text.toUpperCase()) {
    case "STATUS":
      return { kind: "status" };
    case "PULSE":
      return { kind: "pulse" };
    case "SCOUT":
      return { kind: "scout" };
    case "DIAGNOSE":
      return { kind: "diagnose" };
    case "HELP":
      return { kind: "help" };
    case "PAUSE ALL":
      return { kind: "pause_all" };
    case "RESUME":
      return { kind: "resume" };
  }
  const simulate = SIMULATE.exec(text);
  if (simulate) return { kind: "simulate", plan: Number(simulate[1]) };
  if (CAP.test(text)) return { kind: "cap_unsupported" };
  return { kind: "unknown" };
}

/** The policy permission a command needs. Unknown and help need none. */
export function permissionFor(command: Command): Permission | null {
  switch (command.kind) {
    case "status":
    case "pulse":
    case "scout":
    case "diagnose":
    case "simulate":
      return "query";
    case "strike":
    case "strike_incomplete":
      return "strike";
    case "hold":
      return "hold";
    case "drop":
      return "drop";
    case "pause_all":
    case "resume":
    case "cap_unsupported":
      return "cap";
    default:
      return null;
  }
}

/** Ring 0: the only commands a voice note (or its transcript) can queue. Everything else is refused in code. */
export function voiceMayRun(command: Command): boolean {
  return ["status", "pulse", "scout", "diagnose", "simulate"].includes(command.kind) && canVoiceTrigger(command.kind);
}
