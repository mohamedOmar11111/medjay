import { describe, expect, it } from "vitest";
import { COMMANDS, parseInput, pinnedSkillPrompt, resolveInput } from "./commands.js";

const WS = "/work/etl";

describe("parseInput", () => {
  it("separates slash commands, tasks and blanks", () => {
    expect(parseInput("   ")).toEqual({ kind: "empty" });
    expect(parseInput("why is CPL up?")).toEqual({ kind: "task", text: "why is CPL up?" });
    expect(parseInput("/Scout 14")).toEqual({ kind: "slash", name: "scout", args: ["14"] });
  });
  it("honours quotes in arguments", () => {
    expect(parseInput('/media fatigue-call "my file.csv" now=2026-10-05')).toEqual({ kind: "slash", name: "media", args: ["fatigue-call", "my file.csv", "now=2026-10-05"] });
  });
});

describe("resolveInput", () => {
  const go = (text: string, ws: string | null = WS) => resolveInput(parseInput(text), ws);
  it("handles local commands without a workspace", () => {
    expect(go("/help", null)).toEqual({ kind: "local", action: "help" });
    expect(go("/clear", null)).toEqual({ kind: "local", action: "clear" });
    expect(go("/quit", null)).toEqual({ kind: "local", action: "quit" });
    expect(go("/status", null)).toEqual({ kind: "local", action: "status" });
  });
  it("turns read commands into fixed argument lists, workspace last", () => {
    expect(go("/scout")).toEqual({ kind: "cli", argv: ["scout", "--workspace", WS], label: "scout" });
    expect(go("/scout 14")).toEqual({ kind: "cli", argv: ["scout", "--days", "14", "--workspace", WS], label: "scout" });
    expect(go("/diagnose")).toMatchObject({ argv: ["diagnose", "--workspace", WS] });
    expect(go("/doctor")).toMatchObject({ argv: ["doctor", "--workspace", WS] });
    expect(go("/ledger")).toMatchObject({ argv: ["ledger", "verify", "--workspace", WS] });
    expect(go("/plan")).toMatchObject({ argv: ["plan", "list", "--workspace", WS] });
    expect(go("/plan show 3")).toMatchObject({ argv: ["plan", "show", "3", "--workspace", WS] });
  });
  it("maps simulate options by name and validates them", () => {
    expect(go("/simulate scale=50 spend=12000 seed=7")).toMatchObject({ argv: ["simulate", "--scale-pct", "50", "--spend", "12000", "--seed", "7", "--workspace", WS] });
    expect(go("/simulate scale=abc")).toEqual({ kind: "error", message: expect.stringMatching(/scale must be a number/) });
    expect(go("/simulate bogus=1")).toEqual({ kind: "error", message: expect.stringMatching(/does not take bogus/) });
  });
  it("runs media rules, lists and explains them", () => {
    expect(go("/media list")).toMatchObject({ argv: ["media", "list"] });
    expect(go("/media explain 72h-guard")).toMatchObject({ argv: ["media", "explain", "72h-guard"] });
    expect(go("/media fatigue-call ads.csv now=2026-10-05")).toMatchObject({ argv: ["media", "run", "fatigue-call", "ads.csv", "now=2026-10-05", "--workspace", WS] });
  });
  it("sends plain text to the agent, after the options, so it can never be read as a flag", () => {
    expect(go("--workspace /etc why")).toMatchObject({ argv: ["run", "--workspace", WS, "--", "--workspace /etc why"], label: "agent" });
  });
  it("refuses anything that could write, with the terminal command to use instead", () => {
    for (const cmd of ["/plan approve 1", "/plan strike 1", "/approve 1", "/strike 1", "/rollback 1", "/plan hold 1", "/plan reject 1"]) {
      const r = go(cmd);
      expect(r.kind, cmd).toBe("error");
      expect((r as { message: string }).message, cmd).toMatch(/terminal|mdj /);
    }
  });
  it("refuses arguments that look like flags", () => {
    expect(go("/scout --workspace=/etc")).toEqual({ kind: "error", message: expect.stringMatching(/flag/) });
    expect(go("/media fatigue-call --json")).toEqual({ kind: "error", message: expect.stringMatching(/flag/) });
  });
  it("needs a workspace for everything that reads one, and rejects unknown commands", () => {
    expect(go("/scout", null)).toEqual({ kind: "error", message: expect.stringMatching(/no workspace/) });
    expect(go("hello", null)).toEqual({ kind: "error", message: expect.stringMatching(/no workspace/) });
    expect(go("/media list", null)).toMatchObject({ kind: "cli" }); // media list/explain need no workspace
    expect(go("/nope")).toEqual({ kind: "error", message: expect.stringMatching(/unknown command \/nope/) });
    expect(go("")).toEqual({ kind: "none" });
  });
  it("lists every command in the registry once", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["help", "status", "scout", "diagnose", "simulate", "media", "plan", "ledger", "doctor", "clear", "quit"]));
  });
});

