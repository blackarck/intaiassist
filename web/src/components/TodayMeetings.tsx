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
interface Meeting { id: string; title: string; start: Date; end: Date; link: string; joinable?: boolean }

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
    .map((m) => ({ ...m, joinable: /https?:\/\//.test(m.link) }));
}

const HOUR_PX = 64;
const MIN_BLOCK_PX = 28;
const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: "numeric" });
const mins = (d: Date) => d.getHours() * 60 + d.getMinutes();

/** Side-by-side columns for events that overlap in time (like a normal calendar). */
function layout(list: Meeting[]) {
  const sorted = [...list].sort((a, b) => a.start.getTime() - b.start.getTime() || b.end.getTime() - a.end.getTime());
  const out = new Map<string, { col: number; cols: number }>();
  let group: Meeting[] = [];
  let groupEnd = 0;
  const flush = () => {
    const colEnds: number[] = [];
    const placed = group.map((m) => {
      let c = colEnds.findIndex((e) => e <= m.start.getTime());
      if (c === -1) c = colEnds.length;
      colEnds[c] = Math.max(m.end.getTime(), m.start.getTime() + (MIN_BLOCK_PX / HOUR_PX) * 3600_000);
      return { id: m.id, col: c };
    });
    placed.forEach((p) => out.set(p.id, { col: p.col, cols: colEnds.length }));
    group = [];
  };
  for (const m of sorted) {
    if (group.length && m.start.getTime() >= groupEnd) flush();
    group.push(m);
    groupEnd = Math.max(groupEnd, m.end.getTime());
  }
  if (group.length) flush();
  return out;
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

  const today = new Date(now);
  const dateLabel = today.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const timeLabel = today.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  const list = meetings ?? [];
  const startHour = Math.min(8, ...list.map((m) => m.start.getHours()));
  const endHour = Math.min(24, Math.max(19, ...list.map((m) => Math.ceil(mins(m.end) / 60) || 24)));
  const hours = Array.from({ length: endHour - startHour + 1 }, (_, k) => startHour + k);
  const cols = layout(list);
  const nowMin = mins(today);
  const showNow = nowMin >= startHour * 60 && nowMin <= endHour * 60;
  const top = (m: number) => ((m - startHour * 60) / 60) * HOUR_PX;

  return (
    <section aria-label="Today's meetings" className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-2.5">
          <h2 className="text-lg font-semibold tracking-tight">Today</h2>
          <span className="text-xs tabular-nums text-zinc-400 dark:text-zinc-500">{dateLabel} · {timeLabel}</span>
        </div>
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
      {meetings && meetings.length === 0 && <p className="text-sm muted">Nothing on your calendar today.</p>}
      {meetings && meetings.length > 0 && (
        <div className="card overflow-hidden">
          <div className="max-h-[34rem] overflow-y-auto">
            <div className="relative" style={{ height: (endHour - startHour) * HOUR_PX + 24 }}>
              {hours.map((h) => (
                <div key={h} className="absolute inset-x-0" style={{ top: top(h * 60) + 12 }}>
                  <span className="absolute -top-2 left-0 w-14 pr-2 text-right text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">{hourLabel(h)}</span>
                  <div className="ml-16 border-t border-zinc-100 dark:border-zinc-800" />
                </div>
              ))}
              <div className="absolute inset-y-0 right-3 left-[4.5rem]">
                {list.map((m) => {
                  const over = m.end.getTime() < now;
                  const live = m.start.getTime() <= now && !over;
                  const pos = cols.get(m.id) ?? { col: 0, cols: 1 };
                  const h = Math.max(((mins(m.end) - mins(m.start)) / 60) * HOUR_PX, MIN_BLOCK_PX);
                  const compact = h < 52;
                  const tone = live
                    ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/60"
                    : over
                      ? "border-zinc-300 bg-zinc-100/70 opacity-60 dark:border-zinc-700 dark:bg-zinc-800/50"
                      : "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/60";
                  return (
                    <div
                      key={m.id}
                      className={`absolute overflow-hidden rounded-md border-l-[3px] px-2.5 ${compact ? "flex items-center gap-2 py-0" : "py-1.5"} ${tone}`}
                      style={{ top: top(mins(m.start)) + 12 + 1, height: h - 2, left: `${(pos.col / pos.cols) * 100}%`, width: `calc(${100 / pos.cols}% - 4px)` }}
                    >
                      <div className="min-w-0 flex-1">
                        <div className={`truncate text-[13px] font-medium leading-tight ${compact ? "inline" : ""}`}>{m.title}</div>
                        <div className={`truncate text-[11px] tabular-nums muted ${compact ? "ml-2 inline" : "mt-0.5"}`}>{hhmm(m.start)} – {hhmm(m.end)}</div>
                      </div>
                      {live && <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-800 dark:bg-emerald-900 dark:text-emerald-300">Now</span>}
                      {!over && m.joinable && (
                        <button type="button" className={`btn-primary shrink-0 !rounded-md !px-2.5 !py-0.5 text-[11px] ${compact ? "" : "absolute right-2 bottom-1.5"}`} onClick={() => add(m)} disabled={busy !== undefined}>
                          {busy === m.id ? "Adding…" : live ? "Join now" : "Add assistant"}
                        </button>
                      )}
                    </div>
                  );
                })}
                {showNow && (
                  <div className="pointer-events-none absolute inset-x-0 z-10 flex items-center" style={{ top: top(nowMin) + 12 }}>
                    <span className="-ml-1 h-2 w-2 rounded-full bg-red-500" />
                    <span className="h-px flex-1 bg-red-500" />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
