import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import { useRoom } from "../hooks";
import type { Question, Scorecard } from "../types";
import { AnswerCard, ScoreBadge } from "./Score";
import { CopyButton, ErrorNote, Spinner, StatusBadge, clock, unquote } from "./ui";

const FOLLOW: Record<string, string> = { probe: "Probe", clarify: "Clarify", deepen: "Go deeper", move_on: "Move on" };

export function Room({ id, status, onStatus }: { id: string; status: string; onStatus?: (s: string) => void }) {
  const { state, connection, error } = useRoom(id);
  const [assisting, setAssisting] = useState(false);
  const [assistError, setAssistError] = useState<string>();
  const [tab, setTab] = useState<"questions" | "transcript" | "assessment">("transcript");

  const live = state.status ?? status;
  useEffect(() => onStatus?.(live), [live]); // eslint-disable-line react-hooks/exhaustive-deps
  const askAssist = async () => {
    setAssisting(true);
    setAssistError(undefined);
    try {
      await api(`/api/interviews/${id}/room/assist`, { method: "POST", body: {} });
    } catch (e) {
      setAssistError(e instanceof ApiError && e.status === 409 ? "Nothing has been said yet." : "Assist is unavailable right now.");
    } finally {
      setAssisting(false);
    }
  };

  if (error) return <ErrorNote>{error}</ErrorNote>;
  if (!state.loaded) return <Spinner label="Opening the room…" />;

  // Suggestions for the answer just given are the ones to use now; older ones stay available but out of the way.
  const lastAnswerId = state.answers.at(-1)?.id;
  const queuedFollowUps = state.questions.filter((q) => q.kind === "follow_up" && q.status === "queued");
  const followUps = queuedFollowUps.filter((q) => q.answerId === lastAnswerId);
  const olderFollowUps = queuedFollowUps.filter((q) => q.answerId !== lastAnswerId);
  const upNext = state.questions.filter((q) => q.kind !== "follow_up" && q.kind !== "live" && q.status === "queued");
  const asked = state.questions.filter((q) => q.status === "asked");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <StatusBadge status={live} />
        <span className="flex items-center gap-1.5 muted" role="status">
          <span className={`size-2 rounded-full ${connection === "live" ? "bg-emerald-500" : "animate-pulse bg-amber-500"}`} />
          {connection === "live" ? "Connected" : "Reconnecting…"}
        </span>
        <button type="button" className="btn-primary ml-auto" onClick={askAssist} disabled={assisting || state.transcript.length === 0}>
          {assisting ? "Thinking…" : "Assist me"}
        </button>
      </div>

      {state.notices[0] && <ErrorNote>{state.notices[0].text}</ErrorNote>}
      {assistError && <ErrorNote>{assistError}</ErrorNote>}
      {state.assists[0] && <AssistCard item={state.assists[0]} />}
      {state.scorecard && <ScorecardView card={state.scorecard} />}

      <div className="flex gap-1 lg:hidden" role="tablist">
        {(["questions", "transcript", "assessment"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`btn flex-1 capitalize ${tab === t ? "bg-indigo-600 text-white" : "btn-ghost"}`}>{t}</button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1fr)]">
        <section aria-label="Questions" className={`space-y-3 ${tab === "questions" ? "" : "hidden lg:block"}`}>
          <h2 className="text-sm font-semibold">Questions</h2>
          {followUps.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wide text-indigo-600 dark:text-indigo-400">Follow up on the last answer</h3>
              {followUps.map((q) => <QuestionCard key={q.id} q={q} highlight />)}
            </div>
          )}
          <div className="space-y-2">
            <h3 className="text-xs font-medium uppercase tracking-wide muted">Up next</h3>
            {upNext.length === 0 ? <p className="text-sm muted">No prepared questions left.</p> : upNext.map((q) => <QuestionCard key={q.id} q={q} />)}
          </div>
          {olderFollowUps.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer muted">Earlier follow-up ideas ({olderFollowUps.length})</summary>
              <div className="mt-2 space-y-2">{olderFollowUps.map((q) => <QuestionCard key={q.id} q={q} />)}</div>
            </details>
          )}
          {asked.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer muted">Asked ({asked.length})</summary>
              <ul className="mt-2 space-y-1.5 border-l border-zinc-200 pl-3 dark:border-zinc-800">{asked.map((q) => <li key={q.id}>{q.text}</li>)}</ul>
            </details>
          )}
        </section>

        <section aria-label="Transcript" className={`${tab === "transcript" ? "" : "hidden lg:block"}`}>
          <h2 className="mb-2 text-sm font-semibold">Transcript</h2>
          <Transcript segments={state.transcript} partial={state.partial} />
        </section>

        <section aria-label="Assessment" className={`space-y-3 ${tab === "assessment" ? "" : "hidden lg:block"}`}>
          <h2 className="text-sm font-semibold">Assessment <span className="font-normal muted">· advisory, you decide</span></h2>
          {state.answers.length === 0 ? <p className="text-sm muted">Answers appear here with a score as the candidate finishes each one.</p> : [...state.answers].reverse().map((a) => <AnswerCard key={a.id} answer={a} score={state.scores[a.id]} />)}
        </section>
      </div>
    </div>
  );
}

