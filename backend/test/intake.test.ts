import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { InMemoryStore } from "../src/store.js";
import { auth, fakeController, icsB64 } from "./helpers.js";

const TEAMS = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABC%40thread.v2/0?context=x";
const ZOOM = "https://us02web.zoom.us/j/81234567890?pwd=AbCdEf123";

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
  let controller: ReturnType<typeof fakeController>;
  let store: InMemoryStore;
  let app: ReturnType<typeof buildApp>;
  let interviewId: string;

  const post = (url: string, payload: Record<string, unknown>, headers: Record<string, string> = auth) =>
    app.inject({ method: "POST", url, headers, payload });

  beforeEach(async () => {
    controller = fakeController();
    store = new InMemoryStore();
    app = buildApp({ store, controller, aliasDomain: "bot.test", intakeToken: "test-token", enableDevRoutes: true });
    const res = await post("/api/dev/interviews", { alias: "7kq2", ownerEmail: "recruiter@acme.com" });
    interviewId = res.json().id;
  });

  it("rejects missing or wrong token", async () => {
    expect((await post("/api/intake/meeting-invite", invite(), {})).statusCode).toBe(401);
    expect((await post("/api/intake/meeting-invite", invite(), { authorization: "Bearer nope" })).statusCode).toBe(401);
  });

  it("creates the bot with the link and start time, and stores the bot id", async () => {
    const res = await post("/api/intake/meeting-invite", invite());
    expect(res.json()).toMatchObject({ status: "scheduled", interviewId, mode: "scheduled", senderMismatch: false });

    expect(controller.calls.schedule).toHaveLength(1);
    expect(controller.calls.schedule[0]).toMatchObject({
      id: interviewId,
      joinUrl: TEAMS,
      platform: "teams",
      startsAt: "2026-11-20T10:00:00Z",
      icalUid: "uid-1",
    });
    expect(await store.findById(interviewId)).toMatchObject({ status: "scheduled", recallBotId: "bot-1", joinMode: "scheduled" });
    expect((await store.findByBotId("bot-1"))?.id).toBe(interviewId);
  });

  it("works for a Zoom invite", async () => {
    await post("/api/intake/meeting-invite", invite({ body: `Join Zoom Meeting ${ZOOM}` }));
    expect(controller.calls.schedule[0]).toMatchObject({ joinUrl: ZOOM, platform: "zoom" });
  });

  it("passes the previous bot id on reschedule so the controller can replace it", async () => {
    await post("/api/intake/meeting-invite", invite());
    await post("/api/intake/meeting-invite", invite({
      messageId: "m2",
      attachments: [{ name: "invite.ics", contentBytes: icsB64("REQUEST", "uid-1", "20261120T120000Z") }],
    }));
    expect(controller.calls.schedule).toHaveLength(2);
    expect(controller.calls.schedule[1]).toMatchObject({ recallBotId: "bot-1", joinMode: "scheduled", startsAt: "2026-11-20T12:00:00Z" });
    expect((await store.findById(interviewId))?.recallBotId).toBe("bot-2");
  });

  it("cancellation stops the bot and marks the interview cancelled", async () => {
    await post("/api/intake/meeting-invite", invite());
    const res = await post("/api/intake/meeting-invite", invite({
      subject: "Canceled: Interview",
      attachments: [{ name: "invite.ics", contentBytes: icsB64("CANCEL", "uid-1") }],
    }));
    expect(res.json()).toMatchObject({ status: "cancelled", interviewId });
    expect(controller.calls.cancel).toHaveLength(1);
    expect(controller.calls.cancel[0]).toMatchObject({ recallBotId: "bot-1" });
    expect((await store.findById(interviewId))?.status).toBe("cancelled");
  });

  it("rejects an unknown alias and ignores mail without an alias", async () => {
    expect((await post("/api/intake/meeting-invite", invite({ to: "iv-nope1@bot.test" }))).json()).toEqual({
      status: "rejected",
      reason: "unknown_alias",
    });
    expect((await post("/api/intake/meeting-invite", invite({ to: "someone@else.com" }))).json()).toEqual({
      status: "ignored",
      reason: "no_alias",
    });
    expect(controller.calls.schedule).toHaveLength(0);
  });

  it("does not let a paid alias be re-bound to a different meeting", async () => {
    await post("/api/intake/meeting-invite", invite());
    const res = await post("/api/intake/meeting-invite", invite({
      attachments: [{ name: "invite.ics", contentBytes: icsB64("REQUEST", "uid-OTHER", "20261121T100000Z") }],
    }));
    expect(res.json()).toEqual({ status: "rejected", reason: "alias_bound_to_other_meeting" });
    expect(controller.calls.schedule).toHaveLength(1);
  });

  it("ignores an invite with no meeting link", async () => {
    const res = await post("/api/intake/meeting-invite", invite({ body: "<p>see you at the office</p>" }));
    expect(res.json()).toEqual({ status: "ignored", reason: "no_meeting_link" });
    expect(controller.calls.schedule).toHaveLength(0);
  });

  it("ignores updates once the interview is under way", async () => {
    await store.save({ ...(await store.findById(interviewId))!, status: "in_meeting" });
    const res = await post("/api/intake/meeting-invite", invite());
    expect(res.json()).toEqual({ status: "ignored", reason: "interview_in_progress" });
  });

  it("returns 500 (so the sender retries) when the bot provider fails, and stores nothing", async () => {
    controller.schedule = async () => {
      throw new Error("recall is down");
    };
    const res = await post("/api/intake/meeting-invite", invite());
    expect(res.statusCode).toBe(500);
    expect((await store.findById(interviewId))?.status).toBe("paid");
  });

  it("paste-link fallback uses the same pipeline", async () => {
    const res = await post("/api/intake/link", { alias: "7KQ2", link: TEAMS });
    expect(res.json()).toMatchObject({ status: "scheduled", interviewId });
    expect(controller.calls.schedule[0]).toMatchObject({ joinUrl: TEAMS, platform: "teams" });
  });

  it("paste-link rejects non-meeting URLs", async () => {
    const res = await post("/api/intake/link", { alias: "7KQ2", link: "https://evil.example.com/meet/1?p=2" });
    expect(res.json()).toEqual({ status: "ignored", reason: "no_meeting_link" });
  });
});
