import type { MeetingPlatform } from "./invite.js";
import type { TranscriptSegment } from "./meetingSource.js";

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

/**
 * Persistence is split into two small interfaces. Every method is async on purpose, so a network database
 * (Postgres, Cosmos) can replace SQLite later by adding one class; nothing else in the app changes.
 */
export interface InterviewStore {
  findByAlias(alias: string): Promise<Interview | undefined>;
  findById(id: string): Promise<Interview | undefined>;
  findByBotId(botId: string): Promise<Interview | undefined>;
  /** Insert or update by id. Throws if the alias already belongs to a different interview. */
  save(interview: Interview): Promise<void>;
}

export interface TranscriptStore {
  /**
   * Persist a FINAL segment. Idempotent: Recall delivers webhooks at least once, so the same utterance can arrive
   * twice; (interview, speaker, startMs) identifies it.
   */
  appendSegment(segment: TranscriptSegment): Promise<void>;
  /** All stored segments of an interview, oldest first. */
  listSegments(interviewId: string): Promise<TranscriptSegment[]>;
  /** Erase an interview's transcript (retention / data-subject deletion). */
  deleteSegments(interviewId: string): Promise<void>;
}

/**
 * Remembers which inbound e-mails were already processed. SendGrid (like any webhook sender) can deliver the same
 * message more than once; without this a repeated invite would create a second bot.
 * Check first, mark only AFTER successful processing, so a failed attempt is retried and not swallowed.
 */
export interface InboundMessageLog {
  hasMessageSeen(messageId: string): Promise<boolean>;
  markMessageSeen(messageId: string): Promise<void>;
}

/** Process-memory store for tests and quick local runs. State is lost on restart. */
export class InMemoryStore implements InterviewStore, TranscriptStore, InboundMessageLog {
  private byId = new Map<string, Interview>();
  private segments = new Map<string, TranscriptSegment[]>();
  private seen = new Set<string>();

  async findByAlias(alias: string) {
    for (const i of this.byId.values()) if (i.alias === alias.toUpperCase()) return { ...i };
    return undefined;
  }
  async findById(id: string) {
    const i = this.byId.get(id);
    return i ? { ...i } : undefined;
  }
  async findByBotId(botId: string) {
    for (const i of this.byId.values()) if (i.recallBotId === botId) return { ...i };
    return undefined;
  }
  async save(interview: Interview) {
    for (const other of this.byId.values()) {
      if (other.id !== interview.id && other.alias === interview.alias) throw new Error(`alias ${interview.alias} already in use`);
    }
    this.byId.set(interview.id, { ...interview });
  }

  async appendSegment(s: TranscriptSegment) {
    const list = this.segments.get(s.interviewId) ?? [];
    if (!list.some((x) => x.speakerId === s.speakerId && x.startMs === s.startMs)) list.push({ ...s });
    this.segments.set(s.interviewId, list);
  }
  async listSegments(interviewId: string) {
    return [...(this.segments.get(interviewId) ?? [])].sort((a, b) => a.startMs - b.startMs);
  }
  async deleteSegments(interviewId: string) {
    this.segments.delete(interviewId);
  }

  async hasMessageSeen(messageId: string) {
    return this.seen.has(messageId);
  }
  async markMessageSeen(messageId: string) {
    this.seen.add(messageId);
  }
}
