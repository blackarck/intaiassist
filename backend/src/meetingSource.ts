/**
 * Events the meeting bot (Recall.ai) reports about an interview. Kept provider-neutral: the webhook layer maps
 * Recall's payloads into these, and the rest of the system (status tracking, coaching) only sees these types.
 */
export interface TranscriptSegment {
  interviewId: string;
  /** Provider participant id */
  speakerId: string;
  speakerName?: string;
  role?: "interviewer" | "candidate" | "unknown";
  text: string;
  /** false for partial (still-being-spoken) utterances */
  isFinal: boolean;
  /** ms offset from the start of the recording */
  startMs: number;
  endMs?: number;
}

export type MeetingEvent =
  | { type: "lobby_waiting"; interviewId: string }
  | { type: "admitted"; interviewId: string }
  /** Platform-level recording permission (Zoom reports denials). ok=false means no transcript will be produced. */
  | { type: "recording_status"; interviewId: string; ok: boolean; detail?: string }
  | { type: "segment"; segment: TranscriptSegment }
  | {
      type: "ended";
      interviewId: string;
      reason: "meeting_ended" | "removed" | "not_admitted" | "error";
      /** provider sub-code for diagnostics */
      detail?: string;
    };
