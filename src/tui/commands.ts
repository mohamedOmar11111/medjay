// What a person types in the TUI, and the fixed command line each input becomes. The TUI never
// builds a command from free text: slash commands map to an allowlist of read commands, plain text
// goes to `mdj run` (the agent, which has no write tools), and anything that could change a platform
// (approve, strike, rollback) is refused here and left to the terminal, where it is typed on purpose.

export type Parsed = { kind: "empty" } | { kind: "slash"; name: string; args: string[] } | { kind: "task"; text: string };

export interface CommandSpec {
  name: string;
  usage: string;
  summary: string;
}

export const COMMANDS: CommandSpec[] = [
  { name: "help", usage: "/help", summary: "list commands and keys" },
  { name: "status", usage: "/status", summary: "refresh the side panel" },
  { name: "scout", usage: "/scout [days]", summary: "read the dropzone and show a cross-channel snapshot" },
  { name: "diagnose", usage: "/diagnose [days]", summary: "rank wasted spend, over-attribution and funnel drops" },
  { name: "simulate", usage: "/simulate [spend=N] [scale=PCT] [seed=N] [draws=N] [days=N]", summary: "funnel math, break-even, seeded Monte Carlo" },
  { name: "media", usage: "/media list | explain <rule> | <rule> [file] [key=value ...]", summary: "20 read-only media-buyer rules over exported CSVs" },
  { name: "plan", usage: "/plan [list | show <n>]", summary: "list plans or show one (approving is done in the terminal)" },
  { name: "ledger", usage: "/ledger", summary: "verify the tamper-evident audit ledger" },
  { name: "doctor", usage: "/doctor", summary: "pre-flight checks" },
  { name: "clear", usage: "/clear", summary: "clear the feed" },
  { name: "quit", usage: "/quit", summary: "leave (also Ctrl+C)" },
];

export type Resolution =
  | { kind: "none" }
  | { kind: "local"; action: "help" | "status" | "clear" | "quit" }
  | { kind: "cli"; argv: string[]; label: string }
  | { kind: "error"; message: string };

export function parseInput(raw: string): Parsed {
  const text = raw.trim();
  if (text === "") return { kind: "empty" };
  if (!text.startsWith("/")) return { kind: "task", text };
  const body = text.slice(1);
  const parts: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) parts.push(m[1] ?? m[2]!);
  const [name = "", ...args] = parts;
  return { kind: "slash", name: name.toLowerCase(), args };
}

const WRITE_WORDS = new Set(["approve", "strike", "rollback", "hold", "reject", "drop"]);
const writeRefusal = (word: string): Resolution => ({
  kind: "error",
  message: `${word} changes what leaves Medjay, so it is not available here. In a terminal: mdj ${word} <number> (see \`mdj diff <number>\` first).`,
});

const NEEDS_WORKSPACE: Resolution = { kind: "error", message: "no workspace found. Run `mdj init <dir>`, then start mdj inside that folder (or pass --workspace to mdj)." };

const fail = (message: string): Resolution => ({ kind: "error", message });
const flagLike = (args: string[]) => args.find((a) => a.startsWith("-"));
const wholeNumber = (value: string, name: string, lo: number, hi: number): string | Resolution => {
  const n = Number(value);
  return Number.isInteger(n) && n >= lo && n <= hi ? String(n) : fail(`${name} must be a whole number from ${lo} to ${hi}`);
};

const SIMULATE_KEYS: Record<string, { flag: string; integer: boolean }> = {
  spend: { flag: "--spend", integer: false },
  scale: { flag: "--scale-pct", integer: false },
  seed: { flag: "--seed", integer: true },
  draws: { flag: "--draws", integer: true },
  days: { flag: "--days", integer: true },
};

