import { z } from "zod";
import { fence, UNTRUSTED_RULE } from "../untrusted.js";
import { Level, Question } from "./common.js";
import { FinalizeError, requireQuotes, type TaskDef } from "./types.js";

const Dim = z.number().int().min(1).max(5);
const Input = z.object({
  question: Question,
  answer: z.string().min(1).max(4000),
  level: Level.optional(),
  /** What the candidate's resume claims. Used to judge whether the answer sounds like work they did. */
  resumeSummary: z.string().max(1500).optional(),
  /** "noisy" when the speech-to-text looks unreliable (many odd words); the model must then lower its confidence. */
  transcriptQuality: z.enum(["clean", "noisy"]).default("clean"),
});
const Problem = z.object({
  /** Short verbatim quote of what the candidate said. */
  quote: z.string().max(300),
  /** What is wrong with it, in plain words the interviewer can say out loud. */
  issue: z.string().max(300),
  /** What a correct or complete answer says. */
  correction: z.string().max(400),
  severity: z.enum(["minor", "major"]),
  /** A question the interviewer can ask next that exposes or tests this problem. */
  counterQuestion: z.string().max(300),
});
const Experience = z.object({
  /** first_hand: concrete, specific, owns the details. generic: could be recited from a book or blog. unclear: cannot tell yet. */
  signal: z.enum(["first_hand", "unclear", "generic"]),
  /** What in the answer points that way (or what is missing), in a sentence. */
  evidence: z.string().max(300),
  /** A question that makes them prove it: specifics of what THEY did. Required unless the signal is first_hand. */
  probe: z.string().max(300),
});
const Output = z.object({
  /** Two or three sentences in writing: what was right, and what was wrong. */
  verdict: z.string().max(500),
  score: Dim,
  dimensions: z.object({ technicalCorrectness: Dim, depth: Dim, clarity: Dim, relevance: Dim }),
  strengths: z.array(z.string().max(240)).max(4),
  experience: Experience,
  /** Things the candidate SAID that are wrong, vague, unsupported or contradictory. At most 3, worst first. */
  problems: z.array(Problem).max(3),
  /** Things that were left OUT. */
  gaps: z.array(z.string().max(240)).max(4),
  evidenceQuotes: z.array(z.string().max(300)).max(4),
  confidence: z.enum(["low", "medium", "high"]),
  note: z.string().max(300),
});
type I = z.infer<typeof Input>;
type O = z.infer<typeof Output>;

export const scoreAnswer: TaskDef<I, O> = {
  name: "score_answer",
  speed: "slow",
  input: Input,
  output: Output,
  system:
    "You assess one interview answer to support a human interviewer, who makes the decision. Score 1-5 overall and on four dimensions: " +
    "technicalCorrectness (are the claims right?), depth (beyond the surface?), clarity (structured, easy to follow?), relevance (does it answer the question asked?). " +
    "1 = wrong or empty, 2 = weak, 3 = acceptable, 4 = strong, 5 = excellent and precise. Judge against the key points when given, and against the stated level. " +
    "A confident but wrong answer scores low on correctness. A correct but short answer is not 5. " +
    "The answer is speech-to-text: ignore filler and obvious mis-hearings of terms; if the text is too garbled to judge a claim, lower confidence and say so in note. " +
    "Write a short verdict (2-3 sentences): what was right and what was wrong, in plain language for the interviewer. " +
    "Then list the PROBLEMS: each is something the candidate actually said that is wrong, vague, unsupported or contradicts itself. For each give the exact quote, " +
    "what is wrong with it, what a correct answer says, whether it is minor or major, and ONE counterQuestion the interviewer can ask right now that exposes or tests that problem " +
    "(short, speakable, pointed at their own words, never a lecture). Worst problems first, at most 3; do not pad: a correct answer has no problems. Keep every field short, one sentence each, so the interviewer can read it in seconds. " +
    "gaps are different: important things the candidate did not mention at all. " +
    "ALSO judge whether this sounds like work the candidate really did (experience.signal). first_hand = concrete and specific: named systems, numbers, what THEY decided versus the team, trade-offs, something that went wrong. " +
    "generic = textbook or blog-style phrasing that anyone could recite, with no detail of their own. unclear = too little to tell. Compare with <resume> when given: a claim like 'I led X' should come with detail that fits. " +
    "Unless first_hand, give a probe: one short question that makes them prove it (for example: what exactly did you do yourself, what number moved, what did you get wrong first). " +
    "evidenceQuotes are short verbatim quotes from the answer that justify the score. Do not output a hiring decision. " +
    UNTRUSTED_RULE,
  user: (i) =>
    `Level: ${i.level ?? "not stated"}\nTranscript quality: ${i.transcriptQuality}\n\n${fence("question", i.question.text)}` +
    (i.resumeSummary ? `\n\n${fence("resume", i.resumeSummary)}` : "") +
    (i.question.keyPoints?.length ? `\n\nKey points a good answer contains:\n${i.question.keyPoints.map((k) => `- ${k}`).join("\n")}` : "") +
    `\n\n${fence("answer", i.answer)}`,
  finalize: (o, i) => {
    requireQuotes(o.evidenceQuotes, i.answer, "evidenceQuotes");
    requireQuotes(o.problems.map((p) => p.quote), i.answer, "each problem quote");
    if (o.experience.signal !== "first_hand" && !o.experience.probe.trim()) throw new FinalizeError("experience.probe is required unless the signal is first_hand");
    if (o.score <= 3 && o.problems.length === 0 && o.gaps.length === 0) throw new FinalizeError("a score of 3 or lower must say why: list at least one problem or gap");
    if (o.score <= 2 && !o.problems.some((p) => p.severity === "major") && o.gaps.length === 0) throw new FinalizeError("a score of 2 or lower needs a major problem or a gap that explains it");
    const d = o.dimensions;
    const mean = (d.technicalCorrectness + d.depth + d.clarity + d.relevance) / 4;
    if (Math.abs(o.score - mean) > 1.5) throw new FinalizeError(`overall score ${o.score} does not fit the dimension scores (mean ${mean.toFixed(1)})`);
    if (i.transcriptQuality === "noisy" && o.confidence === "high") throw new FinalizeError("confidence cannot be high when the transcript is noisy");
  },
  defaults: { primary: "azure:gpt-6-luna", fallback: "anthropic:haiku", timeoutMs: 30_000, deadlineMs: 60_000, maxOutputTokens: 2000 },
  sample: {
    question: { text: "What happens when a database connection pool is exhausted?", keyPoints: ["requests queue or time out", "find the leak or slow query", "set timeouts and limits"] },
    answer: "The requests that need a connection wait in a queue until one frees up, and if they wait too long they time out. Usually it means something is holding connections, a slow query or a connection that was never released. You find it with the database's active session view, then add statement timeouts and sensible pool limits.",
    level: "senior",
    transcriptQuality: "clean",
  },
};
