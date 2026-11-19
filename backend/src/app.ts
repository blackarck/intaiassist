import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { type SegmentHandler } from "./events.js";
import { handleInvite, handlePastedLink, type IntakeDeps } from "./intake.js";
import type { InviteEmail } from "./invite.js";
import { handleRecallWebhook, verifyRecallSignature } from "./recallWebhook.js";

export interface AppConfig extends IntakeDeps {
  /**
   * Spike auth for /api/*: shared bearer secret.
   * TODO(prod): validate the Entra JWT from the Logic App's managed identity
   * (audience = this API's app ID, check `oid` of the managed identity).
   */
  intakeToken: string;
  enableDevRoutes: boolean;
  /** Workspace verification secret from the Recall dashboard (whsec_...). Without it the webhook route answers 503. */
  recallWebhookSecret?: string;
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

  // Logic App -> here. Body shape is defined in infra/logic-app/workflow.json
  app.post<{ Body: InviteEmail }>("/api/intake/meeting-invite", async (req, reply) => {
    const b = req.body;
    if (!b || typeof b.body !== "string" || typeof b.to !== "string" || typeof b.messageId !== "string") {
      return reply.code(400).send({ error: "invalid payload" });
    }
    // 200 even for ignored/rejected so the Logic App doesn't retry non-errors
    return handleInvite({ ...b, from: b.from ?? "", subject: b.subject ?? "" }, cfg);
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
      if (!verdict.ok) return reply.code(401).send({ error: "invalid signature" });

      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        return reply.code(400).send({ error: "invalid json" });
      }
      // 200 for events we do not use, otherwise Recall retries them (up to 60 times for real-time endpoints)
      return handleRecallWebhook(payload, cfg);
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
