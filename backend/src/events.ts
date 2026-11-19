import type { MeetingEvent } from "./meetingSource.js";
import type { InterviewStatus, InterviewStore } from "./store.js";

const STATUS_FOR: Record<MeetingEvent["type"], InterviewStatus | undefined> = {
  lobby_waiting: "joining",
  admitted: "in_meeting",
  recording_status: undefined,
  segment: undefined,
  ended: "ended",
};

export type SegmentHandler = (e: Extract<MeetingEvent, { type: "segment" }>["segment"]) => void;

/**
 * Receives events from the media bot (lobby, admitted, transcript segments, ended).
 * Spike: updates interview status and hands segments to a handler (logs by default).
 * Next: segment handler feeds turn detection -> evaluator -> chat-bot coaching card.
 */
export async function handleBotEvent(
  e: MeetingEvent,
  deps: { store: InterviewStore; onSegment?: SegmentHandler },
): Promise<{ ok: boolean; error?: string }> {
  const interviewId = e.type === "segment" ? e.segment.interviewId : e.interviewId;
  const interview = await deps.store.findById(interviewId);
  if (!interview) return { ok: false, error: "unknown_interview" };

  // A cancelled interview stays cancelled: the "call ended" that follows our own cancel must not overwrite it.
  if (interview.status === "cancelled") return { ok: true };

  if (e.type === "segment") {
    deps.onSegment?.(e.segment);
    return { ok: true };
  }

  if (e.type === "recording_status") {
    await deps.store.save({ ...interview, recording: { ok: e.ok, detail: e.detail } });
    return { ok: true };
  }

  let status = STATUS_FOR[e.type];
  if (e.type === "ended" && e.reason === "not_admitted") status = "not_admitted";
  if (status) await deps.store.save({ ...interview, status });
  return { ok: true };
}
