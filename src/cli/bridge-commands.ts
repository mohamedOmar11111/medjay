import { createServer } from "node:http";
import type { Command } from "commander";
import { Option } from "commander";
import { diagnose } from "../analysis/diagnose.js";
import { loadUnitEconomics } from "../analysis/simulate.js";
import { handleWebhook, processJobs, type BridgeDeps, type WebhookResult } from "../bridge/handler.js";
import { buildWebhook, type SimKind } from "../bridge/simulator.js";
import { PROVIDERS, type Provider } from "../bridge/types.js";
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
  close: () => void;
}

/** Everything the bridge needs from a real workspace. `secret` overrides the configured one (simulator only). */
async function openBridge(workspaceOption: string | undefined, overrides: { secret?: string; provider?: Provider } = {}): Promise<OpenedBridge> {
  const dir = await workspaceDirOrThrow(workspaceOption);
  const { config } = await loadWorkspace(dir);
  const wa = config.command_bridge.whatsapp;
  const provider: Provider = overrides.provider ?? (wa.provider === "respond_io_webhook" ? "respond_io_webhook" : "whatsapp_cloud_api");

  let secret = overrides.secret ?? "";
  if (secret === "" && wa.credentials) {
    const resolved = await new CredentialResolver().resolve({ keychainRef: wa.credentials.webhook_secret.keychain_ref, envFallback: wa.credentials.webhook_secret.env_fallback });
    secret = resolved.value ?? "";
  }

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
    provider,
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
  return { deps, close: ctx.close };
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
    .addOption(new Option("--provider <provider>", "webhook format").choices(PROVIDERS).default("whatsapp_cloud_api"))
    .option("--message-id <id>", "provider message id (reusing one tests replay protection)")
    .option("--bad-signature", "sign with the wrong secret, to see the request refused")
    .option("--secret <secret>", `signing secret (default: the workspace's, else "${DEFAULT_SIM_SECRET}")`)
    .option("--workspace <dir>", "workspace folder")
    .action((opts: { kind: SimKind; from: string; text?: string; buttonId?: string; provider: Provider; messageId?: string; badSignature?: boolean; secret?: string; workspace?: string }) =>
      guarded(async () => {
        const probe = await openBridge(opts.workspace, { provider: opts.provider, ...(opts.secret ? { secret: opts.secret } : {}) });
        try {
          const secret = probe.deps.secret || DEFAULT_SIM_SECRET;
          const deps = { ...probe.deps, secret };
          const req = buildWebhook({ provider: opts.provider, kind: opts.kind, from: opts.from, secret, ...(opts.text === undefined ? {} : { text: opts.text }), ...(opts.buttonId ? { buttonId: opts.buttonId } : {}), ...(opts.messageId ? { id: opts.messageId } : {}), ...(opts.badSignature ? { badSignature: true } : {}) });
          const result = await handleWebhook(deps, req);
          printResult(result);
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
    .description("listen for provider webhooks on a local port (put a public HTTPS tunnel in front of it). Sending replies back to WhatsApp is not built yet: replies are printed.")
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
              } catch (error) {
                process.stderr.write(`bridge error: ${error instanceof Error ? error.message : String(error)}\n`);
                res.writeHead(500).end();
              }
            })();
          });
        });
        await new Promise<void>((resolve) => server.listen(opts.port, "127.0.0.1", resolve));
        process.stdout.write(`bridge listening on http://127.0.0.1:${opts.port} (${b.deps.provider}). Ctrl+C to stop.\n`);
        await new Promise<void>((resolve) => process.once("SIGINT", resolve));
        server.close();
        b.close();
      }),
    );
}
