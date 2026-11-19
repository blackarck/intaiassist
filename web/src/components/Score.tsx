import type { Answer, Score } from "../types";
import { unquote } from "./ui";

const TONE = ["", "bg-red-500", "bg-orange-500", "bg-amber-500", "bg-lime-600", "bg-emerald-600"];
const DIMS: [keyof Score["output"]["dimensions"], string][] = [
  ["technicalCorrectness", "Correctness"],
  ["depth", "Depth"],
  ["clarity", "Clarity"],
  ["relevance", "Relevance"],
];

export function ScoreBadge({ score, size = "md" }: { score: number; size?: "md" | "lg" }) {
  return (
    <span aria-label={`Score ${score} out of 5`} className={`inline-flex shrink-0 items-center justify-center rounded-lg font-semibold text-white ${TONE[Math.round(score)] ?? "bg-zinc-500"} ${size === "lg" ? "size-12 text-xl" : "size-9 text-base"}`}>
      {Number.isInteger(score) ? score : score.toFixed(1)}
    </span>
  );
}

const CONF: Record<string, string> = { low: "Low confidence", medium: "Medium confidence", high: "High confidence" };

/** One answer with its score, the way the interviewer reads it: number first, then why. */
export function AnswerCard({ answer, score }: { answer: Answer; score?: Score }) {
  const words = answer.text.trim().split(/\s+/).length;
  const o = score?.output;
  return (
    <article className="card space-y-3 p-4" aria-live="polite">
      <header className="flex items-start gap-3">
        {o ? <ScoreBadge score={o.score} /> : <span className="size-9 shrink-0 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700" aria-hidden />}
        <div className="min-w-0">
          <p className="text-sm font-medium leading-snug">{answer.questionText}</p>
          <p className="mt-0.5 text-xs muted">
            {answer.state === "open" ? "Listening…" : o ? `${CONF[o.confidence]}${score && score.version > 1 ? ` · revised (v${score.version})` : ""}` : words < 8 ? "Too short to score" : "Scoring…"}
          </p>
        </div>
      </header>
      <p className="line-clamp-3 text-sm muted">{answer.text}</p>
      {o && (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {DIMS.map(([k, label]) => (
              <div key={k}>
                <dt className="flex justify-between text-xs muted"><span>{label}</span><span>{o.dimensions[k]}/5</span></dt>
                <dd className="mt-0.5 h-1.5 rounded-full bg-zinc-200 dark:bg-zinc-800"><div className={`h-full rounded-full ${TONE[o.dimensions[k]]}`} style={{ width: `${o.dimensions[k] * 20}%` }} /></dd>
              </div>
            ))}
          </dl>
          {o.strengths.length > 0 && <List title="Strengths" items={o.strengths} tone="text-emerald-700 dark:text-emerald-400" />}
          {o.gaps.length > 0 && <List title="Gaps" items={o.gaps} tone="text-amber-700 dark:text-amber-400" />}
          {o.evidenceQuotes.length > 0 && (
            <blockquote className="space-y-1 border-l-2 border-zinc-300 pl-3 text-xs italic muted dark:border-zinc-700">
              {o.evidenceQuotes.map((q, i) => <p key={i}>“{unquote(q)}”</p>)}
            </blockquote>
          )}
          {o.note && <p className="text-xs muted">Note: {o.note}</p>}
        </>
      )}
    </article>
  );
}

function List({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  return (
    <div>
      <h4 className={`text-xs font-semibold uppercase tracking-wide ${tone}`}>{title}</h4>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </div>
  );
}
