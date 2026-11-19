import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { MeetingEvent, TranscriptSegment } from "../src/meetingSource.js";
import { mapRecallPayload, verifyRecallSignature } from "../src/recallWebhook.js";
import { InMemoryStore, type Interview } from "../src/store.js";
import { WEBHOOK_SECRET, auth, fakeController, signed } from "./helpers.js";

const interview: Interview = {
  id: "i-1",
  alias: "7KQ2",
  ownerEmail: "Recruiter@Acme.com",
  status: "scheduled",
  recallBotId: "bot-1",
  joinMode: "scheduled",
};

const bot = { id: "bot-1", metadata: { interview_id: "i-1" } };

function transcript(event: "transcript.data" | "transcript.partial_data", participant: object, words: string[] = ["Hello", "there"]) {
  return {
    event,
    data: {
      data: {
        words: words.map((text, i) => ({ text, start_timestamp: { relative: 1.5 + i * 0.5 }, end_timestamp: { relative: 2 + i * 0.5 } })),
        participant,
      },
      bot,
    },
  };
}
const status = (code: string, sub_code?: string) => ({ event: `bot.${code}`, data: { data: { code, sub_code: sub_code ?? null }, bot } });

describe("verifyRecallSignature", () => {
  const body = '{"event":"transcript.data"}';
  const nowMs = 1_800_000_000_000;
  const ts = nowMs / 1000;
  const args = (over: Record<string, unknown> = {}) => ({
    secret: WEBHOOK_SECRET,
    headers: signed(body, { tsSec: ts }),
    payload: body,
    nowMs,
    ...over,
  });

  it("accepts a correctly signed request", () => {
    expect(verifyRecallSignature(args())).toEqual({ ok: true });
  });

  it("accepts legacy svix-* header names", () => {
    const h = signed(body, { tsSec: ts });
    const svix = { "svix-id": h["webhook-id"], "svix-timestamp": h["webhook-timestamp"], "svix-signature": h["webhook-signature"] };
    expect(verifyRecallSignature(args({ headers: svix }))).toEqual({ ok: true });
  });

  it("rejects a tampered body, a wrong secret, and missing headers", () => {
    expect(verifyRecallSignature(args({ payload: body + " " })).ok).toBe(false);
    const other = "whsec_" + Buffer.from("a-different-secret").toString("base64");
    expect(verifyRecallSignature(args({ secret: other })).ok).toBe(false);
    expect(verifyRecallSignature(args({ headers: {} })).ok).toBe(false);
  });

  it("rejects replays: timestamps more than 5 minutes off, either direction", () => {
    expect(verifyRecallSignature(args({ nowMs: nowMs + 301_000 })).ok).toBe(false);
    expect(verifyRecallSignature(args({ nowMs: nowMs - 301_000 })).ok).toBe(false);
    expect(verifyRecallSignature(args({ nowMs: nowMs + 299_000 })).ok).toBe(true);
  });

  it("accepts when one of several space-separated signatures matches", () => {
    const h = signed(body, { tsSec: ts });
    const headers = { ...h, "webhook-signature": `v1,AAAA ${h["webhook-signature"]}` };
    expect(verifyRecallSignature(args({ headers })).ok).toBe(true);
  });

  it("refuses to run with a missing or malformed server secret", () => {
    expect(verifyRecallSignature(args({ secret: "" })).ok).toBe(false);
    expect(verifyRecallSignature(args({ secret: "not-a-whsec" })).ok).toBe(false);
  });
});

