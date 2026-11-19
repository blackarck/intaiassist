import type { z } from "zod";

/** Thrown by a task's `finalize` when the model's answer is well-formed but wrong. The message is fed back to the model once. */
export class FinalizeError extends Error {}

export interface TaskDefaults {
  /** Catalog ids (models.ts). */
  primary: string;
  fallback: string;
  /** Per model attempt. */
  timeoutMs: number;
  /** For the whole task including retries and failover. */
  deadlineMs: number;
  maxOutputTokens: number;
}

export interface TaskDef<I = unknown, O = unknown> {
  name: string;
  /** fast: runs inline and has a hard deadline. slow: runs in the background and its result is pushed when ready. */
  speed: "fast" | "slow";
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  system: string;
  user(input: I): string;
  /** Checks the answer against the input (quotes really occur, no repeats, ...). Throw FinalizeError to reject. */
  finalize?(out: O, input: I): void;
  defaults: TaskDefaults;
  /** Used by the admin Test button and the model bake-off. */
  sample: I;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** True when `quote` occurs in `source`, ignoring case, punctuation and spacing (speech-to-text is loose about all three). */
export function occursIn(quote: string, source: string): boolean {
  const q = norm(quote);
  return q.length > 0 && norm(source).includes(q);
}

export function requireQuotes(quotes: string[], source: string, what: string) {
  const bad = quotes.find((q) => !occursIn(q, source));
  if (bad !== undefined) throw new FinalizeError(`${what} must be copied exactly from the text provided; this one is not in it: "${bad.slice(0, 80)}"`);
}

/** Near-duplicate test for questions (word-set overlap). */
export function sameQuestion(a: string, b: string): boolean {
  const wa = new Set(norm(a).split(" "));
  const wb = new Set(norm(b).split(" "));
  if (wa.size === 0 || wb.size === 0) return false;
  let both = 0;
  for (const w of wa) if (wb.has(w)) both++;
  return both / Math.min(wa.size, wb.size) >= 0.8;
}
