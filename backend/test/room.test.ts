import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryAiStore } from "../src/ai/configStore.js";
import type { ModelFactory } from "../src/ai/models.js";
import { buildApp } from "../src/app.js";
import type { TranscriptSegment } from "../src/meetingSource.js";
import { openLive } from "../src/room/live.js";
import { RoomService } from "../src/room/service.js";
import { InMemoryRoomStore, type RoomEvent } from "../src/room/types.js";
import { InMemoryStore } from "../src/store.js";
import { fakeController } from "./helpers.js";

const ANSWER = "Our payments service started timing out because the connection pool was exhausted by a report query";

const scoreOut = {
  score: 4,
  dimensions: { technicalCorrectness: 4, depth: 4, clarity: 4, relevance: 4 },
  strengths: ["found root cause"],
  gaps: ["no prevention"],
  evidenceQuotes: ["the connection pool was exhausted"],
  confidence: "high",
  note: "",
};
const followOut = { followUps: [{ text: "What did you change so it cannot happen again?", reason: "prevention not covered", kind: "probe" }] };
const cardOut = { summary: "Solid on incidents.", strengths: ["root cause analysis"], risks: ["prevention"], followUpsNextRound: ["Design a load test"] };
const assistOut = { suggestion: "Ask how the report query was found.", kind: "question", evidence: ["connection pool"] };
const openingOut = { questions: [{ text: "How do you size a connection pool?", why: "core skill", keyPoints: ["limits"], probes: ["what if the DB is the bottleneck?"] }] };

/** A model that recognises which task it was asked by its system prompt and answers with a scripted result. */
function taskModels(over: Partial<Record<string, unknown | Error>> = {}): ModelFactory {
  const table: Record<string, unknown> = { score: scoreOut, follow: followOut, card: cardOut, assist: assistOut, opening: openingOut, ...over };
  return () =>
    new MockLanguageModelV4({
      doGenerate: async (opts) => {
        const sys = JSON.stringify(opts.prompt.find((m) => m.role === "system") ?? "");
        const which = sys.includes("assess one interview answer") ? "score" : sys.includes("follow-up questions") ? "follow" : sys.includes("Summarise an interview") ? "card" : sys.includes("assist me") ? "assist" : "opening";
        const v = table[which];
        if (v instanceof Error) throw Object.assign(v, { statusCode: 503 });
        return { content: [{ type: "text", text: JSON.stringify(v) }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } }, warnings: [] } as never;
      },
    });
}

let clock = 1_000_000;
let ids = 0;
const seg = (role: "interviewer" | "candidate", text: string, startMs: number): TranscriptSegment => ({ interviewId: "i-1", speakerId: role === "interviewer" ? "1" : "2", speakerName: role === "interviewer" ? "Vivek" : "Asha", role, text, isFinal: true, startMs, endMs: startMs + 3000 });

async function setup(models: ModelFactory = taskModels()) {
  clock = 1_000_000;
  ids = 0;
  const interviews = new InMemoryStore();
  await interviews.save({ id: "i-1", alias: "K7M2QX9WPB", ownerEmail: "r@acme.com", status: "in_meeting" });
  const rooms = new InMemoryRoomStore();
  const aiStore = new InMemoryAiStore();
  const room = new RoomService({ rooms, transcripts: interviews, interviews, ai: { config: aiStore, log: aiStore, models }, now: () => clock, newId: () => `id${++ids}`, silenceMs: 2500 });
  const events: RoomEvent[] = [];
  room.bus.subscribe("i-1", (e) => events.push(e));
  const say = async (s: TranscriptSegment, advance = 100) => {
    await interviews.appendSegment(s);
    room.onSegment(s);
    await room.idle("i-1"); // the real server does not wait; tests need the effects applied before they look
    clock += advance;
  };
  return { room, rooms, interviews, aiStore, events, say };
}

