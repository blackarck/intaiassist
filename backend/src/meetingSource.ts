/**
 * Abstraction over "where does the live transcript come from?".
 * Lets us swap our own Graph media bot (Option A) for a vendor bot (Option B)
 * or Work IQ (Option C) without touching evaluation/coaching code.
 * See doc/bot-join-research.md.
 */
export interface TranscriptSegment {
  interviewId: string;
  /** Teams participant id / display name resolved from active-speaker ids */
  speakerId: string;
  speakerName?: string;
  role?: "interviewer" | "candidate" | "unknown";
  text: string;
  isFinal: boolean;
  /** ms offset from join */
  startMs: number;
  endMs?: number;
}

export type MeetingEvent =
  | { type: "lobby_waiting"; interviewId: string }
  | { type: "admitted"; interviewId: string }
  /** Outcome of Graph updateRecordingStatus. ok=false => no transcript will be produced (spike risk #1). */
  | { type: "recording_status"; interviewId: string; ok: boolean; detail?: string }
  | { type: "segment"; segment: TranscriptSegment }
  | { type: "ended"; interviewId: string; reason: "meeting_ended" | "removed" | "not_admitted" | "error" };

export interface MeetingSource {
  join(args: { interviewId: string; joinUrl: string }): Promise<void>;
  leave(interviewId: string): Promise<void>;
  onEvent(handler: (e: MeetingEvent) => void): void;
}
