import { timingSafeEqual } from "node:crypto";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { allEffectiveConfigs, type AiConfigStore, type AiRunLog, type TaskOverride } from "./ai/configStore.js";
import { CATALOG, findModel, type ModelFactory } from "./ai/models.js";
import { runTask } from "./ai/runner.js";
import { TASKS, getTask, taskNames } from "./ai/tasks/index.js";
import { z } from "zod";
import { aliasAddress, generateAlias } from "./alias.js";
import { type SegmentHandler } from "./events.js";
import type { MeetingEvent } from "./meetingSource.js";
import { parseSendGridInbound } from "./inbound.js";
import { handleInvite, handlePastedLink, type IntakeDeps } from "./intake.js";
import type { InviteEmail } from "./invite.js";
import { handleRecallWebhook, verifyRecallSignature } from "./recallWebhook.js";
import { openLive, sseFrame } from "./room/live.js";
import type { RoomService } from "./room/service.js";
import type { InboundMessageLog, TranscriptStore } from "./store.js";

/** Largest inbound e-mail we accept. Invites are tiny; anything near this is junk or a mail with big attachments. */
const MAX_INBOUND_BYTES = 12 * 1024 * 1024;

export interface AppConfig extends IntakeDeps {
  /**
   * Spike auth for /api/*: shared bearer secret.
   * TODO(prod): replace with real authentication (Entra) once the portal exists; browsers must never hold this token.
   */
  intakeToken: string;
  enableDevRoutes: boolean;
  /** Workspace verification secret from the Recall dashboard (whsec_...). Without it the webhook route answers 503. */
  recallWebhookSecret?: string;
  /**
   * Secret that is part of the SendGrid Inbound Parse URL (/inbound/sendgrid/<token>). SendGrid does not sign these
   * requests, so the secret path is what keeps strangers from posting fake invites. Without it the route answers 503.
   */
  inboundToken?: string;
  /** Require SPF or DKIM "pass" on inbound mail (default true). Turn off only for local experiments. */
  requireSenderAuth?: boolean;
  /** Remembers processed inbound messages so a repeated delivery does not create a second bot. */
  messageLog?: InboundMessageLog;
  /** Where final transcript segments are persisted. */
  transcripts?: TranscriptStore;
  /** Called for every final/partial transcript segment. */
  onSegment?: SegmentHandler;
  /** Called for bot lifecycle events (joining, admitted, ended). */
  onMeetingEvent?: (e: MeetingEvent) => void;
  /** The live coaching room. Without it the room routes answer 501. */
  room?: RoomService;
  /** AI coaching: settings store, run log and model factory. Without it the /api/admin/ai routes answer 501. */
  ai?: { config: AiConfigStore; log: AiRunLog; models: ModelFactory };
  /** Injectable clock for signature-timestamp checks (tests). */
  nowMs?: () => number;
}