describe("RoomService: a full interview", () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    t = await setup();
    await t.room.configure({ interviewId: "i-1", roleTitle: "Backend Engineer", roleLevel: "senior", jd: "Node and Postgres", presetQuestions: [{ text: "Tell me about a production incident you handled", keyPoints: ["root cause", "prevention"] }] });
  });
  const types = () => t.events.map((e) => e.type);

  it("shows preset questions, then turns speech into an answer with follow-ups and a score", async () => {
    expect(t.events[0]).toMatchObject({ type: "questions", data: { reason: "setup" } });

    await t.say(seg("interviewer", "Tell me about a production incident you handled", 0));
    await t.say(seg("candidate", ANSWER, 5000));
    clock += 3000;
    t.room.tickAll();
    await t.room.idle("i-1");

    const snap = await t.room.snapshot("i-1");
    expect(snap.questions.find((q) => q.kind === "preset")?.status).toBe("asked"); // matched the preset, not duplicated as a "live" question
    expect(snap.questions.filter((q) => q.kind === "live")).toHaveLength(0);
    expect(snap.answers).toHaveLength(1);
    expect(snap.answers[0]).toMatchObject({ state: "closed", version: 1, score: { version: 1, output: { score: 4, confidence: "high" }, model: expect.any(String) } });
    expect(snap.questions.filter((q) => q.kind === "follow_up").map((q) => q.text)).toEqual(["What did you change so it cannot happen again?"]);
    expect(snap.transcript.map((x) => x.role)).toEqual(["interviewer", "candidate"]);
    expect(types()).toEqual(expect.arrayContaining(["segment", "answer", "questions", "score"]));
    // events are numbered in increasing order
    const seqs = t.events.map((e) => e.seq!).filter(Boolean);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("keeps a question that was not on the list as a 'live' one", async () => {
    await t.say(seg("interviewer", "What is your favourite database and why", 0));
    await t.say(seg("candidate", ANSWER, 5000));
    const q = (await t.rooms.listQuestions("i-1")).filter((x) => x.kind === "live");
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ status: "asked", text: "What is your favourite database and why" });
  });

  it("does not score a one-line answer, but still shows it", async () => {
    await t.say(seg("interviewer", "Do you know Postgres", 0));
    await t.say(seg("candidate", "Yes I do", 4000));
    clock += 3000;
    t.room.tickAll();
    await t.room.idle("i-1");
    expect(types()).not.toContain("score");
    expect((await t.rooms.listAnswers("i-1"))[0]).toMatchObject({ state: "closed" });
  });

  it("re-scores as a new version when the candidate carries on after a pause", async () => {
    await t.say(seg("interviewer", "Tell me about a production incident you handled", 0));
    await t.say(seg("candidate", ANSWER, 5000));
    clock += 3000;
    t.room.tickAll();
    await t.room.idle("i-1");
    await t.say(seg("candidate", "and afterwards we added statement timeouts and a replica for reports", 12_000));
    clock += 3000;
    t.room.tickAll();
    await t.room.idle("i-1");
    const scores = (await t.rooms.listScores("i-1")).map((s) => s.version);
    expect(scores).toEqual([1, 2]);
    expect((await t.room.snapshot("i-1")).answers[0]!.score?.version).toBe(2);
    // the older follow-up suggestion for this answer was replaced, not duplicated
    expect((await t.rooms.listQuestions("i-1")).filter((q) => q.kind === "follow_up")).toHaveLength(1);
  });

  it("closes the last answer when the meeting ends, waits for scoring, then emits the scorecard", async () => {
    await t.say(seg("interviewer", "Tell me about a production incident you handled", 0));
    await t.say(seg("candidate", ANSWER, 5000));
    t.room.onMeetingEvent({ type: "ended", interviewId: "i-1", reason: "meeting_ended" });
    await t.room.settle();
    const card = t.events.find((e) => e.type === "scorecard");
    expect(card?.data).toMatchObject({ summary: "Solid on incidents.", answered: 1, scored: 1, averageScore: 4, dimensionAverages: { depth: 4 } });
    expect(types()).toContain("status");
    expect((await t.room.snapshot("i-1")).scorecard).toMatchObject({ averageScore: 4 });
  });

  it("assist returns a grounded suggestion from this interview, and refuses when nothing was said", async () => {
    expect(await t.room.assist("i-1")).toMatchObject({ ok: false, error: { code: "no_transcript" } });
    await t.say(seg("interviewer", "How did you monitor it afterwards", 0));
    await t.say(seg("candidate", "We had dashboards mostly and some connection pool alerts", 4000));
    const res = await t.room.assist("i-1");
    expect(res).toMatchObject({ ok: true, assist: { kind: "question" } });
    expect(t.events.some((e) => e.type === "assist")).toBe(true);
  });

  it("generates opening questions without repeating presets, and needs a setup first", async () => {
    const res = await t.room.openingQuestions("i-1", 3);
    expect(res.ok && res.items.map((q) => q.kind)).toEqual(["generated"]);
    const fresh = await setup();
    expect(await fresh.room.openingQuestions("i-1")).toMatchObject({ ok: false, error: { code: "no_setup" } });
  });

  it("re-saving the setup keeps what was already asked and removes preset questions that were dropped", async () => {
    await t.say(seg("interviewer", "Tell me about a production incident you handled", 0));
    await t.say(seg("candidate", ANSWER, 5000));
    await t.room.configure({ interviewId: "i-1", roleTitle: "Backend Engineer", jd: "x", presetQuestions: [{ text: "Tell me about a production incident you handled" }, { text: "Explain mutexes" }] });
    let presets = (await t.rooms.listQuestions("i-1")).filter((q) => q.kind === "preset");
    expect(presets.map((q) => q.status)).toEqual(["asked", "queued"]);
    await t.room.configure({ interviewId: "i-1", roleTitle: "Backend Engineer", jd: "x", presetQuestions: [{ text: "Tell me about a production incident you handled" }] });
    presets = (await t.rooms.listQuestions("i-1")).filter((q) => q.kind === "preset");
    expect(presets).toHaveLength(1);
  });
});

