import { describe, expect, it, vi } from "vitest";
import { RecallBotController, SCHEDULED_THRESHOLD_MS } from "../src/botController.js";
import { RecallClient, RecallError, type CreateBotArgs, type RecallApi } from "../src/recall.js";
import type { Interview } from "../src/store.js";

const KEY = "sk_test_super_secret_key_value";
const WEBHOOK = "https://bot.example.com/webhooks/recall";

function client(fetchImpl: typeof fetch, extra: Partial<ConstructorParameters<typeof RecallClient>[0]> = {}) {
  return new RecallClient({ apiKey: KEY, region: "us-west-2", webhookUrl: WEBHOOK, retryDelayMs: 0, fetchImpl, ...extra });
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("RecallClient", () => {
  it("builds the create-bot body: meeting, name, schedule, metadata, live transcription, webhook endpoint", () => {
    const body = client(vi.fn()).buildCreateBody({
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      joinAt: "2026-11-20T09:59:00.000Z",
      metadata: { interview_id: "i-1" },
    });
    expect(body).toEqual({
      meeting_url: "https://meet.google.com/abc-defg-hij",
      bot_name: "Interview Assistant",
      join_at: "2026-11-20T09:59:00.000Z",
      metadata: { interview_id: "i-1" },
      recording_config: {
        transcript: {
          provider: { recallai_streaming: { mode: "prioritize_low_latency", language_code: "en" } },
          diarization: { use_separate_streams_when_available: true },
        },
        realtime_endpoints: [{ type: "webhook", url: WEBHOOK, events: ["transcript.data", "transcript.partial_data"] }],
      },
    });
  });

  it("omits join_at and metadata when not given", () => {
    const body = client(vi.fn()).buildCreateBody({ meetingUrl: "https://meet.google.com/abc-defg-hij" });
    expect(body).not.toHaveProperty("join_at");
    expect(body).not.toHaveProperty("metadata");
  });

  it("posts to the regional endpoint with the raw API key (no Bearer prefix) and returns the bot id", async () => {
    const f = vi.fn(async () => json(201, { id: "bot-abc" }));
    const res = await client(f as unknown as typeof fetch).createBot({ meetingUrl: "https://meet.google.com/abc-defg-hij" });
    expect(res).toEqual({ id: "bot-abc" });

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://us-west-2.recall.ai/api/v1/bot/");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(KEY);
  });

  it("retries 507 (ad-hoc bot pool empty) and then succeeds", async () => {
    let n = 0;
    const f = vi.fn(async () => (++n < 3 ? json(507, { detail: "pool empty" }) : json(201, { id: "bot-late" })));
    const res = await client(f as unknown as typeof fetch).createBot({ meetingUrl: "https://meet.google.com/abc-defg-hij" });
    expect(res.id).toBe("bot-late");
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxRetries on 507", async () => {
    const f = vi.fn(async () => json(507, {}));
    await expect(
      client(f as unknown as typeof fetch, { maxRetries: 4 }).createBot({ meetingUrl: "https://meet.google.com/abc-defg-hij" }),
    ).rejects.toMatchObject({ status: 507 });
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("does not retry other errors, and never leaks the API key in the error", async () => {
    const f = vi.fn(async () => json(401, { detail: "Invalid token" }));
    const err = await client(f as unknown as typeof fetch)
      .createBot({ meetingUrl: "https://meet.google.com/abc-defg-hij" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(RecallError);
    expect(err.status).toBe(401);
    expect(String(err.message)).not.toContain(KEY);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("validates config", () => {
    expect(() => new RecallClient({ apiKey: "", region: "us-west-2", webhookUrl: WEBHOOK })).toThrow(/API key/);
    expect(() => new RecallClient({ apiKey: KEY, region: "evil.com/x", webhookUrl: WEBHOOK })).toThrow(/region/);
  });

  it("delete and leave treat 404 as success but surface real errors", async () => {
    const ok404 = vi.fn(async () => json(404, {}));
    await client(ok404 as unknown as typeof fetch).deleteBot("b1");
    await client(ok404 as unknown as typeof fetch).leaveCall("b1");
    const [url] = ok404.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://us-west-2.recall.ai/api/v1/bot/b1/");
    expect((ok404.mock.calls[1] as unknown as [string])[0]).toBe("https://us-west-2.recall.ai/api/v1/bot/b1/leave_call/");

    const boom = vi.fn(async () => json(500, {}));
    await expect(client(boom as unknown as typeof fetch).deleteBot("b1")).rejects.toMatchObject({ status: 500 });
  });
});

describe("RecallBotController", () => {
  const NOW = Date.parse("2026-11-20T09:00:00Z");
  const base: Interview = {
    id: "i-1",
    alias: "7KQ2",
    ownerEmail: "r@acme.com",
    status: "scheduled",
    joinUrl: "https://meet.google.com/abc-defg-hij",
  };

  function setup() {
    const api = {
      createBot: vi.fn(async (_args: CreateBotArgs) => ({ id: "bot-new" })),
      deleteBot: vi.fn(async () => {}),
      leaveCall: vi.fn(async () => {}),
    } satisfies RecallApi;
    const warn = vi.fn();
    const ctl = new RecallBotController(api, { now: () => NOW, onWarn: warn });
    return { api, ctl, warn };
  }

  it("schedules a bot one minute before a meeting that is more than 10 minutes away", async () => {
    const { api, ctl } = setup();
    const plan = await ctl.schedule({ ...base, startsAt: "2026-11-20T10:00:00Z" });
    expect(plan).toEqual({ botId: "bot-new", mode: "scheduled", joinAt: "2026-11-20T09:59:00.000Z" });
    expect(api.createBot).toHaveBeenCalledWith({
      meetingUrl: base.joinUrl,
      joinAt: "2026-11-20T09:59:00.000Z",
      metadata: { interview_id: "i-1" },
    });
  });

  it("uses an ad-hoc bot (still with join_at) when the meeting is within 10 minutes", async () => {
    const { api, ctl } = setup();
    const plan = await ctl.schedule({ ...base, startsAt: "2026-11-20T09:05:00Z" });
    expect(plan.mode).toBe("ad_hoc");
    expect(plan.joinAt).toBe("2026-11-20T09:04:00.000Z");
    expect(api.createBot).toHaveBeenCalledTimes(1);
  });

  it("joins immediately when the start is past or unknown", async () => {
    const { api, ctl } = setup();
    expect((await ctl.schedule({ ...base, startsAt: "2026-11-20T08:00:00Z" })).joinAt).toBeUndefined();
    expect((await ctl.schedule({ ...base })).joinAt).toBeUndefined();
    expect(api.createBot.mock.calls.every(([a]) => a.joinAt === undefined)).toBe(true);
  });

  it("threshold boundary: exactly 10 minutes of lead is ad hoc, just over is scheduled", async () => {
    const { ctl } = setup();
    const lead = 60_000;
    const at = (leadMs: number) => new Date(NOW + leadMs + lead).toISOString();
    expect((await ctl.schedule({ ...base, startsAt: at(SCHEDULED_THRESHOLD_MS) })).mode).toBe("ad_hoc");
    expect((await ctl.schedule({ ...base, startsAt: at(SCHEDULED_THRESHOLD_MS + 1000) })).mode).toBe("scheduled");
  });

  it("on reschedule removes the old scheduled bot first, then creates the new one", async () => {
    const { api, ctl } = setup();
    await ctl.schedule({ ...base, startsAt: "2026-11-20T12:00:00Z", recallBotId: "bot-old", joinMode: "scheduled" });
    expect(api.deleteBot).toHaveBeenCalledWith("bot-old");
    expect(api.deleteBot.mock.invocationCallOrder[0]!).toBeLessThan(api.createBot.mock.invocationCallOrder[0]!);
  });

  it("cancel: deletes a scheduled bot; falls back to leave_call if delete fails; ad-hoc bots just leave", async () => {
    const a = setup();
    await a.ctl.cancel({ ...base, recallBotId: "b1", joinMode: "scheduled" });
    expect(a.api.deleteBot).toHaveBeenCalledWith("b1");
    expect(a.api.leaveCall).not.toHaveBeenCalled();

    const b = setup();
    b.api.deleteBot.mockRejectedValueOnce(new Error("already started"));
    await b.ctl.cancel({ ...base, recallBotId: "b2", joinMode: "scheduled" });
    expect(b.api.leaveCall).toHaveBeenCalledWith("b2");

    const c = setup();
    await c.ctl.cancel({ ...base, recallBotId: "b3", joinMode: "ad_hoc" });
    expect(c.api.deleteBot).not.toHaveBeenCalled();
    expect(c.api.leaveCall).toHaveBeenCalledWith("b3");
  });

  it("cancel never throws and does nothing without a bot", async () => {
    const { api, ctl, warn } = setup();
    await ctl.cancel(base);
    expect(api.deleteBot).not.toHaveBeenCalled();
    api.leaveCall.mockRejectedValueOnce(new Error("recall down"));
    await expect(ctl.cancel({ ...base, recallBotId: "b4", joinMode: "ad_hoc" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it("refuses to schedule an interview without a link", async () => {
    const { ctl } = setup();
    await expect(ctl.schedule({ ...base, joinUrl: undefined })).rejects.toThrow(/meeting link/);
  });
});
