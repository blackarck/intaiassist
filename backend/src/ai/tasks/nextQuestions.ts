import { z } from "zod";
import { fence, UNTRUSTED_RULE } from "../untrusted.js";
import { Question, Turn, turnsText } from "./common.js";
import { FinalizeError, sameQuestion, type TaskDef } from "./types.js";

const Input = z.object({
  recentTurns: z.array(Turn).min(1).max(8),
  currentQuestion: Question,
  asked: z.array(z.string().max(600)).max(40).default([]),
  jd: z.string().max(1500).optional(),
});
const Output = z.object({
  followUps: z
    .array(z.object({ text: z.string().max(400), reason: z.string().max(240), kind: z.enum(["probe", "clarify", "deepen", "move_on"]) }))
    .max(3),
});
type I = z.infer<typeof Input>;
type O = z.infer<typeof Output>;

export const nextQuestions: TaskDef<I, O> = {
  name: "next_questions",
  speed: "fast",
  input: Input,
  output: Output,
  system:
    "You assist a human interviewer in real time. Based on what the candidate just said, suggest up to 3 short follow-up questions the interviewer could ask next. " +
    "kind: probe = test a claim, clarify = resolve something vague or contradictory, deepen = go further on something solid, move_on = the topic is covered. " +
    "Reference something specific the candidate said. If they said something incorrect, vague or contradictory, make the FIRST follow-up a direct, polite challenge of those exact words (kind=probe or clarify), phrased so the interviewer can say it as is. " +
    "Never repeat a question in <already_asked>. If the answer was complete and nothing needs following up, return one move_on. " +
    UNTRUSTED_RULE,
  user: (i) =>
    `${fence("question", i.currentQuestion.text)}\n\n${fence("transcript", turnsText(i.recentTurns))}` +
    (i.asked.length ? `\n\n${fence("already_asked", i.asked.map((q) => `- ${q}`).join("\n"))}` : "") +
    (i.jd ? `\n\n${fence("job_description", i.jd)}` : ""),
  finalize: (o, i) => {
    const dup = o.followUps.find((f) => i.asked.some((a) => sameQuestion(a, f.text)));
    if (dup) throw new FinalizeError(`this repeats a question already asked: "${dup.text.slice(0, 80)}"`);
  },
  defaults: { primary: "azure:gpt-5.4-mini", fallback: "anthropic:haiku", timeoutMs: 6_000, deadlineMs: 9_000, maxOutputTokens: 1000 },
  sample: {
    recentTurns: [
      { role: "interviewer", text: "Tell me about a production incident you handled." },
      { role: "candidate", text: "Our payments service started timing out. I found the connection pool was exhausted because a new report query held connections open. I added a timeout and moved the report to a replica." },
    ],
    currentQuestion: { text: "Tell me about a production incident you handled.", keyPoints: ["detection", "root cause", "fix", "prevention"] },
    asked: [],
  },
};
