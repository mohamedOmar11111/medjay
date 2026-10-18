// `mdj doctor`: pre-flight checklist. Never prints secrets: credential checks report only where
// each credential comes from. The one place a credential leaves the machine is the Authorization
// header sent to the endpoint it is configured for (an OpenAI-compatible proxy health check).
import { stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { verifyLedger } from "../audit/ledger.js";
import { ModelCatalog } from "../models/catalog.js";
import { CredentialResolver, probeKeystore, type CredentialRef, type KeyStore } from "../models/credentials.js";
import { resolveSlot, SLOT_NAMES, type ResolvedTarget } from "../models/slots.js";
import { isStubbed, pillarById } from "../pillars/catalog.js";
import { evaluateRules } from "../shield/evaluate.js";
import { effectiveRunLimits, loadPolicy, PolicyError } from "../shield/policy.js";
import { Store } from "../store/db.js";
import { loadStyleContext, StyleContextError } from "../style/context.js";
import { findWorkspace, loadWorkspace, WorkspaceError, type LoadedWorkspace } from "../workspace/load.js";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  id: "node" | "keychain" | "workspace" | "policy" | "pillars" | "credentials" | "endpoints" | "models" | "dropzone" | "style" | "store" | "ledger";
  name: string;
  status: CheckStatus;
  detail: string;
  remedy?: string;
}

export interface DoctorOptions {
  cwd: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  keystore: KeyStore;
  fetchFn: typeof fetch;
  catalog?: ModelCatalog;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

const MIN_NODE_MAJOR = 22;
const PROBE_TIMEOUT_MS = 2500;
const AVAILABLE_SHOWN = 8;

const check = (
  id: DoctorCheck["id"],
  name: string,
  status: CheckStatus,
  detail: string,
  remedy?: string,
): DoctorCheck => (remedy === undefined ? { id, name, status, detail } : { id, name, status, detail, remedy });

const skipped = (id: DoctorCheck["id"], name: string) => check(id, name, "skip", "needs a valid workspace.yaml");

function checkNode(): DoctorCheck {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= MIN_NODE_MAJOR
    ? check("node", "Node.js", "pass", `Node ${process.versions.node}`)
    : check("node", "Node.js", "fail", `Node ${process.versions.node} is too old`, `Install Node ${MIN_NODE_MAJOR} or newer`);
}

async function checkKeychain(keystore: KeyStore): Promise<DoctorCheck> {
  const result = await probeKeystore(keystore);
  if (result.ok) return check("keychain", "OS keychain", "pass", "read and write access confirmed");
  return check(
    "keychain",
    "OS keychain",
    "warn",
    `keychain unavailable: ${result.error}`,
    "Headless? Set provider keys as MEDJAY_<PROVIDER>_API_KEY environment variables (for example MEDJAY_ANTHROPIC_API_KEY) instead",
  );
}

async function loadForDoctor(options: DoctorOptions): Promise<{ check: DoctorCheck; loaded?: LoadedWorkspace; dir?: string }> {
  const dir = options.workspaceDir ?? (await findWorkspace(options.cwd));
  if (dir === null) {
    return { check: check("workspace", "workspace.yaml", "skip", "no workspace found here", "Run `mdj init` to create one") };
  }
  try {
    const loaded = await loadWorkspace(dir);
    if (loaded.migrated) {
      return {
        check: check("workspace", "workspace.yaml", "warn", `${loaded.config.workspace.id} uses the old schema 0 (read in memory only)`, "Run `mdj migrate` to upgrade it (the original is backed up)"),
        loaded,
        dir,
      };
    }
    return { check: check("workspace", "workspace.yaml", "pass", `${loaded.config.workspace.id} (${dir})`), loaded, dir };
  } catch (error) {
    const detail =
      error instanceof WorkspaceError
        ? [error.message.split("\n")[0], ...error.issues.slice(0, 8).map((i) => `${i.path || "(root)"}: ${i.message}`)].join("; ")
        : String(error);
    return { check: check("workspace", "workspace.yaml", "fail", detail, "Fix workspace.yaml (see the paths above)"), dir };
  }
}

function slotTargets(loaded: LoadedWorkspace): { target: ResolvedTarget; primary: boolean }[] {
  return SLOT_NAMES.flatMap((name) =>
    resolveSlot(loaded.config.models, name).map((target, index) => ({ target, primary: index === 0 })),
  );
}

function checkPillars(loaded: LoadedWorkspace): DoctorCheck {
  const ids = loaded.config.pillars.active;
  const stubbed = ids.filter(isStubbed);
  if (stubbed.length > 0) {
    const names = stubbed.map((id) => `${id} (${pillarById(id)?.title ?? "?"})`).join(", ");
    return check("pillars", "Pillars", "warn", `active but stubbed until after M3 (no skills run yet): ${names}`);
  }
  return check("pillars", "Pillars", "pass", `${ids.length} active: ${ids.join(", ")}`);
}

async function checkCredentials(loaded: LoadedWorkspace, options: DoctorOptions): Promise<DoctorCheck> {
  const resolver = new CredentialResolver({ keystore: options.keystore, env: options.env });
  const needed = new Map<string, { ref: CredentialRef; primary: boolean }>();
  for (const { target, primary } of slotTargets(loaded)) {
    if (!target.credentialRequired) continue;
    const ref = { keychainRef: target.keychainRef, envFallback: target.envFallback };
    const key = `${ref.keychainRef}\0${ref.envFallback}`;
    needed.set(key, { ref, primary: (needed.get(key)?.primary ?? false) || primary });
  }
  if (needed.size === 0) return check("credentials", "Credentials", "pass", "no vendor credentials required");

  const found: string[] = [];
  const missingPrimary: CredentialRef[] = [];
  const missingFallback: CredentialRef[] = [];
  for (const { ref, primary } of needed.values()) {
    const status = await resolver.status(ref);
    if (status.source === "none") (primary ? missingPrimary : missingFallback).push(ref);
    else found.push(`${ref.keychainRef}: ${status.source}`);
  }
  const fix = (refs: CredentialRef[]) => refs.map((r) => `\`mdj auth set ${r.keychainRef}\` or set ${r.envFallback}`).join("; ");
  const names = (refs: CredentialRef[]) => refs.map((r) => r.keychainRef).join(", ");
  if (missingPrimary.length > 0) {
    return check("credentials", "Credentials", "fail", `missing: ${names(missingPrimary)}`, fix(missingPrimary));
  }
  if (missingFallback.length > 0) {
    return check("credentials", "Credentials", "warn", `fallback credentials missing: ${names(missingFallback)}`, fix(missingFallback));
  }
  return check("credentials", "Credentials", "pass", found.join(", "));
}

type ProbeResult =
  | { kind: "down" }
  | { kind: "auth"; status: number }
  | { kind: "http"; status: number }
  | { kind: "unreadable" }
  | { kind: "ok"; models: { id: string; owned_by?: string }[] };

function parseModelList(text: string): { id: string; owned_by?: string }[] | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const record = json as { data?: unknown; models?: unknown };
  const list = Array.isArray(record?.data) ? record.data : Array.isArray(record?.models) ? record.models : undefined;
  if (!list) return undefined;
  return list.flatMap((entry: unknown) => {
    const e = entry as { id?: unknown; name?: unknown; owned_by?: unknown };
    const id = typeof e?.id === "string" ? e.id : typeof e?.name === "string" ? e.name : undefined;
    return id ? [{ id, ...(typeof e.owned_by === "string" ? { owned_by: e.owned_by } : {}) }] : [];
  });
}

