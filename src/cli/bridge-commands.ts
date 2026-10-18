import { createServer } from "node:http";
import type { Command } from "commander";
import { Option } from "commander";
import { diagnose } from "../analysis/diagnose.js";
import { loadUnitEconomics } from "../analysis/simulate.js";
import { handleWebhook, processJobs, type BridgeDeps, type WebhookResult } from "../bridge/handler.js";
import { buildWebhook, type SimKind } from "../bridge/simulator.js";
import { CloudApiTransport, ConsoleTransport, deliver, GenericWebhookTransport, type BridgeTransport } from "../bridge/transport.js";
import { PRESETS, resolveWebhook, webhookFromWorkspace, type WebhookSpec } from "../bridge/webhook-spec.js";
import { BridgeRepo } from "../bridge/queue.js";
import { CredentialResolver, KeyringStore } from "../models/credentials.js";
import { simulatePlan } from "../plan/simulate-plan.js";
import { loadWorkspace } from "../workspace/load.js";
import { openAnalysis } from "./analysis-commands.js";
import { cliActor, guarded, openPlanContext, workspaceDirOrThrow } from "./util.js";

const SIM_KINDS: SimKind[] = ["text", "voice", "voice_text", "button", "image"];
const DEFAULT_SIM_SECRET = "medjay-simulator-secret";

interface OpenedBridge {
  deps: BridgeDeps;
  transport: BridgeTransport;
  close: () => void;
}

/** Everything the bridge needs from a real workspace. `secret` overrides the configured one (simulator only). */
async function openBridge(workspaceOption: string | undefined, overrides: { secret?: string; preset?: string } = {}): Promise<OpenedBridge> {
  const dir = await workspaceDirOrThrow(workspaceOption);
  const { config } = await loadWorkspace(dir);
  const wa = config.command_bridge.whatsapp;
  let webhook: WebhookSpec;
  if (overrides.preset) {
    const preset = PRESETS[overrides.preset];
    if (!preset) throw new Error(`unknown preset "${overrides.preset}"; known: ${Object.keys(PRESETS).join(", ")}`);
    webhook = preset.provider === "cloud_api" ? resolveWebhook({ provider: "cloud_api" }) : resolveWebhook({ provider: "generic_hmac", preset: overrides.preset });
  } else {
    webhook = webhookFromWorkspace(wa);
  }

  let secret = overrides.secret ?? "";
  if (secret === "" && wa.credentials) {
    const resolved = await new CredentialResolver().resolve({ keychainRef: wa.credentials.webhook_secret.keychain_ref, envFallback: wa.credentials.webhook_secret.env_fallback });
    secret = resolved.value ?? "";
  }

  const creds = new CredentialResolver();
  const ctx = await openPlanContext(workspaceOption, true);
  const keystore = new KeyringStore();
  const resolver = {
    resolve: async (ref: { env?: string; keychain_ref?: string }) => {
      if (ref.env) return process.env[ref.env]?.trim() || undefined;
      if (ref.keychain_ref) return (await keystore.get(ref.keychain_ref).catch(() => null)) ?? undefined;
      return undefined;
    },
  };
  const deps: BridgeDeps = {
    workspaceId: ctx.workspaceId,
    webhook,
    secret,
    policy: ctx.deps.policy,
    ledger: ctx.deps.ledger,
    store: ctx.store,
    plans: ctx.deps,
    resolver,
    now: () => new Date(),
    reads: {
      report: async () => {
        const w = await openAnalysis(workspaceOption);
        try {
          await w.ingest();
          const snapshot = w.snapshot(7);
          return { snapshot, diagnosis: diagnose(snapshot) };
        } finally {
          w.close();
        }
      },
      simulate: async (planNumber) =>
        simulatePlan(ctx.deps, ctx.store, { planNumber, economics: await loadUnitEconomics(dir), attach: true, actor: `bridge:${cliActor()}` }),
    },
  };
  const transport = await makeTransport(wa, creds);
  return { deps, transport, close: ctx.close };
}

type WhatsAppBlock = Awaited<ReturnType<typeof loadWorkspace>>["config"]["command_bridge"]["whatsapp"];

/** The outbound transport the workspace configures (console when none), with its token resolved at run time. */
async function makeTransport(wa: WhatsAppBlock, creds: CredentialResolver): Promise<BridgeTransport> {
  const t = wa.transport;
  if (!t || t.type === "console") return new ConsoleTransport();
  const token = wa.credentials ? ((await creds.resolve({ keychainRef: wa.credentials.api_token.keychain_ref, envFallback: wa.credentials.api_token.env_fallback })).value ?? "") : "";
  const fetchFn = fetch as unknown as ConstructorParameters<typeof GenericWebhookTransport>[0]["fetch"];
  if (t.type === "generic_webhook") return new GenericWebhookTransport({ url: t.url as string, token, fetch: fetchFn });
  return new CloudApiTransport({ phoneNumberId: t.phone_number_id as string, token, version: t.api_version, fetch: fetchFn });
}


function printResult(result: WebhookResult): void {
  const out = process.stdout;
  out.write(`HTTP ${result.status}\n`);
  for (const h of result.handled) out.write(`handled: via=${h.via} command=${h.command} outcome=${h.outcome} sender=${h.sender}\n`);
  if (result.replies.length === 0) out.write("(no reply is sent)\n");
  for (const r of result.replies) {
    out.write(`\n--- reply to ${r.to.slice(0, 5)}...${r.to.slice(-2)} ---\n${r.text}\n`);
    if (r.buttons) out.write(`buttons: ${r.buttons.map((b) => `[${b.title}] ${b.id}`).join("  ")}\n`);
  }
}

