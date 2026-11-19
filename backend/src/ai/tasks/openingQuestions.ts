import { z } from "zod";
import { fence, UNTRUSTED_RULE } from "../untrusted.js";
import { KeyPoints, Level } from "./common.js";
import { sameQuestion, type TaskDef, FinalizeError } from "./types.js";

const Input = z.object({
  role: z.object({ title: z.string().max(120), level: Level.optional() }),
  jd: z.string().max(4000),
  resumeSummary: z.string().max(3000).optional(),
  /** Questions the interviewer already chose; the model must not repeat them. */
  presetQuestions: z.array(z.string().max(600)).max(20).default([]),
  count: z.number().int().min(1).max(10),
});
const Output = z.object({
  questions: z.array(z.object({ text: z.string().max(600), why: z.string().max(300), keyPoints: KeyPoints, probes: z.array(z.string().max(300)).max(4) })).max(10),
});
type I = z.infer<typeof Input>;
type O = z.infer<typeof Output>;

export const openingQuestions: TaskDef<I, O> = {
  name: "opening_questions",
  speed: "fast",
  input: Input,
  output: Output,
  system:
    "You help a human interviewer prepare. Suggest questions that test the skills the role needs, tailored to the candidate's resume where it helps. " +
    "Mix depth: some fundamentals, some applied, at most one open-ended. Each question gets 2-5 key points a good answer would contain, and up to 2 probes to dig deeper. " +
    "Do not repeat any question in <already_chosen>. Plain, speakable wording (the interviewer will read it aloud). " +
    UNTRUSTED_RULE,
  user: (i) =>
    `Role: ${i.role.title}${i.role.level ? ` (${i.role.level})` : ""}\nSuggest ${i.count} questions.\n\n` +
    fence("job_description", i.jd) +
    (i.resumeSummary ? `\n\n${fence("resume", i.resumeSummary)}` : "") +
    (i.presetQuestions.length ? `\n\n${fence("already_chosen", i.presetQuestions.map((q) => `- ${q}`).join("\n"))}` : ""),
  finalize: (o, i) => {
    const dup = o.questions.find((q) => i.presetQuestions.some((p) => sameQuestion(p, q.text)));
    if (dup) throw new FinalizeError(`this repeats an already chosen question: "${dup.text.slice(0, 80)}"`);
  },
  defaults: { primary: "azure:gpt-5.4-mini", fallback: "anthropic:haiku", timeoutMs: 12_000, deadlineMs: 20_000, maxOutputTokens: 1800 },
  sample: {
    role: { title: "Backend Engineer", level: "senior" },
    jd: "Build and run REST services in Node.js and PostgreSQL. Own reliability: monitoring, incident response, capacity. Mentor juniors.",
    resumeSummary: "7 years. Node.js, Go, PostgreSQL. Led a migration from a monolith to services at a payments startup.",
    presetQuestions: ["Tell me about a production incident you handled."],
    count: 4,
  },
};
