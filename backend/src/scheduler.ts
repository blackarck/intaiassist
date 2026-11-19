import type { Interview } from "./store.js";

/** Starts the bot for an interview. Real impl calls the media-bot service. */
export interface JoinRequest {
  interviewId: string;
  joinUrl: string;
  tenantId?: string;
  interviewerAadId?: string;
}

export interface BotDispatcher {
  join(args: JoinRequest): Promise<void>;
  leave(args: { interviewId: string }): Promise<void>;
}

/** Calls the .NET media bot's HTTP API (see media-bot/). */
export class HttpBotDispatcher implements BotDispatcher {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  private async post(path: string, body: unknown) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`media bot ${path} failed: ${res.status} ${await res.text()}`);
  }
  join(a: JoinRequest) {
    return this.post("/api/join", a);
  }
  leave(a: { interviewId: string }) {
    return this.post("/api/leave", a);
  }
}

/** Logs only — default when MEDIA_BOT_URL isn't configured. */
export class LogDispatcher implements BotDispatcher {
  async join(a: JoinRequest) {
    console.log("[dispatch] would JOIN", a);
  }
  async leave(a: { interviewId: string }) {
    console.log("[dispatch] would LEAVE", a);
  }
}

/**
 * Spike scheduler using in-process timers.
 * Production: Azure Service Bus scheduled messages (survive restarts, scale out).
 */
export class Scheduler {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private dispatcher: BotDispatcher,
    private leadMs = 60_000,
    private now: () => number = Date.now,
  ) {}

  schedule(interview: Interview): { runAt: string } {
    if (!interview.joinUrl) throw new Error("no joinUrl");
    this.cancel(interview.id);

    const start = interview.startsAt ? Date.parse(interview.startsAt) : NaN;
    const runAtMs = Number.isNaN(start) ? this.now() : Math.max(this.now(), start - this.leadMs);
    const req: JoinRequest = {
      interviewId: interview.id,
      joinUrl: interview.joinUrl,
      tenantId: interview.tenantId,
      interviewerAadId: interview.interviewerAadId,
    };
    const id = interview.id;

    const t = setTimeout(
      () => {
        this.timers.delete(id);
        this.dispatcher.join(req).catch((e) => console.error("join failed", e));
      },
      Math.min(runAtMs - this.now(), 2 ** 31 - 1), // setTimeout max ~24.8 days
    );
    t.unref?.();
    this.timers.set(id, t);
    return { runAt: new Date(runAtMs).toISOString() };
  }

  cancel(interviewId: string) {
    const t = this.timers.get(interviewId);
    if (t) clearTimeout(t);
    this.timers.delete(interviewId);
  }
}