function QuestionCard({ q, highlight }: { q: Question; highlight?: boolean }) {
  return (
    <div className={`card p-3 text-sm ${highlight ? "border-indigo-300 bg-indigo-50/60 dark:border-indigo-900 dark:bg-indigo-950/30" : ""}`}>
      {q.followKind && <span className="mb-1 inline-block rounded bg-indigo-100 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700 dark:bg-indigo-900 dark:text-indigo-200">{FOLLOW[q.followKind]}</span>}
      <p className="font-medium leading-snug">{q.text}</p>
      {q.why && <p className="mt-1 text-xs muted">{q.why}</p>}
      {(q.keyPoints.length > 0 || q.probes.length > 0) && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer muted">Key points{q.probes.length ? " and probes" : ""}</summary>
          {q.keyPoints.length > 0 && <ul className="mt-1 list-disc pl-4">{q.keyPoints.map((k, i) => <li key={i}>{k}</li>)}</ul>}
          {q.probes.length > 0 && <><p className="mt-2 font-medium">Probes</p><ul className="list-disc pl-4">{q.probes.map((k, i) => <li key={i}>{k}</li>)}</ul></>}
        </details>
      )}
      <div className="mt-2 text-right"><CopyButton text={q.text} label="Copy question" /></div>
    </div>
  );
}

function Transcript({ segments, partial }: { segments: { speakerId: string; speakerName?: string; role: string; text: string; startMs: number }[]; partial?: { speakerName?: string; role: string; text: string } }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [segments.length, partial?.text]);
  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; // keep following unless the person scrolled up to read
      }}
      className="card h-[28rem] space-y-3 overflow-y-auto p-4 lg:h-[calc(100vh-15rem)]"
    >
      {segments.length === 0 && !partial && <p className="text-sm muted">Waiting for the conversation to start…</p>}
      {segments.map((s) => <Line key={`${s.speakerId}:${s.startMs}`} who={s.speakerName ?? s.role} role={s.role} text={s.text} at={clock(s.startMs)} />)}
      {partial && <Line who={partial.speakerName ?? partial.role} role={partial.role} text={partial.text} faded />}
    </div>
  );
}

function Line({ who, role, text, at, faded }: { who: string; role: string; text: string; at?: string; faded?: boolean }) {
  return (
    <div className={faded ? "opacity-60" : ""}>
      <p className="flex items-baseline gap-2 text-xs">
        <span className={`font-semibold ${role === "interviewer" ? "text-indigo-600 dark:text-indigo-400" : role === "candidate" ? "text-emerald-700 dark:text-emerald-400" : "muted"}`}>{who}</span>
        {at && <span className="muted tabular-nums">{at}</span>}
      </p>
      <p className="text-sm leading-relaxed">{text}</p>
    </div>
  );
}

function AssistCard({ item }: { item: { suggestion: string; kind: string; evidence: string[] } }) {
  return (
    <aside className="card border-indigo-300 bg-indigo-50/70 p-4 dark:border-indigo-900 dark:bg-indigo-950/30" aria-live="polite">
      <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700 dark:text-indigo-300">{item.kind === "reminder" ? "Reminder" : item.kind === "clarify" ? "Clarify" : "Suggested question"}</p>
      <p className="mt-1 text-base font-medium">{item.suggestion}</p>
      {item.evidence.length > 0 && <p className="mt-2 text-xs italic muted">Based on: {item.evidence.map((e) => `“${unquote(e)}”`).join(" · ")}</p>}
    </aside>
  );
}

function ScorecardView({ card }: { card: Scorecard }) {
  return (
    <section className="card space-y-3 p-5" aria-label="Scorecard">
      <header className="flex items-center gap-4">
        <ScoreBadge score={card.averageScore} size="lg" />
        <div>
          <h2 className="text-base font-semibold">Scorecard</h2>
          <p className="text-xs muted">{card.scored} of {card.answered} answers scored · advisory, you decide</p>
        </div>
      </header>
      <p className="text-sm leading-relaxed">{card.summary}</p>
      <div className="grid gap-4 sm:grid-cols-3">
        <Bullets title="Strengths" items={card.strengths} tone="text-emerald-700 dark:text-emerald-400" />
        <Bullets title="Risks" items={card.risks} tone="text-amber-700 dark:text-amber-400" />
        <Bullets title="For a next round" items={card.followUpsNextRound} tone="text-indigo-700 dark:text-indigo-400" />
      </div>
    </section>
  );
}

function Bullets({ title, items, tone }: { title: string; items: string[]; tone: string }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className={`text-xs font-semibold uppercase tracking-wide ${tone}`}>{title}</h3>
      <ul className="mt-1 list-disc space-y-1 pl-4 text-sm">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </div>
  );
}
