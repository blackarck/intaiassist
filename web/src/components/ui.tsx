import { useState, type ReactNode } from "react";
import type { InterviewSummary } from "../types";

const STATUS: Record<InterviewSummary["status"], { label: string; cls: string }> = {
  paid: { label: "Waiting for invite", cls: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" },
  scheduled: { label: "Bot scheduled", cls: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300" },
  joining: { label: "Bot in lobby", cls: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  in_meeting: { label: "Live", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300" },
  ended: { label: "Ended", cls: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300" },
  cancelled: { label: "Cancelled", cls: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400" },
  not_admitted: { label: "Not admitted", cls: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
};

export function StatusBadge({ status }: { status: InterviewSummary["status"] | string }) {
  const s = STATUS[status as InterviewSummary["status"]] ?? { label: status, cls: STATUS.paid.cls };
  return <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn-ghost !px-2.5 !py-1 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked: the text is selectable on screen */
        }
      }}
    >
      {done ? "Copied" : label}
    </button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 text-sm muted">
      <span className="size-4 animate-spin rounded-full border-2 border-zinc-300 border-t-indigo-500" />
      {label ?? "Loading…"}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{children}</div>;
}

export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

/** Models often wrap a quote in quote marks of their own; we add ours when displaying, so strip theirs. */
export const unquote = (q: string) => q.trim().replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").trim();
