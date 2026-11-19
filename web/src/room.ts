import type { AssistItem, Answer, Question, RoomEvent, Scorecard, Score, Segment, Snapshot } from "./types";

/** Everything the room screen draws. Built from a snapshot, then kept current by applying live events. */
export interface RoomState {
  loaded: boolean;
  lastSeq: number;
  status?: string;
  transcript: Segment[];
  /** What is being said right now (a partial, not yet final). */
  partial?: Segment;
  questions: Question[];
  answers: Answer[];
  scores: Record<string, Score>;
  assists: AssistItem[];
  scorecard: Scorecard | null;
  /** Problems the person should know about (an AI call failed...). */
  notices: { at: string; text: string }[];
}

export const emptyRoom: RoomState = { loaded: false, lastSeq: 0, transcript: [], questions: [], answers: [], scores: {}, assists: [], scorecard: null, notices: [] };

export function fromSnapshot(s: Snapshot): RoomState {
  const scores: Record<string, Score> = {};
  for (const a of s.answers) if (a.score) scores[a.id] = a.score;
  return {
    ...emptyRoom,
    loaded: true,
    lastSeq: s.lastSeq,
    transcript: s.transcript,
    questions: s.questions,
    answers: s.answers.map(({ score: _s, ...a }) => a),
    scores,
    scorecard: s.scorecard,
  };
}

const upsert = <T extends { id: string }>(list: T[], item: T): T[] => (list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item]);

const NOTICE: Record<string, string> = {
  score_answer: "Scoring an answer failed. It will show without a score.",
  next_questions: "Follow-up suggestions are unavailable for the last answer.",
  assist: "Assist is unavailable right now.",
  opening_questions: "Could not generate questions.",
  scorecard: "The scorecard could not be built.",
};

export function applyEvent(state: RoomState, e: RoomEvent): RoomState {
  const next: RoomState = e.seq !== undefined ? { ...state, lastSeq: Math.max(state.lastSeq, e.seq) } : state;
  const d = e.data as never as Record<string, unknown>;
  switch (e.type) {
    case "segment": {
      const seg = d as unknown as Segment & { final?: boolean };
      if (seg.final === false) return { ...next, partial: seg };
      if (next.transcript.some((x) => x.speakerId === seg.speakerId && x.startMs === seg.startMs)) return next;
      return { ...next, partial: undefined, transcript: [...next.transcript, seg].sort((a, b) => a.startMs - b.startMs) };
    }
    case "answer":
      return { ...next, answers: upsert(next.answers, d as unknown as Answer).sort((a, b) => a.startMs - b.startMs) };
    case "questions": {
      const removed = new Set((d.removedIds as string[] | undefined) ?? []);
      let qs = next.questions.filter((q) => !removed.has(q.id));
      for (const q of (d.items as Question[]) ?? []) qs = upsert(qs, q);
      return { ...next, questions: qs };
    }
    case "score": {
      const s = d as unknown as Score;
      const cur = next.scores[s.answerId];
      return !cur || s.version >= cur.version ? { ...next, scores: { ...next.scores, [s.answerId]: s } } : next;
    }
    case "assist":
      return { ...next, assists: [{ ...(d as unknown as Omit<AssistItem, "at">), at: e.at }, ...next.assists].slice(0, 20) };
    case "scorecard":
      return { ...next, scorecard: d as unknown as Scorecard };
    case "status":
      return { ...next, status: d.status as string };
    case "ai_error":
      return { ...next, notices: [{ at: e.at, text: NOTICE[d.task as string] ?? "An AI step failed." }, ...next.notices].slice(0, 5) };
    default:
      return next;
  }
}
