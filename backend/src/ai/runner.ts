import { generateText, Output } from "ai";
import { effectiveConfig, type AiConfigStore, type AiRun, type AiRunLog } from "./configStore.js";
import { findModel, type ModelFactory } from "./models.js";
import { FinalizeError } from "./tasks/types.js";
import { getTask } from "./tasks/index.js";

export type AiResult<O = unknown> =
  | { ok: true; output: O; model: string; attempts: AiRun["attempts"]; usage: { inputTokens: number; outputTokens: number }; ms: number }
  | { ok: false; error: { code: string; message: string }; attempts: AiRun["attempts"]; ms: number };

export interface RunnerDeps {
  config: AiConfigStore;
  log?: AiRunLog;
  models: ModelFactory;
  now?: () => number;
}

type Failure = "timeout" | "outage" | "invalid_output" | "client_error" | "error";

const statusOf = (e: unknown): number | undefined => {
  const x = e as { statusCode?: number; status?: number; cause?: { statusCode?: number } };
  return x?.statusCode ?? x?.status ?? x?.cause?.statusCode;
};

function classify(e: unknown): Failure {
  const name = (e as { name?: string })?.name ?? "";
  if (name === "AbortError" || name === "TimeoutError" || /timeout|aborted/i.test((e as Error)?.message ?? "")) return "timeout";
  if (name.includes("NoObjectGenerated") || name.includes("TypeValidation") || name.includes("JSONParse")) return "invalid_output";
  const s = statusOf(e);
  if (s !== undefined) {
    if (s === 429 || s >= 500) return "outage";
    if (s >= 400) return "client_error"; // our request is wrong: a fallback model would fail the same way
  }
  if (/fetch failed|ECONN|ENOTFOUND|network/i.test((e as Error)?.message ?? "")) return "outage";
  return "error";
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one AI task: validate input, call the primary model, retry on outage or bad output, fall back to the second model.
 *
 * - OUTAGE (429/5xx/timeout/network): retry the same model once after a short pause, then the fallback.
 * - INVALID OUTPUT (not JSON, wrong shape, or the task's own `finalize` rejects it): retry once on the same model with the
 *   problem fed back, then the fallback.
 * - 4xx other than 429 never fails over.
 * The task's deadline bounds everything; a fast task that cannot finish in time returns `timeout` instead of arriving late.
 */
export async function runTask(deps: RunnerDeps, taskName: string, rawInput: unknown, opts: { interviewId?: string; /** Catalog id the interviewer picked for this interview: tried first. */ model?: string } = {}): Promise<AiResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const attempts: AiRun["attempts"] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let lastModel: string | undefined;

  const finish = async (res: AiResult): Promise<AiResult> => {
    await deps.log
      ?.record({
        at: new Date(started).toISOString(),
        task: taskName,
        interviewId: opts.interviewId,
        model: res.ok ? res.model : lastModel,
        ok: res.ok,
        outcome: res.ok ? "ok" : res.error.code,
        attempts,
        inputTokens,
        outputTokens,
        ms: now() - started,
      })
      .catch(() => undefined); // logging must never break a coaching call
    return res;
  };
  const fail = (code: string, message: string) => finish({ ok: false, error: { code, message }, attempts, ms: now() - started });

  const def = getTask(taskName);
  if (!def) return fail("unknown_task", `no task named ${taskName}`);
  const cfg = await effectiveConfig(deps.config, taskName);
  if (!cfg) return fail("unknown_task", `no task named ${taskName}`);
  if (!cfg.enabled) return fail("disabled", "this task is switched off");

  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) {
    // Describe by path and rule only, never by value: inputs contain interview content.
    const why = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return fail("bad_input", why);
  }
  const input = parsed.data;
  const deadline = started + cfg.deadlineMs;

  // Attempt plan: primary, primary again (outage or bad output, once), then the fallback (twice at most, same rules).
  // An interviewer's own choice goes first; the task's fallback (or its primary, when the choice IS the fallback) backs it up.
  const plan: string[] = opts.model && findModel(opts.model) ? [opts.model, opts.model === cfg.fallback ? cfg.primary : cfg.fallback] : [cfg.primary, cfg.fallback];
  let feedback: string | undefined;
  let lastFailure: Failure = "error";
  let lastMessage = "no attempt was made";

  for (const modelId of plan) {
    const spec = findModel(modelId);
    if (!spec) {
      lastFailure = "error";
      lastMessage = `model ${modelId} is not in the catalog`;
      continue;
    }
    lastModel = modelId;
    let retried = false;
    for (;;) {
      const remaining = deadline - now();
      if (remaining < 500) return fail("timeout", "the task deadline passed before an answer was ready");
      const t0 = now();
      try {
        const model = deps.models(spec);
        const res = await generateText({
          model,
          output: Output.object({ schema: def.output }),
          system: def.system,
          prompt: def.user(input) + (feedback ? `\n\nYour previous answer was rejected: ${feedback}\nAnswer again and fix that.` : ""),
          maxOutputTokens: cfg.maxOutputTokens,
          ...(cfg.temperature !== undefined && spec.acceptsTemperature ? { temperature: cfg.temperature } : {}),
          maxRetries: 0, // retries are ours, so they respect the deadline and the plan
          timeout: Math.min(cfg.timeoutMs, remaining - 200),
        });
        inputTokens += res.usage?.inputTokens ?? 0;
        outputTokens += res.usage?.outputTokens ?? 0;
        const output = res.output;
        try {
          def.finalize?.(output, input);
        } catch (e) {
          if (e instanceof FinalizeError) throw Object.assign(new Error(e.message), { name: "FinalizeRejected" });
          throw e;
        }
        attempts.push({ model: modelId, outcome: "ok", ms: now() - t0 });
        return finish({ ok: true, output, model: modelId, attempts, usage: { inputTokens, outputTokens }, ms: now() - started });
      } catch (e) {
        const rejected = (e as Error)?.name === "FinalizeRejected";
        const kind: Failure = rejected ? "invalid_output" : classify(e);
        // The model ran out of output tokens mid-answer: the same call would be cut off again, so go straight to the fallback.
        const truncated = (e as { finishReason?: string })?.finishReason === "length";
        if (truncated) retried = true;
        // For a rejected answer keep the RULE that failed, cut before any quoted text (which would be interview content).
        const detail = rejected ? (e as Error).message.split(': "')[0]!.slice(0, 140) : undefined;
        attempts.push({ model: modelId, outcome: truncated ? "truncated" : kind, ms: now() - t0, ...(detail ? { detail } : {}) });
        lastFailure = kind;
        lastMessage = rejected ? (e as Error).message : kind === "client_error" ? "the model rejected the request" : kind;
        if (kind === "client_error") return fail("client_error", `${modelId}: ${lastMessage}`);
        if (kind === "invalid_output") feedback = lastMessage;
        if (!retried && (kind === "outage" || kind === "invalid_output" || kind === "timeout")) {
          retried = true;
          if (kind === "outage") await delay(300);
          if (kind !== "timeout") continue; // a model that timed out will probably time out again: move on
        }
        break; // next model in the plan
      }
    }
  }
  const code = lastFailure === "timeout" ? "timeout" : lastFailure === "invalid_output" ? "invalid_output" : lastFailure === "outage" ? "outage" : "error";
  return fail(code, `all models failed (${lastMessage})`);
}
