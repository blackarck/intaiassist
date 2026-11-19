import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { InMemoryStore } from "../src/store.js";
import { auth, fakeController, fixtureEmail, multipartBody, sendgridFields } from "./helpers.js";

const TOKEN = "inbound-secret-token-for-tests";
const ALIAS = "K7M2QX9WPB";
const ALIAS_ADDR = "iv-k7m2qx9wpb@invite.askproso.ai";

describe("POST /inbound/sendgrid/:token", () => {
  let store: InMemoryStore;
  let controller: ReturnType<typeof fakeController>;
  let app: ReturnType<typeof buildApp>;

  const build = (over: Record<string, unknown> = {}) =>
    buildApp({
      store,
      transcripts: store,
      messageLog: store,
      controller,
      aliasDomain: "invite.askproso.ai",
      intakeToken: "api-token",
      enableDevRoutes: false,
      inboundToken: TOKEN,
      ...over,
    });

  const send = (fields: Record<string, string>, token = TOKEN) => {
    const { payload, headers } = multipartBody(fields);
    return app.inject({ method: "POST", url: `/inbound/sendgrid/${token}`, headers, payload });
  };

  beforeEach(async () => {
    store = new InMemoryStore();
    controller = fakeController();
    app = build();
    await store.save({ id: "i-1", alias: ALIAS, ownerEmail: "recruiter@acme.com", status: "paid" });
  });

  it("schedules the bot from an Outlook invite (link, start time and calendar id read from the e-mail)", async () => {
    const res = await send(sendgridFields(fixtureEmail("outlook-invite"), [ALIAS_ADDR]));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "scheduled", interviewId: "i-1", senderMismatch: false });

    expect(controller.calls.schedule).toHaveLength(1);
    expect(controller.calls.schedule[0]).toMatchObject({
      id: "i-1",
      platform: "teams",
      startsAt: "2026-11-20T10:00:00Z",
      icalUid: "040000008200E00074C5B7101A82E00800000000OUTLOOK1",
      joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABC%40thread.v2/0?context=%7b%22Tid%22%3a%22t%22%7d",
    });
    expect((await store.findById("i-1"))?.recallBotId).toBe("bot-1");
  });

  it("works when the alias is only in the envelope (BCC) and the meeting is Google Meet", async () => {
    const res = await send(sendgridFields(fixtureEmail("google-invite"), [ALIAS_ADDR]));
    expect(res.json()).toMatchObject({ status: "scheduled", interviewId: "i-1" });
    expect(controller.calls.schedule[0]).toMatchObject({ platform: "meet", joinUrl: "https://meet.google.com/abc-defg-hij" });
  });

  it("cancels the bot when the cancellation e-mail arrives", async () => {
    await send(sendgridFields(fixtureEmail("outlook-invite"), [ALIAS_ADDR]));
    const res = await send(sendgridFields(fixtureEmail("outlook-cancel"), [ALIAS_ADDR]));
    expect(res.json()).toMatchObject({ status: "cancelled", interviewId: "i-1" });
    expect(controller.calls.cancel[0]).toMatchObject({ recallBotId: "bot-1" });
    expect((await store.findById("i-1"))?.status).toBe("cancelled");
  });

  it("also accepts the same fields as a JSON body (one SendGrid doc page describes raw mode as JSON)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/inbound/sendgrid/${TOKEN}`,
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(sendgridFields(fixtureEmail("outlook-invite"), [ALIAS_ADDR])),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "scheduled", interviewId: "i-1" });
  });

  it("rejects a wrong or missing token, and answers 503 when the feature is not configured", async () => {
    const f = sendgridFields(fixtureEmail("outlook-invite"), [ALIAS_ADDR]);
    expect((await send(f, "wrong-token")).statusCode).toBe(401);
    expect((await send(f, "x")).statusCode).toBe(401);
    expect(controller.calls.schedule).toHaveLength(0);

    app = build({ inboundToken: undefined });
    expect((await send(f)).statusCode).toBe(503);
  });

  it("is not reachable with the API bearer token (separate secret)", async () => {
    const { payload, headers } = multipartBody(sendgridFields(fixtureEmail("outlook-invite"), [ALIAS_ADDR]));
    const res = await app.inject({ method: "POST", url: "/inbound/sendgrid/api-token", headers: { ...headers, ...auth }, payload });
    expect(res.statusCode).toBe(401);
  });

  it("ignores mail whose sender fails SPF and DKIM (spoofed From), without scheduling or retrying", async () => {
    const res = await send(sendgridFields(fixtureEmail("outlook-invite"), [ALIAS_ADDR], { SPF: "fail", dkim: "{@acme.com : fail}" }));
    expect(res.statusCode).toBe(200); // 200: a non-2xx would make SendGrid redeliver the spoof forever
    expect(res.json()).toEqual({ status: "ignored", reason: "sender_not_authenticated" });
    expect(controller.calls.schedule).toHaveLength(0);
    expect((await store.findById("i-1"))?.status).toBe("paid");
  });

  it("can be told not to require sender authentication (local experiments only)", async () => {
    app = build({ requireSenderAuth: false });
    const res = await send(sendgridFields(fixtureEmail("outlook-invite"), [ALIAS_ADDR], { SPF: "none", dkim: "" }));
    expect(res.json()).toMatchObject({ status: "scheduled" });
  });

  it("processes a repeated delivery of the same message only once", async () => {
    const f = sendgridFields(fixtureEmail("outlook-invite"), [ALIAS_ADDR]);
    expect((await send(f)).json()).toMatchObject({ status: "scheduled" });
    expect((await send(f)).json()).toEqual({ status: "ignored", reason: "duplicate_message" });
    expect(controller.calls.schedule).toHaveLength(1);
  });

  it("returns 500 when the bot provider fails, and the retry is then processed (message not marked as seen)", async () => {
    const failing = vi.spyOn(controller, "schedule").mockRejectedValueOnce(new Error("recall is down"));
    const f = sendgridFields(fixtureEmail("outlook-invite"), [ALIAS_ADDR]);

    expect((await send(f)).statusCode).toBe(500);
    expect(await store.hasMessageSeen("<outlook-1@acme.com>")).toBe(false);

    expect((await send(f)).json()).toMatchObject({ status: "scheduled", interviewId: "i-1" });
    expect(failing).toHaveBeenCalledTimes(2);
    expect(await store.hasMessageSeen("<outlook-1@acme.com>")).toBe(true);
  });

  it("acknowledges (200) an unknown alias and mail without raw MIME", async () => {
    const unknown = await send(sendgridFields(fixtureEmail("outlook-invite"), ["iv-zzzzzzzzzz@invite.askproso.ai"], {}));
    // the fixture's own To header still carries the real alias, so use a message without it
    const noAlias = fixtureEmail("google-invite");
    const res = await send(sendgridFields(noAlias, ["iv-zzzzzzzzzz@invite.askproso.ai"]));
    expect(res.json()).toEqual({ status: "rejected", reason: "unknown_alias" });
    expect(unknown.statusCode).toBe(200);

    const notRaw = await send({ from: "a@b.c", subject: "x", text: "hello", SPF: "pass" });
    expect(notRaw.statusCode).toBe(200);
    expect(notRaw.json()).toEqual({ status: "ignored", reason: "raw_mime_required" });
  });

  it("other routes keep parsing JSON normally (multipart is scoped to the inbound route)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/intake/link",
      headers: { ...auth, authorization: "Bearer api-token", "content-type": "application/json" },
      payload: JSON.stringify({ alias: ALIAS, link: "https://meet.google.com/abc-defg-hij" }),
    });
    expect(res.json()).toMatchObject({ status: "scheduled", interviewId: "i-1" });
  });
});

