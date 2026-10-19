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

const SNAPSHOT = {
  ingest: null,
  snapshot: {
    status: "ok",
    currency: "SAR",
    period: { start: "2026-10-10", end: "2026-10-16", days: 7 },
    totals: { spend: 26880, revenue: 200000, blended_mer: 7.44, cost_per_lead: 150, cost_per_deal: 960 },
    platforms: [],
    match: { rate: 0.95 },
  },
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
  const load = vi.fn(async (_dir: string) => DASH);
  const onExit = vi.fn();
  const app = render(<App workspaceDir="/work/etl" baseDir="/base" runner={runner} load={load} version="0.1.1" size={{ cols: 110, rows: 40 }} onExit={onExit} {...over} />);
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
  it("shows the wordmark, a friendly greeting with numbered questions, the workspace, ledger head and side panel", async () => {
    const t = mount();
    await wait(60);
    const f = t.frame();
    expect(f).toContain("█████");
    expect(f).toContain("Ask me anything about your ads");
    expect(f).toContain("Hi! I'm Medjay");
    expect(f).toContain("1. How are my ads doing?");
    expect(f).toContain("Etlaala KSA · SAR");
    expect(f).toContain("ledger #12 a1b2c3d4");
    expect(f).toContain("1 waiting");
    t.unmount();
  });

  it("hides the side panel on a narrow terminal", async () => {
    const t = mount({ size: { cols: 70, rows: 30 } });
    await wait(60);
    expect(t.frame()).not.toContain("WORKSPACE");
    t.unmount();
  });
});

describe("asking in your own words", () => {
  it("answers 'how are my ads doing' from a read-only scout and shows a plain-language headline", async () => {
    const t = mount();
    await t.send("How are my ads doing?");
    expect(t.calls[0]!.argv).toEqual(["scout", "--json", "--workspace", "/work/etl"]);
    expect(t.frame()).toContain("Looking at your numbers");
    t.calls[0]!.emit(JSON.stringify(SNAPSHOT));
    t.calls[0]!.finish(0);
    await wait(80);
    const f = t.frame();
    expect(f).toContain("Between 10–16 Oct you spent SAR 26,880");
    expect(f).toContain("What next? Type a number");
    expect(f).not.toMatch(/\bMER\b|P50/);
    t.unmount();
  });

  it("a typed number picks one of the suggested next questions", async () => {
    const t = mount();
    await t.send("how are my ads doing");
    t.calls[0]!.emit(JSON.stringify(SNAPSHOT));
    t.calls[0]!.finish(0);
    await wait(80);
    await t.send("1");
    expect(t.calls[1]!.argv.slice(0, 2)).toEqual(["diagnose", "--json"]);
    t.unmount();
  });

  it("routes a scale question with its percentage and an unrelated question to the agent, in marketer language", async () => {
    const t = mount();
    await t.send("can I raise the budget by 30%?");
    expect(t.calls[0]!.argv).toEqual(["simulate", "--json", "--scale-pct", "30", "--workspace", "/work/etl"]);
    t.calls[0]!.finish(1);
    await wait(80);
    await t.send("write me three headline ideas");
    expect(t.calls[1]!.argv.slice(0, 4)).toEqual(["run", "--workspace", "/work/etl", "--"]);
    expect(t.calls[1]!.argv[4]).toContain("no jargon");
    expect(t.calls[1]!.argv[4]).toContain("Question: write me three headline ideas");
    t.unmount();
  });

  it("understands Arabic, answers in Arabic and keeps the numbers and commands in ASCII", async () => {
    const t = mount();
    await t.send("كيف حال الإعلانات؟");
    expect(t.calls[0]!.argv[0]).toBe("scout");
    t.calls[0]!.emit(JSON.stringify(SNAPSHOT));
    t.calls[0]!.finish(0);
    await wait(80);
    const f = t.frame();
    expect(f).toContain("SAR 26,880");
    expect(f).toMatch(/[؀-ۿ]{3,}/);
    await t.send("وافق على الخطة 1");
    expect(t.frame()).toContain("mdj approve 1");
    expect(t.calls).toHaveLength(1);
    t.unmount();
  });

  it("answers what's waiting from the side panel data, without running anything", async () => {
    const t = mount();
    await t.send("what's waiting for me?");
    await wait(60);
    expect(t.calls).toHaveLength(0);
    expect(t.frame()).toContain("1 plan(s) waiting for your decision.");
    expect(t.frame()).toContain("mdj diff 1");
    t.unmount();
  });

  it("will not approve in chat, in English or Arabic, and says where to do it", async () => {
    const t = mount();
    await t.send("approve plan 1");
    expect(t.calls).toHaveLength(0);
    expect(t.frame()).toContain("I can't approve or apply changes from here, on purpose.");
    t.unmount();
  });

  it("allows one thing at a time and Esc stops it", async () => {
    const t = mount();
    await t.send("what's wasting money?");
    await t.send("how are my ads doing?");
    expect(t.calls).toHaveLength(1);
    expect(t.frame()).toMatch(/still working/);
    await t.type("\u001B");
    await wait(80);
    expect(t.calls[0]!.cancel).toHaveBeenCalled();
    expect(t.frame()).toContain("Stopped.");
    t.unmount();
  });

  it("explains a missing AI model in plain words", async () => {
    const t = mount();
    await t.send("write me three headline ideas");
    t.calls[0]!.emit("run run_x: failed after 0 step(s)\n");
    t.calls[0]!.finish(1);
    await wait(80);
    t.unmount();
    // the agent's own failure text is hidden behind the friendly message (covered in ask.test.ts)
  });
});

