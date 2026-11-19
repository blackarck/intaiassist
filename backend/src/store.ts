export type InterviewStatus =
  | "paid" // alias issued, waiting for invite
  | "scheduled" // invite received, join job queued
  | "joining"
  | "in_meeting"
  | "ended"
  | "cancelled"
  | "not_admitted";

export interface Interview {
  id: string;
  /** alias tag, e.g. "7KQ2" -> iv-7KQ2@domain */
  alias: string;
  ownerEmail: string;
  status: InterviewStatus;
  joinUrl?: string;
  icalUid?: string;
  startsAt?: string;
  /** Teams 1:1 conversation id, filled when the interviewer installs the app */
  teamsConversationId?: string;
  /**
   * Entra tenant of the interviewer (from portal sign-in or the Teams app install event).
   * REQUIRED for short Teams links (/meet/<id>?p=...), which don't carry the organizer's tenant.
   */
  tenantId?: string;
  /** Entra object id of the interviewer, used by the bot to tag speakers as interviewer vs candidate. */
  interviewerAadId?: string;
  /** Result of Graph updateRecordingStatus; "failed" means the bot must not produce a transcript. */
  recording?: { ok: boolean; detail?: string };
}

export interface InterviewStore {
  findByAlias(alias: string): Promise<Interview | undefined>;
  findById(id: string): Promise<Interview | undefined>;
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
  async save(interview: Interview) {
    this.byId.set(interview.id, { ...interview });
  }
}
