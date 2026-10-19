// The Medjay terminal app: header, activity feed, side panel and a prompt. It only chooses and shows;
// every action runs through the CLI (see runner.ts), so Shield, policy and the ledger apply unchanged.
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { COMMANDS, parseInput, resolveInput } from "./commands.js";
import { ledgerLabel, sidebarLines, emptyDashboard, type Dashboard, type PanelLine } from "./dashboard.js";
import { buildFeedLines, splashText, type Entry, type EntryKind, type FeedTone } from "./feed.js";
import type { Runner, RunHandle } from "./runner.js";
import { COMPACT_BANNER } from "./splash.js";
import { lastWindow } from "./text.js";

export interface AppProps {
  workspaceDir: string | null;
  runner: Runner;
  load: () => Promise<Dashboard>;
  version: string;
  /** Terminal size override (tests); otherwise the real terminal is followed. */
  size?: { cols: number; rows: number };
  onExit?: () => void;
}

const SIDEBAR_WIDTH = 30;
const MIN_COLS_FOR_SIDEBAR = 80;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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

const helpText = (): string =>
  [
    "Plain text goes to the agent (read, draft and propose only; it cannot write to a platform).",
    "",
    ...COMMANDS.flatMap((c) => [c.usage, `      ${c.summary}`]),
    "",
    "Keys: Enter send · Tab complete · ↑/↓ history · PgUp/PgDn scroll",
    "      Esc cancel a running command · Ctrl+L clear · Ctrl+C quit",
    "Approving, striking and rolling back stay in the terminal:",
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

export function App({ workspaceDir, runner, load, version, size: sizeOverride, onExit }: AppProps) {
  const { exit } = useApp();
  const { cols, rows } = useTerminalSize(sizeOverride);
  const nextId = useRef(2);
  const [entries, setEntries] = useState<Entry[]>([{ id: 1, kind: "splash", text: splashText() }]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyAt, setHistoryAt] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [dash, setDash] = useState<Dashboard>(emptyDashboard);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const running = useRef<RunHandle | null>(null);
  const cancelled = useRef(false);

  const add = useCallback((kind: EntryKind, text: string): number => {
    const id = nextId.current++;
    setEntries((all) => [...all, { id, kind, text }]);
    setOffset(0);
    return id;
  }, []);
  const append = useCallback((id: number, text: string) => setEntries((all) => all.map((e) => (e.id === id ? { ...e, text: e.text + text } : e))), []);

  const refresh = useCallback(() => {
    if (workspaceDir === null) return Promise.resolve();
    return load().then(setDash, () => undefined);
  }, [load, workspaceDir]);
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

  const start = useCallback(
    (argv: string[], label: string) => {
      const id = add("out", "");
      cancelled.current = false;
      setBusy(label);
      const handle = runner(argv, (text) => append(id, text));
      running.current = handle;
      void handle.done.then(({ code }) => {
        running.current = null;
        setBusy(null);
        add(cancelled.current ? "info" : code === 0 ? "info" : "err", cancelled.current ? `${label} cancelled` : code === 0 ? `${label} done` : `${label} exited with code ${code}`);
        void refresh();
      });
    },
    [add, append, refresh, runner],
  );

  const submit = useCallback(
    (raw: string) => {
      const parsed = parseInput(raw);
      const resolved = resolveInput(parsed, workspaceDir);
      if (resolved.kind === "none") return;
      setHistory((h) => (h[h.length - 1] === raw.trim() ? h : [...h, raw.trim()]));
      setHistoryAt(null);
      add("user", raw.trim());
      if (resolved.kind === "error") return void add("err", resolved.message);
      if (resolved.kind === "local") {
        if (resolved.action === "quit") return quit();
        if (resolved.action === "clear") return void setEntries([]);
        if (resolved.action === "help") return void add("out", helpText());
        return void refresh().then(() => add("info", "side panel refreshed"));
      }
      if (running.current) return void add("err", `${busy ?? "a command"} is still running; press Esc to cancel it first.`);
      start(resolved.argv, resolved.label);
    },
    [add, busy, quit, refresh, start, workspaceDir],
  );

  const feedWidth = cols >= MIN_COLS_FOR_SIDEBAR ? cols - SIDEBAR_WIDTH - 6 : cols - 4;
  const bodyHeight = Math.max(6, rows - 7);
  const lines = buildFeedLines(entries, feedWidth);
  const view = lastWindow(lines.map((l) => l.text), bodyHeight - 2, offset);

  useInput((typed, key) => {
    if (key.ctrl && typed === "c") return quit();
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

  const panelRows = bodyHeight - 2;
  const rawPanel = cols >= MIN_COLS_FOR_SIDEBAR ? sidebarLines(dash) : null;
  const sidebar = rawPanel === null ? null : (rawPanel.length > panelRows ? rawPanel.filter((l) => l.text !== "") : rawPanel).slice(0, panelRows);
  const where = dash.workspace ? `${dash.workspace.name} · ${dash.workspace.currency}` : "no workspace";
  const scrolled = view.offset > 0 ? `↑ scrolled back ${view.offset} lines (${view.more} above) · PgDn returns` : null;
  const status = [busy !== null ? `${SPINNER[tick % SPINNER.length]} running ${busy} · Esc cancels` : null, scrolled].filter(Boolean).join(" · ") || "/help for commands · PgUp/PgDn scroll";

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
        <Text bold>❯ </Text>
        <Text>{input}</Text>
        <Text>▌</Text>
      </Box>
    </Box>
  );
}