function tokenOk(header: string | undefined, expected: string): boolean {
  const given = Buffer.from((header ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(expected);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function buildApp(cfg: AppConfig): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 });

  app.get("/health", async () => ({ ok: true }));

  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/api/") && !tokenOk(req.headers.authorization, cfg.intakeToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  // Generic JSON intake (manual tests, or any other mail source). The SendGrid route below is the production path.
  app.post<{ Body: InviteEmail }>("/api/intake/meeting-invite", async (req, reply) => {
    const b = req.body;
    if (!b || typeof b.body !== "string" || typeof b.to !== "string" || typeof b.messageId !== "string") {
      return reply.code(400).send({ error: "invalid payload" });
    }
    // 200 even for ignored/rejected so callers don't retry non-errors
    return handleInvite({ ...b, from: b.from ?? "", subject: b.subject ?? "" }, cfg);
  });

  // Create a paid-interview record and its invite address. Until the portal exists this is how interviews are created
  // (called by an operator with the bearer token). Payment is not enforced here yet.
  app.post<{ Body: { ownerEmail: string } }>("/api/interviews", async (req, reply) => {
    const ownerEmail = req.body?.ownerEmail;
    if (typeof ownerEmail !== "string" || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ownerEmail)) {
      return reply.code(400).send({ error: "ownerEmail must be an e-mail address" });
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const alias = generateAlias();
      const interview = { id: crypto.randomUUID(), alias, ownerEmail, status: "paid" as const };
      try {
        await cfg.store.save(interview);
      } catch {
        continue; // alias collision (practically impossible at 50 bits); try another
      }
      return { id: interview.id, alias, address: aliasAddress(alias, cfg.aliasDomain) };
    }
    return reply.code(500).send({ error: "could not allocate an alias" });
  });

  // Read an interview's state and transcript (operator / future portal). Protected by the same bearer token as the rest of /api.
  app.get<{ Params: { id: string } }>("/api/interviews/:id", async (req, reply) => {
    const i = await cfg.store.findById(req.params.id);
    if (!i) return reply.code(404).send({ error: "not found" });
    return {
      id: i.id,
      alias: i.alias,
      status: i.status,
      platform: i.platform,
      startsAt: i.startsAt,
      joinMode: i.joinMode,
      recording: i.recording,
    };
  });

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>("/api/interviews/:id/transcript", async (req, reply) => {
    if (!cfg.transcripts) return reply.code(501).send({ error: "transcript storage not configured" });
    const i = await cfg.store.findById(req.params.id);
    if (!i) return reply.code(404).send({ error: "not found" });
    const segments = await cfg.transcripts.listSegments(i.id);
    if (req.query.format === "text") {
      const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19); // HH:MM:SS from the start of the recording
      return reply
        .type("text/plain; charset=utf-8")
        .send(segments.map((s) => `[${clock(s.startMs)}] ${s.speakerName ?? s.speakerId} (${s.role ?? "unknown"}): ${s.text}`).join("\n"));
    }
    return { interviewId: i.id, segments };
  });

  // ---- AI configuration (operator screens). Same bearer token as the rest of /api until real auth exists.
  const aiOr501 = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => (cfg.ai ? cfg.ai : (reply.code(501).send({ error: "ai not configured" }), undefined));

  app.get("/api/admin/ai/config", async (_req, reply) => {
    const ai = aiOr501(reply);
    if (!ai) return;
    return { models: CATALOG, tasks: await allEffectiveConfigs(ai.config), overrides: await ai.config.getOverrides() };
  });

  app.put<{ Params: { task: string }; Body: Record<string, unknown> }>("/api/admin/ai/config/:task", async (req, reply) => {
    const ai = aiOr501(reply);
    if (!ai) return;
    if (!getTask(req.params.task)) return reply.code(404).send({ error: "unknown task" });
    const b = req.body ?? {};
    const patch: TaskOverride = {};
    const int = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined);
    for (const key of ["primary", "fallback"] as const) {
      if (b[key] === undefined) continue;
      if (typeof b[key] !== "string" || !findModel(b[key] as string)) return reply.code(400).send({ error: `${key} must be a model id from the catalog` });
      patch[key] = b[key] as string;
    }
    for (const [key, lo, hi] of [["timeoutMs", 1000, 300_000], ["deadlineMs", 1000, 600_000], ["maxOutputTokens", 16, 64_000]] as const) {
      if (b[key] === undefined) continue;
      const v = int(b[key], lo, hi);
      if (v === undefined) return reply.code(400).send({ error: `${key} must be an integer from ${lo} to ${hi}` });
      patch[key] = v;
    }
    if (b.temperature !== undefined) {
      if (typeof b.temperature !== "number" || b.temperature < 0 || b.temperature > 2) return reply.code(400).send({ error: "temperature must be 0 to 2" });
      patch.temperature = b.temperature;
    }
    if (b.enabled !== undefined) {
      if (typeof b.enabled !== "boolean") return reply.code(400).send({ error: "enabled must be true or false" });
      patch.enabled = b.enabled;
    }
    await ai.config.setOverride(req.params.task, patch);
    return { task: req.params.task, overrides: (await ai.config.getOverrides())[req.params.task] };
  });

  app.delete<{ Params: { task: string } }>("/api/admin/ai/config/:task", async (req, reply) => {
    const ai = aiOr501(reply);
    if (!ai) return;
    await ai.config.clearOverride(req.params.task);
    return { ok: true };
  });

  // The "Test" button: runs a task on its built-in sample input (invented text, no interview data).
  app.post<{ Params: { task: string } }>("/api/admin/ai/test/:task", async (req, reply) => {
    const ai = aiOr501(reply);
    if (!ai) return;
    if (!getTask(req.params.task)) return reply.code(404).send({ error: "unknown task", tasks: taskNames });
    const res = await runTask(ai, req.params.task, TASKS[req.params.task as keyof typeof TASKS].sample, { interviewId: "admin-test" });
    return res;
  });

  app.get<{ Querystring: { limit?: string } }>("/api/admin/ai/runs", async (req, reply) => {
    const ai = aiOr501(reply);
    if (!ai) return;
    return { runs: await ai.log.recent(Number(req.query.limit) || 50) };
  });

  // ---- live coaching room (operator token for now; the web app will use the interviewer's own login)
  const SetupBody = z.object({
    roleTitle: z.string().min(1).max(120),
    roleLevel: z.string().max(60).optional(),
    jd: z.string().max(20_000),
    resumeSummary: z.string().max(20_000).optional(),
    presetQuestions: z.array(z.object({ text: z.string().min(1).max(600), keyPoints: z.array(z.string().max(300)).max(12).optional() })).max(20).default([]),
  });

  /** Looks up the interview and the room service; sends the error reply itself and returns undefined when either is missing. */
  const roomFor = async (id: string, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (!cfg.room) return void reply.code(501).send({ error: "room not configured" });
    if (!(await cfg.store.findById(id))) return void reply.code(404).send({ error: "not found" });
    return cfg.room;
  };

  app.put<{ Params: { id: string }; Body: unknown }>("/api/interviews/:id/setup", async (req, reply) => {
    const room = await roomFor(req.params.id, reply);
    if (!room) return;
    const parsed = SetupBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    return { questions: await room.configure({ interviewId: req.params.id, ...parsed.data }) };
  });

  app.get<{ Params: { id: string } }>("/api/interviews/:id/room", async (req, reply) => {
    const room = await roomFor(req.params.id, reply);
    return room ? room.snapshot(req.params.id) : undefined;
  });

  app.post<{ Params: { id: string }; Body: { count?: number } }>("/api/interviews/:id/room/opening-questions", async (req, reply) => {
    const room = await roomFor(req.params.id, reply);
    if (!room) return;
    const count = Number.isInteger(req.body?.count) ? Math.min(Math.max(req.body!.count!, 1), 10) : 6;
    const res = await room.openingQuestions(req.params.id, count);
    return res.ok ? res : reply.code(res.error.code === "no_setup" ? 409 : 502).send(res);
  });

  app.post<{ Params: { id: string } }>("/api/interviews/:id/room/assist", async (req, reply) => {
    const room = await roomFor(req.params.id, reply);
    if (!room) return;
    const res = await room.assist(req.params.id);
    return res.ok ? res : reply.code(res.error.code === "no_transcript" ? 409 : 502).send(res);
  });

  app.post<{ Params: { id: string } }>("/api/interviews/:id/room/scorecard", async (req, reply) => {
    const room = await roomFor(req.params.id, reply);
    if (!room) return;
    const res = await room.scorecard(req.params.id);
    return res.ok ? res : reply.code(res.error.code === "nothing_to_score" ? 409 : 502).send(res);
  });

  // Server-Sent Events. A reconnecting client sends Last-Event-ID (or ?after=) and gets what it missed.
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/interviews/:id/live", async (req, reply) => {
    const room = await roomFor(req.params.id, reply);
    if (!room) return;
    const after = Number(req.headers["last-event-id"] ?? req.query.after ?? 0);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    raw.write("retry: 3000\n\n");
    let stop: (() => void) | undefined;
    const heartbeat = setInterval(() => raw.write(": keep-alive\n\n"), 15_000);
    const end = () => {
      clearInterval(heartbeat);
      stop?.();
    };
    req.raw.on("close", end);
    try {
      stop = await openLive(room, req.params.id, Number.isFinite(after) && after > 0 ? after : 0, (e) => raw.write(sseFrame(e)));
      if (raw.destroyed) end();
    } catch {
      end();
      raw.end();
    }
  });

  // Portal paste-link fallback
  app.post<{ Body: { alias: string; link: string; startsAt?: string } }>("/api/intake/link", async (req, reply) => {
    const { alias, link } = req.body ?? {};
    if (typeof alias !== "string" || typeof link !== "string") {
      return reply.code(400).send({ error: "invalid payload" });
    }
    return handlePastedLink({ alias, link, startsAt: req.body.startsAt }, cfg);
  });

  // Recall -> here (real-time transcript events AND bot status events). Authenticated by HMAC signature, not by the
  // bearer token. Lives in its own scope because the signature covers the RAW body, so JSON must not be pre-parsed.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));

    scope.post("/webhooks/recall", async (req, reply) => {
      if (!cfg.recallWebhookSecret) return reply.code(503).send({ error: "recall webhook not configured" });

      const raw = typeof req.body === "string" ? req.body : "";
      const verdict = verifyRecallSignature({
        secret: cfg.recallWebhookSecret,
        headers: req.headers,
        payload: raw,
        nowMs: cfg.nowMs?.(),
      });
      if (!verdict.ok) {
        console.warn(`[recall] webhook rejected: ${verdict.reason}`);
        return reply.code(401).send({ error: "invalid signature" });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return reply.code(400).send({ error: "invalid json" });
      }
      // 200 for events we do not use, otherwise Recall retries them (up to 60 times for real-time endpoints)
      const result = await handleRecallWebhook(payload, { ...cfg, onEvent: cfg.onMeetingEvent });

      // Operational log: event name and outcome only. Never the payload, which holds transcript text and names.
      const event = typeof (payload as { event?: unknown })?.event === "string" ? (payload as { event: string }).event : "unknown";
      const routine = event.startsWith("transcript.") && result.status === "ok"; // one line per utterance would be noise
      if (!routine) console.log(`[recall] ${event} -> ${result.status}${result.status === "ignored" ? ` (${result.reason})` : ""}`);
      return result;
    });
  });

  // SendGrid Inbound Parse -> here: the interviewer's meeting invite, sent to iv-<alias>@<alias domain>.
  // Own scope, because multipart parsing must not apply to the other routes.
  app.register(async (scope) => {
    await scope.register(multipart, {
      attachFieldsToBody: "keyValues",
      limits: { fieldSize: MAX_INBOUND_BYTES, fileSize: MAX_INBOUND_BYTES, files: 20, fields: 40 },
    });

    scope.post<{ Params: { token: string } }>("/inbound/sendgrid/:token", { bodyLimit: MAX_INBOUND_BYTES }, async (req, reply) => {
      if (!cfg.inboundToken) return reply.code(503).send({ error: "inbound e-mail not configured" });
      if (!tokenOk(req.params.token, cfg.inboundToken)) return reply.code(401).send({ error: "unauthorized" });

      // multipart "keyValues" mode: text fields arrive as strings, any file part as a Buffer
      const fields: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries((req.body ?? {}) as Record<string, unknown>)) {
        fields[k] = typeof v === "string" ? v : Buffer.isBuffer(v) ? v.toString("utf8") : undefined;
      }

      // One operational line per message: the outcome only. Never sender, subject, recipients or body (names, links).
      const done = <T extends { status: string; reason?: string; mode?: string; startNote?: string }>(result: T): T => {
        const detail = [result.reason, result.mode && `mode=${result.mode}`, result.startNote && `start not understood: ${result.startNote}`]
          .filter(Boolean)
          .join(", ");
        console.log(`[inbound] ${result.status}${detail ? ` (${detail})` : ""}`);
        return result;
      };

      const parsed = await parseSendGridInbound(fields);
      // 200 for everything we deliberately skip: a non-2xx makes SendGrid redeliver the same mail again and again.
      if (!parsed) {
        console.warn("[inbound] no raw MIME in the request: set 'POST the raw, full MIME message' on the Inbound Parse host");
        return { status: "ignored", reason: "raw_mime_required" };
      }
      if (cfg.requireSenderAuth !== false && !parsed.senderAuthenticated) {
        return done({ status: "ignored", reason: "sender_not_authenticated" });
      }
      if (cfg.messageLog && (await cfg.messageLog.hasMessageSeen(parsed.invite.messageId))) {
        return done({ status: "ignored", reason: "duplicate_message" });
      }

      // A provider failure here throws -> HTTP 500 -> SendGrid retries later (the message is not yet marked as seen).
      const result = await handleInvite(parsed.invite, cfg);
      await cfg.messageLog?.markMessageSeen(parsed.invite.messageId);
      return done(result);
    });
  });

  if (cfg.enableDevRoutes) {
    // Seed a "paid" interview without the portal/payment flow.
    app.post<{ Body: { alias: string; ownerEmail: string } }>("/api/dev/interviews", async (req, reply) => {
      const { alias, ownerEmail } = req.body ?? {};
      if (!alias || !ownerEmail) return reply.code(400).send({ error: "alias and ownerEmail required" });
      const interview = { id: crypto.randomUUID(), alias: alias.toUpperCase(), ownerEmail, status: "paid" as const };
      await cfg.store.save(interview);
      return interview;
    });
  }

  return app;
}
