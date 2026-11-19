/** Data the room works with. All of it belongs to one interview and is deleted with it. */
export interface PresetQuestion {
  text: string;
  keyPoints?: string[];
}

export interface RoomSetup {
  interviewId: string;
  roleTitle: string;
  roleLevel?: string;
  jd: string;
  resumeSummary?: string;
  presetQuestions: PresetQuestion[];
}

export interface RoomQuestion {
  id: string;
  interviewId: string;
  /** preset: chosen by the interviewer. generated: suggested up front. follow_up: suggested after an answer. live: asked but not on the list. */
  kind: "preset" | "generated" | "follow_up" | "live";
  text: string;
  why?: string;
  keyPoints: string[];
  probes: string[];
  /** follow_up: the answer it follows from. */
  answerId?: string;
  followKind?: "probe" | "clarify" | "deepen" | "move_on";
  status: "queued" | "asked" | "skipped";
  createdAt: string;
}

export interface RoomAnswer {
  id: string;
  interviewId: string;
  questionId?: string;
  questionText: string;
  text: string;
  startMs: number;
  endMs: number;
  state: "open" | "closed";
  /** Bumped each time the answer is closed after new speech; a score belongs to one version. */
  version: number;
}

export interface RoomScore {
  interviewId: string;
  answerId: string;
  version: number;
  model: string;
  output: {
    score: number;
    dimensions: { technicalCorrectness: number; depth: number; clarity: number; relevance: number };
    strengths: string[];
    gaps: string[];
    evidenceQuotes: string[];
    confidence: "low" | "medium" | "high";
    note: string;
  };
  at: string;
}

export type RoomEventType = "segment" | "status" | "answer" | "questions" | "score" | "assist" | "scorecard" | "ai_error";

export interface RoomEvent {
  /** Per-interview, increasing. Absent on transient events (partial transcript) that are not replayed. */
  seq?: number;
  at: string;
  type: RoomEventType;
  data: unknown;
}

export interface RoomStore {
  getSetup(interviewId: string): Promise<RoomSetup | undefined>;
  saveSetup(setup: RoomSetup): Promise<void>;

  /** Upsert by id. */
  saveQuestion(q: RoomQuestion): Promise<void>;
  deleteQuestions(interviewId: string, ids: string[]): Promise<void>;
  /** Oldest first. */
  listQuestions(interviewId: string): Promise<RoomQuestion[]>;

  saveAnswer(a: RoomAnswer): Promise<void>;
  listAnswers(interviewId: string): Promise<RoomAnswer[]>;

  saveScore(s: RoomScore): Promise<void>;
  /** Every stored version, oldest first. */
  listScores(interviewId: string): Promise<RoomScore[]>;

  /** Persist an event for replay and return it with its seq. */
  appendEvent(interviewId: string, type: RoomEventType, data: unknown): Promise<RoomEvent & { seq: number }>;
  eventsAfter(interviewId: string, afterSeq: number, limit: number): Promise<(RoomEvent & { seq: number })[]>;
  lastEvent(interviewId: string, type: RoomEventType): Promise<(RoomEvent & { seq: number }) | undefined>;

  deleteRoom(interviewId: string): Promise<void>;
}

export class InMemoryRoomStore implements RoomStore {
  private setups = new Map<string, RoomSetup>();
  private questions = new Map<string, RoomQuestion>();
  private answers = new Map<string, RoomAnswer>();
  private scores: RoomScore[] = [];
  private events = new Map<string, (RoomEvent & { seq: number })[]>();

  async getSetup(id: string) {
    const s = this.setups.get(id);
    return s && structuredClone(s);
  }
  async saveSetup(s: RoomSetup) {
    this.setups.set(s.interviewId, structuredClone(s));
  }
  async saveQuestion(q: RoomQuestion) {
    this.questions.set(q.id, structuredClone(q));
  }
  async deleteQuestions(interviewId: string, ids: string[]) {
    for (const id of ids) if (this.questions.get(id)?.interviewId === interviewId) this.questions.delete(id);
  }
  async listQuestions(interviewId: string) {
    return [...this.questions.values()].filter((q) => q.interviewId === interviewId).map((q) => structuredClone(q));
  }
  async saveAnswer(a: RoomAnswer) {
    this.answers.set(a.id, structuredClone(a));
  }
  async listAnswers(interviewId: string) {
    return [...this.answers.values()].filter((a) => a.interviewId === interviewId).sort((x, y) => x.startMs - y.startMs).map((a) => structuredClone(a));
  }
  async saveScore(s: RoomScore) {
    this.scores = this.scores.filter((x) => !(x.answerId === s.answerId && x.version === s.version));
    this.scores.push(structuredClone(s));
  }
  async listScores(interviewId: string) {
    return this.scores.filter((s) => s.interviewId === interviewId).map((s) => structuredClone(s));
  }
  async appendEvent(interviewId: string, type: RoomEventType, data: unknown) {
    const list = this.events.get(interviewId) ?? [];
    const ev = { seq: (list.at(-1)?.seq ?? 0) + 1, at: new Date().toISOString(), type, data: structuredClone(data) };
    list.push(ev);
    this.events.set(interviewId, list);
    return structuredClone(ev);
  }
  async eventsAfter(interviewId: string, afterSeq: number, limit: number) {
    return (this.events.get(interviewId) ?? []).filter((e) => e.seq > afterSeq).slice(0, limit).map((e) => structuredClone(e));
  }
  async lastEvent(interviewId: string, type: RoomEventType) {
    const e = [...(this.events.get(interviewId) ?? [])].reverse().find((x) => x.type === type);
    return e && structuredClone(e);
  }
  async deleteRoom(interviewId: string) {
    this.setups.delete(interviewId);
    for (const [id, q] of this.questions) if (q.interviewId === interviewId) this.questions.delete(id);
    for (const [id, a] of this.answers) if (a.interviewId === interviewId) this.answers.delete(id);
    this.scores = this.scores.filter((s) => s.interviewId !== interviewId);
    this.events.delete(interviewId);
  }
}
