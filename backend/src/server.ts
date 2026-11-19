import { buildApp } from "./app.js";
import { LogBotController, RecallBotController, type BotController } from "./botController.js";
import { RecallClient } from "./recall.js";
import { InMemoryStore } from "./store.js";

const intakeToken = process.env.INTAKE_TOKEN;
if (!intakeToken) {
  console.error("INTAKE_TOKEN is required (shared secret the Logic App sends as a Bearer token)");
  process.exit(1);
}

const aliasDomain = process.env.ALIAS_DOMAIN ?? "example.com";

// Recall.ai. Either all of these are set, or none (local development: bots are logged, not created).
// Accepts either spelling for the two secrets (RECALL_API_KEY / RECALL_AI_API_KEY, RECALL_WEBHOOK_SECRET / RECALL_VERI_SECRET).
const RECALL_API_KEY = process.env.RECALL_API_KEY ?? process.env.RECALL_AI_API_KEY;
const RECALL_WEBHOOK_SECRET = process.env.RECALL_WEBHOOK_SECRET ?? process.env.RECALL_VERI_SECRET;
const { RECALL_REGION, PUBLIC_BASE_URL } = process.env;
let controller: BotController;
if (RECALL_API_KEY) {
  const missing = [
    ["RECALL_REGION", RECALL_REGION],
    ["RECALL_WEBHOOK_SECRET", RECALL_WEBHOOK_SECRET],
    ["PUBLIC_BASE_URL", PUBLIC_BASE_URL],
  ].filter(([, v]) => !v);
  if (missing.length) {
    console.error(`RECALL_API_KEY is set but these are missing: ${missing.map(([k]) => k).join(", ")}`);
    process.exit(1);
  }
  const client = new RecallClient({
    apiKey: RECALL_API_KEY,
    region: RECALL_REGION!,
    webhookUrl: `${PUBLIC_BASE_URL!.replace(/\/$/, "")}/webhooks/recall`,
    botName: process.env.BOT_NAME,
    language: process.env.TRANSCRIPT_LANGUAGE,
  });
  controller = new RecallBotController(client, { onWarn: (m, e) => console.warn(`[recall] ${m}:`, (e as Error)?.message) });
} else {
  console.warn("RECALL_API_KEY not set: running with a log-only bot controller (no meetings will be joined)");
  controller = new LogBotController();
}

const app = buildApp({
  store: new InMemoryStore(),
  controller,
  aliasDomain,
  intakeToken,
  recallWebhookSecret: RECALL_WEBHOOK_SECRET,
  enableDevRoutes: process.env.NODE_ENV !== "production",
  onSegment: (s) =>
    console.log(`[segment] ${s.role ?? "?"} ${s.speakerName ?? s.speakerId}${s.isFinal ? "" : " (partial)"}: ${s.text}`),
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
console.log(`backend listening on :${port} (alias domain ${aliasDomain}, bots: ${RECALL_API_KEY ? "recall " + RECALL_REGION : "log-only"})`);