async function probe(url: string, headers: Record<string, string>, fetchFn: typeof fetch): Promise<ProbeResult> {
  try {
    const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (response.status === 401 || response.status === 403) return { kind: "auth", status: response.status };
    if (!response.ok) return { kind: "http", status: response.status };
    const models = parseModelList(await response.text());
    return models ? { kind: "ok", models } : { kind: "unreadable" };
  } catch {
    return { kind: "down" };
  }
}

const hasModel = (models: { id: string }[], model: string) => models.some((m) => m.id === model || m.id === `${model}:latest`);

async function checkEndpoints(loaded: LoadedWorkspace, options: DoctorOptions): Promise<DoctorCheck> {
  const targets = slotTargets(loaded).filter(({ target }) => target.baseURL !== undefined);
  if (targets.length === 0) return check("endpoints", "Endpoints", "pass", "no local endpoints configured");

  const resolver = new CredentialResolver({ keystore: options.keystore, env: options.env });
  const probes = new Map<string, Promise<ProbeResult>>();
  const probeOnce = (target: ResolvedTarget): Promise<ProbeResult> => {
    const url = `${(target.baseURL as string).replace(/\/$/, "")}${target.healthcheckPath}`;
    let pending = probes.get(url);
    if (!pending) {
      pending = (async () => {
        const headers: Record<string, string> = {};
        if (target.provider === "openai" || target.provider === "openai_compatible") {
          // sent only to the endpoint this credential is configured for
          const credential = await resolver.resolve({ keychainRef: target.keychainRef, envFallback: target.envFallback });
          if (credential.value) headers.authorization = `Bearer ${credential.value}`;
        }
        return probe(url, headers, options.fetchFn);
      })();
      probes.set(url, pending);
    }
    return pending;
  };

  const lines: { severity: "fail" | "warn" | "ok"; text: string; remedy?: string }[] = [];
  for (const { target, primary } of targets) {
    const result = await probeOnce(target);
    const host = new URL(target.baseURL as string).host;
    const bad = primary ? "fail" : "warn";
    switch (result.kind) {
      case "down":
        lines.push({
          severity: bad,
          text: `${host} not reachable`,
          remedy: target.provider === "ollama" ? "Start Ollama (`ollama serve`) or fix base_url in workspace.yaml" : "Start the service or fix base_url in workspace.yaml",
        });
        break;
      case "auth":
        lines.push({
          severity: bad,
          text: `${host} requires authentication (HTTP ${result.status})`,
          remedy: `Store its key with \`mdj auth set ${target.keychainRef}\` or set ${target.envFallback}`,
        });
        break;
      case "http":
        lines.push({
          severity: bad,
          text: `${host}${target.healthcheckPath} returned HTTP ${result.status}`,
          remedy: "Check base_url and healthcheck_path; Ollama's OpenAI-compatible endpoint is http://localhost:11434/v1",
        });
        break;
      case "unreadable":
        lines.push({ severity: "warn", text: `${host} reachable but its model list could not be read` });
        break;
      case "ok": {
        const entry = result.models.find((m) => m.id === target.model || m.id === `${target.model}:latest`);
        if (hasModel(result.models, target.model)) {
          lines.push({
            severity: "ok",
            text: `${host} ok, ${result.models.length} models, ${target.model} found${entry?.owned_by ? ` (owned_by ${entry.owned_by})` : ""}`,
          });
        } else {
          const ids = result.models.map((m) => m.id);
          const shown = ids.slice(0, AVAILABLE_SHOWN).join(", ");
          lines.push({
            severity: bad,
            text: `model ${target.model} not found at ${host} (available: ${shown || "none"}${ids.length > AVAILABLE_SHOWN ? `, +${ids.length - AVAILABLE_SHOWN} more` : ""})`,
            remedy: target.provider === "ollama" ? `Run \`ollama pull ${target.model}\` or pick an installed model` : "Pick a model the endpoint lists, or fix base_url",
          });
        }
      }
    }
  }
  const status: CheckStatus = lines.some((l) => l.severity === "fail") ? "fail" : lines.some((l) => l.severity === "warn") ? "warn" : "pass";
  const remedies = [...new Set(lines.filter((l) => l.severity !== "ok" && l.remedy).map((l) => l.remedy as string))];
  return check("endpoints", "Endpoints", status, lines.map((l) => l.text).join("; "), remedies.length > 0 ? remedies.join("; ") : undefined);
}