export function registerBridgeCommands(program: Command): void {
  const bridge = program.command("bridge").description("the WhatsApp command bridge: typed commands in, reports and approval cards out. Voice can never approve.");

  bridge
    .command("simulate-webhook")
    .description("send one signed, provider-format webhook to the bridge in this process (no public tunnel); runs for real against this workspace")
    .addOption(new Option("--kind <kind>", "text, voice (audio note, optional transcript), voice_text (text flagged as a transcription), button, image").choices(SIM_KINDS).default("text"))
    .requiredOption("--from <e164>", "sender number, e.g. +966551234567")
    .option("--text <text>", "message text, or the transcript for voice")
    .option("--button-id <id>", "button id from an approval card (for --kind button)")
    .addOption(new Option("--preset <preset>", "webhook format preset (default: the workspace's own webhook configuration, else cloud_api)").choices(Object.keys(PRESETS)))
    .option("--send", "also deliver the replies through the workspace's configured transport (default: just print them)")
    .option("--message-id <id>", "provider message id (reusing one tests replay protection)")
    .option("--bad-signature", "sign with the wrong secret, to see the request refused")
    .option("--secret <secret>", `signing secret (default: the workspace's, else "${DEFAULT_SIM_SECRET}")`)
    .option("--workspace <dir>", "workspace folder")
    .action((opts: { kind: SimKind; from: string; text?: string; buttonId?: string; preset?: string; send?: boolean; messageId?: string; badSignature?: boolean; secret?: string; workspace?: string }) =>
      guarded(async () => {
        const probe = await openBridge(opts.workspace, { ...(opts.preset ? { preset: opts.preset } : {}), ...(opts.secret ? { secret: opts.secret } : {}) });
        try {
          const secret = probe.deps.secret || DEFAULT_SIM_SECRET;
          const deps = { ...probe.deps, secret };
          const req = buildWebhook({ webhook: deps.webhook, kind: opts.kind, from: opts.from, secret, ...(opts.text === undefined ? {} : { text: opts.text }), ...(opts.buttonId ? { buttonId: opts.buttonId } : {}), ...(opts.messageId ? { id: opts.messageId } : {}), ...(opts.badSignature ? { badSignature: true } : {}) });
          const result = await handleWebhook(deps, req);
          printResult(result);
          if (opts.send) for (const r of await deliver(result.replies, probe.transport)) process.stdout.write(`sent: ${r.ok ? "ok" : `failed${r.status ? ` (${r.status})` : ""} ${r.detail ?? ""}`}\n`);
          return result.status === 200 ? 0 : 1;
        } finally {
          probe.close();
        }
      }),
    );

  bridge
    .command("run-jobs")
    .description("run any read jobs left queued or interrupted (a crashed job is retried once its lease expires)")
    .option("--workspace <dir>", "workspace folder")
    .action((opts: { workspace?: string }) =>
      guarded(async () => {
        const b = await openBridge(opts.workspace);
        try {
          const n = await processJobs(b.deps);
          process.stdout.write(`ran ${n} job(s); ${new BridgeRepo(b.deps.store).pending().length} still pending\n`);
        } finally {
          b.close();
        }
      }),
    );

  bridge
    .command("serve")
    .description("listen for webhooks on a local port (put a public HTTPS tunnel in front of it); replies go out through the workspace's configured transport")
    .option("--port <n>", "port", (v) => Number(v), 8787)
    .option("--workspace <dir>", "workspace folder")
    .action((opts: { port: number; workspace?: string }) =>
      guarded(async () => {
        const b = await openBridge(opts.workspace);
        if (b.deps.secret === "") {
          b.close();
          throw new Error("no webhook secret: set command_bridge.whatsapp.credentials.webhook_secret in workspace.yaml and store it (mdj auth set)");
        }
        const server = createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => {
            void (async () => {
              try {
                // Meta's subscription handshake: echo hub.challenge when the verify token matches the secret.
                const url = new URL(req.url ?? "/", "http://localhost");
                if (req.method === "GET" && url.searchParams.get("hub.verify_token") === b.deps.secret) {
                  res.writeHead(200).end(url.searchParams.get("hub.challenge") ?? "");
                  return;
                }
                if (req.method !== "POST") return void res.writeHead(405).end();
                const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
                const result = await handleWebhook(b.deps, { rawBody: Buffer.concat(chunks).toString("utf8"), headers });
                printResult(result);
                res.writeHead(result.status).end();
                for (const r of await deliver(result.replies, b.transport)) if (!r.ok) process.stderr.write(`reply not delivered: ${r.status ?? ""} ${r.detail ?? ""}\n`);
              } catch (error) {
                process.stderr.write(`bridge error: ${error instanceof Error ? error.message : String(error)}\n`);
                res.writeHead(500).end();
              }
            })();
          });
        });
        await new Promise<void>((resolve) => server.listen(opts.port, "127.0.0.1", resolve));
        process.stdout.write(`bridge listening on http://127.0.0.1:${opts.port} (${b.deps.webhook.label}, replies via ${b.transport.kind}). Ctrl+C to stop.\n`);
        await new Promise<void>((resolve) => process.once("SIGINT", resolve));
        server.close();
        b.close();
      }),
    );
}
