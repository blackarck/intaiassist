export interface Me { email: string; name?: string; provider: string; subject: string; isAdmin: boolean }

export interface InterviewSummary {
  id: string;
  alias: string;
  /** The address to put on the meeting invite. */
  address: string;
  status: "paid" | "scheduled" | "joining" | "in_meeting" | "ended" | "cancelled" | "not_admitted";
  platform?: "teams" | "zoom" | "meet";
  startsAt?: string;
  joinMode?: "scheduled" | "ad_hoc";
  recording?: { ok: boolean; detail?: string };
  createdAt?: string;
}

export interface Question {
  id: string;
  kind: "preset" | "generated" | "follow_up" | "live";
  text: string;
  why?: string;
  keyPoints: string[];
  probes: string[];
  answerId?: string;
  followKind?: "probe" | "clarify" | "deepen" | "move_on";
  /** "score": derived from problems found in the answer (better grounded than the quick "fast" ones). */
  source?: "fast" | "score";
  aboutQuote?: string;
  status: "queued" | "asked" | "skipped";
}

export interface Problem { quote: string; issue: string; correction: string; severity: "minor" | "major"; counterQuestion: string }

export interface ScoreOutput {
  /** Written assessment: what was right and what was wrong. */
  verdict: string;
  experience: { signal: "first_hand" | "unclear" | "generic"; evidence: string; probe: string };
  problems: Problem[];
  score: number;
  dimensions: { technicalCorrectness: number; depth: number; clarity: number; relevance: number };
  strengths: string[];
  gaps: string[];
  evidenceQuotes: string[];
  confidence: "low" | "medium" | "high";
  note: string;
}
export interface Score { answerId: string; version: number; model: string; output: ScoreOutput; at: string }

export interface Answer {
  id: string;
  questionId?: string;
  questionText: string;
  text: string;
  startMs: number;
  endMs: number;
  state: "open" | "closed";
  version: number;
}

export interface Segment { speakerId: string; speakerName?: string; role: "interviewer" | "candidate" | "unknown"; text: string; startMs: number; endMs?: number }

export interface AssistItem { suggestion: string; kind: "question" | "reminder" | "clarify"; evidence: string[]; at: string; /** Offered without being asked. */ auto?: boolean }

export interface Scorecard {
  summary: string;
  strengths: string[];
  risks: string[];
  followUpsNextRound: string[];
  answered: number;
  scored: number;
  averageScore: number;
  dimensionAverages: ScoreOutput["dimensions"];
}

export interface Snapshot {
  lastSeq: number;
  setup?: { roleTitle: string; roleLevel?: string; presetCount: number };
  questions: Question[];
  answers: (Answer & { score: Score | null })[];
  scorecard: Scorecard | null;
  transcript: Segment[];
}

export interface RoomEvent { seq?: number; at: string; type: string; data: unknown }
