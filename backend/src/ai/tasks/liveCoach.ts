import { z } from "zod";
import { fence, UNTRUSTED_RULE } from "../untrusted.js";
import { KeyPoints, Turn, turnsText } from "./common.js";
import { FinalizeError, sameQuestion, type TaskDef } from "./types.js";

const Suggestion = z.object({
  /** Short and speakable: the interviewer reads it out as written. */
  text: z.string().max(240),
  /** Why ask it, in a few words. */
  remark: z.string().max(120),
});

const Input = z.object({
  question: z.object({ text: z.string().min(1).max(600), keyPoints: KeyPoints.optional() }),
  /** What the candidate has said so far in this answer (it may still be going). */
  answerSoFar: z.string().min(1).max(3000),
  recentTurns: z.array(Turn).max(6).default([]),
  resumeSummary: z.string().max(1500).optional(),
  jd: z.string().max(1000).optional(),
  /** Questions the interviewer has already asked. Never suggest these again. */
  asked: z.array(z.string().max(600)).max(30).default([]),
  /** What the coach showed a moment ago. Keep a question if it still fits; replace one the candidate has since answered. */
  shown: z.array(z.string().max(300)).max(4).default([]),
});

const Output = z.object({
  /** right: correct so far. partly_right: some correct, some wrong or missing. wrong: the core claim is wrong. vague: nothing checkable yet. */
  stance: z.enum(["right", "partly_right", "wrong", "vague"]),
  /** One sentence: where the answer stands and why, said plainly. */
  remark: z.string().max(200),
  /** 2 or 3 counter-questions the interviewer can ask next. */
  questions: z.array(Suggestion).min(2).max(3),
  /** If the answer sounds textbook or secondhand: one question that makes them prove they did the work. Otherwise null. */
  proof: Suggestion.nullable(),
});
type I = z.infer<typeof Input>;
type O = z.infer<typeof Output>;

export const liveCoach: TaskDef<I, O> = {
  name: "live_coach",
  speed: "fast",
  input: Input,
  output: Output,
  system:
    "You sit beside a busy human interviewer and listen to the candidate AS THEY ANSWER. Every few seconds you tell the interviewer, at a glance: " +
    "where the answer stands (stance + one plain sentence), and 2 or 3 counter-questions they can ask next. " +
    "If the answer is RIGHT, say so and suggest questions that go further (an edge case, a trade-off, a time it went wrong). " +
    "If it is WRONG or PARTLY wrong, say what is wrong in the remark and ask questions that make the candidate confront it. " +
    "If it is VAGUE, ask for specifics (what exactly did they do, which number, which system). " +
    "stance rules: wrong ONLY when a factual claim they made is incorrect (name it in the remark). An answer that is generic, thin or incomplete is vague or partly_right, not wrong. " +
    "Each question must be a real QUESTION (ends with a question mark), at most about 25 words, short enough to say aloud as written, refer to the candidate's own words, and carry a few-word remark saying why to ask it. " +
    "Do not repeat a question in <already_asked>. Keep a question from <shown_a_moment_ago> if it still fits; replace it when the candidate's later words have already answered it, so the screen stays steady but never stale. " +
    "If the answer sounds textbook or secondhand rather than something they did (compare with <resume>), set proof to ONE short question (not an explanation) that makes them prove it; otherwise null. " +
    "The answer may be unfinished: judge what has been said so far and do not penalise it for stopping mid-thought. " +
    UNTRUSTED_RULE,
  user: (i) =>
    `${fence("question", i.question.text)}` +
    (i.question.keyPoints?.length ? `\n\nA good answer covers:\n${i.question.keyPoints.map((k) => `- ${k}`).join("\n")}` : "") +
    `\n\n${fence("answer", i.answerSoFar)}` +
    (i.recentTurns.length ? `\n\n${fence("transcript", turnsText(i.recentTurns))}` : "") +
    (i.resumeSummary ? `\n\n${fence("resume", i.resumeSummary)}` : "") +
    (i.jd ? `\n\n${fence("job_description", i.jd)}` : "") +
    (i.asked.length ? `\n\n${fence("already_asked", i.asked.map((q) => `- ${q}`).join("\n"))}` : "") +
    (i.shown.length ? `\n\n${fence("shown_a_moment_ago", i.shown.map((q) => `- ${q}`).join("\n"))}` : ""),
  finalize: (o, i) => {
    const all = [...o.questions, ...(o.proof ? [o.proof] : [])];
    const notQuestion = all.find((q) => !q.text.includes("?") || q.text.length > 200);
    if (notQuestion) throw new FinalizeError(`each suggestion must be one short question ending with a question mark: "${notQuestion.text.slice(0, 80)}"`);
    const dup = all.find((q) => i.asked.some((a) => sameQuestion(a, q.text)));
    if (dup) throw new FinalizeError(`this repeats a question already asked: "${dup.text.slice(0, 80)}"`);
  },
  defaults: { primary: "azure:gpt-5.4-mini", fallback: "anthropic:haiku", timeoutMs: 8_000, deadlineMs: 12_000, maxOutputTokens: 900 },
  sample: {
    question: { text: "Tell me about a production incident you handled.", keyPoints: ["detection", "root cause", "fix", "prevention"] },
    answerSoFar: "Our payments service started timing out. I found the connection pool was exhausted because a new report query held connections open. I added a timeout and moved the report to a replica.",
    recentTurns: [{ role: "interviewer", text: "Tell me about a production incident you handled." }],
    resumeSummary: "7 years. Node.js, Go, PostgreSQL. On-call lead for two years.",
    asked: [],
    shown: [],
  },
};
