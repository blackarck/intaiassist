import { useEffect, useState } from "react";
import type { RoomState } from "../room";
import type { CoachData, Suggestion } from "../types";
import { CopyButton } from "./ui";

const STANCE: Record<CoachData["stance"], { label: string; cls: string; ring: string }> = {
  right: { label: "Answer is right so far", cls: "bg-emerald-600 text-white", ring: "border-emerald-300 dark:border-emerald-900" },
  partly_right: { label: "Partly right", cls: "bg-amber-500 text-white", ring: "border-amber-300 dark:border-amber-900" },
  wrong: { label: "Answer looks wrong", cls: "bg-red-600 text-white", ring: "border-red-300 dark:border-red-900" },
  vague: { label: "Too vague so far", cls: "bg-zinc-600 text-white", ring: "border-zinc-300 dark:border-zinc-700" },
};

/**
 * The one thing the interviewer looks at: how the answer stands, and 2 or 3 questions to ask next, each with a few words on why.
 * It refreshes by itself while the candidate talks. It never clears while waiting: the last suggestions stay until new ones replace
 * them, and the layout does not change size, so nothing jumps.
 */
export function Coach({ state }: { state: RoomState }) {
  const c = state.coach;
  const latest = state.answers.at(-1);
  const stale = !!c && !!latest && c.answerId !== latest.id; // a newer question has started; the new advice is still building up
  const age = useAge(c?.at);

  if (!c) {
    return (
      <Frame ring="border-zinc-200 dark:border-zinc-800">
        <p className="text-base font-medium">{latest ? "Listening to the answer…" : "Listening."}</p>
        <p className="mt-1 text-sm muted">Suggested questions appear here as soon as the candidate has said enough, and refresh while they keep talking.</p>
      </Frame>
    );
  }
  const st = STANCE[c.stance];
  return (
    <Frame ring={st.ring} dim={stale}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-3 py-1 text-sm font-semibold ${st.cls}`}>{st.label}</span>
        <span className="ml-auto text-xs muted" aria-live="off">{stale ? "from the previous answer" : age}</span>
      </div>
      <p className="mt-3 text-base leading-snug">{c.remark}</p>

      <h2 className="mt-5 text-xs font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">{c.stance === "right" ? "You could also ask" : "Ask next"}</h2>
      <ol className="mt-2 space-y-2.5">
        {c.questions.map((q, i) => <Ask key={q.text} s={q} primary={i === 0} />)}
      </ol>
      {c.proof && (
        <div className="mt-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-red-700 dark:text-red-400">Check they did the work</h2>
          <ol className="mt-2"><Ask s={c.proof} primary={false} /></ol>
        </div>
      )}
    </Frame>
  );
}

function Ask({ s, primary }: { s: Suggestion; primary: boolean }) {
  return (
    <li className={`flex items-start gap-3 rounded-xl border p-3.5 ${primary ? "border-indigo-300 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-950/40" : "border-zinc-200 dark:border-zinc-800"}`}>
      <div className="min-w-0 flex-1">
        <p className={primary ? "text-lg font-medium leading-snug" : "text-base leading-snug"}>{s.text}</p>
        <p className="mt-1 text-xs muted">{s.remark}</p>
      </div>
      <CopyButton text={s.text} />
    </li>
  );
}

function Frame({ children, ring, dim }: { children: React.ReactNode; ring: string; dim?: boolean }) {
  // min height keeps the panel from collapsing and re-expanding as suggestions come and go
  return <section aria-label="Coach" aria-live="polite" className={`card min-h-72 border-2 p-5 transition-opacity duration-500 ${ring} ${dim ? "opacity-60" : ""}`}>{children}</section>;
}

/** "just now", "12 s ago", "1 min ago": re-rendered every few seconds, nothing else on the page moves with it. */
function useAge(iso?: string) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 8 ? "updated just now" : s < 60 ? `updated ${s} s ago` : `updated ${Math.round(s / 60)} min ago`;
}
