import { useState } from "react";
import { coachView, type RoomState } from "../room";
import type { Problem, Question, ScoreOutput } from "../types";
import { ScoreBadge } from "./Score";
import { CopyButton, unquote } from "./ui";

const SIGNAL: Record<ScoreOutput["experience"]["signal"], { label: string; cls: string }> = {
  first_hand: { label: "Sounds first-hand", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  unclear: { label: "Experience unclear", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  generic: { label: "Sounds textbook, not first-hand", cls: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
};

/**
 * The live coach: sits above everything, reads at a glance, and updates on its own after every answer.
 * It says in plain words what was wrong and gives the next question to ask, so the interviewer never has to press anything.
 */
export function Coach({ state }: { state: RoomState }) {
  const v = coachView(state);
  const [more, setMore] = useState(false);

  if (v.phase === "idle") return <Shell tone="idle"><p className="text-sm muted">Coach is listening. After each answer it will say what was wrong and what to ask next.</p></Shell>;
  if (v.phase === "listening") return <Shell tone="idle"><p className="text-sm"><span className="font-medium">Listening to the answer…</span> <span className="muted">{v.question}</span></p></Shell>;
  if (v.phase === "short") return <Shell tone="idle"><p className="text-sm muted">Short reply to “{v.question}”. Nothing to assess yet.</p></Shell>;
  if (v.phase === "assessing") return <Shell tone="busy"><p className="flex items-center gap-2 text-sm"><span className="size-3 animate-spin rounded-full border-2 border-indigo-300 border-t-indigo-600" /> Assessing the answer to “{v.question}”…</p></Shell>;

  const o = v.score.output;
  const problems = o.problems;
  const shown = more ? problems : problems.slice(0, 1);
  const sig = SIGNAL[o.experience.signal];
  const tone = o.score <= 2 ? "bad" : o.score === 3 ? "warn" : "good";
  const ask = v.ask.slice(0, 3);

  return (
    <Shell tone={tone}>
      <div className="flex items-start gap-4">
        <ScoreBadge score={o.score} size="lg" />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <p className="text-xs muted">Answer to: {v.answer.questionText}</p>
            <p className="mt-1 text-base font-medium leading-snug">{o.verdict}</p>
            <p className="mt-2"><span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${sig.cls}`}>{sig.label}</span> {o.experience.signal !== "first_hand" && <span className="text-xs muted">{o.experience.evidence}</span>}</p>
          </div>

          {ask.length > 0 && (
            <div aria-label="Ask next" className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">Ask next</h3>
              {ask.map((q, i) => <AskRow key={q.id} q={q} primary={i === 0} />)}
            </div>
          )}
          {shown.length > 0 && (
            <ul className="space-y-2" aria-label="What was wrong">
              {shown.map((p, i) => <ProblemRow key={i} p={p} />)}
            </ul>
          )}
          {problems.length > 1 && <button type="button" className="text-xs text-indigo-600 hover:underline dark:text-indigo-400" onClick={() => setMore(!more)}>{more ? "Show fewer problems" : `Show ${problems.length - 1} more problem${problems.length - 1 > 1 ? "s" : ""}`}</button>}

        </div>
      </div>
      {v.suggestion && (
        <p className="mt-3 border-t border-zinc-200 pt-3 text-sm dark:border-zinc-800"><span className="text-xs font-semibold uppercase tracking-wide muted">{v.suggestion.auto ? "Suggestion" : "You asked for help"}</span><br />{v.suggestion.suggestion}</p>
      )}
    </Shell>
  );
}

function ProblemRow({ p }: { p: Problem }) {
  return (
    <li className="rounded-lg bg-white/60 p-3 text-sm dark:bg-black/20">
      <p><span className={`mr-2 rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase ${p.severity === "major" ? "bg-red-600 text-white" : "bg-amber-500 text-white"}`}>{p.severity}</span><span className="italic">“{unquote(p.quote)}”</span></p>
      <p className="mt-1"><span className="font-medium">Problem:</span> {p.issue}</p>
      <p className="mt-0.5 muted"><span className="font-medium">Correct:</span> {p.correction}</p>
    </li>
  );
}

function AskRow({ q, primary }: { q: Question; primary: boolean }) {
  const proof = q.why?.startsWith("Check they did the work");
  return (
    <div className={`flex items-start gap-2 rounded-lg border p-3 ${primary ? "border-indigo-300 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-950/40" : "border-zinc-200 dark:border-zinc-800"}`}>
      <div className="min-w-0 flex-1">
        {proof && <p className="text-[11px] font-semibold uppercase tracking-wide text-red-700 dark:text-red-400">Check they did the work</p>}
        <p className={primary ? "text-base font-medium leading-snug" : "text-sm leading-snug"}>{q.text}</p>
      </div>
      <CopyButton text={q.text} />
    </div>
  );
}

function Shell({ tone, children }: { tone: "idle" | "busy" | "good" | "warn" | "bad"; children: React.ReactNode }) {
  const cls = { idle: "border-zinc-200 dark:border-zinc-800", busy: "border-indigo-200 dark:border-indigo-900", good: "border-emerald-300 dark:border-emerald-900", warn: "border-amber-300 dark:border-amber-900", bad: "border-red-300 dark:border-red-900" }[tone];
  return <section aria-label="Coach" aria-live="polite" className={`card border-2 p-4 ${cls}`}>{children}</section>;
}
