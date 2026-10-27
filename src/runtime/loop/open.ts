// Opens everything a run needs from a workspace folder: config, policy, tools, scope, store, ledger
// and (unless one is injected) the real model driver. Shared by the CLI and the live tests.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Ledger } from "../../audit/ledger.js";
import type { SlotName } from "../../constants.js";
import { ModelCatalog } from "../../models/catalog.js";
import { CredentialResolver } from "../../models/credentials.js";
import { resolveSlot } from "../../models/slots.js";
import { loadPolicy } from "../../shield/policy.js";
import { Store } from "../../store/db.js";
import { skillRootsWithPlugins } from "../../plugins/plugins.js";
import { discoverSkills } from "../../skills/discover.js";
import { loadStyleContext } from "../../style/context.js";
import type { Pack } from "../../style/slop.js";
import { loadWorkspace } from "../../workspace/load.js";
import { ToolRegistry } from "../registry.js";
import { RunScope } from "../scope.js";
import { createDraftChecker } from "../../drafts/checker.js";
import { DraftStore } from "../../drafts/store.js";
import { ContextStore } from "../../context/store.js";
import { contextTools } from "../tools/context-update.js";
import { draftTools } from "../tools/drafts.js";
import { growthTools, type GrowthPort } from "../tools/growth.js";
import { skillTools } from "../tools/skills.js";
import { resolveClientFiles } from "../client-files.js";
import { createBuiltinTools } from "../tools/index.js";
import { createAiSdkDriver } from "./driver.js";
import type { RunDeps } from "./run.js";
import type { ModelDriver } from "./types.js";

export const LEDGER_PATH = join(".medjay", "audit-log.jsonl");
export const STORE_PATH = join(".medjay", "experiments.db");

/** For commands that only read saved runs: no model, no catalog fetch. */
export const NO_MODEL: ModelDriver = { step: async () => { throw new Error("this command does not call a model"); } };

export interface OpenRunOptions {
  dir: string;
  slot: SlotName;
  actor?: string;
  /** Replace the real driver (tests). */
  driver?: ModelDriver;
  credentials?: CredentialResolver;
  catalog?: ModelCatalog;
  now?: () => Date;
  /** The analyses the growth tools call; without it the agent has only the built-in tools. */
  growth?: GrowthPort;
  /** Where ~/.medjay and ~/.claude are looked for (tests); defaults to the user's home. */
  home?: string;
}

export interface OpenedRun {
  deps: RunDeps;
  store: Store;
  close: () => void;
}

export async function openRun(options: OpenRunOptions): Promise<OpenedRun> {
  const { dir } = options;
  const { config, dropzoneDir } = await loadWorkspace(dir);
  const policy = await loadPolicy(dir);
  const context = await loadStyleContext(dir);
  const languages = [config.localization.languages.primary, config.localization.languages.secondary].filter((l): l is string => Boolean(l));
  const packs: Pack[] = config.style.slop.packs ?? ["protocol", "extended", ...(languages.includes("ar") ? (["ar"] as const) : [])];
  const extraBanned = [...config.style.slop.extra_banned, ...context.forbiddenPhrases];

  const ledger = new Ledger(join(dir, LEDGER_PATH));
  const registry = new ToolRegistry({ policy, ledger });
  const drafts = new DraftStore(dir, {
    checker: await createDraftChecker(dir),
    audit: async ({ event, author, ...payload }) => {
      await ledger.append({ actor: String(author), event: String(event), payload });
    },
  });
  for (const tool of createBuiltinTools({ policy, style: { packs, extraBanned, allow: config.style.slop.allow, claims: context.claims, failOn: config.style.slop.fail_on }, drafts })) {
    registry.register(tool);
  }
  for (const tool of draftTools(drafts)) registry.register(tool);
  const contextStore = new ContextStore(dir, {
    audit: async ({ event, author, ...payload }) => {
      await ledger.append({ actor: String(author), event: String(event), payload });
    },
  });
  for (const tool of contextTools(contextStore)) registry.register(tool);
  if (options.growth) for (const tool of growthTools(options.growth)) registry.register(tool);
  const home = options.home ?? homedir();
  const expand = (p: string) => (p === "~" ? home : p.startsWith("~/") || p.startsWith("~\\") ? join(home, p.slice(2)) : p);
  const mounts = config.mounts.map((m) => {
    // the mount that holds this client's documents is limited to that client's folder and the shared ones
    const mapped = config.client_docs?.mount === m.name ? [config.client_docs.folder, ...config.client_docs.shared] : [];
    return { name: m.name, path: resolve(expand(m.path)), trust: m.trust, allow: [...(m.allow_paths ?? []), ...mapped] };
  });
  const scope = await RunScope.create({ workspaceDir: dir, workspaceId: config.workspace.id, dropzoneDir, client: config.workspace.id, mounts });
  const discovery = await discoverSkills((await skillRootsWithPlugins(config, { workspaceDir: dir, home })).roots);
  if (discovery.skills.length > 0) {
    for (const tool of skillTools(discovery, { clientFiles: (names) => resolveClientFiles(scope, config.client_docs, names) })) registry.register(tool);
  }
  const store = Store.open(join(dir, STORE_PATH));

  let driver = options.driver;
  if (!driver) {
    const catalog = options.catalog ?? new ModelCatalog();
    await catalog.load().catch(() => "unavailable");
    driver = createAiSdkDriver({ targets: resolveSlot(config.models, options.slot), credentials: options.credentials ?? new CredentialResolver(), catalog });
  }

  return {
    deps: {
      workspaceId: config.workspace.id,
      policy,
      ledger,
      store,
      registry,
      scope,
      driver,
      style: config.style,
      language: config.localization.languages.primary,
      extraBanned,
      now: options.now ?? (() => new Date()),
      ...(options.actor ? { actor: options.actor } : {}),
    },
    store,
    close: () => store.close(),
  };
}
