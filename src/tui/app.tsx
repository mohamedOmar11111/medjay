// The Medjay terminal app: header, activity feed, side panel and a prompt. You ask in your own words
// (English or Arabic); it picks the right read-only analysis, runs it through the CLI (see runner.ts,
// so Shield, policy and the ledger apply unchanged) and answers in plain language. It never approves
// or applies anything: that stays a typed action in a terminal.
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { answerIntent, askAgent, type AskContext, type Reply } from "./ask.js";
import { cleanPastedSecret } from "../cli/secret-input.js";
import { helpAnswer, modelErrorAnswer, renderAnswer, type Suggestion } from "./answers.js";
import { COMMANDS, parseInput, resolveInput } from "./commands.js";
import { ledgerLabel, sidebarLines, emptyDashboard, type Dashboard, type PanelLine } from "./dashboard.js";
import { buildFeedLines, splashText, type Entry, type EntryKind, type FeedTone } from "./feed.js";
import { detectLanguage, routeIntent, toLatinDigits, type Language, type Routed } from "./intent.js";
import { classifyModelFailure } from "./model-errors.js";
import type { RunEvent } from "../run-events.js";
import { onboardingDone, startOnboarding, stepOnboarding, type OnboardState } from "./onboarding.js";
import type { Runner, RunHandle } from "./runner.js";
import { COMPACT_BANNER } from "./splash.js";
import { lastWindow } from "./text.js";

export interface AppProps {
  workspaceDir: string | null;
  /** Folder new workspaces are created in (first-run setup). */
  baseDir?: string;
  runner: Runner;
  load: (dir: string) => Promise<Dashboard>;
  version: string;
  /** Terminal size override (tests); otherwise the real terminal is followed. */
  size?: { cols: number; rows: number };
  onExit?: () => void;
}

const SIDEBAR_WIDTH = 30;
const MIN_COLS_FOR_SIDEBAR = 80;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const THINKS: Routed["intent"][] = ["performance", "waste", "scale", "trust"];
const PROBE_TASK = "Reply with the single word OK.";

const FEED_COLOR: Record<FeedTone, { color?: string; dim?: boolean; bold?: boolean }> = {
  normal: {},
  dim: { dim: true },
  accent: { color: "white", bold: true },
  err: { color: "red" },
  user: { color: "white", bold: true },
};
const PANEL_COLOR: Record<PanelLine["tone"], { color?: string; dim?: boolean; bold?: boolean }> = {
  normal: {},
  dim: { dim: true },
  warn: { color: "yellow" },
  good: { color: "green" },
  head: { dim: true, bold: true },
};

const pick = (lang: Language) => (en: string, ar: string) => (lang === "ar" ? ar : en);

const shortcutsText = (): string =>
  [
    "Just ask in your own words, in English or Arabic. For example:",
    "  How are my ads doing?   ·   What's wasting money?   ·   Can I raise spend by 20%?",
    "  What's waiting for my approval?   ·   Is my data up to date?",
    "",
    "Shortcuts (optional):",
    ...COMMANDS.flatMap((c) => [`  ${c.usage}`, `        ${c.summary}`]),
    "",
    "Keys: Enter send · Tab complete a shortcut · ↑/↓ earlier questions · PgUp/PgDn scroll",
    "      Esc stop what I'm doing · Ctrl+L clear · Ctrl+C quit",
    "Approving and applying plans stays in a terminal, on purpose:",
    "      mdj approve <n> · mdj strike <n>",
  ].join("\n");

