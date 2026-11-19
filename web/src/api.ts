import { config } from "./config";
import { createSseParser } from "./sse";
import type { RoomEvent } from "./types";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Returns the full Authorization header value for the signed-in person. Set by the auth provider. */
let authHeader: () => Promise<string> = async () => {
  throw new ApiError(401, "not signed in");
};
export const setAuthHeader = (fn: () => Promise<string>) => {
  authHeader = fn;
};

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${config.apiUrl}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { authorization: await authHeader(), ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const j = json as { error?: string | { message?: string } } | undefined;
    const msg = typeof j?.error === "string" ? j.error : j?.error?.message ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return json as T;
}

/**
 * Follows an interview's live feed until `signal` aborts. Uses fetch (not EventSource) so it can send the sign-in token as a
 * header. Reconnects with a short backoff and resumes from the last event id, so a dropped connection loses nothing.
 */
export async function followRoom(id: string, afterSeq: number, onEvent: (e: RoomEvent) => void, onState: (s: "connecting" | "live" | "reconnecting") => void, signal: AbortSignal) {
  let last = afterSeq;
  let delay = 500;
  while (!signal.aborted) {
    try {
      onState(last === afterSeq && delay === 500 ? "connecting" : "reconnecting");
      const res = await fetch(`${config.apiUrl}/api/interviews/${id}/live`, { headers: { authorization: await authHeader(), "last-event-id": String(last), accept: "text/event-stream" }, signal });
      if (res.status === 401 || res.status === 404) throw new ApiError(res.status, "not allowed");
      if (!res.ok || !res.body) throw new Error(`stream failed (${res.status})`);
      onState("live");
      delay = 500;
      const parse = createSseParser();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const e of parse(dec.decode(value, { stream: true }))) {
          if (e.seq !== undefined) last = Math.max(last, e.seq);
          onEvent(e);
        }
      }
    } catch (e) {
      if (signal.aborted) return;
      if (e instanceof ApiError) throw e;
    }
    onState("reconnecting");
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 8000);
  }
}
