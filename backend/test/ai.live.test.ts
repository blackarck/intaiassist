import { describe, it } from "vitest";
import { InMemoryAiStore } from "../src/ai/configStore.js";
import { envModelFactory } from "../src/ai/models.js";
import { runTask } from "../src/ai/runner.js";
import { TASKS, type TaskName } from "../src/ai/tasks/index.js";

/**
 * Live model bake-off. COSTS MONEY (a few cents) and needs provider keys, so it only runs when LIVE_AI=1:
 *   LIVE_AI=1 node --env-file=.env node_modules/vitest/vitest.mjs run test/ai.live.test.ts
 * Prints, per task and model: pass rate over RUNS calls (valid + finalize-checked output) and latency. No content is printed.
 * Each model runs ALONE (primary = fallback = itself, no retries beyond the runner's one), so numbers are for that model.
 */
const RUNS = Number(process.env.LIVE_RUNS ?? 2);
const FAST = ["azure:gpt-5.4-nano", "azure:gpt-5.4-mini", "azure:gpt-5.6-luna", "azure:gpt-6-luna", "anthropic:haiku", "azure:llama-4-maverick", "azure:gpt-oss-120b"];
const SLOW = ["anthropic:sonnet", "azure:gpt-5.4", "azure:gpt-6-astra", "anthropic:haiku", "azure:gpt-5.6-terra"];
const plan: Record<TaskName, string[]> = {
  opening_questions: FAST,
  live_coach: FAST,
  assist: FAST,
  score_answer: SLOW,
  scorecard: SLOW,
};
const only = process.env.LIVE_TASKS?.split(",");

describe.skipIf(!process.env.LIVE_AI)("live bake-off", () => {
  const models = envModelFactory(process.env);
  for (const [task, ids] of Object.entries(plan) as [TaskName, string[]][]) {
    if (only && !only.includes(task)) continue;
    it(task, { timeout: 600_000 }, async () => {
      const rows: string[] = [];
      for (const id of ids) {
        const store = new InMemoryAiStore();
        await store.setOverride(task, { primary: id, fallback: id, deadlineMs: 120_000, timeoutMs: 60_000 });
        const times: number[] = [];
        let ok = 0;
        const errs = new Set<string>();
        for (let n = 0; n < RUNS; n++) {
          const t0 = Date.now();
          const res = await runTask({ config: store, models }, task, TASKS[task].sample);
          times.push(Date.now() - t0);
          if (res.ok) ok++;
          else errs.add(res.error.code + ":" + res.error.message.slice(0, 90));
        }
        times.sort((a, b) => a - b);
        rows.push(`${id.padEnd(26)} ok ${ok}/${RUNS}  median ${String(times[Math.floor(times.length / 2)]).padStart(6)} ms  max ${String(times.at(-1)).padStart(6)} ms${errs.size ? "  ERR " + [...errs].join(" | ") : ""}`);
      }
      console.log(`\n== ${task}\n${rows.join("\n")}`);
    });
  }
});
