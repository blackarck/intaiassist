import { createHmac } from "node:crypto";
import { vi } from "vitest";
import type { BotController, BotPlan } from "../src/botController.js";
import type { Interview } from "../src/store.js";

export const TOKEN = "test-token";
export const auth = { authorization: `Bearer ${TOKEN}` };

export const WEBHOOK_SECRET = "whsec_" + Buffer.from("unit-test-signing-key-0123456789").toString("base64");

/** Headers Recall would send for this exact raw body. */
export function signed(body: string, opts: { id?: string; tsSec?: number; secret?: string } = {}) {
  const id = opts.id ?? "msg_test_1";
  const ts = opts.tsSec ?? Math.floor(Date.now() / 1000);
  const key = Buffer.from((opts.secret ?? WEBHOOK_SECRET).slice("whsec_".length), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": String(ts),
    "webhook-signature": `v1,${sig}`,
  };
}

/** A BotController that records calls and hands out bot-1, bot-2, ... */
export function fakeController(plan: Partial<BotPlan> = {}) {
  const calls = { schedule: [] as Interview[], cancel: [] as Interview[] };
  let n = 0;
  const controller: BotController & { calls: typeof calls } = {
    calls,
    schedule: vi.fn(async (i: Interview) => {
      calls.schedule.push({ ...i });
      return { botId: `bot-${++n}`, mode: "scheduled" as const, joinAt: "2026-11-20T09:59:00.000Z", ...plan };
    }),
    cancel: vi.fn(async (i: Interview) => {
      calls.cancel.push({ ...i });
    }),
  };
  return controller;
}

export function icsB64(method: string, uid: string, dtstart?: string) {
  const lines = ["BEGIN:VCALENDAR", `METHOD:${method}`, "BEGIN:VEVENT", `UID:${uid}`];
  if (dtstart) lines.push(`DTSTART:${dtstart}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return Buffer.from(lines.join("\r\n")).toString("base64");
}
