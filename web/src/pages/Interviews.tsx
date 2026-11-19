import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, api } from "../api";
import { ErrorNote, Spinner, StatusBadge, when } from "../components/ui";
import { useInterviews } from "../hooks";
import type { InterviewSummary } from "../types";

export function InterviewsPage() {
  const { data, error, loading } = useInterviews();
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Interviews</h1>
          <p className="text-sm muted">Create one, add its address to your meeting invite, and the assistant joins the call.</p>
        </div>
        <button className="btn-primary" onClick={create} disabled={creating}>{creating ? "Creating…" : "New interview"}</button>
      </div>
      {createError && <ErrorNote>{createError}</ErrorNote>}
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
          <li key={i.id}>
            <Link to={`/i/${i.id}`} className="card flex flex-wrap items-center gap-3 p-4 transition hover:border-indigo-400">
              <StatusBadge status={i.status} />
              <span className="font-mono text-sm">{i.address}</span>
              <span className="ml-auto text-xs muted">{i.startsAt ? `Starts ${when(i.startsAt)}` : when(i.createdAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