describe("/connect", () => {
  it("resolves to a local action with a known provider, defaulting to anthropic", () => {
    expect(resolveInput(parseInput("/connect openai"), null)).toEqual({ kind: "local", action: "connect", provider: "openai" });
    expect(resolveInput(parseInput("/connect"), null)).toEqual({ kind: "local", action: "connect", provider: "anthropic" });
  });
  it("refuses anything that is not a provider name, so a key typed here is never treated as a command", () => {
    expect(resolveInput(parseInput("/connect sk-ant-abc"), null)).toMatchObject({ kind: "error" });
    expect(resolveInput(parseInput("/connect google extra"), null)).toMatchObject({ kind: "error" });
  });
});

describe("/expand", () => {
  it("resolves to a local action for a card number and refuses anything else", () => {
    expect(resolveInput(parseInput("/expand 2"), null)).toEqual({ kind: "local", action: "expand", n: 2 });
    expect(resolveInput(parseInput("/expand"), null)).toMatchObject({ kind: "error" });
    expect(resolveInput(parseInput("/expand 0"), null)).toMatchObject({ kind: "error" });
    expect(resolveInput(parseInput("/expand a"), null)).toMatchObject({ kind: "error" });
  });
});

describe("/skills, /skill and /drafts", () => {
  const go = (text: string, ws: string | null = WS) => resolveInput(parseInput(text), ws);

  it("/skills lists, and /skills show <name> shows one, as fixed read commands", () => {
    expect(go("/skills")).toEqual({ kind: "cli", argv: ["skills", "list", "--workspace", WS], label: "skills" });
    expect(go("/skills show email-sequence")).toEqual({ kind: "cli", argv: ["skills", "show", "email-sequence", "--workspace", WS], label: "skills show" });
    expect(go("/skills show")).toMatchObject({ kind: "error" });
    expect(go("/skills link ../x")).toMatchObject({ kind: "error" });
    expect(go("/skills show --workspace /etc")).toMatchObject({ kind: "error" });
    expect(go("/skills", null)).toMatchObject({ kind: "error" });
  });

  it("/drafts lists drafts and takes no arguments", () => {
    expect(go("/drafts")).toEqual({ kind: "cli", argv: ["draft", "list", "--workspace", WS], label: "drafts" });
    expect(go("/drafts revert x")).toMatchObject({ kind: "error" });
    expect(go("/drafts", null)).toMatchObject({ kind: "error" });
  });

  it("/skill pins, clears and shows, locally and without a workspace", () => {
    expect(go("/skill email-sequence", null)).toEqual({ kind: "local", action: "skill", mode: "pin", name: "email-sequence" });
    expect(go("/skill off", null)).toEqual({ kind: "local", action: "skill", mode: "clear" });
    expect(go("/skill clear", null)).toEqual({ kind: "local", action: "skill", mode: "clear" });
    expect(go("/skill", null)).toEqual({ kind: "local", action: "skill", mode: "show" });
  });

  it("/skill refuses names that are not plain skill names", () => {
    for (const bad of ['"a b"', "-x", "../up", "a/b", "x;rm", `"${"a".repeat(121)}"`]) expect(go(`/skill ${bad}`, null)).toMatchObject({ kind: "error" });
    expect(go("/skill a b", null)).toMatchObject({ kind: "error" });
  });

  it("lists the new commands in the help table", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(expect.arrayContaining(["skills", "skill", "drafts"]));
  });
});

describe("pinnedSkillPrompt", () => {
  it("asks the agent to load the pinned skill first and keeps the person's words after it", () => {
    const text = pinnedSkillPrompt("email-sequence", "write a Ramadan welcome email");
    expect(text).toContain('"email-sequence"');
    expect(text).toContain("skill_load");
    expect(text.endsWith("write a Ramadan welcome email")).toBe(true);
  });
  it("returns the words unchanged when nothing is pinned", () => {
    expect(pinnedSkillPrompt(null, "hello")).toBe("hello");
  });
});
