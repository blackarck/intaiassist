import { timingSafeEqual } from "node:crypto";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { aliasAddress, generateAlias } from "./alias.js";
import { type SegmentHandler } from "./events.js";
import { parseSendGridInbound } from "./inbound.js";
import { handleInvite, handlePastedLink, type IntakeDeps } from "./intake.js";
import type { InviteEmail } from "./invite.js";
import { handleRecallWebhook, verifyRecallSignature } from "./recallWebhook.js";
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
      const result = await handleRecallWebhook(payload, cfg);

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
      const done = <T extends { status: string; reason?: string }>(result: T): T => {
        console.log(`[inbound] ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
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
