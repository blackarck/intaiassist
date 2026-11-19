import { getTask, taskNames, type TaskName } from "./tasks/index.js";
import type { TaskDefaults } from "./tasks/types.js";

/** What an operator can change per task without a deploy. Anything unset falls back to the task's built-in default. */
export interface TaskConfig extends TaskDefaults {
  enabled: boolean;
  /** Only sent to models that accept one. */
  temperature?: number;
}
export type TaskOverride = Partial<TaskConfig>;

export interface AiConfigStore {
  getOverrides(): Promise<Record<string, TaskOverride>>;
  setOverride(task: string, patch: TaskOverride): Promise<void>;
  clearOverride(task: string): Promise<void>;
}

export interface AiRun {
  at: string;
  task: string;
  interviewId?: string;
  /** Catalog id of the model that produced the answer, or the last one tried. */
  model?: string;
  ok: boolean;
  /** `ok` or an error code: timeout, outage, invalid_output, disabled, not_configured, bad_input. */
  outcome: string;
  attempts: { model: string; outcome: string; ms: number; /** Which rule rejected the answer. Never contains interview text. */ detail?: string }[];
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

/** Operational log of AI calls. Holds NO prompts, transcripts or answers: only what ran, how fast, and what it cost. */
export interface AiRunLog {
  record(run: AiRun): Promise<void>;
  recent(limit: number): Promise<AiRun[]>;
}

export class InMemoryAiStore implements AiConfigStore, AiRunLog {
  private overrides: Record<string, TaskOverride> = {};
  private runs: AiRun[] = [];
  async getOverrides() {
    return structuredClone(this.overrides);
  }
  async setOverride(task: string, patch: TaskOverride) {
    this.overrides[task] = { ...this.overrides[task], ...patch };
  }
  async clearOverride(task: string) {
    delete this.overrides[task];
  }
  async record(run: AiRun) {
    this.runs.push(run);
    if (this.runs.length > 1000) this.runs.shift();
  }
  async recent(limit: number) {
    return this.runs.slice(-limit).reverse();
  }
}

export async function effectiveConfig(store: AiConfigStore, task: TaskName | string): Promise<TaskConfig | undefined> {
  const def = getTask(task);
  if (!def) return undefined;
  const o = (await store.getOverrides())[task] ?? {};
  return { enabled: true, ...def.defaults, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) };
}

export async function allEffectiveConfigs(store: AiConfigStore) {
  return Object.fromEntries(await Promise.all(taskNames.map(async (t) => [t, await effectiveConfig(store, t)] as const)));
}
