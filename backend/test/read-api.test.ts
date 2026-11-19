import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { InMemoryStore } from "../src/store.js";
import { auth, fakeController } from "./helpers.js";

describe("read API: interview state and transcript", () => {
  let store: InMemoryStore;
  let app: ReturnType<typeof buildApp>;
  const get = (url: string, headers: Record<string, string> = { authorization: "Bearer api-token" }) =>
    app.inject({ method: "GET", url, headers });

  beforeEach(async () => {
    store = new InMemoryStore();
    app = buildApp({ store, transcripts: store, controller: fakeController(), aliasDomain: "invite.askproso.ai", intakeToken: "api-token", enableDevRoutes: false });
    await store.save({ id: "i-1", alias: "K7M2QX9WPB", ownerEmail: "r@acme.com", status: "in_meeting", platform: "teams", joinUrl: "https://teams.microsoft.com/meet/1?p=secret", recallBotId: "bot-1", joinMode: "ad_hoc" });
    await store.appendSegment({ interviewId: "i-1", speakerId: "2", speakerName: "Asha", role: "candidate", text: "I built it", isFinal: true, startMs: 65_000 });
    await store.appendSegment({ interviewId: "i-1", speakerId: "1", speakerName: "Vivek", role: "interviewer", text: "Tell me about Kafka", isFinal: true, startMs: 3_000 });
  });

  it("requires the API token on both routes", async () => {
    expect((await get("/api/interviews/i-1", {})).statusCode).toBe(401);
    expect((await get("/api/interviews/i-1/transcript", { authorization: "Bearer nope" })).statusCode).toBe(401);
  });

  it("returns interview status without exposing the meeting link, bot id or owner e-mail", async () => {
    const body = (await get("/api/interviews/i-1")).json();
    expect(body).toMatchObject({ id: "i-1", status: "in_meeting", platform: "teams", joinMode: "ad_hoc" });
    expect(JSON.stringify(body)).not.toMatch(/secret|bot-1|acme\.com|teams\.microsoft/);
  });

  it("returns the transcript as JSON, oldest first", async () => {
    const body = (await get("/api/interviews/i-1/transcript")).json();
    expect(body.interviewId).toBe("i-1");
    expect(body.segments.map((s: { text: string }) => s.text)).toEqual(["Tell me about Kafka", "I built it"]);
  });

  it("returns the transcript as readable text with a clock", async () => {
    const res = await get("/api/interviews/i-1/transcript?format=text");
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.body).toBe("[00:00:03] Vivek (interviewer): Tell me about Kafka\n[00:01:05] Asha (candidate): I built it");
  });

  it("404 for an unknown interview, 501 when transcript storage is not configured", async () => {
    expect((await get("/api/interviews/nope")).statusCode).toBe(404);
    expect((await get("/api/interviews/nope/transcript")).statusCode).toBe(404);
    const bare = buildApp({ store, controller: fakeController(), aliasDomain: "x", intakeToken: "api-token", enableDevRoutes: false });
    expect((await bare.inject({ method: "GET", url: "/api/interviews/i-1/transcript", headers: { authorization: "Bearer api-token" } })).statusCode).toBe(501);
  });

  it("deletes an interview in any state, with its transcript, and stops its bot", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/interviews/i-1", headers: { authorization: "Bearer api-token" } });
    expect(res.statusCode).toBe(204);
    expect(await store.findById("i-1")).toBeUndefined();
    expect(await store.listSegments("i-1")).toEqual([]);
    expect((await get("/api/interviews/i-1")).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: "/api/interviews/i-1", headers: { authorization: "Bearer api-token" } })).statusCode).toBe(404);
  });

  it("sends the bot into a calendar meeting once, even if asked twice", async () => {
    const ctl = fakeController();
    const verifier = { verify: async (t: string) => (t === "tok" ? { provider: "microsoft" as const, subject: "microsoft:t:u1", email: "me@x.com" } : undefined) };
    const a = buildApp({ store, transcripts: store, controller: ctl, aliasDomain: "invite.askproso.ai", intakeToken: "api-token", enableDevRoutes: false, verifier });
    const join = (link: string) => a.inject({ method: "POST", url: "/api/me/interviews/join", headers: { authorization: "Bearer tok" }, payload: { link, startsAt: "2026-11-19T09:00:00Z" } });
    const url = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d";
    const first = await join(url);
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe("scheduled");
    const again = await join(url);
    expect(again.json().id).toBe(first.json().id);
    expect((await store.listByOwner("microsoft:t:u1")).length).toBe(1);
    expect((await join("no link here")).statusCode).toBe(422);
  });
});
void auth;
