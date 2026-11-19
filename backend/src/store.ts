import type { MeetingPlatform } from "./invite.js";

export type InterviewStatus =
  | "paid" // alias issued, waiting for invite
  | "scheduled" // invite received, bot created at Recall
  | "joining"
  | "in_meeting"
  | "ended"
  | "cancelled"
  | "not_admitted";

export interface Interview {
  id: string;
  /** alias tag, e.g. "7KQ2" -> iv-7KQ2@domain */
  alias: string;
  /** Interviewer's e-mail. Used to tag the interviewer's speech (Recall reports participant e-mail when available). */
  ownerEmail: string;
  status: InterviewStatus;
  joinUrl?: string;
  platform?: MeetingPlatform;
  icalUid?: string;
  startsAt?: string;
  /** Recall bot created for this interview. */
  recallBotId?: string;
  /** "scheduled" = Recall reserved a bot for join_at (>10 min ahead); "ad_hoc" = created for an immediate/near join. */
  joinMode?: "scheduled" | "ad_hoc";
  /** Teams 1:1 conversation id, filled when the interviewer installs the Teams chat app (optional coaching channel). */
  teamsConversationId?: string;
  /** Platform-level recording permission result (Zoom reports denials). ok=false means no transcript. */
  recording?: { ok: boolean; detail?: string };
}

export interface InterviewStore {
  findByAlias(alias: string): Promise<Interview | undefined>;
  findById(id: string): Promise<Interview | undefined>;
  findByBotId(botId: string): Promise<Interview | undefined>;
  save(interview: Interview): Promise<void>;
}

/** Spike-only store. Replace with Postgres/Cosmos. */
export class InMemoryStore implements InterviewStore {
  private byId = new Map<string, Interview>();

  async findByAlias(alias: string) {
    for (const i of this.byId.values()) if (i.alias === alias.toUpperCase()) return i;
    return undefined;
  }
  async findById(id: string) {
    return this.byId.get(id);
  }
  async findByBotId(botId: string) {
    for (const i of this.byId.values()) if (i.recallBotId === botId) return i;
    return undefined;
  }
  async save(interview: Interview) {
    this.byId.set(interview.id, { ...interview });
  }
}
