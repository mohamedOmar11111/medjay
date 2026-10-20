# Phase 1: classified model errors and `/connect` in the TUI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the catch-all "I'm not connected to an AI model yet" with specific, actionable messages, and let a marketer connect a model key from inside the TUI without the key ever touching a command line.

**Architecture:** A pure classifier turns the text of a failed `mdj run` into a failure kind. `askAgent` uses it to pick an answer. `/connect` is a TUI-local action that collects the key in a masked prompt and passes it to the child `mdj auth set <provider>` on stdin only (new optional `stdin` on the runner), then confirms with a tiny agent probe.

**Tech Stack:** TypeScript (Node 24, ESM), Ink 8 + React 19, vitest 5 + ink-testing-library.

**Spec:** [docs/superpowers/specs/2026-10-20-growth-session-and-tools-design.md](../specs/2026-10-20-growth-session-and-tools-design.md), section 6 and build step 1. Phases 2-5 (events stream, growth tools, ask prompts, propose plan) get their own plans.

## Global Constraints

- TUI is a front end only: it spawns the same CLI; no capability the CLI lacks; write verbs (`approve`, `strike`, `rollback`, `hold`, `reject`) stay refused.
- A key is never placed in argv, the feed, history, logs or the ledger.
- Commands, hashes and plan ids stay ASCII in Arabic mode. Arabic copy uses Egyptian/Gulf performance vocabulary and is unreviewed by a native marketer.
- Architecture layers: `tui` may import `cli`, `shared`, etc. (see `test/architecture.test.ts`).
- Tests first; commit after each task; commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Do not push until the owner says so.

## File structure

- Create `src/tui/model-errors.ts` (+ `model-errors.test.ts`): `classifyModelFailure`.
- Modify `src/tui/answers.ts` (+ test): `modelErrorAnswer`.
- Modify `src/tui/ask.ts` (+ test): use the classifier.
- Modify `src/tui/runner.ts` (+ new `runner.test.ts`): optional `stdin`.
- Modify `src/tui/commands.ts` (+ test): `/connect`.
- Modify `src/tui/app.tsx` (+ `app.test.tsx`): masked secret prompt.

### Task 1: classify a failed model call

**Files:** Create `src/tui/model-errors.ts`, `src/tui/model-errors.test.ts`.

**Interfaces:**
- Produces: `type ModelFailureKind = "no_key" | "key_malformed" | "key_rejected" | "quota" | "model_not_found" | "network" | "other"`; `interface ModelFailure { kind: ModelFailureKind; provider?: string; detail: string }`; `classifyModelFailure(text: string): ModelFailure | null` (null when the text shows no model failure).

