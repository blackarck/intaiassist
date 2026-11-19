import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, api } from "../api";
import { ErrorNote, Spinner, StatusBadge, when } from "../components/ui";
import { TodayMeetings } from "../components/TodayMeetings";
import { useInterviews } from "../hooks";
import type { InterviewSummary } from "../types";

export function InterviewsPage() {
  const { data, error, loading, reload } = useInterviews();
  const nav = useNavigate();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string>();

  const create = async () => {
    setCreating(true);
    setCreateError(undefined);
    try {
      nav(`/i/${(await api<InterviewSummary>("/api/me/interviews", { method: "POST", body: {} })).id}`);
    } catch (e) {
      setCreateError(e instanceof ApiError ? e.message : "Could not create the interview.");
      setCreating(false);
    }
  };

  const remove = async (i: InterviewSummary) => {
    const note = i.status === "ended" ? " Its transcript and scores are deleted too." : "";
    if (!window.confirm(`Delete ${i.address}?${note} This cannot be undone.`)) return;
    try {
      await api(`/api/interviews/${i.id}`, { method: "DELETE" });
      reload();
    } catch (e) {
      setCreateError(e instanceof ApiError ? e.message : "Could not delete the interview.");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Interviews</h1>
          <p className="text-sm muted">Create one, add its address to your meeting invite, and the assistant joins the call.</p>
        </div>
        <button className="btn-primary" onClick={create} disabled={creating}>{creating ? "Creating…" : "New interview"}</button>
      </div>
      <TodayMeetings />
      {createError && <ErrorNote>{createError}</ErrorNote>}
      <h2 className="text-lg font-semibold tracking-tight">Your interviews</h2>
      {loading && <Spinner />}
      {error && <ErrorNote>{error}</ErrorNote>}
      {data && data.interviews.length === 0 && (
        <div className="card p-8 text-center">
          <p className="font-medium">No interviews yet</p>
          <p className="mt-1 text-sm muted">Start with “New interview”. You will get an address to add to your calendar invite.</p>
        </div>
      )}
      <ul className="space-y-3">
        {data?.interviews.map((i) => (
          <li key={i.id} className="card flex items-center gap-2 transition hover:border-indigo-400">
            <Link to={`/i/${i.id}`} className="flex min-w-0 flex-1 flex-wrap items-center gap-3 p-4">
              <StatusBadge status={i.status} />
              <span className="font-mono text-sm">{i.address}</span>
              <span className="ml-auto text-xs muted">{i.startsAt ? `Starts ${when(i.startsAt)}` : when(i.createdAt)}</span>
            </Link>
            <button type="button" className="btn-ghost mr-3 !px-2.5 !py-1 text-xs !text-red-600" onClick={() => remove(i)} aria-label={`Delete ${i.address}`}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
