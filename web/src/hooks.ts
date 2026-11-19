import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ApiError, api, followRoom } from "./api";
import { applyEvent, emptyRoom, fromSnapshot, type RoomState } from "./room";
import type { InterviewSummary, Me, RoomEvent, Snapshot } from "./types";

/** Loads once, exposes data/error/reload. */
export function useLoad<T>(path: string | undefined) {
  const [state, set] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: !!path });
  const load = useCallback(async () => {
    if (!path) return;
    try {
      set((s) => ({ ...s, loading: true }));
      set({ data: await api<T>(path), loading: false });
    } catch (e) {
      set({ error: e instanceof ApiError ? e.message : "Could not load", loading: false });
    }
  }, [path]);
  useEffect(() => void load(), [load]);
  return { ...state, reload: load };
}

export const useMe = () => useLoad<Me>("/api/me");
export const useInterviews = () => useLoad<{ interviews: InterviewSummary[] }>("/api/me/interviews");
export const useInterview = (id: string) => useLoad<InterviewSummary>(`/api/interviews/${id}`);

type Action = { kind: "snapshot"; snap: Snapshot } | { kind: "event"; e: RoomEvent };
const reduce = (s: RoomState, a: Action): RoomState => (a.kind === "snapshot" ? fromSnapshot(a.snap) : applyEvent(s, a.e));

/** The live room: snapshot first, then the event stream from where the snapshot ended. */
export function useRoom(id: string) {
  const [state, dispatch] = useReducer(reduce, emptyRoom);
  const [connection, setConnection] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const [error, setError] = useState<string>();
  const started = useRef(false);

  useEffect(() => {
    const ctl = new AbortController();
    started.current = false;
    (async () => {
      try {
        const snap = await api<Snapshot>(`/api/interviews/${id}/room`);
        dispatch({ kind: "snapshot", snap });
        started.current = true;
        await followRoom(id, snap.lastSeq, (e) => dispatch({ kind: "event", e }), setConnection, ctl.signal);
      } catch (e) {
        if (!ctl.signal.aborted) setError(e instanceof ApiError ? e.message : "Could not open the room");
      }
    })();
    return () => ctl.abort();
  }, [id]);

  return { state, connection, error };
}