- [ ] **Step 1: failing test** (`src/tui/model-errors.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { classifyModelFailure } from "./model-errors.js";

const kind = (t: string) => classifyModelFailure(t)?.kind;

describe("classifyModelFailure", () => {
  it("tells a missing key from a rejected key", () => {
    expect(kind('auth: all model targets failed: anthropic/x (auth: no API key for anthropic: store one with "mdj auth set anthropic")')).toBe("no_key");
    expect(kind("auth: all model targets failed: openai/gpt-5.4-mini (auth: Invalid API key)")).toBe("key_rejected");
  });
  it("recognises a malformed stored key before calling it a network problem", () => {
    expect(kind("connection: all model targets failed: anthropic/c (connection: Failed after 3 attempts. Last error: AI_APICallError: Cannot connect to API: invalid x-api-key header)")).toBe("key_malformed");
  });
  it("reads a spend cap with its reset date", () => {
    const f = classifyModelFailure("failed: You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.");
    expect(f?.kind).toBe("quota");
    expect(f?.detail).toContain("2026-11-01");
  });
  it("recognises network and unknown-model failures and names the provider", () => {
    expect(kind("connection: all model targets failed: google/g (connection: Cannot connect to API: fetch failed)")).toBe("network");
    const f = classifyModelFailure("all model targets failed: openai/gpt-9 (other: The model gpt-9 does not exist)");
    expect(f).toMatchObject({ kind: "model_not_found", provider: "openai" });
  });
  it("returns null for ordinary output", () => {
    expect(classifyModelFailure("Cut the broad Reels ad set first.")).toBeNull();
  });
});
```

- [ ] **Step 2:** `npx vitest run src/tui/model-errors.test.ts` → FAIL (module missing).

- [ ] **Step 3: implement** (`src/tui/model-errors.ts`)

```ts
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
```

- [ ] **Step 4:** run the test → PASS.
- [ ] **Step 5:** `git add src/tui/model-errors* && git commit -m "feat(tui): classify a failed model call by cause"`.

### Task 2: plain-language answers for each cause

**Files:** Modify `src/tui/answers.ts` (replace `noModelAnswer`'s single use; keep export for the no-key case), `src/tui/answers.test.ts`.

**Interfaces:**
- Consumes: `ModelFailure` from Task 1.
- Produces: `modelErrorAnswer(failure: ModelFailure, lang: Language): Answer`.

- [ ] **Step 1: failing test** (append to `answers.test.ts`, import `modelErrorAnswer`)

```ts
describe("modelErrorAnswer", () => {
  const f = (kind: Parameters<typeof modelErrorAnswer>[0]["kind"], detail = "d", provider = "openai") => ({ kind, provider, detail });
  it("says what is wrong and the exact next step, in ASCII commands", () => {
    expect(text(modelErrorAnswer(f("no_key"), "en"))).toContain("/connect openai");
    expect(text(modelErrorAnswer(f("key_rejected"), "en"))).toMatch(/rejected/);
    expect(text(modelErrorAnswer(f("key_malformed"), "en"))).toMatch(/pasted|stray/);
    expect(text(modelErrorAnswer(f("quota", "regain access on 2026-11-01 at 00:00 UTC"), "en"))).toContain("2026-11-01");
    expect(text(modelErrorAnswer(f("network"), "en"))).toMatch(/reach/);
    expect(text(modelErrorAnswer(f("model_not_found"), "en"))).toContain("workspace.yaml");
  });
  it("answers in Arabic with ASCII commands", () => {
    const a = modelErrorAnswer(f("no_key", "d", "anthropic"), "ar");
    expect(a.headline).toMatch(/[؀-ۿ]/);
    expect(text(a, "ar")).toContain("/connect anthropic");
  });
  it("never repeats the old catch-all for a stored-but-rejected key", () => {
    expect(text(modelErrorAnswer(f("key_rejected"), "en"))).not.toMatch(/not connected to an AI model yet/);
  });
});
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: implement** (in `answers.ts`, after `noModelAnswer`; import `ModelFailure` type)

```ts
export function modelErrorAnswer(f: ModelFailure, lang: Language): Answer {
  const p = f.provider ?? "anthropic";
  const L = pick(lang);
  const next = helpAnswer(lang, false).next.slice(0, 4);
  const connect = L(`Type /connect ${p} to paste a fresh key (it is hidden and stored in your system keychain).`, `اكتب /connect ${p} وألصق مفتاحاً جديداً (يبقى مخفياً ويُحفظ في مفاتيح النظام).`);
  switch (f.kind) {
    case "no_key":
      return { headline: L(`I don't have a key for ${p} yet.`, `ما عندي مفتاح لـ ${p} للحين.`), body: [connect], next };
    case "key_rejected":
      return { headline: L(`${p} rejected the saved key.`, `${p} رفض المفتاح المحفوظ.`), body: [L("It may be expired, revoked, or copied wrong.", "ممكن انتهت صلاحيته أو انلغى أو انسخ غلط."), connect], next };
    case "key_malformed":
      return { headline: L("The saved key has stray characters from pasting, so it can't be sent.", "المفتاح المحفوظ فيه رموز زيادة من اللصق، فما ينفع يُرسل."), body: [connect], next };
    case "quota":
      return { headline: L(`${p} says your spending limit is reached.`, `${p} يقول إنك وصلت حد الصرف.`), body: [f.detail, L("Raise the limit in your provider's billing page, or connect another provider with /connect.", "ارفع الحد من صفحة الفوترة عند المزود، أو اربط مزوداً ثانياً بـ /connect.")], next };
    case "model_not_found":
      return { headline: L("That model name isn't available on your account.", "اسم النموذج هذا مو متاح في حسابك."), body: [L("Pick another model in workspace.yaml (the models: slots section).", "اختر نموذجاً ثانياً في workspace.yaml (قسم models: slots).")], next };
    case "network":
      return { headline: L(`I couldn't reach ${p}.`, `ما قدرت أوصل لـ ${p}.`), body: [L("Check your internet connection and try again.", "تأكد من الإنترنت وجرّب مرة ثانية.")], next };
    default:
      return { headline: L("The AI model call failed.", "فشل الاتصال بنموذج الذكاء."), body: [f.detail], next };
  }
}
```

- [ ] **Step 4:** run → PASS. **Step 5:** commit `feat(tui): specific answers for each model failure`.

### Task 3: use the classifier in `askAgent`

**Files:** Modify `src/tui/ask.ts:111-121`, `src/tui/ask.test.ts`.

**Interfaces:** Consumes `classifyModelFailure`, `modelErrorAnswer`.

- [ ] **Step 1: failing tests** (add to `askAgent` describe; keep the existing missing-key test but update its expectation)

```ts
it("a missing key points to /connect with the provider", async () => {
  const { ctx } = ctxWith(() => ({ out: "run run_x: failed after 0 step(s)\n", err: 'auth: all model targets failed: anthropic/x (auth: no API key for anthropic: store one with "mdj auth set anthropic")\n', code: 1 }));
  const r = await askAgent("write three headlines", ctx);
  expect(r.text).toMatch(/^# I don't have a key for anthropic yet/);
  expect(r.text).toContain("/connect anthropic");
});
it("a rejected key is not reported as 'not connected'", async () => {
  const { ctx } = ctxWith(() => ({ out: "run run_x: failed after 0 step(s)\n", err: "auth: all model targets failed: openai/gpt-5.4-mini (auth: Invalid API key)\n", code: 1 }));
  const r = await askAgent("hi", ctx);
  expect(r.text).toMatch(/^# openai rejected the saved key/);
});
it("a spend cap shows the reset date", async () => {
  const { ctx } = ctxWith(() => ({ out: "run run_x: failed after 0 step(s), 0 tokens\n", err: "failed: You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.\n", code: 1 }));
  expect((await askAgent("hi", ctx)).text).toContain("2026-11-01");
});
```

Change the old test `explains a missing model key in plain words` to expect `/^# I don't have a key for anthropic yet/`.

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: implement** replace the regex line in `askAgent`:

```ts
const failure = c.code !== 0 ? classifyModelFailure(`${c.err}\n${c.out}`) : null;
if (failure) return reply(modelErrorAnswer(failure, ctx.lang), ctx.lang);
```

(import both; remove `noModelAnswer` import if unused.)

- [ ] **Step 4:** run `npx vitest run src/tui` → PASS. **Step 5:** commit `fix(tui): say why the model call failed instead of "not connected"`.

### Task 4: runner can pipe stdin (for secrets)

**Files:** Modify `src/tui/runner.ts`; create `src/tui/runner.test.ts`.

**Interfaces:** `type Runner = (argv, onChunk, options?: { stdin?: string }) => RunHandle`. Existing callers unchanged.

- [ ] **Step 1: failing test** (`runner.test.ts`) using a throwaway script that echoes stdin length and its argv:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnRunner } from "./runner.js";

describe("spawnRunner stdin", () => {
  it("passes stdin to the child without putting it in argv", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mdj-runner-"));
    const cli = join(dir, "echo.mjs");
    writeFileSync(cli, 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify({len:s.length,argvHasSecret:process.argv.join(" ").includes("sekret")})));');
    let out = "";
    const { code } = await spawnRunner(cli)(["auth", "set", "x"], (t) => (out += t), { stdin: "sekret-value" }).done;
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ len: 12, argvHasSecret: false });
  });
  it("still gives a child with no stdin option an empty stdin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mdj-runner-"));
    const cli = join(dir, "e.mjs");
    writeFileSync(cli, 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(s.length));');
    let out = "";
    await spawnRunner(cli)([], (t) => (out += t)).done;
    expect(out.trim()).toBe("0");
  });
});
```

- [ ] **Step 2:** run → FAIL (type error / arg ignored).
- [ ] **Step 3: implement** in `runner.ts`: change the `Runner` type to add `options?: { stdin?: string }`; in `spawn`, use `stdio: [options?.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"]`; after spawn: `if (options?.stdin !== undefined) child.stdin!.end(options.stdin);`. Update the header comment: "a child has no stdin unless one value is given for a single command (used only to hand a pasted key to `auth set`)".
- [ ] **Step 4:** run → PASS. **Step 5:** commit `feat(tui): runner can hand one value to a child on stdin`.

### Task 5: `/connect` command and masked prompt

**Files:** Modify `src/tui/commands.ts`, `src/tui/commands.test.ts`, `src/tui/app.tsx`, `src/tui/app.test.tsx`.

**Interfaces:**
- `Resolution` local action gains `"connect"` with `provider: string`; providers allowed: `anthropic`, `google`, `openai`, `openai_compatible`; default provider = `anthropic`.
- Consumes `cleanPastedSecret` from `../cli/secret-input.js`, the `Runner` stdin option, `classifyModelFailure`.

- [ ] **Step 1: failing tests**

`commands.test.ts`:
```ts
it("/connect resolves to a local action with a known provider and refuses others", () => {
  expect(resolveInput(parseInput("/connect openai"), null)).toEqual({ kind: "local", action: "connect", provider: "openai" });
  expect(resolveInput(parseInput("/connect"), null)).toEqual({ kind: "local", action: "connect", provider: "anthropic" });
  expect(resolveInput(parseInput("/connect sk-ant-abc"), null)).toMatchObject({ kind: "error" });
});
```
`app.test.tsx` (follow the file's existing render helper; the fake runner records `(argv, options)`):
```ts
it("/connect asks for the key hidden, stores it via stdin only, and confirms with a probe", async () => {
  // type "/connect openai", Enter; assert feed shows the prompt and not any key text
  // type "sk-test-123", assert the frame shows "••••" and never "sk-test-123"
  // Enter; assert runner got argv ["auth","set","openai"] with options.stdin "sk-test-123"
  // and that no argv anywhere contains "sk-test-123"; assert history does not contain it
  // then the probe call is ["run","--workspace",<dir>,"--","Reply with the single word OK."]
});
it("shows the specific reason when the probe fails", async () => { /* fake probe returns Invalid API key -> feed contains "rejected the saved key" */ });
```
(When implementing, write these out fully against the helper already in `app.test.tsx`; the steps above are the assertions that must hold.)

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: implement**
  - `commands.ts`: add `{ name: "connect", usage: "/connect [anthropic|google|openai|openai_compatible]", summary: "connect an AI model key (hidden input)" }` to `COMMANDS`; extend `Resolution` local with `provider?: string` and action `"connect"`; in `resolveInput` handle `case "connect"` before the workspace check: provider = `args[0] ?? "anthropic"`; if not in the allowed set return `fail("providers: anthropic, google, openai, openai_compatible")`.
  - `app.tsx`: add `const secretFor = useRef<string | null>(null)` and `const [secretLen, setSecretLen] = useState(0)`; in `runShortcut` for action `connect`: set `secretFor.current = provider`, `add("info", "Paste your <provider> key now. It is hidden and goes straight to your system keychain. Esc cancels.")`. In `useInput`: if `secretFor.current !== null`: Esc clears it; Enter takes the buffered value, `cleanPastedSecret`, empty → message, else run `tracked(["auth","set",provider], onChunk, { stdin: value })`, then (if code 0) run the probe via `tracked(["run","--workspace",dir,"--","Reply with the single word OK."], ...)`, classify the result with `classifyModelFailure` and show `modelErrorAnswer` or "Connected: <provider> works."; typed characters append to a ref buffer only (never to `input`, `history`, or entries); the prompt line renders `"•".repeat(len)`. `submit` must not be called for the secret.
- [ ] **Step 4:** run `npx vitest run src/tui` → PASS; then `npm run build` and the full suite.
- [ ] **Step 5:** commit `feat(tui): /connect pastes a key hidden and verifies it`.

### Task 6: docs and live check

- [ ] Add a short paragraph to `docs/SPEC.md` §30.18: error classification and `/connect` (key via stdin only, probe costs one tiny agent call).
- [ ] Rebuild; with a pty smoke script (as in `C:\tmp\ptytest`) launch `mdj` in a scratch workspace with no key: ask a question; expect "I don't have a key for ..." with `/connect`. Report honestly if the pty check cannot run.
- [ ] Commit `docs: classified model errors and /connect`. Do not push.

## Self-review

- Spec section 6 coverage: classification (Tasks 1-3), `/connect` masked, stdin-only (Tasks 4-5), probe (Task 5), explicit base URLs (already done and tested in `models/factory.ts`).
- Types: `ModelFailure`/`ModelFailureKind` (Task 1) used by Tasks 2, 3, 5; `Runner` options (Task 4) used by Task 5.
- Known limit: the probe costs one tiny model call and creates a saved run; the spec's "one-token probe" is approximated with `mdj run`, because the CLI has no dedicated ping command.
