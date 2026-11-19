import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { handleBotEvent, type SegmentHandler } from "./events.js";
import { handleInvite, handlePastedLink, type IntakeDeps } from "./intake.js";
import type { InviteEmail } from "./invite.js";
import type { MeetingEvent } from "./meetingSource.js";

export interface AppConfig extends IntakeDeps {
  /** Called for every final/partial transcript segment from the bot. */
  onSegment?: SegmentHandler;
  /**
   * Spike auth: shared bearer secret.
   * TODO(prod): validate Entra JWT from the Logic App's managed identity
   * (audience = this API's app ID, check `oid` of the managed identity).
   */
  intakeToken: string;
  enableDevRoutes: boolean;
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
    const result = await handleInvite(
      { ...b, from: b.from ?? "", subject: b.subject ?? "" },
      cfg,
    );
    // 200 even for ignored/rejected so the Logic App doesn't retry non-errors
    return result;
  });

  // Portal paste-link fallback
  app.post<{ Body: { alias: string; link: string; startsAt?: string } }>(
    "/api/intake/link",
    async (req, reply) => {
      const { alias, link } = req.body ?? {};
      if (typeof alias !== "string" || typeof link !== "string") {
        return reply.code(400).send({ error: "invalid payload" });
      }
      return handlePastedLink({ alias, link, startsAt: req.body.startsAt }, cfg);
    },
  );

  // Media bot -> here (lobby/admitted/segment/ended events)
  app.post<{ Body: MeetingEvent }>("/api/bot/events", async (req, reply) => {
    const e = req.body;
    if (!e || typeof e.type !== "string") return reply.code(400).send({ error: "invalid payload" });
    const res = await handleBotEvent(e, cfg);
    return res.ok ? res : reply.code(404).send(res);
  });

  if (cfg.enableDevRoutes) {
    // Seed a "paid" interview without the portal/payment flow.
    app.post<{ Body: { alias: string; ownerEmail: string; tenantId?: string; interviewerAadId?: string } }>(
      "/api/dev/interviews",
      async (req, reply) => {
      const { alias, ownerEmail, tenantId, interviewerAadId } = req.body ?? {};
      if (!alias || !ownerEmail) return reply.code(400).send({ error: "alias and ownerEmail required" });
      const interview = {
        id: crypto.randomUUID(),
        alias: alias.toUpperCase(),
        ownerEmail,
        tenantId,
        interviewerAadId,
        status: "paid" as const,
      };
      await cfg.store.save(interview);
      return interview;
      },
    );
  }

  return app;
}
