import { createHmac, timingSafeEqual } from "node:crypto";
import { handleBotEvent, type SegmentHandler } from "./events.js";
import type { MeetingEvent } from "./meetingSource.js";
import type { Interview, InterviewStore, TranscriptStore } from "./store.js";

// ---------------------------------------------------------------------------------------------------------------
// Signature verification (Recall docs: "Verifying webhooks, websockets and callback requests from Recall.ai")
//   headers: webhook-id, webhook-timestamp, webhook-signature ("v1,<base64>" ...; svix-* for legacy accounts)
//   signed content: `${id}.${timestamp}.${rawBody}`, HMAC-SHA256 with the base64 key after the "whsec_" prefix
// We also reject timestamps more than 5 minutes off, which blocks replay of captured requests.
// ---------------------------------------------------------------------------------------------------------------

export type VerifyResult = { ok: true } | { ok: false; reason: string };

type HeaderBag = Record<string, string | string[] | undefined>;

function header(h: HeaderBag, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = h[n];
    if (typeof v === "string" && v) return v;
    if (Array.isArray(v) && v[0]) return v[0];
  }
  return undefined;
}

export function verifyRecallSignature(args: {
  secret: string;
  headers: HeaderBag;
  /** The RAW request body, byte for byte as received. Re-serialized JSON will not verify. */
  payload: string;
  nowMs?: number;
  toleranceSec?: number;
}): VerifyResult {
  const { secret, headers, payload } = args;
  if (!secret.startsWith("whsec_")) return { ok: false, reason: "server secret is missing or malformed" };

  const id = header(headers, "webhook-id", "svix-id");
  const ts = header(headers, "webhook-timestamp", "svix-timestamp");
  const sig = header(headers, "webhook-signature", "svix-signature");
  if (!id || !ts || !sig) return { ok: false, reason: "missing signature headers" };

  const tsSec = Number(ts);
  const now = (args.nowMs ?? Date.now()) / 1000;
  if (!Number.isFinite(tsSec) || Math.abs(now - tsSec) > (args.toleranceSec ?? 300)) {
    return { ok: false, reason: "timestamp outside tolerance" };
  }

  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${payload}`).digest();

  for (const part of sig.split(" ")) {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) continue;
    const got = Buffer.from(value, "base64");
    if (got.length === expected.length && timingSafeEqual(got, expected)) return { ok: true };
  }
  return { ok: false, reason: "no matching signature" };
}

// ---------------------------------------------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function roleFor(participant: Json, interviewerEmail: string): "interviewer" | "candidate" | "unknown" {
  const email = str(participant.email)?.toLowerCase();
  if (email && email === interviewerEmail.toLowerCase()) return "interviewer";
  if (participant.is_host === true) return "interviewer"; // organizer is usually the interviewer; refine for panels
  if (participant.is_host === false) return "candidate";
  return "unknown";
}

/** Sub-codes that mean the bot never got in or was thrown out (Recall "Call Ended Sub Codes"). */
const NOT_ADMITTED = new Set([
  "timeout_exceeded_waiting_room",
  "call_ended_by_platform_waiting_room_timeout",
  "bot_kicked_from_waiting_room",
]);
const REMOVED = new Set(["bot_kicked_from_call", "bot_received_leave_call"]);

export function mapRecallPayload(payload: unknown, interview: Interview): MeetingEvent[] {
  if (!isObj(payload)) return [];
  const event = str(payload.event);
  const data = isObj(payload.data) ? payload.data : {};
  const inner = isObj(data.data) ? data.data : {};
  const interviewId = interview.id;
  if (!event) return [];

  if (event === "transcript.data" || event === "transcript.partial_data") {
    const words = Array.isArray(inner.words) ? inner.words.filter(isObj) : [];
    const text = words.map((w) => str(w.text) ?? "").join(" ").replace(/\s+/g, " ").trim();
    if (!text) return [];

    const participant = isObj(inner.participant) ? inner.participant : {};
    const rel = (w: Json | undefined, k: "start_timestamp" | "end_timestamp") => {
      const t = w && isObj(w[k]) ? (w[k] as Json).relative : undefined;
      return typeof t === "number" ? Math.round(t * 1000) : undefined;
    };
    return [
      {
        type: "segment",
        segment: {
          interviewId,
          speakerId: participant.id !== undefined && participant.id !== null ? String(participant.id) : "unknown",
          speakerName: str(participant.name),
          role: roleFor(participant, interview.ownerEmail),
          text,
          isFinal: event === "transcript.data",
          startMs: rel(words[0], "start_timestamp") ?? 0,
          endMs: rel(words[words.length - 1], "end_timestamp"),
        },
      },
    ];
  }

  const sub = str(inner.sub_code);
  switch (event) {
    case "bot.in_waiting_room":
      return [{ type: "lobby_waiting", interviewId }];
    case "bot.in_call_not_recording":
    case "bot.in_call_recording":
      return [{ type: "admitted", interviewId }];
    case "bot.recording_permission_allowed":
      return [{ type: "recording_status", interviewId, ok: true }];
    case "bot.recording_permission_denied":
      return [{ type: "recording_status", interviewId, ok: false, detail: sub }];
    case "bot.call_ended": {
      const reason = sub && NOT_ADMITTED.has(sub) ? "not_admitted" : sub && REMOVED.has(sub) ? "removed" : "meeting_ended";
      return [{ type: "ended", interviewId, reason, detail: sub }];
    }
    case "bot.fatal":
      return [{ type: "ended", interviewId, reason: "error", detail: sub }];
    default:
      return []; // joining_call, done, breakout rooms, ...
  }
}

export type WebhookResult = { status: "ok"; events: number } | { status: "ignored"; reason: string };

/**
 * Handles one verified Recall webhook (real-time transcript events and bot status events share this endpoint).
 * Always returns normally for events we do not act on, so Recall gets a 2xx and does not retry.
 */
export async function handleRecallWebhook(
  payload: unknown,
  deps: { store: InterviewStore; transcripts?: TranscriptStore; onSegment?: SegmentHandler },
): Promise<WebhookResult> {
  const bot = isObj(payload) && isObj(payload.data) && isObj(payload.data.bot) ? payload.data.bot : undefined;
  const botId = str(bot?.id);
  const metaId = isObj(bot?.metadata) ? str((bot?.metadata as Json).interview_id) : undefined;

  // metadata first: it is present from the very first event, before our own bot-id bookkeeping could race it
  const interview =
    (metaId ? await deps.store.findById(metaId) : undefined) ?? (botId ? await deps.store.findByBotId(botId) : undefined);
  if (!interview) return { status: "ignored", reason: "unknown_interview" };

  // events from a bot that was replaced by a reschedule must not touch the new bot's interview state
  if (interview.recallBotId && botId && interview.recallBotId !== botId) return { status: "ignored", reason: "stale_bot" };

  const events = mapRecallPayload(payload, interview);
  if (events.length === 0) return { status: "ignored", reason: "event_not_used" };
  for (const e of events) await handleBotEvent(e, deps);
  return { status: "ok", events: events.length };
}
