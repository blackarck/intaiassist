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
  verdict: "Found the root cause and a sound fix; prevention was thin.",
  experience: { signal: "first_hand", evidence: "named the report query and the replica", probe: "" },
  problems: [],
  score: 4,
  dimensions: { technicalCorrectness: 4, depth: 4, clarity: 4, relevance: 4 },
  strengths: ["found root cause"],
  gaps: ["no prevention"],
  evidenceQuotes: ["the connection pool was exhausted"],
  confidence: "high",
  note: "",
};
const problemScore = {
  ...scoreOut,
  score: 2,
  dimensions: { technicalCorrectness: 2, depth: 2, clarity: 3, relevance: 3 },
  problems: [{ quote: "connection pool was exhausted", issue: "Does not say why the pool ran dry.", correction: "A long-held connection or leak; check active sessions.", severity: "major", counterQuestion: "How did you find out what was holding the connections?" }],
};
const coachOut = {
  stance: "partly_right",
  remark: "Found the cause but did not say why the pool ran dry.",
  questions: [
    { text: "How did you find out what was holding the connections?", remark: "tests whether they diagnosed it themselves" },
    { text: "What did you change so it cannot happen again?", remark: "prevention not covered" },
  ],
  proof: null,
};
/** Every prompt the coach was sent, in order (so tests can check what it was told). */
const coachPrompts: string[] = [];
const cardOut = { summary: "Solid on incidents.", strengths: ["root cause analysis"], risks: ["prevention"], followUpsNextRound: ["Design a load test"] };
const assistOut = { suggestion: "Ask how the report query was found.", kind: "question", evidence: ["connection pool"] };
const openingOut = { questions: [{ text: "How do you size a connection pool?", why: "core skill", keyPoints: ["limits"], probes: ["what if the DB is the bottleneck?"] }] };

/** A model that recognises which task it was asked by its system prompt and answers with a scripted result. */
function taskModels(over: Partial<Record<string, unknown | Error>> = {}): ModelFactory {
  const table: Record<string, unknown> = { score: scoreOut, coach: coachOut, card: cardOut, assist: assistOut, opening: openingOut, ...over };
  return () =>
    new MockLanguageModelV4({
      doGenerate: async (opts) => {
        const sys = JSON.stringify(opts.prompt.find((m) => m.role === "system") ?? "");
        if (sys.includes("AS THEY ANSWER")) coachPrompts.push(JSON.stringify(opts.prompt.filter((m) => m.role === "user")));
        const which = sys.includes("assess one interview answer") ? "score" : sys.includes("AS THEY ANSWER") ? "coach" : sys.includes("Summarise an interview") ? "card" : sys.includes("assist me") ? "assist" : "opening";
        const v = table[which];
        if (v instanceof Error) throw Object.assign(v, { statusCode: 503 });
        return { content: [{ type: "text", text: JSON.stringify(v) }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } }, warnings: [] } as never;
      },
    });
}

let clock = 1_000_000;
let ids = 0;
const seg = (role: "interviewer" | "candidate", text: string, startMs: number): TranscriptSegment => ({ interviewId: "i-1", speakerId: role === "interviewer" ? "1" : "2", speakerName: role === "interviewer" ? "Vivek" : "Asha", role, text, isFinal: true, startMs, endMs: startMs + 3000 });

