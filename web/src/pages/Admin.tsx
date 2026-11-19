import { useEffect, useState } from "react";
import { ApiError, api } from "../api";
import { ErrorNote, Spinner } from "../components/ui";
import { useLoad, useMe } from "../hooks";

interface Model { id: string; label: string; provider: string }
interface TaskCfg { enabled: boolean; primary: string; fallback: string; timeoutMs: number; deadlineMs: number; maxOutputTokens: number }
interface Config { models: Model[]; tasks: Record<string, TaskCfg>; overrides: Record<string, Partial<TaskCfg>> }
interface Run { at: string; task: string; model?: string; ok: boolean; outcome: string; inputTokens: number; outputTokens: number; ms: number; interviewId?: string }

const TASK_HELP: Record<string, string> = {
  opening_questions: "Extra questions from the JD and resume (once, at setup)",
  live_coach: "The coach: how the answer stands and 2-3 questions to ask, refreshed while the candidate talks (live, fast)",
  assist: "“Assist me” suggestion (live, fast)",
  score_answer: "Score for each answer (background)",
  scorecard: "End-of-interview summary (background)",
};

export function AdminPage() {
  const cfg = useLoad<Config>("/api/admin/ai/config");
  const me = useMe();
  const runs = useLoad<{ runs: Run[] }>("/api/admin/ai/runs?limit=40");
  if (cfg.loading && !cfg.data) return <Spinner />;
  if (cfg.error === "forbidden")
    return (
      <div className="space-y-2">
        <ErrorNote>You do not have access to this page.</ErrorNote>
        {me.data && <p className="text-sm muted">To be made an admin, give the operator your account id: <code className="select-all rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">{me.data.subject}</code></p>}
      </div>
    );
  if (cfg.error) return <ErrorNote>{cfg.error}</ErrorNote>;
  if (!cfg.data) return null;
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">AI settings</h1>
        <p className="text-sm muted">Which model answers each step, with a fallback if it fails. Changes apply to the next call.</p>
      </div>
      <div className="space-y-4">
        {Object.entries(cfg.data.tasks).map(([task, c]) => <TaskRow key={task} task={task} cfg={c} models={cfg.data!.models} overridden={!!cfg.data!.overrides[task]} onChanged={() => { void cfg.reload(); void runs.reload(); }} />)}
      </div>
      <section aria-label="Recent runs" className="space-y-2">
        <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Recent calls</h2><button className="btn-ghost" onClick={runs.reload}>Refresh</button></div>
        <p className="text-xs muted">Only what ran and how it went. No interview content is stored here.</p>
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-xs uppercase muted dark:border-zinc-800"><tr><th className="p-2.5">When</th><th>Step</th><th>Model</th><th>Result</th><th className="text-right">Tokens in/out</th><th className="pr-3 text-right">Time</th></tr></thead>
            <tbody>
              {runs.data?.runs.length === 0 && <tr><td colSpan={6} className="p-4 muted">Nothing yet.</td></tr>}
              {runs.data?.runs.map((r, i) => (
                <tr key={i} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                  <td className="p-2.5 whitespace-nowrap">{new Date(r.at).toLocaleTimeString()}</td><td>{r.task}</td><td>{r.model ?? "-"}</td>
                  <td><span className={r.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-600"}>{r.outcome}</span></td>
                  <td className="text-right tabular-nums">{r.inputTokens}/{r.outputTokens}</td><td className="pr-3 text-right tabular-nums">{(r.ms / 1000).toFixed(1)} s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function TaskRow({ task, cfg, models, overridden, onChanged }: { task: string; cfg: TaskCfg; models: Model[]; overridden: boolean; onChanged: () => void }) {
  const [draft, setDraft] = useState(cfg);
  useEffect(() => setDraft(cfg), [cfg]); // follow saves and resets
  const [busy, setBusy] = useState<"save" | "test" | "reset" | undefined>();
  const [note, setNote] = useState<{ ok: boolean; text: string }>();
  const dirty = JSON.stringify(draft) !== JSON.stringify(cfg);
  const set = <K extends keyof TaskCfg>(k: K, v: TaskCfg[K]) => setDraft({ ...draft, [k]: v });
  const fail = (e: unknown) => setNote({ ok: false, text: e instanceof ApiError ? e.message : "Failed." });

  return (
    <section className="card space-y-3 p-4" aria-label={task}>
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h2 className="font-mono text-sm font-semibold">{task}{overridden && <span className="ml-2 rounded bg-indigo-100 px-1.5 py-0.5 font-sans text-[11px] font-medium text-indigo-700 dark:bg-indigo-900 dark:text-indigo-200">customised</span>}</h2>
          <p className="text-xs muted">{TASK_HELP[task]}</p>
        </div>
        <label className="ml-auto flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={(e) => set("enabled", e.target.checked)} /> Enabled</label>
      </header>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Sel label="Primary model" value={draft.primary} models={models} onChange={(v) => set("primary", v)} />
        <Sel label="Fallback model" value={draft.fallback} models={models} onChange={(v) => set("fallback", v)} />
        <Num label="Timeout per try (ms)" value={draft.timeoutMs} onChange={(v) => set("timeoutMs", v)} />
        <Num label="Deadline overall (ms)" value={draft.deadlineMs} onChange={(v) => set("deadlineMs", v)} />
        <Num label="Max output tokens" value={draft.maxOutputTokens} onChange={(v) => set("maxOutputTokens", v)} />
      </div>
      {note && (note.ok ? <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{note.text}</p> : <ErrorNote>{note.text}</ErrorNote>)}
      <div className="flex flex-wrap gap-2">
        <button className="btn-primary" disabled={!dirty || !!busy} onClick={async () => { setBusy("save"); setNote(undefined); try { await api(`/api/admin/ai/config/${task}`, { method: "PUT", body: draft }); setNote({ ok: true, text: "Saved." }); onChanged(); } catch (e) { fail(e); } setBusy(undefined); }}>{busy === "save" ? "Saving…" : "Save"}</button>
        <button className="btn-ghost" disabled={!!busy} onClick={async () => { setBusy("test"); setNote(undefined); try { const r = await api<{ ok: boolean; model?: string; ms: number; error?: { code: string } }>(`/api/admin/ai/test/${task}`, { method: "POST", body: {} }); setNote(r.ok ? { ok: true, text: `Works: ${r.model} answered in ${(r.ms / 1000).toFixed(1)} s (using saved settings).` } : { ok: false, text: `Failed: ${r.error?.code}` }); onChanged(); } catch (e) { fail(e); } setBusy(undefined); }}>{busy === "test" ? "Testing…" : "Test"}</button>
        {overridden && <button className="btn-ghost" disabled={!!busy} onClick={async () => { setBusy("reset"); try { await api(`/api/admin/ai/config/${task}`, { method: "DELETE" }); onChanged(); setNote({ ok: true, text: "Back to defaults." }); } catch (e) { fail(e); } setBusy(undefined); }}>Reset to defaults</button>}
      </div>
    </section>
  );
}

function Sel({ label, value, models, onChange }: { label: string; value: string; models: Model[]; onChange: (v: string) => void }) {
  return (
    <label className="block"><span className="label">{label}</span>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {models.map((m) => <option key={m.id} value={m.id}>{m.label} ({m.provider})</option>)}
      </select>
    </label>
  );
}
function Num({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return <label className="block"><span className="label">{label}</span><input className="input" type="number" value={value} min={16} onChange={(e) => onChange(Number(e.target.value))} /></label>;
}
