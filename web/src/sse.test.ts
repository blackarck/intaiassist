import { describe, expect, it } from "vitest";
import { applyEvent, coachView, emptyRoom, fromSnapshot } from "./room";
import { createSseParser } from "./sse";
import type { RoomEvent, Snapshot } from "./types";

describe("createSseParser", () => {
  it("parses ids, types and JSON data, across chunk boundaries, ignoring comments and retry", () => {
    const p = createSseParser();
    expect(p("retry: 3000\n\n: keep-alive\n\nid: 7\nevent: ans")).toEqual([]);
    const out = p('wer\ndata: {"at":"t","data":{"id":"a1"}}\n\nevent: segment\ndata: {"at":"t2","data":{"text":"hi"}}\n\n');
    expect(out).toEqual([
      { seq: 7, at: "t", type: "answer", data: { id: "a1" } },
      { seq: undefined, at: "t2", type: "segment", data: { text: "hi" } },
    ]);
  });
  it("handles CRLF and skips a malformed frame without failing", () => {
    const p = createSseParser();
    expect(p('id: 1\r\nevent: x\r\ndata: {bad\r\n\r\nid: 2\r\nevent: y\r\ndata: {"at":"t","data":1}\r\n\r\n')).toEqual([{ seq: 2, at: "t", type: "y", data: 1 }]);
  });
});

const ev = (type: string, data: unknown, seq?: number): RoomEvent => ({ type, data, seq, at: "2026-11-19T10:00:00Z" });
const snap: Snapshot = {
  lastSeq: 4,
  questions: [{ id: "q1", kind: "preset", text: "Explain mutexes", keyPoints: [], probes: [], status: "queued" }],
  answers: [{ id: "a1", questionText: "q", text: "t", startMs: 100, endMs: 200, state: "closed", version: 1, score: { answerId: "a1", version: 1, model: "m", at: "t", output: { verdict: "ok", experience: { signal: "first_hand", evidence: "", probe: "" }, problems: [], score: 3, dimensions: { technicalCorrectness: 3, depth: 3, clarity: 3, relevance: 3 }, strengths: [], gaps: [], evidenceQuotes: [], confidence: "high", note: "" } } }],
  scorecard: null,
  transcript: [{ speakerId: "1", role: "interviewer", text: "Hi", startMs: 0 }],
};

describe("room reducer", () => {
  it("starts from a snapshot and tracks the last seq", () => {
    const s = fromSnapshot(snap);
    expect(s).toMatchObject({ loaded: true, lastSeq: 4 });
    expect(s.scores.a1?.output.score).toBe(3);
    expect(s.answers[0]).not.toHaveProperty("score");
  });
  it("adds final segments once, orders them, and keeps partials separate", () => {
    let s = emptyRoom;
    const seg = (text: string, startMs: number, final = true) => ev("segment", { speakerId: "2", role: "candidate", text, startMs, final }, final ? startMs + 1 : undefined);
    s = applyEvent(s, seg("A mut", 5000, false));
    expect(s.partial?.text).toBe("A mut");
    s = applyEvent(s, seg("A mutex", 5000));
    s = applyEvent(s, seg("A mutex", 5000)); // duplicate delivery
    s = applyEvent(s, seg("earlier", 1000));
    expect(s.transcript.map((x) => x.text)).toEqual(["earlier", "A mutex"]);
    expect(s.partial).toBeUndefined();
    expect(s.lastSeq).toBe(5001);
  });
  it("upserts questions, removes replaced ones, and marks asked", () => {
    let s = fromSnapshot(snap);
    s = applyEvent(s, ev("questions", { reason: "follow_up", items: [{ id: "f1", kind: "follow_up", text: "Why?", keyPoints: [], probes: [], status: "queued" }], removedIds: [] }, 5));
    s = applyEvent(s, ev("questions", { reason: "asked", items: [{ ...snap.questions[0]!, status: "asked" }], removedIds: ["f1"] }, 6));
    expect(s.questions.map((q) => [q.id, q.status])).toEqual([["q1", "asked"]]);
  });
  it("keeps the highest score version and ignores an older one that arrives late", () => {
    let s = fromSnapshot(snap);
    const sc = (version: number, score: number) => ev("score", { answerId: "a1", version, model: "m", at: "t", output: { ...snap.answers[0]!.score!.output, score } }, 10 + version);
    s = applyEvent(s, sc(2, 5));
    s = applyEvent(s, sc(1, 1));
    expect(s.scores.a1?.output.score).toBe(5);
  });
  it("turns an AI failure into a plain notice, and records assist, scorecard and status", () => {
    let s = fromSnapshot(snap);
    s = applyEvent(s, ev("ai_error", { task: "score_answer", code: "outage" }, 11));
    expect(s.notices[0]?.text).toMatch(/Scoring an answer failed/);
    s = applyEvent(s, ev("assist", { suggestion: "Ask more", kind: "question", evidence: [] }, 12));
    expect(s.assists[0]).toMatchObject({ suggestion: "Ask more", at: "2026-11-19T10:00:00Z" });
    s = applyEvent(s, ev("status", { status: "ended" }, 13));
    expect(s.status).toBe("ended");
    expect(applyEvent(s, ev("something_new", {}, 14)).lastSeq).toBe(14); // unknown events are tolerated
  });
});

describe("coachView (what the live coach shows)", () => {
  const answer = (over = {}) => ({ id: "a1", questionText: "Explain mutexes", text: "A mutex is a lock around shared state that only one thread holds at a time", startMs: 1, endMs: 2, state: "closed" as const, version: 1, ...over });
  const score = (at = "2026-11-19T10:00:00Z") => snap.answers[0]!.score && { ...snap.answers[0]!.score!, answerId: "a1", at };
  const base = { ...emptyRoom, loaded: true };

  it("walks through listening, assessing and ready by itself as events arrive", () => {
    expect(coachView(base)).toEqual({ phase: "idle" });
    let s = { ...base, answers: [answer({ state: "open" as const })] };
    expect(coachView(s)).toMatchObject({ phase: "listening" });
    s = { ...s, answers: [answer()] };
    expect(coachView(s)).toMatchObject({ phase: "assessing" });
    expect(coachView({ ...s, answers: [answer({ text: "Yes I do" })] })).toMatchObject({ phase: "short" });
    s = { ...s, scores: { a1: score()! } };
    expect(coachView(s)).toMatchObject({ phase: "ready" });
  });

  it("offers only the queued follow-ups for the LATEST answer, in order, and an automatic suggestion made after the score", () => {
    const q = (id: string, answerId: string, status: "queued" | "asked" = "queued") => ({ id, kind: "follow_up" as const, text: id, keyPoints: [], probes: [], answerId, status });
    const s = { ...base, answers: [answer()], scores: { a1: score("2026-11-19T10:00:00Z")! }, questions: [q("old", "a0"), q("first", "a1"), q("second", "a1"), q("gone", "a1", "asked")], assists: [{ suggestion: "Ask about deadlocks", kind: "question" as const, evidence: [], at: "2026-11-19T10:00:15Z", auto: true }] };
    const v = coachView(s);
    expect(v.phase === "ready" && v.ask.map((x) => x.id)).toEqual(["first", "second"]);
    expect(v.phase === "ready" && v.suggestion?.suggestion).toBe("Ask about deadlocks");
    const older = coachView({ ...s, assists: [{ ...s.assists[0]!, at: "2026-11-19T09:59:00Z" }] });
    expect(older.phase === "ready" && older.suggestion).toBeUndefined(); // a suggestion from before this answer is stale
  });
});
