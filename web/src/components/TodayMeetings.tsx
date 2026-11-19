import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, api } from "../api";
import { useAuth } from "../auth";
import type { InterviewSummary } from "../types";
import { ErrorNote, Spinner } from "./ui";

interface GraphEvent {
  id: string;
  subject?: string;
  start: { dateTime: string };
  end: { dateTime: string };
  isCancelled?: boolean;
  isOnlineMeeting?: boolean;
  onlineMeeting?: { joinUrl?: string } | null;
  location?: { displayName?: string };
  bodyPreview?: string;
}
interface Meeting { id: string; title: string; start: Date; end: Date; link: string }

const KEY = "calendar-connected";
const remembered = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};
const hhmm = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

async function loadToday(token: string): Promise<Meeting[]> {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + 24 * 3600_000);
  const q = new URLSearchParams({
    startDateTime: from.toISOString(),
    endDateTime: to.toISOString(),
    $select: "id,subject,start,end,isCancelled,isOnlineMeeting,onlineMeeting,location,bodyPreview",
    $orderby: "start/dateTime",
    $top: "50",
  });
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/calendarView?${q}`, { headers: { authorization: `Bearer ${token}`, prefer: 'outlook.timezone="UTC"' } });
  if (!res.ok) throw new Error(`Calendar request failed (${res.status})`);
  const body = (await res.json()) as { value: GraphEvent[] };
  return body.value
    .filter((e) => !e.isCancelled)
    .map((e) => ({
      id: e.id,
      title: e.subject || "(no title)",
      start: new Date(`${e.start.dateTime}Z`),
      end: new Date(`${e.end.dateTime}Z`),
      // Teams puts the join link in onlineMeeting; Zoom and Meet usually live in the location or the invite text.
      link: [e.onlineMeeting?.joinUrl, e.location?.displayName, e.bodyPreview].filter(Boolean).join(" "),
    }))
    .filter((m) => /https?:\/\//.test(m.link));
}

/** Today's calendar, with a button to send the assistant into any of those meetings, including one that is already running. */
export function TodayMeetings() {
  const { calendarToken } = useAuth();
  const nav = useNavigate();
  const [meetings, setMeetings] = useState<Meeting[]>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!calendarToken) return;
    setLoading(true);
    setError(undefined);
    try {
      setMeetings(await loadToday(await calendarToken()));
      try {
        localStorage.setItem(KEY, "1");
      } catch {
        /* optional */
      }
    } catch (e) {
      setError((e as { errorCode?: string }).errorCode === "user_cancelled" ? undefined : e instanceof Error ? e.message : "Could not read your calendar.");
    } finally {
      setLoading(false);
    }
  }, [calendarToken]);

  // Once the person has allowed it, load without asking again (silent; if a prompt would be needed they click the button).
  useEffect(() => {
    if (remembered()) void load();
  }, [load]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const add = async (m: Meeting) => {
    setBusy(m.id);
    setError(undefined);
    try {
      const i = await api<InterviewSummary>("/api/me/interviews/join", { method: "POST", body: { link: m.link, startsAt: m.start.toISOString() } });
      nav(`/i/${i.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not add the assistant.");
      setBusy(undefined);
    }
  };

  if (!calendarToken) return null; // no Microsoft sign-in in this build

  return (
    <section aria-label="Today's meetings" className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">Today's meetings</h2>
        {meetings && <button type="button" className="btn-ghost !py-1 text-xs" onClick={load} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {!meetings && !loading && (
        <div className="card flex flex-wrap items-center gap-3 p-4">
          <p className="text-sm muted">Show today's calendar here and add the assistant to a meeting with one click. We only read your calendar.</p>
          <button type="button" className="btn-primary ml-auto" onClick={load}>Show my meetings</button>
        </div>
      )}
      {loading && !meetings && <Spinner />}
      {meetings && meetings.length === 0 && <p className="text-sm muted">No online meetings on your calendar today.</p>}
      <ul className="space-y-2">
        {meetings?.map((m) => {
          const over = m.end.getTime() < now;
          const live = m.start.getTime() <= now && !over;
          return (
            <li key={m.id} className={`card flex flex-wrap items-center gap-3 p-3 ${over ? "opacity-60" : ""}`}>
              <span className="w-28 shrink-0 text-sm tabular-nums muted">{hhmm(m.start)} – {hhmm(m.end)}</span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{m.title}</span>
              {live && <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">Happening now</span>}
              {!over && <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => add(m)} disabled={busy !== undefined}>{busy === m.id ? "Adding…" : live ? "Join now" : "Add assistant"}</button>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