describe("RoomService: failures stay out of the meeting", () => {
  it("an AI outage becomes an ai_error event; transcript, answers and later scoring carry on", async () => {
    const t = await setup(taskModels({ score: new Error("down") }));
    await t.say(seg("interviewer", "Tell me about a production incident you handled", 0));
    await t.say(seg("candidate", ANSWER, 5000));
    clock += 3000;
    t.room.tickAll();
    await t.room.idle("i-1");
    expect(t.events.find((e) => e.type === "ai_error")?.data).toMatchObject({ task: "score_answer", code: "outage" });
    expect(t.events.some((e) => e.type === "questions" && (e.data as { reason: string }).reason === "follow_up")).toBe(true); // follow-ups still worked
    expect((await t.room.snapshot("i-1")).answers[0]!.score).toBeNull();
  });
});

describe("live feed", () => {
  it("replays what a reconnecting client missed, then streams live, with no gaps or repeats", async () => {
    const t = await setup();
    await t.room.configure({ interviewId: "i-1", roleTitle: "B", jd: "x", presetQuestions: [{ text: "Explain mutexes" }] });
    await t.say(seg("interviewer", "Explain mutexes please", 0));
    await t.room.idle("i-1");
    const all = await t.rooms.eventsAfter("i-1", 0, 100);
    const seen: RoomEvent[] = [];
    const stop = await openLive(t.room, "i-1", all[1]!.seq, (e) => seen.push(e));
    expect(seen.map((e) => e.seq)).toEqual(all.slice(2).map((e) => e.seq)); // only what came after the id it already had
    await t.say(seg("candidate", "A mutex is a lock around shared state that only one thread holds", 4000));
    await t.room.idle("i-1");
    const seqs = seen.map((e) => e.seq).filter(Boolean) as number[];
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seen.some((e) => e.type === "answer")).toBe(true);
    stop();
    const before = seen.length;
    await t.say(seg("candidate", "more words after the stream was closed by the client", 9000));
    await t.room.idle("i-1");
    expect(seen.length).toBe(before);
  });

  it("partial transcript is delivered live but never stored or replayed", async () => {
    const t = await setup();
    const seen: RoomEvent[] = [];
    await openLive(t.room, "i-1", 0, (e) => seen.push(e));
    t.room.onSegment({ ...seg("candidate", "A mut", 100), isFinal: false });
    await t.room.idle("i-1");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.seq).toBeUndefined();
    expect(await t.rooms.eventsAfter("i-1", 0, 10)).toEqual([]);
  });
});

describe("room routes", () => {
  const H = { authorization: "Bearer api-token" };
  it("validates and saves setup, serves the snapshot, streams over a real connection, and refuses without a token", async () => {
    const t = await setup();
    const app = buildApp({ store: t.interviews, transcripts: t.interviews, controller: fakeController(), aliasDomain: "x.test", intakeToken: "api-token", enableDevRoutes: false, room: t.room });
    const call = (method: "GET" | "PUT" | "POST", url: string, payload?: unknown, headers: Record<string, string> = H) => app.inject({ method, url, headers, payload: payload as never });

    expect((await call("GET", "/api/interviews/i-1/room", undefined, {})).statusCode).toBe(401);
    expect((await call("GET", "/api/interviews/nope/room")).statusCode).toBe(404);
    expect((await call("PUT", "/api/interviews/i-1/setup", { roleTitle: "" })).statusCode).toBe(400);
    const ok = await call("PUT", "/api/interviews/i-1/setup", { roleTitle: "Backend", jd: "Node", presetQuestions: [{ text: "Explain mutexes" }] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().questions).toHaveLength(1);
    const snap = (await call("GET", "/api/interviews/i-1/room")).json();
    expect(snap.setup).toMatchObject({ roleTitle: "Backend", presetCount: 1 });
    expect(snap.lastSeq).toBeGreaterThan(0);
    expect((await call("POST", "/api/interviews/i-1/room/assist")).statusCode).toBe(409);
    expect((await call("POST", "/api/interviews/i-1/room/scorecard")).statusCode).toBe(409);

    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const port = (app.server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/interviews/i-1/live`, { headers: H });
      expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
      const reader = res.body!.getReader();
      let text = "";
      while (!text.includes("event: questions")) text += new TextDecoder().decode((await reader.read()).value);
      expect(text).toMatch(/id: \d+\nevent: questions\ndata: \{"at":"[^"]+","data":\{"reason":"setup"/);
      await reader.cancel();
      expect((await fetch(`http://127.0.0.1:${port}/api/interviews/i-1/live`)).status).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("answers 501 when the room is not configured", async () => {
    const t = await setup();
    const app = buildApp({ store: t.interviews, controller: fakeController(), aliasDomain: "x.test", intakeToken: "api-token", enableDevRoutes: false });
    expect((await app.inject({ method: "GET", url: "/api/interviews/i-1/room", headers: H })).statusCode).toBe(501);
  });
});