async function checkModels(loaded: LoadedWorkspace, catalog: ModelCatalog): Promise<DoctorCheck> {
  const vendor = slotTargets(loaded)
    .map(({ target }) => target)
    .filter((t) => (t.provider === "anthropic" || t.provider === "google" || t.provider === "openai") && t.baseURL === undefined);
  if (vendor.length === 0) return check("models", "Model ids", "pass", "no vendor models configured");
  if ((await catalog.load()) === "unavailable") {
    return check("models", "Model ids", "skip", "model catalog unavailable (offline); ids were not checked");
  }
  const unknown = [...new Set(vendor.filter((t) => !catalog.find(t.provider, t.model)).map((t) => `${t.provider}/${t.model}`))];
  if (unknown.length > 0) {
    return check("models", "Model ids", "warn", `not in the models.dev catalog (typo?): ${unknown.join(", ")}`, "Check the spelling against https://models.dev");
  }
  return check("models", "Model ids", "pass", `${new Set(vendor.map((t) => `${t.provider}/${t.model}`)).size} vendor model ids found in the catalog`);
}

async function checkDropzone(loaded: LoadedWorkspace): Promise<DoctorCheck> {
  const shown = relative(loaded.dir, loaded.dropzoneDir) || ".";
  const isDir = await stat(loaded.dropzoneDir).then((s) => s.isDirectory(), () => false);
  return isDir
    ? check("dropzone", "Dropzone", "pass", shown)
    : check("dropzone", "Dropzone", "warn", `${shown} does not exist yet`, `Create it (mkdir ${shown}) and drop exports there`);
}

const TOOL_CLASS_RULES = ["read.*", "draft.*", "propose.*"] as const;