async function setup(models: ModelFactory = taskModels(), extra: { silenceMs?: number } = {}) {
  coachPrompts.length = 0;
  clock = 1_000_000;
  ids = 0;
  const interviews = new InMemoryStore();
  await interviews.save({ id: "i-1", alias: "K7M2QX9WPB", ownerEmail: "r@acme.com", status: "in_meeting" });
  const rooms = new InMemoryRoomStore();
  const aiStore = new InMemoryAiStore();
  const room = new RoomService({ rooms, transcripts: interviews, interviews, ai: { config: aiStore, log: aiStore, models }, now: () => clock, newId: () => `id${++ids}`, silenceMs: extra.silenceMs ?? 2500 });
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

  it("shows preset questions, then turns speech into an answer with live coaching and a score", async () => {
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
    expect(snap.coach).toMatchObject({ answerId: snap.answers[0]!.id, stance: "partly_right", questions: [{ text: "How did you find out what was holding the connections?" }, { text: "What did you change so it cannot happen again?" }] });
    expect(snap.transcript.map((x) => x.role)).toEqual(["interviewer", "candidate"]);
    expect(types()).toEqual(expect.arrayContaining(["segment", "answer", "questions", "coach", "score"]));
    // events are numbered in increasing order
    const seqs = t.events.map((e) => e.seq!).filter(Boolean);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("coaches WHILE the candidate is still talking, and only once enough has been said", async () => {
    await t.say(seg("interviewer", "Tell me about a production incident you handled", 0));
    await t.say(seg("candidate", "Our payments service started timing out", 5000)); // 6 words: too early to say anything
    expect(coachPrompts).toHaveLength(0);
    await t.say(seg("candidate", "because the connection pool was exhausted by a long report query", 8000)); // 18 words in total
    expect(coachPrompts).toHaveLength(1);
    const first = t.events.find((e) => e.type === "coach")!;
    expect(first.data).toMatchObject({ stance: "partly_right", questions: [{ remark: "tests whether they diagnosed it themselves" }, expect.anything()], proof: null });
    expect((await t.room.snapshot("i-1")).answers[0]!.state).toBe("open"); // still the same open answer: nothing was closed or scored
    expect(types()).not.toContain("score");
  });

  it("refreshes after a pause or after plenty of new speech, tells the coach what is on screen, and not more often than needed", async () => {
    const t = await setup(taskModels(), { silenceMs: 20_000 }); // the real setting: a pause is not the end of an answer
    await t.say(seg("interviewer", "Tell me about a production incident you handled", 0));
    await t.say(seg("candidate", ANSWER, 5000)); // first coaching
    expect(coachPrompts).toHaveLength(1);

    clock += 1000;
    await t.say(seg("candidate", "we then added a statement timeout", 9000)); // 5 new words, no pause: nothing
    t.room.tickAll();
    await t.room.idle("i-1");
    expect(coachPrompts).toHaveLength(1);

    clock += 5000; // now the candidate has paused for 5 s with enough new words
    t.room.tickAll();
    await t.room.idle("i-1");
    expect(coachPrompts).toHaveLength(1); // 5 new words is below the pause threshold of 8

    await t.say(seg("candidate", "and moved the reporting query onto a read replica so it could not starve the main pool again", 16_000));
    clock += 3000;
    t.room.tickAll();
    await t.room.idle("i-1");
    expect(coachPrompts).toHaveLength(2);
    expect(coachPrompts[1]).toContain("shown_a_moment_ago"); // the second call was told what the first one showed
    expect(coachPrompts[1]).toContain("How did you find out what was holding the connections?");
    expect(t.events.filter((e) => e.type === "coach")).toHaveLength(2);
  });

  it("carries the 'prove you did the work' question when the coach asks for it", async () => {
    const t2 = await setup(taskModels({ coach: { ...coachOut, proof: { text: "What exactly did you change yourself?", remark: "answer sounded textbook" } } }));
    await t2.say(seg("interviewer", "Tell me about a production incident you handled", 0));
    await t2.say(seg("candidate", ANSWER, 5000));
    const c = t2.events.find((e) => e.type === "coach")!.data as { proof: { text: string } };
    expect(c.proof.text).toBe("What exactly did you change yourself?");
  });

  it("only one coaching call runs at a time per interview; speech that arrives meanwhile is covered by the next one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let coachCalls = 0;
    const slow: ModelFactory = (spec) => {
      const inner = taskModels()(spec) as MockLanguageModelV4;
      const orig = inner.doGenerate as (o: never) => Promise<never>;
      inner.doGenerate = (async (o: never) => {
        if (JSON.stringify(o).includes("AS THEY ANSWER")) {
          coachCalls++;
          await gate;
        }
        return orig(o);
      }) as never;
      return inner;
    };
    const t2 = await setup(slow, { silenceMs: 20_000 });
    await t2.interviews.appendSegment(seg("interviewer", "Tell me about a production incident you handled", 0));
    t2.room.onSegment(seg("interviewer", "Tell me about a production incident you handled", 0));
    t2.room.onSegment(seg("candidate", ANSWER, 5000)); // starts the first (blocked) coaching call
    await new Promise((r) => setTimeout(r, 20));
    clock += 9000;
    t2.room.onSegment(seg("candidate", "and afterwards we put alerts on pool usage and moved the report to a replica for good measure then wrote a runbook for the on call team and ran a game day to practise the same failure with the new alerts in place", 14_000));
    await new Promise((r) => setTimeout(r, 20));
    expect(coachCalls).toBe(1); // the second is waiting, not racing
    release();
    await t2.room.idle("i-1");
    expect(coachCalls).toBe(2);
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
    expect(t.events.some((e) => e.type === "coach")).toBe(true); // live coaching still worked
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
    const app = buildApp({ store: t.interviews, transcripts: t.interviews, controller: fakeController(), aliasDomain: "x.test", intakeToken: "api-token", enableDevRoutes: false, room: t.room, allowedOrigins: ["https://app.test"] });
    const call = (method: "GET" | "PUT" | "POST", url: string, payload?: unknown, headers: Record<string, string> = H) => app.inject({ method, url, headers, payload: payload as never });

    expect((await call("GET", "/api/interviews/i-1/room", undefined, {})).statusCode).toBe(401);
    expect((await call("GET", "/api/interviews/nope/room")).statusCode).toBe(404);
    expect((await call("GET", "/api/interviews/i-1/setup")).json()).toEqual({ setup: null }); // nothing saved yet
    expect((await call("PUT", "/api/interviews/i-1/setup", { roleTitle: "" })).statusCode).toBe(400);
    const ok = await call("PUT", "/api/interviews/i-1/setup", { roleTitle: "Backend", jd: "Node", presetQuestions: [{ text: "Explain mutexes" }] });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().questions).toHaveLength(1);
    expect((await call("GET", "/api/interviews/i-1/setup")).json().setup).toMatchObject({ roleTitle: "Backend", jd: "Node", presetQuestions: [{ text: "Explain mutexes" }] });
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

      // a browser on the web app's origin must be allowed to read the stream; other origins must not be
      const allowed = await fetch(`http://127.0.0.1:${port}/api/interviews/i-1/live`, { headers: { ...H, origin: "https://app.test" } });
      expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.test");
      await allowed.body!.cancel();
      const other = await fetch(`http://127.0.0.1:${port}/api/interviews/i-1/live`, { headers: { ...H, origin: "https://evil.test" } });
      expect(other.headers.get("access-control-allow-origin")).toBeNull();
      await other.body!.cancel();
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