describe("POST /api/interviews", () => {
  const make = () => {
    const store = new InMemoryStore();
    const app = buildApp({
      store,
      controller: fakeController(),
      aliasDomain: "invite.askproso.ai",
      intakeToken: "api-token",
      enableDevRoutes: false,
    });
    return { store, app };
  };
  const post = (app: ReturnType<typeof buildApp>, body: unknown, token = "api-token") =>
    app.inject({ method: "POST", url: "/api/interviews", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: JSON.stringify(body) });

  it("creates an interview with a 10-character alias and returns the invite address", async () => {
    const { store, app } = make();
    const res = await post(app, { ownerEmail: "recruiter@acme.com" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.alias).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(body.address).toBe(`iv-${body.alias.toLowerCase()}@invite.askproso.ai`);
    expect(await store.findByAlias(body.alias)).toMatchObject({ id: body.id, ownerEmail: "recruiter@acme.com", status: "paid" });
  });

  it("gives every interview a different alias", async () => {
    const { app } = make();
    const aliases = new Set<string>();
    for (let i = 0; i < 25; i++) aliases.add((await post(app, { ownerEmail: "r@acme.com" })).json().alias);
    expect(aliases.size).toBe(25);
  });

  it("validates the e-mail and requires the API token", async () => {
    const { app } = make();
    expect((await post(app, { ownerEmail: "not-an-email" })).statusCode).toBe(400);
    expect((await post(app, {})).statusCode).toBe(400);
    expect((await post(app, { ownerEmail: "r@acme.com" }, "wrong")).statusCode).toBe(401);
  });

  it("the invite address it returns is accepted by the inbound parser end to end", async () => {
    const store = new InMemoryStore();
    const controller = fakeController();
    const app = buildApp({ store, messageLog: store, controller, aliasDomain: "invite.askproso.ai", intakeToken: "api-token", enableDevRoutes: false, inboundToken: TOKEN });
    const { alias, address } = (await post(app, { ownerEmail: "recruiter@acme.com" })).json();

    const raw = fixtureEmail("outlook-invite").replace(/iv-K7M2QX9WPB@invite\.askproso\.ai/, address);
    const { payload, headers } = multipartBody(sendgridFields(raw, []));
    const res = await app.inject({ method: "POST", url: `/inbound/sendgrid/${TOKEN}`, headers, payload });
    expect(res.json()).toMatchObject({ status: "scheduled" });
    expect((await store.findByAlias(alias))?.status).toBe("scheduled");
  });
});
