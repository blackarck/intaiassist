import { describe, expect, it } from "vitest";
import { InMemoryRoomStore, type RoomAnswer, type RoomQuestion, type RoomScore, type RoomStore } from "../src/room/types.js";
import { SqliteStore } from "../src/sqliteStore.js";

const q = (id: string, over: Partial<RoomQuestion> = {}): RoomQuestion => ({ id, interviewId: "i-1", kind: "preset", text: `Q ${id}`, keyPoints: [], probes: [], status: "queued", createdAt: "2026-11-19T10:00:00Z", ...over });
const a = (id: string, startMs: number, over: Partial<RoomAnswer> = {}): RoomAnswer => ({ id, interviewId: "i-1", questionText: "q", text: "t", startMs, endMs: startMs + 1, state: "open", version: 0, ...over });
const score = (answerId: string, version: number, n: number): RoomScore => ({
  interviewId: "i-1", answerId, version, model: "m", at: "2026-11-19T10:00:00Z",
  output: { score: n, dimensions: { technicalCorrectness: n, depth: n, clarity: n, relevance: n }, strengths: [], gaps: [], evidenceQuotes: [], confidence: "medium", note: "" },
});


describe.each([
  ["in-memory", async () => new InMemoryRoomStore() as RoomStore],
  ["sqlite", async () => {
    const db = new SqliteStore(":memory:");
    for (const id of ["i-1", "i-2"]) await db.save({ id, alias: id.toUpperCase().replace("-", "") + "AAAAAAAA", ownerEmail: "o@x.com", status: "paid" });
    return db as RoomStore;
  }],
])("RoomStore contract (%s)", (_n, make) => {
  it("round-trips setup, upserts questions in place, deletes by id", async () => {
    const s = await make();
    expect(await s.getSetup("i-1")).toBeUndefined();
    await s.saveSetup({ interviewId: "i-1", roleTitle: "Backend", jd: "jd", presetQuestions: [{ text: "x", keyPoints: ["k"] }] });
    expect((await s.getSetup("i-1"))?.presetQuestions[0]?.keyPoints).toEqual(["k"]);

    await s.saveQuestion(q("p1"));
    await s.saveQuestion(q("p2"));
    await s.saveQuestion(q("p1", { status: "asked", text: "changed" })); // upsert keeps position
    expect((await s.listQuestions("i-1")).map((x) => [x.id, x.status])).toEqual([["p1", "asked"], ["p2", "queued"]]);
    await s.deleteQuestions("i-1", ["p2", "nope"]);
    expect((await s.listQuestions("i-1")).map((x) => x.id)).toEqual(["p1"]);
  });

  it("lists answers by start time and keeps every score version", async () => {
    const s = await make();
    await s.saveAnswer(a("a2", 9000));
    await s.saveAnswer(a("a1", 1000));
    await s.saveAnswer(a("a1", 1000, { state: "closed", version: 1 }));
    expect((await s.listAnswers("i-1")).map((x) => [x.id, x.state])).toEqual([["a1", "closed"], ["a2", "open"]]);
    await s.saveScore(score("a1", 1, 3));
    await s.saveScore(score("a1", 2, 4));
    await s.saveScore(score("a1", 2, 5)); // same version replaced
    expect((await s.listScores("i-1")).map((x) => [x.version, x.output.score])).toEqual([[1, 3], [2, 5]]);
  });

  it("numbers events per replay and finds the last of a type; interviews are isolated; deleteRoom clears", async () => {
    const s = await make();
    const e1 = await s.appendEvent("i-1", "segment", { n: 1 });
    await s.appendEvent("i-2", "segment", { n: 99 });
    const e2 = await s.appendEvent("i-1", "scorecard", { s: 1 });
    const e3 = await s.appendEvent("i-1", "scorecard", { s: 2 });
    expect(e2.seq).toBeGreaterThan(e1.seq);
    expect((await s.eventsAfter("i-1", e1.seq, 10)).map((e) => e.data)).toEqual([{ s: 1 }, { s: 2 }]);
    expect((await s.eventsAfter("i-1", 0, 1)).length).toBe(1);
    expect((await s.lastEvent("i-1", "scorecard"))?.seq).toBe(e3.seq);
    expect(await s.lastEvent("i-1", "assist")).toBeUndefined();
    await s.saveAnswer(a("a1", 1));
    await s.deleteRoom("i-1");
    expect(await s.listAnswers("i-1")).toEqual([]);
    expect(await s.eventsAfter("i-1", 0, 10)).toEqual([]);
    expect((await s.eventsAfter("i-2", 0, 10)).length).toBe(1);
  });
});
