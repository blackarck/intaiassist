import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { Scheduler, type BotDispatcher } from "../src/scheduler.js";
import { InMemoryStore } from "../src/store.js";

const TEAMS = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABC%40thread.v2/0?context=x";
const TOKEN = "test-token";
const auth = { authorization: `Bearer ${TOKEN}` };

function icsB64(method: string, uid: string, dtstart?: string) {
  const lines = ["BEGIN:VCALENDAR", `METHOD:${method}`, "BEGIN:VEVENT", `UID:${uid}`];
  if (dtstart) lines.push(`DTSTART:${dtstart}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return Buffer.from(lines.join("\r\n")).toString("base64");
}

function invite(over: Record<string, unknown> = {}) {
  return {
    messageId: "m1",
    from: "recruiter@acme.com",
    to: "candidate@gmail.com; iv-7kq2@bot.test",
    subject: "Interview",
    body: `<a href="${TEAMS}">Join</a>`,
    attachments: [{ name: "invite.ics", contentBytes: icsB64("REQUEST", "uid-1", "20261120T100000Z") }],
    ...over,
  };
}

describe("intake API", () => {
  let dispatcher: BotDispatcher & { join: ReturnType<typeof vi.fn>; leave: ReturnType<typeof vi.fn> };
  let now: number;
  let app: ReturnType<typeof buildApp>;
  let store: InMemoryStore;
  let interviewId: string;

  beforeEach(async () => {
    // Fake only what the scheduler uses; faking setImmediate/nextTick would hang Fastify's inject().
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    now = Date.parse("2026-11-20T09:00:00Z");
    vi.setSystemTime(now);
    dispatcher = { join: vi.fn().mockResolvedValue(undefined), leave: vi.fn().mockResolvedValue(undefined) };
    store = new InMemoryStore();
    app = buildApp({
      store,
      scheduler: new Scheduler(dispatcher, 60_000, () => Date.now()),
      aliasDomain: "bot.test",
      intakeToken: TOKEN,
      enableDevRoutes: true,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/dev/interviews",
      headers: auth,
      payload: { alias: "7kq2", ownerEmail: "recruiter@acme.com" },
    });
    interviewId = res.json().id;
  });

  it("rejects missing or wrong token", async () => {
    const r1 = await app.inject({ method: "POST", url: "/api/intake/meeting-invite", payload: invite() });
    expect(r1.statusCode).toBe(401);
    const r2 = await app.inject({
      method: "POST",
      url: "/api/intake/meeting-invite",
      headers: { authorization: "Bearer nope" },
      payload: invite(),
    });
    expect(r2.statusCode).toBe(401);
  });

  it("schedules the bot 60s before start and dispatches the join URL", async () => {
    const res = await app.inject({ method: "POST", url: "/api/intake/meeting-invite", headers: auth, payload: invite() });
    expect(res.json()).toMatchObject({ status: "scheduled", interviewId, runAt: "2026-11-20T09:59:00.000Z" });
    expect(dispatcher.join).not.toHaveBeenCalled();

    // now=09:00, start=10:00, lead=60s -> fires at 09:59, i.e. 59 min from now
    await vi.advanceTimersByTimeAsync(58 * 60_000 + 59_000);
    expect(dispatcher.join).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dispatcher.join).toHaveBeenCalledWith({ interviewId, joinUrl: TEAMS });
  });

  it("joins immediately when no start time is known", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/intake/meeting-invite",
      headers: auth,
      payload: invite({ attachments: [] }),
    });
    expect(res.json().status).toBe("scheduled");
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatcher.join).toHaveBeenCalledTimes(1);
  });

  it("reschedule replaces the pending job (no double join)", async () => {
    await app.inject({ method: "POST", url: "/api/intake/meeting-invite", headers: auth, payload: invite() });
    await app.inject({
      method: "POST",
      url: "/api/intake/meeting-invite",
      headers: auth,
      payload: invite({
        messageId: "m2",
        attachments: [{ name: "invite.ics", contentBytes: icsB64("REQUEST", "uid-1", "20261120T120000Z") }],
      }),
    });
    await vi.advanceTimersByTimeAsync(4 * 3600_000);
    expect(dispatcher.join).toHaveBeenCalledTimes(1);
  });

  it("cancellation cancels the job", async () => {
    await app.inject({ method: "POST", url: "/api/intake/meeting-invite", headers: auth, payload: invite() });
    const res = await app.inject({
      method: "POST",
      url: "/api/intake/meeting-invite",
      headers: auth,
      payload: invite({
        subject: "Canceled: Interview",
        attachments: [{ name: "invite.ics", contentBytes: icsB64("CANCEL", "uid-1") }],
      }),
    });
    expect(res.json()).toMatchObject({ status: "cancelled", interviewId });
    await vi.advanceTimersByTimeAsync(4 * 3600_000);
    expect(dispatcher.join).not.toHaveBeenCalled();
    expect((await store.findById(interviewId))?.status).toBe("cancelled");
  });

  it("rejects an unknown alias and ignores mail without an alias", async () => {
    const unknown = await app.inject({
      method: "POST",
      url: "/api/intake/meeting-invite",
      headers: auth,
      payload: invite({ to: "iv-nope1@bot.test" }),
    });
    expect(unknown.json()).toEqual({ status: "rejected", reason: "unknown_alias" });

    const none = await app.inject({
      method: "POST",
      url: "/api/intake/meeting-invite",
      headers: auth,
      payload: invite({ to: "someone@else.com" }),
    });
    expect(none.json()).toEqual({ status: "ignored", reason: "no_alias" });
  });

  it("does not let a paid alias be re-bound to a different meeting", async () => {
    await app.inject({ method: "POST", url: "/api/intake/meeting-invite", headers: auth, payload: invite() });
    const res = await app.inject({
      method: "POST",
      url: "/api/intake/meeting-invite",
      headers: auth,
      payload: invite({
        attachments: [{ name: "invite.ics", contentBytes: icsB64("REQUEST", "uid-OTHER", "20261121T100000Z") }],
      }),
    });
    expect(res.json()).toEqual({ status: "rejected", reason: "alias_bound_to_other_meeting" });
  });

  it("ignores an invite with no Teams link", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/intake/meeting-invite",
      headers: auth,
      payload: invite({ body: "<p>see you at the office</p>" }),
    });
    expect(res.json()).toEqual({ status: "ignored", reason: "no_join_url" });
  });

  it("paste-link fallback uses the same pipeline", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/intake/link",
      headers: auth,
      payload: { alias: "7KQ2", link: TEAMS },
    });
    expect(res.json()).toMatchObject({ status: "scheduled", interviewId });
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatcher.join).toHaveBeenCalledWith({ interviewId, joinUrl: TEAMS });
  });

  it("bot events drive interview status and forward segments", async () => {
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/bot/events", headers: auth, payload });

    await post({ type: "lobby_waiting", interviewId });
    expect((await store.findById(interviewId))?.status).toBe("joining");
    await post({ type: "admitted", interviewId });
    expect((await store.findById(interviewId))?.status).toBe("in_meeting");
    await post({ type: "ended", interviewId, reason: "not_admitted" });
    expect((await store.findById(interviewId))?.status).toBe("not_admitted");

    const unknown = await post({ type: "admitted", interviewId: "nope" });
    expect(unknown.statusCode).toBe(404);
  });

  it("passes tenantId and interviewerAadId to the bot (needed for short /meet/ links)", async () => {
    const seeded = await app.inject({
      method: "POST",
      url: "/api/dev/interviews",
      headers: auth,
      payload: { alias: "TNT1", ownerEmail: "r@acme.com", tenantId: "tenant-123", interviewerAadId: "oid-456" },
    });
    const id = seeded.json().id;
    const shortLink = "https://teams.microsoft.com/meet/123456789012?p=AbCdEf";
    await app.inject({ method: "POST", url: "/api/intake/link", headers: auth, payload: { alias: "TNT1", link: shortLink } });
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatcher.join).toHaveBeenCalledWith({
      interviewId: id,
      joinUrl: shortLink,
      tenantId: "tenant-123",
      interviewerAadId: "oid-456",
    });
  });

  it("records the updateRecordingStatus outcome from the bot", async () => {
    const post = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/api/bot/events", headers: auth, payload });
    await post({ type: "recording_status", interviewId, ok: false, detail: "403 not allowed" });
    expect((await store.findById(interviewId))?.recording).toEqual({ ok: false, detail: "403 not allowed" });
    await post({ type: "recording_status", interviewId, ok: true });
    expect((await store.findById(interviewId))?.recording?.ok).toBe(true);
  });

  it("paste-link rejects non-Teams URLs", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/intake/link",
      headers: auth,
      payload: { alias: "7KQ2", link: "https://evil.example.com/meet/1?p=2" },
    });
    expect(res.json()).toEqual({ status: "ignored", reason: "no_join_url" });
  });
});
