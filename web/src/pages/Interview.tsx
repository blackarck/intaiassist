import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Room } from "../components/Room";
import { SetupForm } from "../components/SetupForm";
import { CopyButton, ErrorNote, Spinner, StatusBadge, when } from "../components/ui";
import { api } from "../api";
import { useInterview } from "../hooks";

export function InterviewPage() {
  const { id = "" } = useParams();
  const { data: iv, error, loading, reload } = useInterview(id);
  const [tab, setTab] = useState<"prepare" | "room">("prepare");
  const [liveStatus, setLiveStatus] = useState<string>();
  const nav = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const remove = async () => {
    if (!window.confirm("Delete this interview and its transcript? This cannot be undone.")) return;
    setDeleting(true);
    try {
      await api(`/api/interviews/${id}`, { method: "DELETE" });
      nav("/");
    } catch {
      setDeleting(false);
      window.alert("Could not delete the interview.");
    }
  };

  // Once the call is on, the room is what you want to see.
  useEffect(() => {
    if (iv && ["in_meeting", "joining", "ended"].includes(iv.status)) setTab("room");
  }, [iv?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  // The invite status changes while you wait (bot scheduled, in the lobby...). Poll lightly until the room takes over.
  useEffect(() => {
    if (!iv || tab === "room") return;
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, [iv, tab, reload]);

  // Once the call is on, the screen belongs to the coach: the invite instructions shrink to one line.
  const live = ["in_meeting", "ended"].includes(liveStatus ?? iv?.status ?? "");

  if (loading && !iv) return <Spinner />;
  if (error || !iv) return <div className="space-y-3"><ErrorNote>{error ?? "Interview not found."}</ErrorNote><Link to="/" className="text-sm text-indigo-600 hover:underline">Back to interviews</Link></div>;

  // Once it is over nothing can be changed: show what was recorded, and nothing to edit.
  const finished = (liveStatus ?? iv.status) === "ended";

  return (
    <div className="space-y-5">
      <div>
        <Link to="/" className="text-sm muted hover:underline">← Interviews</Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Interview</h1>
          <StatusBadge status={liveStatus ?? iv.status} />
          {iv.startsAt && <span className="text-sm muted">{finished ? "Started" : "Starts"} {when(iv.startsAt)}</span>}
          <button type="button" className="btn-ghost ml-auto !text-red-600" onClick={remove} disabled={deleting}>{deleting ? "Deleting…" : "Delete"}</button>
        </div>
      </div>

      {live ? (
        <p className="text-sm muted">Invite address: <code className="select-all font-mono">{iv.address}</code></p>
      ) : (
      <section aria-label="Invite address" className="card space-y-2 p-4">
        <p className="text-sm font-medium">Add this address to your meeting invite</p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="select-all rounded-md bg-zinc-100 px-2.5 py-1.5 font-mono text-sm dark:bg-zinc-800">{iv.address}</code>
          <CopyButton text={iv.address} label="Copy address" />
        </div>
        <p className="text-xs muted">Invite it like any attendee from Teams, Zoom or Google Calendar. The assistant joins a minute before the start. In Teams, admit it from the lobby. It listens only; it never speaks in the meeting.</p>
        {iv.recording?.ok === false && <ErrorNote>Recording was not permitted in this meeting, so no transcript is possible ({iv.recording.detail}).</ErrorNote>}
      </section>
      )}

      {!finished && <div className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800" role="tablist">
        {(["prepare", "room"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium capitalize ${tab === t ? "border-indigo-600 text-indigo-700 dark:text-indigo-300" : "border-transparent muted hover:text-zinc-900 dark:hover:text-zinc-100"}`}>{t === "room" ? "Live room" : "Prepare"}</button>
        ))}
      </div>}

      {finished ? <Room id={id} status="ended" onStatus={setLiveStatus} readOnly /> : tab === "prepare" ? <SetupForm id={id} onSaved={() => undefined} /> : <Room id={id} status={iv.status} onStatus={setLiveStatus} />}
    </div>
  );
}
