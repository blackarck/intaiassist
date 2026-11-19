import { buildApp } from "./app.js";
import { HttpBotDispatcher, LogDispatcher, Scheduler } from "./scheduler.js";
import { InMemoryStore } from "./store.js";

const intakeToken = process.env.INTAKE_TOKEN;
if (!intakeToken) {
  console.error("INTAKE_TOKEN is required (shared secret the Logic App sends as a Bearer token)");
  process.exit(1);
}

const aliasDomain = process.env.ALIAS_DOMAIN ?? "example.com";
const mediaBotUrl = process.env.MEDIA_BOT_URL;
const dispatcher = mediaBotUrl
  ? new HttpBotDispatcher(mediaBotUrl, process.env.MEDIA_BOT_API_KEY ?? "")
  : new LogDispatcher();

const app = buildApp({
  store: new InMemoryStore(),
  scheduler: new Scheduler(dispatcher),
  aliasDomain,
  intakeToken,
  enableDevRoutes: process.env.NODE_ENV !== "production",
  onSegment: (s) => console.log(`[segment] ${s.speakerName ?? s.speakerId}${s.isFinal ? "" : " (partial)"}: ${s.text}`),
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
console.log(`backend listening on :${port} (alias domain ${aliasDomain}, dispatcher ${mediaBotUrl ? "http" : "log"})`);
