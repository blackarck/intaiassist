import type { InterviewStore, TranscriptStore } from "../store.js";
import type { MeetingEvent, TranscriptSegment } from "../meetingSource.js";
import { runTask, type AiResult, type RunnerDeps } from "../ai/runner.js";
import { sameQuestion } from "../ai/tasks/types.js";
import { RoomBus } from "./bus.js";
import { TurnDetector, type TurnEffect } from "./turns.js";
import type { RoomAnswer, RoomEvent, RoomEventType, RoomQuestion, RoomScore, RoomSetup, RoomStore } from "./types.js";

export interface RoomDeps {
  rooms: RoomStore;
  transcripts: TranscriptStore;
  interviews: InterviewStore;
  ai: RunnerDeps;
  now?: () => number;
  newId?: () => string;
  /** Quiet time after which a candidate answer is considered finished. */
  silenceMs?: number;
  reopenMs?: number;
  /** Cap on simultaneous AI calls across all interviews. */
  maxConcurrentAi?: number;
  /**
   * If the candidate has finished an answer and the interviewer has said nothing for this long, offer a suggestion without being
   * asked (they are busy taking notes, not pressing buttons). 0 turns it off.
   */
  autoAssistMs?: number;
  /** Answers shorter than this many words are shown but not scored. */
  minScoreWords?: number;
  onWarn?: (message: string, err?: unknown) => void;
}

interface State {
  detector: TurnDetector;
  chain: Promise<void>;
  answers: Map<string, RoomAnswer>;
  seen: Set<string>;
}

const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
const roleOf = (r?: string): "interviewer" | "candidate" | "unknown" => (r === "interviewer" || r === "candidate" ? r : "unknown");

/**
 * The live coaching room for every interview: turns transcript segments into questions and answers, asks the AI for
 * follow-ups (inline) and scores (in the background), and publishes everything as room events.
 *
 * Failures never reach the meeting: an AI error becomes an `ai_error` event the screen can show, and the transcript keeps flowing.
 */
export class RoomService {
  readonly bus = new RoomBus();
  private states = new Map<string, State>();
  private inflight = new Map<string, Set<Promise<unknown>>>();
  private finishing = new Set<Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;
  private aiActive = 0;
  private aiWaiting: (() => void)[] = [];

  constructor(private readonly d: RoomDeps) {}

  get rooms(): RoomStore {
    return this.d.rooms;
  }

  private now = () => (this.d.now ?? Date.now)();
  private id = () => (this.d.newId ?? (() => crypto.randomUUID()))();
  private warn = (m: string, e?: unknown) => this.d.onWarn?.(m, e);

  // ---- lifecycle