function useTerminalSize(override?: { cols: number; rows: number }): { cols: number; rows: number } {
  const { stdout } = useStdout();
  const read = () => override ?? { cols: (stdout as NodeJS.WriteStream).columns ?? 100, rows: (stdout as NodeJS.WriteStream).rows ?? 32 };
  const [size, setSize] = useState(read);
  useEffect(() => {
    if (override) return;
    const onResize = () => setSize(read());
    stdout.on("resize", onResize);
    return () => void stdout.off("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stdout, override]);
  return override ?? size;
}

const hasLetters = (text: string) => /[A-Za-z؀-ۿ]/.test(text);

export function App({ workspaceDir, baseDir, runner, load, version, size: sizeOverride, onExit }: AppProps) {
  const { exit } = useApp();
  const { cols, rows } = useTerminalSize(sizeOverride);
  const nextId = useRef(10);
  const [ws, setWsState] = useState<string | null>(workspaceDir);
  const wsRef = useRef<string | null>(workspaceDir);
  const setWs = (dir: string | null) => {
    wsRef.current = dir;
    setWsState(dir);
  };
  const langRef = useRef<Language>("en");
  const suggestions = useRef<Suggestion[]>(workspaceDir ? helpAnswer("en", true).next : []);
  const onboardRef = useRef<OnboardState | null>(null);
  const [entries, setEntries] = useState<Entry[]>(() => {
    const first: Entry = { id: 1, kind: "splash", text: splashText() };
    if (workspaceDir) return [first, { id: 2, kind: "answer", text: renderAnswer(helpAnswer("en", true), "en") }];
    const started = startOnboarding("en");
    onboardRef.current = started.state;
    return [first, { id: 2, kind: "out", text: `${started.say}\n\n${startOnboarding("ar").say}` }];
  });
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [dash, setDash] = useState<Dashboard>(emptyDashboard);
  const dashRef = useRef<Dashboard>(dash);
  const [busy, setBusy] = useState<string | null>(null);
  /** While set, typed text is a secret key: kept out of the prompt, the feed and the history. */
  const [secretProvider, setSecretProvider] = useState<string | null>(null);
  const secretBuf = useRef("");
  /** Details behind each step card, for /expand. */
  const cards = useRef<string[][]>([]);
  const [secretLen, setSecretLen] = useState(0);
  const [tick, setTick] = useState(0);
  const running = useRef<RunHandle | null>(null);
  const cancelled = useRef(false);
  const baseFolder = baseDir ?? process.cwd();

  const add = useCallback((kind: EntryKind, text: string): number => {
    const id = nextId.current++;
    setEntries((all) => [...all, { id, kind, text }]);
    setOffset(0);
    return id;
  }, []);
  const append = useCallback((id: number, text: string) => setEntries((all) => all.map((e) => (e.id === id ? { ...e, text: e.text + text } : e))), []);

  const refresh = useCallback(
    async (dir: string | null = wsRef.current): Promise<Dashboard> => {
      if (dir === null) return dashRef.current;
      try {
        const next = await load(dir);
        dashRef.current = next;
        setDash(next);
        return next;
      } catch {
        return dashRef.current;
      }
    },
    [load],
  );
  useEffect(() => void refresh(), [refresh]);

  useEffect(() => {
    if (busy === null) return;
    const timer = setInterval(() => setTick((n) => n + 1), 120);
    return () => clearInterval(timer);
  }, [busy]);

  const quit = useCallback(() => {
    running.current?.cancel();
    onExit?.();
    exit();
  }, [exit, onExit]);

  const cancel = useCallback(() => {
    if (running.current) {
      cancelled.current = true;
      running.current.cancel();
    }
  }, []);

  /** A runner that remembers the child it started, so Esc and quit can stop it. */
  const tracked = useCallback<Runner>(
    (argv, onChunk, options) => {
      const handle = runner(argv, onChunk, options);
      running.current = handle;
      return handle;
    },
    [runner],
  );

  const showReply = useCallback(
    (reply: Reply) => {
      suggestions.current = reply.suggestions;
      add("answer", reply.text);
    },
    [add],
  );

  /** One analysis or agent question, start to finish. */
  const ask = useCallback(
    (routed: Routed | null, text: string, lang: Language) => {
      const dir = wsRef.current;
      if (dir === null) return;
      const viaAgent = routed === null || routed.intent === "greet";
      const thinking = viaAgent || THINKS.includes(routed.intent);
      cancelled.current = false;
      if (thinking) {
        setBusy(pick(lang)("looking", "أراجع"));
        add("info", pick(lang)(viaAgent ? "Thinking about that…" : "Looking at your numbers…", viaAgent ? "أفكر في سؤالك…" : "أراجع أرقامك…"));
      }
      void (async () => {
        try {
          if (routed !== null && !THINKS.includes(routed.intent)) await refresh();
          const started = new Map<string, Extract<RunEvent, { type: "tool.started" }>>();
          const onEvent = (e: RunEvent) => {
            if (e.type === "step.started") setBusy(pick(lang)(`working · step ${e.step}`, `أشتغل · خطوة ${e.step}`));
            else if (e.type === "tool.started") started.set(e.call_id, e);
            else if (e.type === "tool.finished") {
              const s = started.get(e.call_id);
              cards.current.push([`Tool: ${e.name} (${s?.class ?? "tool"})`, `Call: ${e.call_id} · step ${e.step}`, `Input fingerprint: ${s?.input_hash ?? "n/a"}`, `Result: ${e.ok ? "ok" : `failed (${e.error_kind ?? "error"})`}`, `Summary: ${e.summary}`]);
              add("card", `▸ [${cards.current.length}] ${e.label} · ${e.summary}`);
            }
          };
          const ctx: AskContext = { runner: tracked, workspaceDir: dir, dash: dashRef.current, lang, cancelled: () => cancelled.current, onEvent };
          let reply = routed === null ? await askAgent(text, ctx) : routed.intent === "greet" ? await askAgent(text, ctx, "chat") : await answerIntent(routed, ctx);
          if (routed?.intent === "greet" && reply.modelFailure) {
            // no usable model: the fixed greeting still works, plus the one thing to do about it
            const hint = modelErrorAnswer(reply.modelFailure, lang);
            reply = await answerIntent(routed, ctx);
            add("info", [hint.headline, hint.body[0] ?? ""].join(" ").trim());
          }
          if (routed?.intent === "language" && routed.params.language) langRef.current = routed.params.language;
          if (cancelled.current) add("info", pick(lang)("Stopped.", "تم الإيقاف."));
          else showReply(reply);
        } catch (error) {
          add("err", error instanceof Error ? error.message : String(error));
        } finally {
          running.current = null;
          setBusy(null);
          void refresh();
        }
      })();
    },
    [add, refresh, showReply, tracked],
  );

  /** First-run setup: collect answers, then run the init command through the CLI. */
  const onboard = useCallback(
    (text: string) => {
      const state = onboardRef.current;
      if (state === null) return;
      const result = stepOnboarding(state, text, baseFolder);
      onboardRef.current = result.state;
      langRef.current = result.state.lang;
      add("out", result.say);
      if (!result.create) return;
      const { dir, argv } = result.create;
      let err = "";
      cancelled.current = false;
      setBusy(pick(result.state.lang)("setting up", "أجهّز"));
      void tracked(argv, (chunk, stream) => {
        if (stream === "err") err += chunk;
      }).done.then(({ code }) => {
        running.current = null;
        setBusy(null);
        const lang = result.state.lang;
        if (code !== 0) {
          onboardRef.current = { step: "name", lang };
          add("err", `${pick(lang)("I couldn't create the workspace:", "ما قدرت أنشئ مساحة العمل:")} ${err.trim().split("\n")[0] ?? ""}\n${startOnboarding(lang).say}`);
          return;
        }
        onboardRef.current = null;
        setWs(dir);
        const [head = "", ...rest] = onboardingDone(dir, lang).split("\n");
        const next = helpAnswer(lang, false).next.filter((s) => s.intent === "performance" || s.intent === "data");
        suggestions.current = next;
        add("answer", renderAnswer({ headline: head, body: rest, next }, lang));
        void refresh(dir);
      });
    },
    [add, baseFolder, refresh, tracked],
  );

  /** Store the pasted key through the CLI (stdin only), then prove it works with one tiny question. */
  const finishConnect = useCallback(
    (provider: string, value: string) => {
      const lang = langRef.current;
      const dir = wsRef.current;
      if (value === "") return void add("err", pick(lang)("No key entered; nothing was stored.", "ما دخلت مفتاح؛ ما انحفظ شي."));
      let err = "";
      cancelled.current = false;
      setBusy(pick(lang)("saving the key", "أحفظ المفتاح"));
      void tracked(["auth", "set", provider], (chunk, stream) => {
        if (stream === "err") err += chunk;
      }, { stdin: value }).done.then(({ code }) => {
        if (code !== 0) {
          running.current = null;
          setBusy(null);
          return void add("err", `${pick(lang)("I couldn't store the key:", "ما قدرت أحفظ المفتاح:")} ${err.trim().split("\n")[0] ?? ""}`);
        }
        if (dir === null) {
          running.current = null;
          setBusy(null);
          return void add("info", pick(lang)("Key stored. Once a workspace is set up, ask me something to test it.", "انحفظ المفتاح. بعد ما تجهز مساحة العمل اسألني أي شي لتجربته."));
        }
        setBusy(pick(lang)("testing the key", "أجرّب المفتاح"));
        let out = "";
        void tracked(["run", "--workspace", dir, "--", PROBE_TASK], (chunk) => void (out += chunk)).done.then(({ code: probe }) => {
          running.current = null;
          setBusy(null);
          const failure = probe !== 0 ? classifyModelFailure(out) : null;
          if (failure) return void add("answer", renderAnswer(modelErrorAnswer(failure, lang), lang));
          add("info", pick(lang)(`Connected: ${provider} works.`, `تم الاتصال: ${provider} يشتغل.`));
        });
      });
    },
    [add, tracked],
  );

  const runShortcut = useCallback(
    (text: string) => {
      const resolved = resolveInput(parseInput(text), wsRef.current);
      if (resolved.kind === "none") return;
      if (resolved.kind === "error") return void add("err", resolved.message);
      if (resolved.kind === "local") {
        if (resolved.action === "quit") return quit();
        if (resolved.action === "clear") return void setEntries([]);
        if (resolved.action === "help") return void add("out", shortcutsText());
        if (resolved.action === "expand") {
          const detail = cards.current[resolved.n - 1];
          return void (detail ? add("out", detail.join("\n")) : add("err", `There is no card ${resolved.n}. Cards are numbered as they appear in the feed.`));
        }
        if (resolved.action === "connect") {
          secretBuf.current = "";
          setSecretLen(0);
          setSecretProvider(resolved.provider);
          return void add("info", pick(langRef.current)(`Paste your ${resolved.provider} key now. It is hidden and goes straight to your system keychain. Enter saves, Esc cancels.`, `الصق مفتاح ${resolved.provider} الحين. يبقى مخفياً ويروح مباشرة لمفاتيح النظام. Enter للحفظ وEsc للإلغاء.`));
        }
        return void refresh().then(() => add("info", pick(langRef.current)("Side panel refreshed.", "تم تحديث اللوحة الجانبية.")));
      }
      if (running.current) return void add("err", pick(langRef.current)("I'm still working on something; press Esc to stop it first.", "للحين أشتغل على شي؛ اضغط Esc لإيقافه أولاً."));
      const id = add("out", "");
      cancelled.current = false;
      setBusy(resolved.label);
      const handle = tracked(resolved.argv, (chunk) => append(id, chunk));
      void handle.done.then(({ code }) => {
        running.current = null;
        setBusy(null);
        add(cancelled.current ? "info" : code === 0 ? "info" : "err", cancelled.current ? `${resolved.label} cancelled` : code === 0 ? `${resolved.label} done` : `${resolved.label} exited with code ${code}`);
        void refresh();
      });
    },
    [add, append, quit, refresh, tracked],
  );

  const submit = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (text === "") return;
      setHistory((h) => (h[h.length - 1] === text ? h : [...h, text]));
      setHistoryAt(null);
      add("user", text);
      if (onboardRef.current !== null) return onboard(text);
      if (text.startsWith("/")) return runShortcut(text);
      const lang: Language = hasLetters(text) ? detectLanguage(text) : langRef.current;
      langRef.current = lang;
      if (/^[1-9]$/.test(toLatinDigits(text)) && suggestions.current.length > 0 && suggestions.current[Number(toLatinDigits(text)) - 1] === undefined) {
        return void add("info", pick(lang)(`Pick a number from 1 to ${suggestions.current.length}, or just ask in your own words.`, `اختر رقماً من 1 إلى ${suggestions.current.length}، أو اسأل بكلامك.`));
      }
      const pickedNumber = /^[1-9]$/.test(toLatinDigits(text)) ? suggestions.current[Number(toLatinDigits(text)) - 1] : undefined;
      const routed: Routed | null = pickedNumber ? { intent: pickedNumber.intent, params: pickedNumber.params ?? {} } : routeIntent(text);
      if (running.current) return void add("err", pick(lang)("I'm still working on something; press Esc to stop it first.", "للحين أشتغل على شي؛ اضغط Esc لإيقافه أولاً."));
      if (wsRef.current === null) return void add("err", pick(lang)("There's no workspace yet.", "ما في مساحة عمل للحين."));
      ask(routed, text, lang);
    },
    [add, ask, onboard, runShortcut],
  );

  const feedWidth = cols >= MIN_COLS_FOR_SIDEBAR ? cols - SIDEBAR_WIDTH - 6 : cols - 4;
  const bodyHeight = Math.max(6, rows - 7);
  const lines = buildFeedLines(entries, feedWidth);
  const view = lastWindow(lines.map((l) => l.text), bodyHeight - 2, offset);

  useInput((typed, key) => {
    if (key.ctrl && typed === "c") return quit();
    if (secretProvider !== null) {
      if (key.escape) {
        secretBuf.current = "";
        setSecretLen(0);
        setSecretProvider(null);
        return void add("info", pick(langRef.current)("Cancelled; nothing was stored.", "تم الإلغاء؛ ما انحفظ شي."));
      }
      if (key.return) {
        const value = cleanPastedSecret(secretBuf.current);
        const provider = secretProvider;
        secretBuf.current = "";
        setSecretLen(0);
        setSecretProvider(null);
        return finishConnect(provider, value);
      }
      if (key.backspace || key.delete) {
        secretBuf.current = secretBuf.current.slice(0, -1);
        return void setSecretLen(secretBuf.current.length);
      }
      if (key.ctrl || key.meta || typed === "") return;
      secretBuf.current += typed;
      return void setSecretLen(secretBuf.current.length);
    }
    if (key.ctrl && typed === "l") return void setEntries([]);
    if (key.escape) return cancel();
    if (key.pageUp) return void setOffset((o) => Math.min(o + Math.max(1, bodyHeight - 4), Math.max(0, lines.length - (bodyHeight - 2))));
    if (key.pageDown) return void setOffset((o) => Math.max(0, o - Math.max(1, bodyHeight - 4)));
    if (key.return) {
      const text = input;
      setInput("");
      return submit(text);
    }
    if (key.backspace || key.delete) return void setInput((s) => s.slice(0, -1));
    if (key.upArrow || key.downArrow) {
      if (history.length === 0) return;
      const at = key.upArrow ? (historyAt === null ? history.length - 1 : Math.max(0, historyAt - 1)) : historyAt === null ? null : historyAt + 1;
      if (at === null || at >= history.length) {
        setHistoryAt(null);
        return void setInput("");
      }
      setHistoryAt(at);
      return void setInput(history[at]!);
    }
    if (key.tab) {
      if (!input.startsWith("/") || input.includes(" ")) return;
      const names = COMMANDS.map((c) => c.name).filter((n) => n.startsWith(input.slice(1).toLowerCase()));
      if (names.length === 1) setInput(`/${names[0]} `);
      else if (names.length > 1) {
        let prefix = names[0]!;
        for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
        setInput(`/${prefix}`);
      }
      return;
    }
    if (key.ctrl || key.meta || typed === "") return;
    setInput((s) => s + typed.replace(/[\r\n]+/g, " "));
  });

  const lang = langRef.current;
  const panelRows = bodyHeight - 2;
  const rawPanel = cols >= MIN_COLS_FOR_SIDEBAR ? sidebarLines(dash) : null;
  const sidebar = rawPanel === null ? null : (rawPanel.length > panelRows ? rawPanel.filter((l) => l.text !== "") : rawPanel).slice(0, panelRows);
  const where = dash.workspace ? `${dash.workspace.name} · ${dash.workspace.currency}` : ws === null ? "setting up" : "";
  const scrolled = view.offset > 0 ? `↑ scrolled back ${view.offset} lines (${view.more} above) · PgDn returns` : null;
  const idle = secretProvider !== null ? pick(lang)("Paste the key · Enter saves · Esc cancels", "الصق المفتاح · Enter للحفظ · Esc للإلغاء") : onboardRef.current !== null ? pick(lang)("Answer the questions above · Ctrl+C quits", "جاوب على الأسئلة أعلاه · Ctrl+C للخروج") : pick(lang)("Ask me anything · type a number to pick a suggestion · / for shortcuts", "اسألني أي شي · اكتب رقم لاختيار اقتراح · / للاختصارات");
  const status = [busy !== null ? `${SPINNER[tick % SPINNER.length]} ${busy} · Esc stops` : null, scrolled].filter(Boolean).join(" · ") || idle;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Box borderStyle="single" borderColor="gray" paddingX={1} justifyContent="space-between">
        <Text>
          <Text bold color="white">{COMPACT_BANNER}</Text>
          <Text dimColor>  {where}</Text>
        </Text>
        <Text dimColor>{ledgerLabel(dash)} · v{version}</Text>
      </Box>
      <Box height={bodyHeight}>
        <Box flexGrow={1} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} overflow="hidden">
          {view.lines.map((text, i) => {
            const line = lines[view.more + i]!;
            const style = FEED_COLOR[line.tone];
            return (
              <Box key={view.more + i} flexShrink={0}>
                <Text {...(style.color ? { color: style.color } : {})} bold={style.bold === true} dimColor={style.dim === true} wrap="truncate">
                  {text === "" ? " " : text}
                </Text>
              </Box>
            );
          })}
        </Box>
        {sidebar && (
          <Box width={SIDEBAR_WIDTH} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} overflow="hidden">
            {sidebar.map((l, i) => {
              const style = PANEL_COLOR[l.tone];
              return (
                <Box key={i} flexShrink={0}>
                  <Text {...(style.color ? { color: style.color } : {})} bold={style.bold === true} dimColor={style.dim === true} wrap="truncate">
                    {l.text === "" ? " " : l.text}
                  </Text>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>
      <Box paddingX={1}>
        <Text dimColor>{status}</Text>
      </Box>
      <Box borderStyle="single" borderColor={busy !== null ? "gray" : "white"} paddingX={1}>
        <Text bold>{secretProvider !== null ? "🔒 " : "❯ "}</Text>
        <Text>{secretProvider !== null ? "•".repeat(Math.min(secretLen, 60)) : input}</Text>
        <Text>▌</Text>
      </Box>
    </Box>
  );
}
