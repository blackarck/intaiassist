import type { TranscriptSegment } from "../meetingSource.js";

/**
 * Turn detection: turns a stream of final transcript segments into "question -> answer" pairs.
 *
 *  - Interviewer speech (that is not just "ok", "right", "mm-hmm") is the question. Several segments in a row are one question.
 *  - The candidate's next speech opens an answer to that question; more candidate speech extends it.
 *  - The answer CLOSES when the interviewer speaks again, when the candidate has been quiet for `silenceMs`, or when the meeting ends.
 *  - If the candidate resumes within `reopenMs` and the interviewer has not spoken in between, the same answer is REOPENED
 *    (a pause to think is not the end of the answer). Closing it again produces a new version, which is re-scored.
 *  - Speech from people whose role is unknown is ignored here (it is still in the transcript).
 *
 * Pure: the caller supplies the clock (arrival time), so tests need no timers.
 */
export interface TurnOptions {
  silenceMs: number;
  reopenMs: number;
  newId: () => string;
}

export type TurnEffect =
  | { kind: "answer_open"; answerId: string; questionText: string; text: string; startMs: number; endMs: number }
  | { kind: "answer_update"; answerId: string; text: string; endMs: number }
  | { kind: "answer_close"; answerId: string; questionText: string; text: string; startMs: number; endMs: number; version: number; reason: "interviewer" | "silence" | "end" };

interface Answer {
  id: string;
  questionText: string;
  text: string;
  startMs: number;
  endMs: number;
  lastHeardAt: number;
  open: boolean;
  closedAt?: number;
  version: number;
}

const BACKCHANNEL = /^(?:ok(?:ay)?|right|yeah|yes|yep|yup|mm+(?:[- ]?hmm)?|uh[- ]?huh|sure|got it|i see|all ?right|good|great|nice|cool|thanks?(?: you)?|thank you|go on|go ahead|please continue|continue|exactly|correct)[\s.,!?-]*$/i;

export const isBackchannel = (text: string): boolean => BACKCHANNEL.test(text.trim()) || text.trim().split(/\s+/).length <= 1;

export class TurnDetector {
  private qBuf?: { text: string; startMs: number };
  private answer?: Answer;
  private interviewerSince = false;
  private lastWasInterviewer = false;
  private seen = new Set<string>();

  constructor(private readonly o: TurnOptions) {}

  onSegment(seg: TranscriptSegment, now: number): TurnEffect[] {
    if (!seg.isFinal) return [];
    const key = `${seg.speakerId}:${seg.startMs}`;
    if (this.seen.has(key)) return []; // Recall delivers at least once
    this.seen.add(key);
    const text = seg.text.trim();
    if (!text) return [];
    const endMs = seg.endMs ?? seg.startMs;

    if (seg.role === "interviewer") {
      if (isBackchannel(text)) return [];
      const effects = this.close("interviewer", now);
      this.interviewerSince = true;
      this.qBuf = this.lastWasInterviewer && this.qBuf ? { text: `${this.qBuf.text} ${text}`, startMs: this.qBuf.startMs } : { text, startMs: seg.startMs };
      this.lastWasInterviewer = true;
      return effects;
    }

    if (seg.role !== "candidate") return [];
    this.lastWasInterviewer = false;
    const a = this.answer;
    if (a?.open) {
      a.text = `${a.text} ${text}`;
      a.endMs = endMs;
      a.lastHeardAt = now;
      return [{ kind: "answer_update", answerId: a.id, text: a.text, endMs }];
    }
    if (a && !this.interviewerSince && a.closedAt !== undefined && now - a.closedAt <= this.o.reopenMs) {
      a.open = true;
      a.closedAt = undefined;
      a.text = `${a.text} ${text}`;
      a.endMs = endMs;
      a.lastHeardAt = now;
      return [{ kind: "answer_update", answerId: a.id, text: a.text, endMs }];
    }
    if (this.qBuf) {
      this.answer = { id: this.o.newId(), questionText: this.qBuf.text, text, startMs: seg.startMs, endMs, lastHeardAt: now, open: true, version: 0 };
      this.qBuf = undefined;
      this.interviewerSince = false;
      return [{ kind: "answer_open", answerId: this.answer.id, questionText: this.answer.questionText, text, startMs: seg.startMs, endMs }];
    }
    return []; // candidate speaking with no question asked (an introduction, small talk)
  }

  /** Call regularly with the current time; closes an answer after `silenceMs` of quiet. */
  tick(now: number): TurnEffect[] {
    const a = this.answer;
    return a?.open && now - a.lastHeardAt >= this.o.silenceMs ? this.close("silence", now) : [];
  }

  /** The meeting ended: close whatever is open. */
  flush(now: number): TurnEffect[] {
    return this.close("end", now);
  }

  get hasOpenAnswer(): boolean {
    return this.answer?.open === true;
  }

  private close(reason: "interviewer" | "silence" | "end", now: number): TurnEffect[] {
    const a = this.answer;
    if (!a?.open) return [];
    a.open = false;
    a.closedAt = now;
    a.version += 1;
    return [{ kind: "answer_close", answerId: a.id, questionText: a.questionText, text: a.text, startMs: a.startMs, endMs: a.endMs, version: a.version, reason }];
  }
}