describe("mapRecallPayload", () => {
  const one = (p: unknown): MeetingEvent => {
    const e = mapRecallPayload(p, interview);
    expect(e).toHaveLength(1);
    return e[0]!;
  };

  it("maps a final utterance to a segment with joined words and ms offsets", () => {
    const e = one(transcript("transcript.data", { id: 100, name: "Asha", is_host: false }, ["I", "built", "it"]));
    expect(e).toEqual({
      type: "segment",
      segment: {
        interviewId: "i-1",
        speakerId: "100",
        speakerName: "Asha",
        role: "candidate",
        text: "I built it",
        isFinal: true,
        startMs: 1500,
        endMs: 3000,
      },
    });
  });

  it("marks partial utterances as not final", () => {
    expect((one(transcript("transcript.partial_data", { id: 1 })) as { segment: TranscriptSegment }).segment.isFinal).toBe(false);
  });

  it("tags the interviewer by e-mail (case-insensitive) or by host flag; unknown otherwise", () => {
    const role = (p: object) => (one(transcript("transcript.data", p)) as { segment: TranscriptSegment }).segment.role;
    expect(role({ id: 1, email: "recruiter@acme.com", is_host: false })).toBe("interviewer");
    expect(role({ id: 2, is_host: true })).toBe("interviewer");
    expect(role({ id: 3, is_host: false, email: "cand@x.com" })).toBe("candidate");
    expect(role({ id: 4, is_host: null })).toBe("unknown");
  });

  it("ignores empty or malformed transcript payloads", () => {
    expect(mapRecallPayload(transcript("transcript.data", { id: 1 }, []), interview)).toEqual([]);
    expect(mapRecallPayload(transcript("transcript.data", { id: 1 }, ["", " "]), interview)).toEqual([]);
    expect(mapRecallPayload(null, interview)).toEqual([]);
    expect(mapRecallPayload({ event: "transcript.data" }, interview)).toEqual([]);
    expect(mapRecallPayload("garbage", interview)).toEqual([]);
  });

  it("maps bot lifecycle events", () => {
    expect(one(status("in_waiting_room"))).toEqual({ type: "lobby_waiting", interviewId: "i-1" });
    expect(one(status("in_call_not_recording")).type).toBe("admitted");
    expect(one(status("in_call_recording")).type).toBe("admitted");
    expect(one(status("recording_permission_allowed"))).toEqual({ type: "recording_status", interviewId: "i-1", ok: true });
    expect(one(status("recording_permission_denied", "zoom_local_recording_denied"))).toEqual({
      type: "recording_status",
      interviewId: "i-1",
      ok: false,
      detail: "zoom_local_recording_denied",
    });
    expect(mapRecallPayload(status("joining_call"), interview)).toEqual([]);
    expect(mapRecallPayload(status("done"), interview)).toEqual([]);
  });

  it("maps call_ended sub-codes to the right end reason", () => {
    const reason = (sub?: string) => (one(status("call_ended", sub)) as { reason: string }).reason;
    expect(reason("timeout_exceeded_waiting_room")).toBe("not_admitted");
    expect(reason("bot_kicked_from_waiting_room")).toBe("not_admitted");
    expect(reason("call_ended_by_platform_waiting_room_timeout")).toBe("not_admitted");
    expect(reason("bot_kicked_from_call")).toBe("removed");
    expect(reason("bot_received_leave_call")).toBe("removed");
    expect(reason("call_ended_by_host")).toBe("meeting_ended");
    expect(reason("timeout_exceeded_everyone_left")).toBe("meeting_ended");
    expect(reason(undefined)).toBe("meeting_ended");
    expect(one(status("fatal", "meeting_not_found"))).toMatchObject({ type: "ended", reason: "error", detail: "meeting_not_found" });
  });
});

