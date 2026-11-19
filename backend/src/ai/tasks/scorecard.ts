import { z } from "zod";
import { fence, UNTRUSTED_RULE } from "../untrusted.js";
import { FinalizeError, type TaskDef } from "./types.js";

const Item = z.object({
  question: z.string().max(600),
  answerSummary: z.string().max(600),
  score: z.number().int().min(1).max(5),
  gaps: z.array(z.string().max(240)).max(4).default([]),
});
const Input = z.object({ role: z.string().max(120), items: z.array(Item).min(1).max(40) });
const Output = z.object({
  summary: z.string().max(900),
  strengths: z.array(z.string().max(240)).max(5),
  risks: z.array(z.string().max(240)).max(5),
  followUpsNextRound: z.array(z.string().max(300)).max(4),
});
type I = z.infer<typeof Input>;
type O = z.infer<typeof Output>;

/** Words that would turn the scorecard into a decision. The product supports the interviewer; it never decides. */
const VERDICT = /\b(no[- ]hire|do not hire|don't hire|should (?:be )?hired|should be rejected|reject(?:ed)?\b|recommend(?:ed)? (?:hiring|rejecting|a hire))/i;

export const scorecard: TaskDef<I, O> = {
  name: "scorecard",
  speed: "slow",
  input: Input,
  output: Output,
  system:
    "Summarise an interview for the human interviewer from the scored answers. Be specific and balanced: what went well, where the risks are, " +
    "and what to probe in a next round. Describe evidence, not a verdict: never say whether to hire or reject. " +
    UNTRUSTED_RULE,
  user: (i) =>
    `Role: ${i.role}\n\n` +
    fence("scored_answers", i.items.map((it, n) => `${n + 1}. Q: ${it.question}\n   A (summary): ${it.answerSummary}\n   Score: ${it.score}/5${it.gaps.length ? `\n   Gaps: ${it.gaps.join("; ")}` : ""}`).join("\n")),
  finalize: (o) => {
    if (VERDICT.test([o.summary, ...o.strengths, ...o.risks, ...o.followUpsNextRound].join(" "))) throw new FinalizeError("do not state a hiring decision; describe the evidence only");
  },
  defaults: { primary: "anthropic:sonnet", fallback: "azure:gpt-5.4", timeoutMs: 40_000, deadlineMs: 90_000, maxOutputTokens: 1200 },
  sample: {
    role: "Backend Engineer",
    items: [
      { question: "Describe a production incident you handled.", answerSummary: "Pool exhaustion from a report query; added timeouts, moved report to replica.", score: 4, gaps: ["no prevention beyond timeouts"] },
      { question: "How would you design rate limiting?", answerSummary: "Token bucket in Redis, per API key; unsure about clock skew.", score: 3, gaps: ["distributed edge cases"] },
    ],
  },
};
