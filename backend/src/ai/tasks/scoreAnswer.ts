import { z } from "zod";
import { fence, UNTRUSTED_RULE } from "../untrusted.js";
import { Level, Question } from "./common.js";
import { FinalizeError, requireQuotes, type TaskDef } from "./types.js";

const Dim = z.number().int().min(1).max(5);
const Input = z.object({
  question: Question,
  answer: z.string().min(1).max(4000),
  level: Level.optional(),
  /** "noisy" when the speech-to-text looks unreliable (many odd words); the model must then lower its confidence. */
  transcriptQuality: z.enum(["clean", "noisy"]).default("clean"),
});
const Output = z.object({
  score: Dim,
  dimensions: z.object({ technicalCorrectness: Dim, depth: Dim, clarity: Dim, relevance: Dim }),
  strengths: z.array(z.string().max(240)).max(4),
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
    "evidenceQuotes are short verbatim quotes from the answer that justify the score. Do not output a hiring decision. " +
    UNTRUSTED_RULE,
  user: (i) =>
    `Level: ${i.level ?? "not stated"}\nTranscript quality: ${i.transcriptQuality}\n\n${fence("question", i.question.text)}` +
    (i.question.keyPoints?.length ? `\n\nKey points a good answer contains:\n${i.question.keyPoints.map((k) => `- ${k}`).join("\n")}` : "") +
    `\n\n${fence("answer", i.answer)}`,
  finalize: (o, i) => {
    requireQuotes(o.evidenceQuotes, i.answer, "evidenceQuotes");
    const d = o.dimensions;
    const mean = (d.technicalCorrectness + d.depth + d.clarity + d.relevance) / 4;
    if (Math.abs(o.score - mean) > 1.5) throw new FinalizeError(`overall score ${o.score} does not fit the dimension scores (mean ${mean.toFixed(1)})`);
    if (i.transcriptQuality === "noisy" && o.confidence === "high") throw new FinalizeError("confidence cannot be high when the transcript is noisy");
  },
  defaults: { primary: "anthropic:sonnet", fallback: "azure:gpt-5.4", timeoutMs: 30_000, deadlineMs: 60_000, maxOutputTokens: 900 },
  sample: {
    question: { text: "What happens when a database connection pool is exhausted?", keyPoints: ["requests queue or time out", "find the leak or slow query", "set timeouts and limits"] },
    answer: "The requests that need a connection wait in a queue until one frees up, and if they wait too long they time out. Usually it means something is holding connections, a slow query or a connection that was never released. You find it with the database's active session view, then add statement timeouts and sensible pool limits.",
    level: "senior",
    transcriptQuality: "clean",
  },
};