describe("POST /webhooks/recall", () => {
  let store: InMemoryStore;
  let app: ReturnType<typeof buildApp>;
  let segments: TranscriptSegment[];

  const send = (body: unknown, headers?: Record<string, string>) => {
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    return app.inject({ method: "POST", url: "/webhooks/recall", headers: headers ?? signed(raw), payload: raw });
  };

  beforeEach(async () => {
    store = new InMemoryStore();
    segments = [];
    app = buildApp({
      store,
      controller: fakeController(),
      aliasDomain: "bot.test",
      intakeToken: "test-token",
      enableDevRoutes: false,
      recallWebhookSecret: WEBHOOK_SECRET,
      onSegment: (s) => segments.push(s),
    });
    await store.save({ ...interview });
  });

  it("rejects unsigned, mis-signed and replayed requests with 401", async () => {
    const body = JSON.stringify(status("in_waiting_room"));
    expect((await send(body, { "content-type": "application/json" })).statusCode).toBe(401);
    expect((await send(body, signed(body, { secret: "whsec_" + Buffer.from("nope").toString("base64") }))).statusCode).toBe(401);
    expect((await send(body, signed(body, { tsSec: Math.floor(Date.now() / 1000) - 3600 }))).statusCode).toBe(401);
    expect((await store.findById("i-1"))?.status).toBe("scheduled");
  });

  it("is not reachable with the API bearer token alone (separate auth)", async () => {
    const r = await app.inject({ method: "POST", url: "/webhooks/recall", headers: { ...auth, "content-type": "application/json" }, payload: "{}" });
    expect(r.statusCode).toBe(401);
  });

  it("answers 503 when no webhook secret is configured", async () => {
    const bare = buildApp({ store, controller: fakeController(), aliasDomain: "bot.test", intakeToken: "t", enableDevRoutes: false });
    const r = await bare.inject({ method: "POST", url: "/webhooks/recall", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(r.statusCode).toBe(503);
  });

  it("walks the interview through its lifecycle from status webhooks", async () => {
    await send(status("in_waiting_room"));
    expect((await store.findById("i-1"))?.status).toBe("joining");
    await send(status("in_call_recording"));
    expect((await store.findById("i-1"))?.status).toBe("in_meeting");
    await send(status("call_ended", "call_ended_by_host"));
    expect((await store.findById("i-1"))?.status).toBe("ended");
  });

  it("marks the interview not_admitted when the bot times out in the waiting room", async () => {
    await send(status("in_waiting_room"));
    await send(status("call_ended", "timeout_exceeded_waiting_room"));
    expect((await store.findById("i-1"))?.status).toBe("not_admitted");
  });

  it("records a denied recording permission", async () => {
    await send(status("recording_permission_denied", "zoom_local_recording_denied"));
    expect((await store.findById("i-1"))?.recording).toEqual({ ok: false, detail: "zoom_local_recording_denied" });
  });

  it("delivers transcript segments to the handler", async () => {
    const res = await send(transcript("transcript.data", { id: 7, name: "Asha", is_host: false }, ["I", "like", "Kafka"]));
    expect(res.json()).toEqual({ status: "ok", events: 1 });
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ interviewId: "i-1", text: "I like Kafka", role: "candidate", isFinal: true });
  });

  it("resolves the interview by metadata even before the bot id is stored (no race)", async () => {
    await store.save({ ...interview, recallBotId: undefined });
    await send(status("in_waiting_room"));
    expect((await store.findById("i-1"))?.status).toBe("joining");
  });

  it("resolves by bot id when metadata is absent", async () => {
    await send({ event: "bot.in_waiting_room", data: { data: {}, bot: { id: "bot-1", metadata: {} } } });
    expect((await store.findById("i-1"))?.status).toBe("joining");
  });

  it("ignores events from a bot that a reschedule replaced", async () => {
    await send({ ...status("call_ended", "bot_received_leave_call"), data: { data: {}, bot: { id: "bot-OLD", metadata: { interview_id: "i-1" } } } });
    expect((await store.findById("i-1"))?.status).toBe("scheduled");
  });

  it("keeps a cancelled interview cancelled when the cancelled bot reports it left", async () => {
    await store.save({ ...interview, status: "cancelled" });
    await send(status("call_ended", "bot_received_leave_call"));
    expect((await store.findById("i-1"))?.status).toBe("cancelled");
  });

  it("acknowledges (200) events it does not use or cannot place, so Recall does not retry", async () => {
    expect((await send(status("joining_call"))).json()).toEqual({ status: "ignored", reason: "event_not_used" });
    expect((await send({ event: "bot.done", data: { bot: { id: "unknown", metadata: {} } } })).json()).toEqual({ status: "ignored", reason: "unknown_interview" });
  });

  it("returns 400 for a signed body that is not JSON", async () => {
    expect((await send("not json")).statusCode).toBe(400);
  });

  it("other JSON routes still parse normally (raw-body parser is scoped to the webhook)", async () => {
    const r = await app.inject({ method: "POST", url: "/api/intake/link", headers: { ...auth, "content-type": "application/json" }, payload: JSON.stringify({ alias: "NOPE", link: "x" }) });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: "rejected", reason: "unknown_alias" });
  });
});

void vi;
