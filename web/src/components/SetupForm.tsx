import { useEffect, useState } from "react";
import { ApiError, api } from "../api";
import type { Question } from "../types";
import { SupportNote } from "./Support";
import { ErrorNote } from "./ui";

interface Preset { text: string; keyPoints: string }

const LEVELS = ["", "junior", "mid", "senior", "staff / principal", "manager"];

/** What the interviewer tells us before the call: the role, the JD, the resume, and any questions they already plan to ask. */
export function SetupForm({ id, onSaved }: { id: string; onSaved: () => void }) {
  const [roleTitle, setRoleTitle] = useState("");
  const [roleLevel, setRoleLevel] = useState("");
  const [jd, setJd] = useState("");
  const [resume, setResume] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const [presets, setPresets] = useState<Preset[]>([{ text: "", keyPoints: "" }]);
  const [busy, setBusy] = useState<"save" | "suggest" | undefined>();
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [suggested, setSuggested] = useState<Question[]>([]);

  // Come back to what was saved before.
  useEffect(() => {
    api<{ setup: { aiModel?: string; roleTitle: string; roleLevel?: string; jd: string; resumeSummary?: string; presetQuestions: { text: string; keyPoints?: string[] }[] } | null }>(`/api/interviews/${id}/setup`)
      .then(({ setup }) => {
        if (!setup) return;
        setRoleTitle(setup.roleTitle);
        setRoleLevel(setup.roleLevel ?? "");
        setJd(setup.jd);
        setResume(setup.resumeSummary ?? "");
        setAiModel(setup.aiModel ?? "");
        setPresets(setup.presetQuestions.length ? setup.presetQuestions.map((p) => ({ text: p.text, keyPoints: (p.keyPoints ?? []).join("\n") })) : [{ text: "", keyPoints: "" }]);
      })
      .catch(() => undefined); // an empty form is a fine fallback
  }, [id]);

  // The models this server can actually use (providers with credentials). Empty = only the automatic choice.
  useEffect(() => {
    api<{ models: { id: string; label: string }[] }>("/api/me/ai-models").then((r) => setModels(r.models)).catch(() => undefined);
  }, []);

  const body = () => ({
    aiModel: aiModel || undefined,
    roleTitle: roleTitle.trim(),
    roleLevel: roleLevel || undefined,
    jd: jd.trim(),
    resumeSummary: resume.trim() || undefined,
    presetQuestions: presets
      .filter((p) => p.text.trim())
      .map((p) => ({ text: p.text.trim(), keyPoints: p.keyPoints.split("\n").map((k) => k.trim()).filter(Boolean) })),
  });

  const save = async (): Promise<boolean> => {
    if (!roleTitle.trim() || !jd.trim()) {
      setMsg({ ok: false, text: "Add the role title and the job description." });
      return false;
    }
    try {
      await api(`/api/interviews/${id}/setup`, { method: "PUT", body: body() });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof ApiError ? e.message : "Could not save." });
      return false;
    }
  };

  return (
    <form
      className="space-y-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy("save");
        setMsg(undefined);
        if (await save()) {
          setMsg({ ok: true, text: "Saved. Your questions are ready in the room." });
          onSaved();
        }
        setBusy(undefined);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
        <div>
          <label className="label" htmlFor="role">Role</label>
          <input id="role" className="input" value={roleTitle} onChange={(e) => setRoleTitle(e.target.value)} placeholder="Backend Engineer" maxLength={120} />
        </div>
        <div>
          <label className="label" htmlFor="level">Level</label>
          <select id="level" className="input" value={roleLevel} onChange={(e) => setRoleLevel(e.target.value)}>
            {LEVELS.map((l) => <option key={l} value={l}>{l || "Not specified"}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="label" htmlFor="jd">Job description</label>
        <textarea id="jd" className="input min-h-32" value={jd} onChange={(e) => setJd(e.target.value)} placeholder="Paste the job description" maxLength={20000} />
      </div>
      <div>
        <label className="label" htmlFor="resume">Candidate resume <span className="normal-case muted">(paste the text; optional)</span></label>
        <textarea id="resume" className="input min-h-32" value={resume} onChange={(e) => setResume(e.target.value)} placeholder="Paste the candidate's resume or a summary" maxLength={20000} />
      </div>

      {models.length > 0 && (
        <div>
          <label className="label" htmlFor="ai-model">AI model <span className="normal-case muted">(optional)</span></label>
          <select id="ai-model" className="input" value={aiModel} onChange={(e) => setAiModel(e.target.value)}>
            <option value="">Automatic (recommended)</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <p className="mt-1 text-xs muted">Used to assess answers and suggest questions in this interview. Automatic picks the best model for each job; if your choice is unavailable or too slow, it falls back to the automatic choice.</p>
        </div>
      )}

      <fieldset className="space-y-3">
        <legend className="label">Questions you plan to ask</legend>
        {presets.map((p, i) => (
          <div key={i} className="card space-y-2 p-3">
            <input className="input" aria-label={`Question ${i + 1}`} value={p.text} onChange={(e) => setPresets(presets.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} placeholder="Tell me about a production incident you handled" maxLength={600} />
            <textarea className="input min-h-16" aria-label={`Key points for question ${i + 1}`} value={p.keyPoints} onChange={(e) => setPresets(presets.map((x, j) => (j === i ? { ...x, keyPoints: e.target.value } : x)))} placeholder="What a good answer covers, one per line (optional)" />
            {presets.length > 1 && <button type="button" className="text-xs text-red-600 hover:underline" onClick={() => setPresets(presets.filter((_, j) => j !== i))}>Remove</button>}
          </div>
        ))}
        {presets.length < 20 && <button type="button" className="btn-ghost" onClick={() => setPresets([...presets, { text: "", keyPoints: "" }])}>Add a question</button>}
      </fieldset>

      {msg && (msg.ok ? <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{msg.text}</p> : <ErrorNote>{msg.text}</ErrorNote>)}

      <div className="flex flex-wrap gap-2">
        <button className="btn-primary" disabled={!!busy}>{busy === "save" ? "Saving…" : "Save"}</button>
        <button
          type="button"
          className="btn-ghost"
          disabled={!!busy}
          onClick={async () => {
            setBusy("suggest");
            setMsg(undefined);
            if (await save()) {
              try {
                const r = await api<{ items: Question[] }>(`/api/interviews/${id}/room/opening-questions`, { method: "POST", body: { count: 6 } });
                setSuggested(r.items);
                onSaved();
              } catch {
                setMsg({ ok: false, text: "Could not generate questions right now." });
              }
            }
            setBusy(undefined);
          }}
        >
          {busy === "suggest" ? "Thinking…" : "Suggest more questions"}
        </button>
      </div>

      <SupportNote />

      {suggested.length > 0 && (
        <section aria-label="Suggested questions" className="space-y-2">
          <h3 className="text-sm font-semibold">Suggested for this role and candidate</h3>
          <p className="text-xs muted">They are already in your room under "Up next".</p>
          <ul className="space-y-2">{suggested.map((q) => <li key={q.id} className="card p-3 text-sm"><p className="font-medium">{q.text}</p>{q.why && <p className="mt-1 text-xs muted">{q.why}</p>}</li>)}</ul>
        </section>
      )}
    </form>
  );
}
