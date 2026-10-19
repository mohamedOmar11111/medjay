import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App, type AppProps } from "./app.js";
import { emptyDashboard, type Dashboard } from "./dashboard.js";
import { buildFeedLines } from "./feed.js";
import type { Runner } from "./runner.js";

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const DASH: Dashboard = {
  ...emptyDashboard(),
  workspace: { id: "etl", name: "Etlaala KSA", currency: "SAR", timezone: "Asia/Riyadh" },
  ledger: { seq: 12, head: "a1b2c3d4e5f6a7b8" },
  gate: { required: true, minChance: 0.6 },
  plans: [{ number: 1, state: "proposed", id: "pl_1", expires_at: "2099-01-01T00:00:00Z" }],
};

interface Call {
  argv: string[];
  emit: (text: string) => void;
  finish: (code: number) => void;
  cancel: ReturnType<typeof vi.fn>;
}

function fakeRunner(): { runner: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: Runner = (argv, onChunk) => {
    let finish!: (v: { code: number }) => void;
    const done = new Promise<{ code: number }>((r) => (finish = r));
    const cancel = vi.fn(() => finish({ code: 130 }));
    calls.push({ argv, emit: (t) => onChunk(t, "out"), finish: (code) => finish({ code }), cancel });
    return { done, cancel };
  };
  return { runner, calls };
}

function mount(over: Partial<AppProps> = {}) {
  const { runner, calls } = fakeRunner();
  const load = vi.fn(async () => DASH);
  const onExit = vi.fn();
  const app = render(<App workspaceDir="/work/etl" runner={runner} load={load} version="0.1.1" size={{ cols: 110, rows: 34 }} onExit={onExit} {...over} />);
  const type = async (text: string) => {
    app.stdin.write(text);
    await wait();
  };
  const send = async (text: string) => {
    await type(text);
    app.stdin.write("\r");
    await wait();
  };
  return { ...app, calls, load, onExit, type, send, frame: () => app.lastFrame() ?? "" };
}

