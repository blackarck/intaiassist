import { beforeEach, describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../src/meetingSource.js";
import { TurnDetector, isBackchannel, type TurnEffect } from "../src/room/turns.js";

let n = 0;
const seg = (role: TranscriptSegment["role"], text: string, startMs: number, speakerId = role === "interviewer" ? "1" : "2"): TranscriptSegment => ({
  interviewId: "i-1", speakerId, role, text, isFinal: true, startMs, endMs: startMs + 2000,
});

describe("TurnDetector", () => {
  let d: TurnDetector;
  beforeEach(() => {
    n = 0;
    d = new TurnDetector({ silenceMs: 2500, reopenMs: 20_000, newId: () => `a${++n}` });
  });
  const kinds = (e: TurnEffect[]) => e.map((x) => x.kind);

  it("pairs a question with the candidate's answer and closes it when the interviewer speaks again", () => {
    expect(d.onSegment(seg("interviewer", "Tell me about a production incident", 0), 1000)).toEqual([]);
    const open = d.onSegment(seg("candidate", "Our payments service timed out", 5000), 6000);
    expect(open).toEqual([{ kind: "answer_open", answerId: "a1", questionText: "Tell me about a production incident", text: "Our payments service timed out", startMs: 5000, endMs: 7000 }]);
    expect(kinds(d.onSegment(seg("candidate", "the pool was exhausted", 8000), 9000))).toEqual(["answer_update"]);
    const close = d.onSegment(seg("interviewer", "And how did you fix it", 12000), 13000);
    expect(close).toEqual([expect.objectContaining({ kind: "answer_close", answerId: "a1", text: "Our payments service timed out the pool was exhausted", version: 1, reason: "interviewer" })]);
  });

  it("joins consecutive interviewer segments into one question", () => {
    d.onSegment(seg("interviewer", "Tell me about Kafka", 0), 1);
    d.onSegment(seg("interviewer", "and when you would not use it", 3000), 2);
    const [open] = d.onSegment(seg("candidate", "Kafka is a log", 6000), 3);
    expect(open).toMatchObject({ questionText: "Tell me about Kafka and when you would not use it" });
  });

  it("ignores backchannel remarks: they neither close an answer nor start a question", () => {
    d.onSegment(seg("interviewer", "Explain mutexes", 0), 0);
    d.onSegment(seg("candidate", "A mutex is a lock", 3000), 3000);
    expect(d.onSegment(seg("interviewer", "all right", 5000), 5000)).toEqual([]);
    expect(d.onSegment(seg("interviewer", "mm-hmm", 5500), 5500)).toEqual([]);
    expect(d.hasOpenAnswer).toBe(true);
    expect(isBackchannel("Right")).toBe(true);
    expect(isBackchannel("Right, so what about deadlocks?")).toBe(false);
    expect(isBackchannel("Yeah")).toBe(true);
  });

  it("closes after silence, and reopens (same answer, next version) if the candidate carries on", () => {
    d.onSegment(seg("interviewer", "Explain mutexes", 0), 0);
    d.onSegment(seg("candidate", "A mutex is a lock", 3000), 3000);
    expect(d.tick(5000)).toEqual([]); // 2 s of quiet: not yet
    const [close1] = d.tick(5600);
    expect(close1).toMatchObject({ kind: "answer_close", answerId: "a1", version: 1, reason: "silence" });
    const upd = d.onSegment(seg("candidate", "it protects shared state", 9000), 10_000); // within 20 s, interviewer silent
    expect(upd).toEqual([expect.objectContaining({ kind: "answer_update", answerId: "a1", text: "A mutex is a lock it protects shared state" })]);
    const [close2] = d.tick(13_000);
    expect(close2).toMatchObject({ answerId: "a1", version: 2, text: "A mutex is a lock it protects shared state" });
  });

  it("does not reopen after the interviewer has spoken, or after too long", () => {
    d.onSegment(seg("interviewer", "Q1 about locks", 0), 0);
    d.onSegment(seg("candidate", "answer one here", 3000), 3000);
    d.tick(6000);
    d.onSegment(seg("interviewer", "Q2 about threads", 8000), 8000);
    expect(d.onSegment(seg("candidate", "answer two here", 11_000), 11_000)).toEqual([expect.objectContaining({ kind: "answer_open", answerId: "a2", questionText: "Q2 about threads" })]);

    d.tick(15_000); // closes a2
    expect(d.onSegment(seg("candidate", "much later remark", 60_000), 60_000)).toEqual([]); // >20 s: no question pending, ignored
  });

  it("ignores a candidate who speaks before any question, and unknown speakers", () => {
    expect(d.onSegment(seg("candidate", "Hi, nice to meet you", 0), 0)).toEqual([]);
    d.onSegment(seg("interviewer", "Tell me about yourself", 3000), 3000);
    expect(d.onSegment(seg("unknown", "background chatter", 4000, "9"), 4000)).toEqual([]);
    expect(kinds(d.onSegment(seg("candidate", "I am an engineer", 5000), 5000))).toEqual(["answer_open"]);
  });

  it("ignores partials and duplicate deliveries", () => {
    d.onSegment(seg("interviewer", "Explain mutexes", 0), 0);
    expect(d.onSegment({ ...seg("candidate", "A mut", 3000), isFinal: false }, 3000)).toEqual([]);
    expect(kinds(d.onSegment(seg("candidate", "A mutex is a lock", 3000), 3100))).toEqual(["answer_open"]);
    expect(d.onSegment(seg("candidate", "A mutex is a lock", 3000), 3200)).toEqual([]); // webhook retry
  });

  it("does not treat a short interviewer fragment during an answer as a new question", () => {
    d.onSegment(seg("interviewer", "Why did the payment file fail", 0), 0);
    d.onSegment(seg("candidate", "the bank account on the vendor was wrong", 3000), 3000);
    expect(d.onSegment(seg("interviewer", "is wrong answer", 5000), 5000)).toEqual([]); // 3 words, answer open: a murmur
    expect(d.onSegment(seg("interviewer", "for that", 5500), 5500)).toEqual([]);
    expect(d.hasOpenAnswer).toBe(true);
    // a real follow-up question (4+ words) still closes it and becomes the next question
    const close = d.onSegment(seg("interviewer", "what specific places would you check first", 9000), 9000);
    expect(close).toEqual([expect.objectContaining({ kind: "answer_close", reason: "interviewer", text: "the bank account on the vendor was wrong" })]);
    const [open] = d.onSegment(seg("candidate", "I would open the vendor master and compare the account", 12_000), 12_000);
    expect(open).toMatchObject({ kind: "answer_open", questionText: "what specific places would you check first" });
  });

  it("current() exposes the answer being given", () => {
    expect(d.current()).toBeUndefined();
    d.onSegment(seg("interviewer", "Explain mutexes", 0), 0);
    d.onSegment(seg("candidate", "A mutex is a lock", 3000), 4000);
    expect(d.current()).toMatchObject({ id: "a1", open: true, text: "A mutex is a lock", lastHeardAt: 4000, questionText: "Explain mutexes" });
    d.tick(7000);
    expect(d.current()).toMatchObject({ open: false, version: 1 });
  });

  it("flush closes the open answer at the end of the meeting", () => {
    d.onSegment(seg("interviewer", "Last question", 0), 0);
    d.onSegment(seg("candidate", "My final answer", 3000), 3000);
    expect(d.flush(9000)).toEqual([expect.objectContaining({ kind: "answer_close", reason: "end", version: 1 })]);
    expect(d.flush(9500)).toEqual([]);
  });
});
