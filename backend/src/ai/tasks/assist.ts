import { z } from "zod";
import { fence, UNTRUSTED_RULE } from "../untrusted.js";
import { Turn, turnsText } from "./common.js";
import { FinalizeError, requireQuotes, sameQuestion, type TaskDef } from "./types.js";

const Input = z.object({
  recentTurns: z.array(Turn).min(1).max(8),
  /** Earlier parts of THIS interview, condensed by the app. Never other candidates' data. */
  earlierNotes: z.string().max(4000).optional(),
  resumeSummary: z.string().max(3000).optional(),
  jd: z.string().max(1500).optional(),
  asked: z.array(z.string().max(600)).max(40).default([]),
});
const Output = z.object({
  suggestion: z.string().max(500),
  kind: z.enum(["question", "reminder", "clarify"]),
  /** Short verbatim quotes the suggestion rests on. */
  evidence: z.array(z.string().max(300)).max(3),
});
type I = z.infer<typeof Input>;
type O = z.infer<typeof Output>;

const sourceOf = (i: I) => [turnsText(i.recentTurns), i.earlierNotes ?? "", i.resumeSummary ?? ""].join("\n");

export const assist: TaskDef<I, O> = {
  name: "assist",
  speed: "fast",
  input: Input,
  output: Output,
  system:
    "The human interviewer pressed 'assist me': they are unsure what to say next. Give ONE short, speakable suggestion: usually a question, " +
    "or a reminder of something the candidate said earlier that contradicts or builds on the current point (kind=reminder), or a clarifying question. " +
    "Ground it in what was actually said in this interview or in the resume; put 1-3 short verbatim quotes in evidence. " +
    "Never repeat a question in <already_asked>. " +
    UNTRUSTED_RULE,
  user: (i) =>
    fence("transcript", turnsText(i.recentTurns)) +
    (i.earlierNotes ? `\n\n${fence("earlier_in_interview", i.earlierNotes)}` : "") +
    (i.resumeSummary ? `\n\n${fence("resume", i.resumeSummary)}` : "") +
    (i.jd ? `\n\n${fence("job_description", i.jd)}` : "") +
    (i.asked.length ? `\n\n${fence("already_asked", i.asked.map((q) => `- ${q}`).join("\n"))}` : ""),
  finalize: (o, i) => {
    requireQuotes(o.evidence, sourceOf(i), "evidence quotes");
    if (o.kind === "question" && i.asked.some((a) => sameQuestion(a, o.suggestion))) throw new FinalizeError("this repeats a question already asked");
  },
  defaults: { primary: "azure:gpt-5.4-mini", fallback: "anthropic:haiku", timeoutMs: 6_000, deadlineMs: 9_000, maxOutputTokens: 500 },
  sample: {
    recentTurns: [
      { role: "interviewer", text: "And how did you monitor it afterwards?" },
      { role: "candidate", text: "We had dashboards, mostly." },
    ],
    earlierNotes: "candidate: I led the migration from the monolith. We never had an outage during the migration.",
    resumeSummary: "7 years. Node.js, Go, PostgreSQL. Led a migration from a monolith to services.",
    asked: [],
  },
};