/** Never edits the policy: an older file that lacks the tool-class rules gets a hint, not a silent change. */
async function checkPolicyFile(dir: string): Promise<DoctorCheck> {
  try {
    const policy = await loadPolicy(dir);
    const { limits, raised } = effectiveRunLimits(policy);
    const summary = `${limits.max_steps} steps, ${limits.max_tokens} tokens, ${limits.max_cost_usd} per run`;
    const raisedNote = raised.length > 0 ? `; raised above the engine default: ${raised.map((r) => `${r.key} ${r.default}->${r.configured}`).join(", ")}` : "";
    const notAllowed = TOOL_CLASS_RULES.filter((rule) => evaluateRules(policy.rules, rule.replace("*", "tool"), "tool:tool", policy.defaults.effect) !== "allow");
    if (notAllowed.length > 0) {
      return check(
        "policy",
        "Policy",
        "warn",
        `${notAllowed.join(", ")} not allowed by shield.policy.yaml, so an agent run would pause (approval_required) at the first such tool call; limits: ${summary}${raisedNote}`,
        `If you want agent runs to use them, add rules like { action: "read.*", resource: "*", effect: allow } (same for draft.* and propose.*). Medjay does not change your policy for you`,
      );
    }
    return check("policy", "Policy", "pass", `limits: ${summary}${raisedNote}; read.*, draft.*, propose.* allowed`);
  } catch (error) {
    if (error instanceof PolicyError) {
      return check("policy", "Policy", "fail", [error.message.split("\n")[0], ...error.issues.slice(0, 6).map((i) => `${i.path || "(root)"}: ${i.message}`)].join("; "), "Fix shield.policy.yaml (see the paths above)");
    }
    throw error;
  }
}

async function checkStyle(loaded: LoadedWorkspace): Promise<DoctorCheck> {
  const style = loaded.config.style;
  try {
    const ctx = await loadStyleContext(loaded.dir);
    const claims = ctx.claims ? `${ctx.claims.claims.length} claims (${ctx.claims.claims.filter((c) => c.status === "verified").length} verified)` : "no claim register (numbers are not checked)";
    return check(
      "style",
      "Style",
      "pass",
      `caveman internal=${style.caveman.internal}, whatsapp=${style.caveman.whatsapp}; slop fails on ${style.slop.fail_on}; ${ctx.forbiddenPhrases.length + style.slop.extra_banned.length} forbidden phrases; ${claims}`,
    );
  } catch (error) {
    if (error instanceof StyleContextError) {
      return check("style", "Style", "fail", [error.message.split("\n")[0], ...error.issues.slice(0, 6).map((i) => `${i.path || "(root)"}: ${i.message}`)].join("; "), "Fix the frontmatter in context/brand-voice.md or context/claims.md");
    }
    throw error;
  }
}

function checkStore(dir: string): DoctorCheck {
  try {
    const store = Store.open(join(dir, ".medjay", "experiments.db"));
    const detail = `schema v${store.schemaVersion()}, ${store.journalMode()} mode`;
    store.close();
    return check("store", "Machine-state DB", "pass", detail);
  } catch (error) {
    return check("store", "Machine-state DB", "fail", `cannot open .medjay/experiments.db: ${error instanceof Error ? error.message : String(error)}`, "Check folder permissions and that nothing else holds the file");
  }
}

async function checkLedger(dir: string): Promise<DoctorCheck> {
  const result = await verifyLedger(join(dir, ".medjay", "audit-log.jsonl"));
  if (result.ok) {
    return check("ledger", "Audit ledger", "pass", result.entries === 0 ? "empty" : `${result.entries} entries, head ${result.head.slice(0, 12)}`);
  }
  return check(
    "ledger",
    "Audit ledger",
    "fail",
    `${result.failure.kind} at line ${result.failure.line}: ${result.failure.message}`,
    "Investigate before trusting this workspace's history; restore from backup or version control",
  );
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [checkNode(), await checkKeychain(options.keystore)];
  const { check: workspaceCheck, loaded, dir } = await loadForDoctor(options);
  checks.push(workspaceCheck);
  checks.push(dir ? await checkPolicyFile(dir) : skipped("policy", "Policy"));

  if (loaded) {
    checks.push(checkPillars(loaded));
    checks.push(await checkCredentials(loaded, options));
    checks.push(await checkEndpoints(loaded, options));
    checks.push(await checkModels(loaded, options.catalog ?? new ModelCatalog()));
    checks.push(await checkDropzone(loaded));
    checks.push(await checkStyle(loaded));
  } else {
    checks.push(
      skipped("pillars", "Pillars"),
      skipped("credentials", "Credentials"),
      skipped("endpoints", "Endpoints"),
      skipped("models", "Model ids"),
      skipped("dropzone", "Dropzone"),
      skipped("style", "Style"),
    );
  }
  checks.push(dir ? checkStore(dir) : skipped("store", "Machine-state DB"));
  checks.push(dir ? await checkLedger(dir) : skipped("ledger", "Audit ledger"));
  return { ok: checks.every((c) => c.status !== "fail"), checks };
}