  start(tickMs = 500) {
    this.timer ??= setInterval(() => this.tickAll(), tickMs);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Resolves when the interview's queued work and background AI jobs have finished (not the end-of-meeting scorecard). */
  async idle(interviewId: string) {
    for (;;) {
      const pending: Promise<unknown>[] = [...(this.inflight.get(interviewId) ?? [])];
      const chain = this.states.get(interviewId)?.chain;
      if (chain) pending.push(chain);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
      if ((this.inflight.get(interviewId)?.size ?? 0) === 0) return;
    }
  }

  /** Resolves when everything, including end-of-meeting scorecards, has finished. For tests and graceful shutdown. */
  async settle() {
    for (;;) {
      const ids = [...new Set([...this.states.keys(), ...this.inflight.keys()])];
      await Promise.all(ids.map((id) => this.idle(id)));
      if (this.finishing.size === 0) return;
      await Promise.allSettled([...this.finishing]);
    }
  }

  // ---- input from the meeting

  onSegment(seg: TranscriptSegment) {
    this.enqueue(seg.interviewId, async (st) => {
      const data = { speakerId: seg.speakerId, speakerName: seg.speakerName, role: roleOf(seg.role), text: seg.text, startMs: seg.startMs, endMs: seg.endMs, final: seg.isFinal };
      if (!seg.isFinal) {
        this.emit(seg.interviewId, "segment", data, false); // partials are for live display only: not stored, not replayed
        return;
      }
      const key = `${seg.speakerId}:${seg.startMs}`;
      if (st.seen.has(key)) return;
      st.seen.add(key);
      await this.emit(seg.interviewId, "segment", data, true);
      await this.apply(seg.interviewId, st, st.detector.onSegment(seg, this.now()));
    });
  }

  /** Bot lifecycle events from Recall (joining, admitted, ended). Segments come through onSegment. */
  onMeetingEvent(e: MeetingEvent) {
    if (e.type === "segment") return;
    if (e.type === "ended") {
      this.onStatus(e.interviewId, e.reason === "not_admitted" ? "not_admitted" : "ended");
      if (e.reason === "meeting_ended" || e.reason === "removed") this.onEnded(e.interviewId);
      else void this.idle(e.interviewId).then(() => this.states.delete(e.interviewId)); // never joined: nothing to score, just release memory
    } else if (e.type === "lobby_waiting") this.onStatus(e.interviewId, "joining");
    else if (e.type === "admitted") this.onStatus(e.interviewId, "in_meeting");
  }

  /** The bot's status changed (joining, in the meeting, ended...). */
  onStatus(interviewId: string, status: string) {
    this.enqueue(interviewId, async () => {
      await this.emit(interviewId, "status", { status }, true);
    });
  }

  /** The meeting is over: close the open answer, wait for scoring, then build the scorecard. */
  onEnded(interviewId: string) {
    this.enqueue(interviewId, async (st) => {
      await this.apply(interviewId, st, st.detector.flush(this.now()));
    });
    const done: Promise<unknown> = (async () => {
      await this.idle(interviewId);
      await this.scorecard(interviewId);
      this.states.delete(interviewId);
    })()
      .catch((e) => this.warn(`scorecard failed for ${interviewId}`, e))
      .finally(() => this.finishing.delete(done));
    this.finishing.add(done);
  }

  tickAll() {
    const wait = this.d.autoAssistMs ?? 10_000;
    for (const [id, st] of this.states) {
      const effects = st.detector.tick(this.now());
      if (effects.length) this.enqueue(id, (s) => this.apply(id, s, effects));
      if (wait > 0 && st.detector.stalled(this.now(), wait) !== undefined) this.spawn(id, () => this.assist(id, { auto: true }));
    }
  }

  // ---- setup and on-demand tasks

  /** Save the interviewer's setup (role, JD, resume, preset questions) and make the preset questions visible in the room. */
  async configure(setup: RoomSetup) {
    await this.d.rooms.saveSetup(setup);
    const existing = await this.d.rooms.listQuestions(setup.interviewId);
    const wanted = setup.presetQuestions.map((p, i) => ({ id: `${setup.interviewId}:preset:${i}`, p }));
    const keep = new Set(wanted.map((w) => w.id));
    const removed = existing.filter((q) => q.kind === "preset" && !keep.has(q.id) && q.status === "queued").map((q) => q.id);
    await this.d.rooms.deleteQuestions(setup.interviewId, removed);
    const items: RoomQuestion[] = [];
    for (const { id, p } of wanted) {
      const prev = existing.find((q) => q.id === id);
      const q: RoomQuestion = { id, interviewId: setup.interviewId, kind: "preset", text: p.text, keyPoints: p.keyPoints ?? [], probes: [], status: prev?.status ?? "queued", createdAt: prev?.createdAt ?? new Date(this.now()).toISOString() };
      await this.d.rooms.saveQuestion(q);
      items.push(q);
    }
    await this.emit(setup.interviewId, "questions", { reason: "setup", items, removedIds: removed }, true);
    return items;
  }

  /** Generate extra questions from the JD and resume (the interviewer's preset questions are not repeated). */
  async openingQuestions(interviewId: string, count = 6) {
    const setup = await this.d.rooms.getSetup(interviewId);
    if (!setup) return fail("no_setup", "save the interview setup first");
    const res = await this.run("opening_questions", {
      role: { title: setup.roleTitle, level: setup.roleLevel },
      jd: setup.jd.slice(0, 4000),
      resumeSummary: setup.resumeSummary?.slice(0, 3000),
      presetQuestions: setup.presetQuestions.map((p) => p.text),
      count,
    }, interviewId);
    if (!res.ok) return this.aiError(interviewId, "opening_questions", res);
    const old = (await this.d.rooms.listQuestions(interviewId)).filter((q) => q.kind === "generated" && q.status === "queued").map((q) => q.id);
    await this.d.rooms.deleteQuestions(interviewId, old);
    const items = (res.output as { questions: { text: string; why: string; keyPoints: string[]; probes: string[] }[] }).questions.map((q): RoomQuestion => ({
      id: this.id(), interviewId, kind: "generated", text: q.text, why: q.why, keyPoints: q.keyPoints, probes: q.probes, status: "queued", createdAt: new Date(this.now()).toISOString(),
    }));
    for (const q of items) await this.d.rooms.saveQuestion(q);
    await this.emit(interviewId, "questions", { reason: "opening", items, removedIds: old }, true);
    return { ok: true as const, items };
  }

  /** "Assist me": one suggestion grounded in this interview's own transcript, the resume and the JD. */
  async assist(interviewId: string, opts: { auto?: boolean } = {}) {
    const segs = await this.d.transcripts.listSegments(interviewId);
    const turns = segs.filter((s) => s.text.trim()).map((s) => ({ role: roleOf(s.role), text: s.text.slice(0, 1500) }));
    if (turns.length === 0) return fail("no_transcript", "nothing has been said yet");
    const recent = turns.slice(-8);
    const earlier = turns.slice(0, -8).map((t) => `${t.role}: ${t.text}`).join("\n");
    const setup = await this.d.rooms.getSetup(interviewId);
    const asked = (await this.d.rooms.listQuestions(interviewId)).filter((q) => q.status === "asked").map((q) => q.text).slice(-40);
    const res = await this.run("assist", {
      recentTurns: recent,
      earlierNotes: earlier ? earlier.slice(-4000) : undefined,
      resumeSummary: setup?.resumeSummary?.slice(0, 3000),
      jd: setup?.jd.slice(0, 1500),
      asked,
    }, interviewId);
    if (!res.ok) return opts.auto ? { ok: false as const, error: res.error } : this.aiError(interviewId, "assist", res);
    await this.emit(interviewId, "assist", { ...(res.output as object), auto: opts.auto === true }, true);
    return { ok: true as const, assist: res.output };
  }

  /** Summarise the interview from the scored answers. Describes evidence; never decides. */
  async scorecard(interviewId: string) {
    const [answers, scores, setup] = await Promise.all([this.d.rooms.listAnswers(interviewId), this.d.rooms.listScores(interviewId), this.d.rooms.getSetup(interviewId)]);
    const latest = new Map<string, RoomScore>();
    for (const s of scores) if (!latest.has(s.answerId) || latest.get(s.answerId)!.version < s.version) latest.set(s.answerId, s);
    const scored = answers.filter((a) => latest.has(a.id));
    if (scored.length === 0) return fail("nothing_to_score", "no answer has been scored");
    const items = scored.slice(-40).map((a) => {
      const s = latest.get(a.id)!.output;
      return { question: a.questionText.slice(0, 600), answerSummary: a.text.slice(0, 600), score: s.score, gaps: [...s.problems.map((p) => p.issue), ...s.gaps].slice(0, 4) };
    });
    const res = await this.run("scorecard", { role: setup?.roleTitle ?? "Interview", items }, interviewId);
    if (!res.ok) return this.aiError(interviewId, "scorecard", res);
    const outs = scored.map((a) => latest.get(a.id)!.output);
    const avg = (f: (o: RoomScore["output"]) => number) => Math.round((outs.reduce((n, o) => n + f(o), 0) / outs.length) * 10) / 10;
    const card = {
      ...(res.output as object),
      answered: answers.length,
      scored: scored.length,
      averageScore: avg((o) => o.score),
      dimensionAverages: {
        technicalCorrectness: avg((o) => o.dimensions.technicalCorrectness),
        depth: avg((o) => o.dimensions.depth),
        clarity: avg((o) => o.dimensions.clarity),
        relevance: avg((o) => o.dimensions.relevance),
      },
    };
    await this.emit(interviewId, "scorecard", card, true);
    return { ok: true as const, scorecard: card };
  }

  /** Everything the screen needs to draw the room from scratch (a page load or a reconnect after a long gap). */
  async snapshot(interviewId: string) {
    const [setup, questions, answers, scores, scorecard, segs, lastSeq] = await Promise.all([
      this.d.rooms.getSetup(interviewId),
      this.d.rooms.listQuestions(interviewId),
      this.d.rooms.listAnswers(interviewId),
      this.d.rooms.listScores(interviewId),
      this.d.rooms.lastEvent(interviewId, "scorecard"),
      this.d.transcripts.listSegments(interviewId),
      this.lastSeq(interviewId),
    ]);
    const latest = new Map<string, RoomScore>();
    for (const s of scores) if (!latest.has(s.answerId) || latest.get(s.answerId)!.version < s.version) latest.set(s.answerId, s);
    return {
      /** Subscribe to the live feed with Last-Event-ID = this to receive only what comes after the snapshot. */
      lastSeq,
      setup: setup && { roleTitle: setup.roleTitle, roleLevel: setup.roleLevel, presetCount: setup.presetQuestions.length },
      questions,
      answers: answers.map((a) => ({ ...a, score: latest.get(a.id) ?? null })),
      scorecard: scorecard?.data ?? null,
      transcript: segs.map((s) => ({ speakerId: s.speakerId, speakerName: s.speakerName, role: roleOf(s.role), text: s.text, startMs: s.startMs, endMs: s.endMs })),
    };
  }

  private async lastSeq(interviewId: string): Promise<number> {
    let after = 0;
    for (;;) {
      const page = await this.d.rooms.eventsAfter(interviewId, after, 500);
      if (page.length === 0) return after;
      after = page[page.length - 1]!.seq;
    }
  }

  // ---- effects of turn detection

  private async apply(interviewId: string, st: State, effects: TurnEffect[]) {
    for (const e of effects) {
      if (e.kind === "answer_open") {
        const qs = await this.d.rooms.listQuestions(interviewId);
        let q = qs.find((x) => x.status === "queued" && sameQuestion(x.text, e.questionText));
        if (q) q = { ...q, status: "asked" };
        else q = { id: this.id(), interviewId, kind: "live", text: e.questionText, keyPoints: [], probes: [], status: "asked", createdAt: new Date(this.now()).toISOString() };
        await this.d.rooms.saveQuestion(q);
        await this.emit(interviewId, "questions", { reason: "asked", items: [q], removedIds: [] }, true);
        const a: RoomAnswer = { id: e.answerId, interviewId, questionId: q.id, questionText: e.questionText, text: e.text, startMs: e.startMs, endMs: e.endMs, state: "open", version: 0 };
        st.answers.set(a.id, a);
        await this.d.rooms.saveAnswer(a);
        await this.emit(interviewId, "answer", a, true);
      } else if (e.kind === "answer_update") {
        const a = st.answers.get(e.answerId);
        if (!a) continue;
        Object.assign(a, { text: e.text, endMs: e.endMs, state: "open" });
        await this.d.rooms.saveAnswer(a);
        await this.emit(interviewId, "answer", a, true);
      } else {
        const a = st.answers.get(e.answerId);
        if (!a) continue;
        Object.assign(a, { text: e.text, endMs: e.endMs, state: "closed", version: e.version });
        await this.d.rooms.saveAnswer(a);
        await this.emit(interviewId, "answer", a, true);
        if (words(a.text) >= (this.d.minScoreWords ?? 8)) {
          const snap = { ...a };
          this.spawn(interviewId, () => this.followUps(snap));
          this.spawn(interviewId, () => this.scoreJob(snap));
        }
      }
    }
  }

  private async followUps(a: RoomAnswer) {
    const segs = await this.d.transcripts.listSegments(a.interviewId);
    const recentTurns = segs.filter((s) => s.text.trim()).slice(-8).map((s) => ({ role: roleOf(s.role), text: s.text.slice(0, 1500) }));
    const [qs, setup] = await Promise.all([this.d.rooms.listQuestions(a.interviewId), this.d.rooms.getSetup(a.interviewId)]);
    const current = qs.find((q) => q.id === a.questionId);
    const res = await this.run("next_questions", {
      recentTurns: recentTurns.length ? recentTurns : [{ role: "candidate", text: a.text.slice(0, 1500) }],
      currentQuestion: { text: a.questionText.slice(0, 600), keyPoints: current?.keyPoints },
      asked: qs.filter((q) => q.status === "asked").map((q) => q.text.slice(0, 600)).slice(-40),
      jd: setup?.jd.slice(0, 1500),
    }, a.interviewId);
    if (!res.ok) return void (await this.aiError(a.interviewId, "next_questions", res));
    const existing = (await this.d.rooms.listQuestions(a.interviewId)).filter((q) => q.kind === "follow_up" && q.answerId === a.id && q.status === "queued");
    // The score found specific problems and already supplied pointed questions for them: those are better, keep them.
    if (existing.some((q) => q.source === "score")) return;
    // A newer close of the same answer replaces the older fast suggestions.
    const stale = existing.map((q) => q.id);
    await this.d.rooms.deleteQuestions(a.interviewId, stale);
    const items = (res.output as { followUps: { text: string; reason: string; kind: RoomQuestion["followKind"] }[] }).followUps.map((f): RoomQuestion => ({
      id: this.id(), interviewId: a.interviewId, kind: "follow_up", text: f.text, why: f.reason, keyPoints: [], probes: [], answerId: a.id, followKind: f.kind, source: "fast", status: "queued", createdAt: new Date(this.now()).toISOString(),
    }));
    for (const q of items) await this.d.rooms.saveQuestion(q);
    await this.emit(a.interviewId, "questions", { reason: "follow_up", answerId: a.id, items, removedIds: stale }, true);
  }

  private async scoreJob(a: RoomAnswer) {
    const [qs, setup] = await Promise.all([this.d.rooms.listQuestions(a.interviewId), this.d.rooms.getSetup(a.interviewId)]);
    const current = qs.find((q) => q.id === a.questionId);
    const res = await this.run("score_answer", {
      question: { text: a.questionText.slice(0, 600), keyPoints: current?.keyPoints },
      answer: a.text.slice(0, 4000),
      level: setup?.roleLevel,
      resumeSummary: setup?.resumeSummary?.slice(0, 1500),
      transcriptQuality: "clean",
    }, a.interviewId);
    if (!res.ok) return void (await this.aiError(a.interviewId, "score_answer", res, a.id));
    const score: RoomScore = { interviewId: a.interviewId, answerId: a.id, version: a.version, model: res.model, output: res.output as RoomScore["output"], at: new Date(this.now()).toISOString() };
    await this.d.rooms.saveScore(score);
    await this.emit(a.interviewId, "score", score, true);
    await this.counterQuestions(a, score);
  }

  /**
   * Turn the problems the scoring found into questions the interviewer can ask now, one per problem, each tied to the candidate's own
   * words. They replace the generic follow-ups for the same answer. Skipped if the candidate has since carried on (a newer version of
   * the answer is being scored and will produce its own).
   */
  private async counterQuestions(a: RoomAnswer, score: RoomScore) {
    const o = score.output;
    const picks = o.problems.filter((p) => p.counterQuestion.trim()).slice(0, 2);
    // Not first-hand? Add the question that makes them prove they did the work. It goes last: fix what is wrong first.
    const proof = o.experience.signal !== "first_hand" && o.experience.probe.trim() ? o.experience : undefined;
    if (picks.length === 0 && !proof) return;
    const current = (await this.d.rooms.listAnswers(a.interviewId)).find((x) => x.id === a.id);
    if (current && current.version > a.version) return;
    const stale = (await this.d.rooms.listQuestions(a.interviewId)).filter((q) => q.kind === "follow_up" && q.answerId === a.id && q.status === "queued").map((q) => q.id);
    await this.d.rooms.deleteQuestions(a.interviewId, stale);
    const items = picks.map((p): RoomQuestion => ({
      id: this.id(), interviewId: a.interviewId, kind: "follow_up", text: p.counterQuestion, why: p.issue, keyPoints: p.correction ? [p.correction] : [], probes: [],
      answerId: a.id, followKind: p.severity === "major" ? "probe" : "clarify", source: "score", aboutQuote: p.quote, status: "queued", createdAt: new Date(this.now()).toISOString(),
    }));
    if (proof) {
      items.push({
        id: this.id(), interviewId: a.interviewId, kind: "follow_up", text: proof.probe, why: `Check they did the work: ${proof.evidence}`, keyPoints: [], probes: [],
        answerId: a.id, followKind: "probe", source: "score", status: "queued", createdAt: new Date(this.now()).toISOString(),
      });
    }
    for (const q of items) await this.d.rooms.saveQuestion(q);
    await this.emit(a.interviewId, "questions", { reason: "follow_up", answerId: a.id, items, removedIds: stale }, true);
  }

  // ---- plumbing

  private async run(task: string, input: unknown, interviewId: string): Promise<AiResult> {
    if (this.aiActive >= (this.d.maxConcurrentAi ?? 4)) await new Promise<void>((r) => this.aiWaiting.push(r));
    this.aiActive++;
    try {
      return await runTask(this.d.ai, task, input, { interviewId });
    } finally {
      this.aiActive--;
      this.aiWaiting.shift()?.();
    }
  }

  private async aiError(interviewId: string, task: string, res: Extract<AiResult, { ok: false }>, answerId?: string) {
    await this.emit(interviewId, "ai_error", { task, code: res.error.code, answerId }, true).catch(() => undefined);
    return { ok: false as const, error: res.error };
  }

  private state(interviewId: string): State {
    let st = this.states.get(interviewId);
    if (!st) {
      st = {
        detector: new TurnDetector({ silenceMs: this.d.silenceMs ?? 2500, reopenMs: this.d.reopenMs ?? 20_000, newId: () => this.id() }),
        chain: Promise.resolve(),
        answers: new Map(),
        seen: new Set(),
      };
      this.states.set(interviewId, st);
    }
    return st;
  }

  /** Work for one interview runs strictly in order, so effects never interleave. */
  private enqueue(interviewId: string, fn: (st: State) => Promise<void>) {
    const st = this.state(interviewId);
    st.chain = st.chain.then(() => fn(st)).catch((e) => this.warn(`room work failed for ${interviewId}`, e));
  }

  private spawn(interviewId: string, fn: () => Promise<unknown>) {
    const set = this.inflight.get(interviewId) ?? new Set<Promise<unknown>>();
    this.inflight.set(interviewId, set);
    const p: Promise<unknown> = fn()
      .catch((e) => this.warn(`room job failed for ${interviewId}`, e))
      .finally(() => {
        set.delete(p);
        if (set.size === 0) this.inflight.delete(interviewId);
      });
    set.add(p);
  }

  private async emit(interviewId: string, type: RoomEventType, data: unknown, persist: boolean) {
    const ev: RoomEvent = persist ? await this.d.rooms.appendEvent(interviewId, type, data) : { at: new Date(this.now()).toISOString(), type, data };
    this.bus.publish(interviewId, ev);
  }
}

function fail(code: string, message: string) {
  return { ok: false as const, error: { code, message } };
}