function simulate(args: string[], ws: string): Resolution {
  const argv = ["simulate"];
  for (const arg of args) {
    const at = arg.indexOf("=");
    const key = at === -1 ? arg : arg.slice(0, at);
    const def = SIMULATE_KEYS[key];
    if (!def) return fail(`simulate does not take ${key}; it takes ${Object.keys(SIMULATE_KEYS).map((k) => `${k}=`).join(", ")}`);
    const value = at === -1 ? "" : arg.slice(at + 1);
    const n = Number(value);
    if (value === "" || !Number.isFinite(n) || (def.integer && !Number.isInteger(n))) return fail(`${key} must be a number${def.integer ? " (whole)" : ""}`);
    argv.push(def.flag, String(n));
  }
  return { kind: "cli", argv: [...argv, "--workspace", ws], label: "simulate" };
}

function windowed(name: "scout" | "diagnose", args: string[], ws: string): Resolution {
  const flag = flagLike(args);
  if (flag) return fail(`${name} takes a number of days, not a flag (${flag})`);
  if (args.length > 1) return fail(`${name} takes at most one argument: the number of days`);
  const argv: string[] = [name];
  if (args[0] !== undefined) {
    const days = wholeNumber(args[0], "days", 1, 365);
    if (typeof days !== "string") return days;
    argv.push("--days", days);
  }
  return { kind: "cli", argv: [...argv, "--workspace", ws], label: name };
}

function media(args: string[], ws: string | null): Resolution {
  const [first, ...rest] = args;
  const flag = flagLike(args);
  if (flag) return fail(`media takes no flags (${flag}); parameters are key=value`);
  if (first === undefined || first === "list") return { kind: "cli", argv: ["media", "list"], label: "media" };
  if (first === "explain") return rest[0] ? { kind: "cli", argv: ["media", "explain", rest[0]], label: "media" } : fail("usage: /media explain <rule>");
  if (ws === null) return NEEDS_WORKSPACE;
  return { kind: "cli", argv: ["media", "run", first, ...rest, "--workspace", ws], label: `media ${first}` };
}

function plan(args: string[], ws: string): Resolution {
  const [sub = "list", n] = args;
  if (WRITE_WORDS.has(sub)) return writeRefusal(sub);
  if (sub === "list" && args.length <= 1) return { kind: "cli", argv: ["plan", "list", "--workspace", ws], label: "plan" };
  if (sub === "show" || sub === "diff") {
    if (n === undefined) return fail("usage: /plan show <number>");
    const num = wholeNumber(n, "plan number", 1, 1_000_000);
    return typeof num === "string" ? { kind: "cli", argv: ["plan", "show", num, "--workspace", ws], label: `plan ${num}` } : num;
  }
  return fail("usage: /plan [list | show <number>]");
}

export function resolveInput(parsed: Parsed, workspaceDir: string | null): Resolution {
  if (parsed.kind === "empty") return { kind: "none" };
  if (parsed.kind === "task") {
    if (workspaceDir === null) return NEEDS_WORKSPACE;
    return { kind: "cli", argv: ["run", "--workspace", workspaceDir, "--", parsed.text], label: "agent" };
  }
  const { name, args } = parsed;
  if (WRITE_WORDS.has(name)) return writeRefusal(name);
  switch (name) {
    case "help":
    case "status":
    case "clear":
    case "quit":
      return { kind: "local", action: name };
    case "media":
      return media(args, workspaceDir);
  }
  if (!COMMANDS.some((c) => c.name === name)) return fail(`unknown command /${name}; /help lists them`);
  if (workspaceDir === null) return NEEDS_WORKSPACE;
  switch (name) {
    case "scout":
    case "diagnose":
      return windowed(name, args, workspaceDir);
    case "simulate":
      return simulate(args, workspaceDir);
    case "plan":
      return plan(args, workspaceDir);
    case "ledger":
      return { kind: "cli", argv: ["ledger", "verify", "--workspace", workspaceDir], label: "ledger" };
    default:
      return { kind: "cli", argv: ["doctor", "--workspace", workspaceDir], label: "doctor" };
  }
}
