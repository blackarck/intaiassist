import { z } from "zod";

export const Turn = z.object({
  role: z.enum(["interviewer", "candidate", "unknown"]),
  text: z.string().max(1500),
});
export type Turn = z.infer<typeof Turn>;

export const KeyPoints = z.array(z.string().max(300)).max(12);

export const Question = z.object({ text: z.string().min(1).max(600), keyPoints: KeyPoints.optional() });

export const Level = z.string().max(60);

export const turnsText = (turns: Turn[]) => turns.map((t) => `${t.role}: ${t.text}`).join("\n");
