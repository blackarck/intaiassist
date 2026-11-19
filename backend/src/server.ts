import { buildApp } from "./app.js";
import { LogBotController, RecallBotController, type BotController } from "./botController.js";
import { RecallClient } from "./recall.js";
import { SqliteStore } from "./sqliteStore.js";
import { InMemoryStore } from "./store.js";

const intakeToken = process.env.INTAKE_TOKEN;
if (!intakeToken) {
  console.error("INTAKE_TOKEN is required (bearer token for /api/*)");
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

// Persistence: SQLite file when DATABASE_PATH is set (production), otherwise process memory (local quick runs).
// Moving to a network database later means writing one class implementing InterviewStore + TranscriptStore.
const dbPath = process.env.DATABASE_PATH;
const sqlite = dbPath ? new SqliteStore(dbPath) : undefined;
const store = sqlite ?? new InMemoryStore();
if (sqlite) console.log(`database: ${sqlite.path} (schema v${sqlite.schemaVersion})`);
else console.warn("DATABASE_PATH not set: using the in-memory store (state is lost on restart)");

const app = buildApp({
  store,
  transcripts: store,
  messageLog: store,
  controller,
  aliasDomain,
  intakeToken,
  recallWebhookSecret: RECALL_WEBHOOK_SECRET,
  inboundToken: process.env.INBOUND_TOKEN,
  requireSenderAuth: process.env.INBOUND_REQUIRE_AUTH !== "false",
  enableDevRoutes: process.env.NODE_ENV !== "production",
  onSegment: (s) =>
    console.log(`[segment] ${s.role ?? "?"} ${s.speakerName ?? s.speakerId}${s.isFinal ? "" : " (partial)"}: ${s.text}`),
});

// As PID 1 in a container, Node only stops on SIGTERM if we handle it. Finish in-flight requests, then close the database.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    console.log(`${signal} received, shutting down`);
    try {
      await app.close();
      sqlite?.close();
    } finally {
      process.exit(0);
    }
  });
}

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
console.log(`backend listening on :${port} (alias domain ${aliasDomain}, bots: ${RECALL_API_KEY ? "recall " + RECALL_REGION : "log-only"})`);