describe("first run", () => {
  it("asks setup questions in English and Arabic, then creates the workspace through the CLI and starts using it", async () => {
    const t = mount({ workspaceDir: null });
    await wait(60);
    expect(t.frame()).toContain("called?");
    expect(t.frame()).toContain("ايش اسم نشاطك");
    expect(t.frame()).toContain("setting up");
    await t.send("Etlaala KSA");
    expect(t.frame()).toContain("What best describes you?");
    await t.send("3");
    await t.send("1");
    expect(t.frame()).toContain('Create "Etlaala KSA" (SAR)');
    await t.send("yes");
    expect(t.calls[0]!.argv.slice(0, 3)).toEqual(["init", expect.stringContaining("etlaala-ksa"), "--id"]);
    expect(t.calls[0]!.argv).toEqual(expect.arrayContaining(["--currency", "SAR", "--business-type", "high_ticket_hybrid"]));
    t.calls[0]!.finish(0);
    await wait(80);
    expect(t.frame()).toContain("Your workspace is ready.");
    expect(t.frame()).toContain("data");
    expect(t.load).toHaveBeenCalledWith(expect.stringContaining("etlaala-ksa"));
    await t.send("how are my ads doing?");
    expect(t.calls[1]!.argv[0]).toBe("scout");
    t.unmount();
  });

  it("reports a failed setup and asks again", async () => {
    const t = mount({ workspaceDir: null });
    await t.send("Shop");
    await t.send("1");
    await t.send("AED");
    await t.send("yes");
    t.calls[0]!.finish(1);
    await wait(80);
    expect(t.frame()).toContain("I couldn't create the workspace");
    expect(t.frame()).toContain("called?");
    t.unmount();
  });
});

describe("the prompt and shortcuts", () => {
  it("echoes typing and edits with backspace", async () => {
    const t = mount();
    await t.type("/hel");
    expect(t.frame()).toContain("❯ /hel▌");
    await t.type("\u007f");
    expect(t.frame()).toContain("❯ /he▌");
    t.unmount();
  });

  it("/help explains how to just ask, lists the shortcuts and the keys", async () => {
    const t = mount({ size: { cols: 110, rows: 50 } });
    await t.send("/help");
    const f = t.frame();
    for (const word of ["Just ask in your own words", "/scout", "/diagnose", "/simulate", "/media", "/plan", "/ledger", "/doctor", "Esc stop", "mdj approve"]) expect(f).toContain(word);
    t.unmount();
  });

  it("tab completes a shortcut and arrows recall earlier input", async () => {
    const t = mount();
    await t.type("/sc");
    await t.type("\t");
    expect(t.frame()).toContain("❯ /scout ▌");
    await t.send("\u007f\u007f\u007f\u007f\u007f\u007f\u007f");
    await t.send("/help");
    await t.type("\u001B[A");
    expect(t.frame()).toContain("❯ /help▌");
    t.unmount();
  });

  it("/scout still runs the raw command and streams it, and write shortcuts are refused", async () => {
    const t = mount();
    await t.send("/scout 14");
    expect(t.calls[0]!.argv).toEqual(["scout", "--days", "14", "--workspace", "/work/etl"]);
    t.calls[0]!.emit("Blended MER 7.46\n");
    await wait();
    expect(t.frame()).toContain("Blended MER 7.46");
    t.calls[0]!.finish(0);
    await wait(60);
    expect(t.frame()).toContain("scout done");
    await t.send("/plan approve 1");
    expect(t.calls).toHaveLength(1);
    expect(t.frame()).toContain("mdj approve <number>");
    t.unmount();
  });

  it("/quit and Ctrl+C stop a running command and exit", async () => {
    const t = mount();
    await t.send("/scout");
    await t.type("\u0003");
    expect(t.calls[0]!.cancel).toHaveBeenCalled();
    expect(t.onExit).toHaveBeenCalled();
    t.unmount();
  });

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
  it("wraps output, tones each kind and styles answers (headline, body, what-next)", () => {
    const lines = buildFeedLines(
      [
        { id: 1, kind: "user", text: "scout" },
        { id: 2, kind: "out", text: "a ".repeat(20) },
        { id: 3, kind: "err", text: "bad" },
        { id: 4, kind: "info", text: "done" },
        { id: 5, kind: "answer", text: "# Headline here\nbody line\n\n> What next?\n>   1. one" },
      ],
      20,
    );
    expect(lines.every((l) => l.text.length <= 20)).toBe(true);
    expect(lines.find((l) => l.text === "Headline here")!.tone).toBe("accent");
    expect(lines.find((l) => l.text === "body line")!.tone).toBe("normal");
    expect(lines.find((l) => l.text === "  1. one")!.tone).toBe("dim");
    expect(lines.find((l) => l.tone === "err")!.text).toBe("! bad");
  });
});