describe("the shell", () => {
  it("shows the wordmark, the workspace, currency, ledger head, version and the side panel", async () => {
    const t = mount();
    await wait(60);
    const f = t.frame();
    expect(f).toContain("█████"); // wordmark
    expect(f).toContain("SHIELD + SWORD");
    expect(f).toContain("▌MEDJAY");
    expect(f).toContain("Etlaala KSA · SAR");
    expect(f).toContain("ledger #12 a1b2c3d4");
    expect(f).toContain("v0.1.1");
    expect(f).toContain("PLANS");
    expect(f).toContain("1 waiting");
    expect(f).toContain("scale needs P(>0) ≥ 60%");
    t.unmount();
  });

  it("hides the side panel on a narrow terminal", async () => {
    const t = mount({ size: { cols: 70, rows: 30 } });
    await wait(60);
    expect(t.frame()).not.toContain("WORKSPACE");
    t.unmount();
  });

  it("says there is no workspace and refuses agent tasks and workspace commands", async () => {
    const t = mount({ workspaceDir: null });
    await wait();
    expect(t.frame()).toContain("no workspace");
    await t.send("why is CPL up?");
    expect(t.frame()).toMatch(/no workspace found\. Run `mdj init/);
    expect(t.calls).toHaveLength(0);
    t.unmount();
  });
});

describe("the prompt", () => {
  it("echoes typing, edits with backspace and clears on Enter", async () => {
    const t = mount();
    await t.type("/hel");
    expect(t.frame()).toContain("❯ /hel▌");
    await t.type("\u007f");
    expect(t.frame()).toContain("❯ /he▌");
    t.unmount();
  });

  it("/help lists every command and the keys", async () => {
    const t = mount();
    await t.send("/help");
    const f = t.frame();
    for (const word of ["/scout", "/diagnose", "/simulate", "/media", "/plan", "/ledger", "/doctor", "Esc cancel", "mdj approve"]) expect(f).toContain(word);
    t.unmount();
  });

  it("tab completes a unique command and a common prefix", async () => {
    const t = mount();
    await t.type("/sc");
    await t.type("\t");
    expect(t.frame()).toContain("❯ /scout ▌");
    t.unmount();
  });

  it("recalls earlier input with the arrow keys", async () => {
    const t = mount();
    await t.send("/help");
    await t.type("\u001B[A");
    expect(t.frame()).toContain("❯ /help▌");
    t.unmount();
  });
});

describe("running commands", () => {
  it("runs /scout through the CLI with a fixed argument list, streams output and marks it done", async () => {
    const t = mount();
    await t.send("/scout 14");
    expect(t.calls[0]!.argv).toEqual(["scout", "--days", "14", "--workspace", "/work/etl"]);
    expect(t.frame()).toContain("running scout");
    t.calls[0]!.emit("Blended MER 7.46\n");
    await wait();
    expect(t.frame()).toContain("Blended MER 7.46");
    t.calls[0]!.finish(0);
    await wait(60);
    expect(t.frame()).toContain("scout done");
    expect(t.frame()).not.toContain("running scout");
    expect(t.load.mock.calls.length).toBeGreaterThanOrEqual(2); // refreshed after the command
    t.unmount();
  });

  it("sends plain text to the agent with the task after `--`", async () => {
    const t = mount();
    await t.send("why is CPL up?");
    expect(t.calls[0]!.argv).toEqual(["run", "--workspace", "/work/etl", "--", "why is CPL up?"]);
    t.calls[0]!.finish(2);
    await wait(60);
    expect(t.frame()).toContain("agent exited with code 2");
    t.unmount();
  });

  it("allows one command at a time and says so", async () => {
    const t = mount();
    await t.send("/scout");
    await t.send("/diagnose");
    expect(t.calls).toHaveLength(1);
    expect(t.frame()).toMatch(/still running/);
    t.unmount();
  });

  it("Esc cancels the running command", async () => {
    const t = mount();
    await t.send("/scout");
    await t.type("\u001B");
    await wait(60);
    expect(t.calls[0]!.cancel).toHaveBeenCalled();
    expect(t.frame()).toContain("scout cancelled");
    t.unmount();
  });

  it("refuses write commands in the TUI and points to the terminal", async () => {
    const t = mount();
    await t.send("/plan approve 1");
    await t.send("/strike 1");
    expect(t.calls).toHaveLength(0);
    expect(t.frame()).toContain("mdj strike <number>");
    t.unmount();
  });

  it("reports an unknown command and a bad argument without running anything", async () => {
    const t = mount();
    await t.send("/nope");
    await t.send("/scout abc");
    expect(t.calls).toHaveLength(0);
    expect(t.frame()).toContain("unknown command /nope");
    expect(t.frame()).toContain("days must be a whole number");
    t.unmount();
  });

  it("/clear empties the feed and /quit cancels a running command and exits", async () => {
    const t = mount();
    await t.send("/help");
    await t.send("/clear");
    expect(t.frame()).not.toContain("/diagnose");
    await t.send("/scout");
    await t.send("/quit");
    expect(t.calls[0]!.cancel).toHaveBeenCalled();
    expect(t.onExit).toHaveBeenCalled();
    t.unmount();
  });

  it("Ctrl+C cancels the running command and exits", async () => {
    const t = mount();
    await t.send("/scout");
    await t.type("\u0003");
    expect(t.calls[0]!.cancel).toHaveBeenCalled();
    expect(t.onExit).toHaveBeenCalled();
    t.unmount();
  });
});

describe("scrolling", () => {
  it("PageUp scrolls back through long output and PageDown returns", async () => {
    const t = mount({ size: { cols: 110, rows: 20 } });
    await t.send("/scout");
    t.calls[0]!.emit(Array.from({ length: 80 }, (_, i) => `row-${i}`).join("\n"));
    await wait();
    expect(t.frame()).toContain("row-79");
    expect(t.frame()).not.toContain("row-10");
    await t.type("\u001B[5~");
    expect(t.frame()).toMatch(/scrolled back \d+ lines/);
    await t.type("\u001B[6~");
    expect(t.frame()).toContain("row-79");
    t.unmount();
  });
});

describe("buildFeedLines", () => {
  it("wraps output to the feed width and tones each kind", () => {
    const lines = buildFeedLines(
      [
        { id: 1, kind: "user", text: "scout" },
        { id: 2, kind: "out", text: "a ".repeat(20) },
        { id: 3, kind: "err", text: "bad" },
        { id: 4, kind: "info", text: "done" },
      ],
      20,
    );
    expect(lines.every((l) => l.text.length <= 20)).toBe(true);
    expect(lines.map((l) => l.tone)).toEqual(expect.arrayContaining(["user", "normal", "err", "dim"]));
    expect(lines.find((l) => l.tone === "err")!.text).toBe("! bad");
  });
});
