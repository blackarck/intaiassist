import type { RecallApi } from "./recall.js";
import type { Interview } from "./store.js";

export interface BotPlan {
  botId: string;
  mode: "scheduled" | "ad_hoc";
  /** ISO time the bot was told to join, or undefined when it joins immediately. */
  joinAt?: string;
}

/** Decides when and how the meeting bot joins, and cancels it. Implemented over Recall; faked in tests. */
export interface BotController {
  /** (Re)create the bot for this interview. Replaces any bot that already exists for it. */
  schedule(interview: Interview): Promise<BotPlan>;
  /** Stop or remove the bot for this interview, if any. */
  cancel(interview: Interview): Promise<void>;
}

/** Recall treats a join_at more than this far ahead as a scheduled bot (guaranteed on time). */
export const SCHEDULED_THRESHOLD_MS = 10 * 60_000;

export class RecallBotController implements BotController {
  constructor(
    private readonly recall: RecallApi,
    private readonly opts: { leadMs?: number; now?: () => number; onWarn?: (msg: string, err: unknown) => void } = {},
  ) {}

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  async schedule(interview: Interview): Promise<BotPlan> {
    if (!interview.joinUrl) throw new Error("interview has no meeting link");
    if (interview.recallBotId) await this.cancel(interview); // reschedule: replace the old bot

    const lead = this.opts.leadMs ?? 60_000;
    const start = interview.startsAt ? Date.parse(interview.startsAt) : NaN;
    const now = this.now();

    // Join a minute early. If that moment already passed (or the start time is unknown), join right away.
    const joinAtMs = Number.isNaN(start) ? undefined : start - lead;
    const joinAt = joinAtMs !== undefined && joinAtMs > now ? new Date(joinAtMs).toISOString() : undefined;
    const mode: BotPlan["mode"] = joinAtMs !== undefined && joinAtMs - now > SCHEDULED_THRESHOLD_MS ? "scheduled" : "ad_hoc";

    const bot = await this.recall.createBot({
      meetingUrl: interview.joinUrl,
      joinAt,
      metadata: { interview_id: interview.id },
    });
    return { botId: bot.id, mode, joinAt };
  }

  async cancel(interview: Interview): Promise<void> {
    const botId = interview.recallBotId;
    if (!botId) return;
    try {
      if (interview.joinMode === "scheduled") {
        try {
          await this.recall.deleteBot(botId); // not joined yet: remove the reservation
          return;
        } catch (e) {
          this.opts.onWarn?.("delete of scheduled bot failed, asking it to leave instead", e);
        }
      }
      await this.recall.leaveCall(botId);
    } catch (e) {
      // The interview is cancelled regardless; a leftover bot leaves by itself when the meeting ends.
      this.opts.onWarn?.("could not stop Recall bot", e);
    }
  }
}

/** Used when no Recall credentials are configured (local development): records nothing, joins nothing. */
export class LogBotController implements BotController {
  async schedule(interview: Interview): Promise<BotPlan> {
    console.log("[bot] would schedule", { id: interview.id, url: interview.joinUrl, startsAt: interview.startsAt });
    return { botId: `dev-${interview.id}`, mode: "ad_hoc" };
  }
  async cancel(interview: Interview): Promise<void> {
    console.log("[bot] would cancel", interview.id);
  }
}
