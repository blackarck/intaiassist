import { InMemoryAiStore } from "./ai/configStore.js";
import { availableModels, envModelFactory } from "./ai/models.js";
import { buildApp } from "./app.js";
import { anyOf, googleVerifier, microsoftVerifier, type TokenVerifier } from "./auth.js";
import { LogBotController, RecallBotController, type BotController } from "./botController.js";
import { RecallClient } from "./recall.js";
import { RoomService } from "./room/service.js";
import { InMemoryRoomStore } from "./room/types.js";
import { SqliteStore } from "./sqliteStore.js";
import { InMemoryStore } from "./store.js";
import { stripeSupport } from "./support.js";

const intakeToken = process.env.INTAKE_TOKEN;
if (!intakeToken) {
  console.error("INTAKE_TOKEN is required (bearer token for /api/*)");
  process.exit(1);
}

// The operator token guards every non-user /api route. A short or guessable one is brute-forceable, so refuse it in production.
if (process.env.NODE_ENV === "production" && intakeToken.length < 24) {
  console.error("INTAKE_TOKEN must be at least 24 characters in production (use: openssl rand -hex 32)");
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

// AI coaching (question suggestions, answer scoring). Provider keys come from the environment; a model is only built
// when a task is actually routed to it, so a missing key affects only the tasks that use that provider.
const aiStore = sqlite ?? new InMemoryAiStore();
const ai = { config: aiStore, log: aiStore, models: envModelFactory(process.env), available: availableModels(process.env).map((m) => m.id) };

// The live coaching room needs the SQLite store (rooms live beside the interviews they belong to).
const room = new RoomService({
  rooms: sqlite ?? new InMemoryRoomStore(),
  transcripts: store,
  interviews: store,
  ai,
  onWarn: (m, e) => console.warn(`[room] ${m}:`, (e as Error)?.message),
});
room.start();

// Sign-in: the web app sends the user's Microsoft or Google ID token as the bearer token. Each provider is on only when its
// client id is set. The operator token (INTAKE_TOKEN) keeps working for scripts and administration.
const verifiers: TokenVerifier[] = [];
if (process.env.MS_CLIENT_ID) verifiers.push(microsoftVerifier({ clientId: process.env.MS_CLIENT_ID }));
if (process.env.GOOGLE_CLIENT_ID) verifiers.push(googleVerifier({ clientId: process.env.GOOGLE_CLIENT_ID }));
const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
if (process.env.DEV_AUTH === "1" && process.env.NODE_ENV === "production") {
  console.error("DEV_AUTH=1 is not allowed with NODE_ENV=production");
  process.exit(1);
}
if (verifiers.length === 0 && process.env.DEV_AUTH !== "1") console.warn("MS_CLIENT_ID / GOOGLE_CLIENT_ID not set: people cannot sign in (operator token only)");

// Optional Stripe "support us" payments. Needs both values; with neither, the web app simply shows no support option.
const { STRIPE_SECRET_KEY, WEB_BASE_URL } = process.env;
if (STRIPE_SECRET_KEY && !WEB_BASE_URL) {
  console.error("STRIPE_SECRET_KEY is set but WEB_BASE_URL is missing (where Stripe sends people back to)");
  process.exit(1);
}
const support = STRIPE_SECRET_KEY && WEB_BASE_URL ? stripeSupport({ secretKey: STRIPE_SECRET_KEY, webBaseUrl: WEB_BASE_URL }) : undefined;
if (!support) console.warn("STRIPE_SECRET_KEY not set: the optional support payment is disabled");

const app = buildApp({
  support,
  // In production the backend is reachable only through Caddy (see deploy/docker-compose.yml), so its forwarded client address can be trusted.
  trustProxy: process.env.NODE_ENV === "production",
  verifier: verifiers.length ? anyOf(...verifiers) : undefined,
  adminSubjects: list(process.env.ADMIN_SUBJECTS),
  allowedOrigins: list(process.env.ALLOWED_ORIGINS),
  devAuth: process.env.DEV_AUTH === "1",
  ai,
  room,
  onMeetingEvent: (e) => room.onMeetingEvent(e),
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
  // Transcript text is personal data: it goes to the database, NOT to the logs. LOG_TRANSCRIPT=1 is for local debugging only.
  onSegment: (s) => {
    room.onSegment(s);
    if (process.env.LOG_TRANSCRIPT === "1") console.log(`[segment] ${s.role ?? "?"} ${s.speakerName ?? s.speakerId}${s.isFinal ? "" : " (partial)"}: ${s.text}`);
  },
});

// As PID 1 in a container, Node only stops on SIGTERM if we handle it. Finish in-flight requests, then close the database.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    console.log(`${signal} received, shutting down`);
    try {
      room.stop();
      await app.close();
      await room.settle(); // let in-flight scoring finish and be saved before the database closes
      sqlite?.close();
    } finally {
      process.exit(0);
    }
  });
}

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
console.log(`backend listening on :${port} (alias domain ${aliasDomain}, bots: ${RECALL_API_KEY ? "recall " + RECALL_REGION : "log-only"})`);
