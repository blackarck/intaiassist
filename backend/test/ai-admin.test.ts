import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryAiStore } from "../src/ai/configStore.js";
import { buildApp } from "../src/app.js";
import { InMemoryStore } from "../src/store.js";
import { fakeController } from "./helpers.js";

const nextQ = {
  stance: "partly_right",
  remark: "Cause found, prevention missing.",
  questions: [{ text: "What would you monitor to catch it earlier?", remark: "prevention was not covered" }, { text: "How did you confirm the cause?", remark: "tests diagnosis" }],
  proof: null,
};

describe("admin AI routes", () => {
  let app: ReturnType<typeof buildApp>;
  let ai: InMemoryAiStore;
  const H = { authorization: "Bearer api-token" };
  const call = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = H) =>
    app.inject({ method, url, headers, payload: payload as never });

  beforeEach(() => {
    ai = new InMemoryAiStore();
    const models = () =>
      new MockLanguageModelV4({
        doGenerate: async () =>
          ({
            content: [{ type: "text", text: JSON.stringify(nextQ) }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: { inputTokens: { total: 50 }, outputTokens: { total: 10 } },
            warnings: [],
          }) as never,
      });
    app = buildApp({ store: new InMemoryStore(), controller: fakeController(), aliasDomain: "invite.askproso.ai", intakeToken: "api-token", enableDevRoutes: false, ai: { config: ai, log: ai, models } });
  });

  it("is protected by the API token", async () => {
    expect((await call("GET", "/api/admin/ai/config", undefined, {})).statusCode).toBe(401);
  });

  it("lists the model catalog and each task's effective settings", async () => {
    const body = (await call("GET", "/api/admin/ai/config")).json();
    expect(body.models.length).toBeGreaterThan(5);
    expect(Object.keys(body.tasks).sort()).toEqual(["assist", "live_coach", "opening_questions", "score_answer", "scorecard"]);
    expect(body.tasks.score_answer).toMatchObject({ enabled: true, primary: "anthropic:sonnet" });
  });

  it("saves a change, validates it, and can reset it", async () => {
    expect((await call("PUT", "/api/admin/ai/config/assist", { primary: "azure:gpt-5.4-nano", timeoutMs: 4000, enabled: false })).statusCode).toBe(200);
    expect((await call("GET", "/api/admin/ai/config")).json().tasks.assist).toMatchObject({ primary: "azure:gpt-5.4-nano", timeoutMs: 4000, enabled: false });

    for (const bad of [{ primary: "made-up-model" }, { timeoutMs: 5 }, { temperature: 9 }, { enabled: "yes" }, { maxOutputTokens: 1.5 }])
      expect((await call("PUT", "/api/admin/ai/config/assist", bad)).statusCode, JSON.stringify(bad)).toBe(400);
    expect((await call("PUT", "/api/admin/ai/config/nope", {})).statusCode).toBe(404);

    await call("DELETE", "/api/admin/ai/config/assist");
    expect((await call("GET", "/api/admin/ai/config")).json().tasks.assist.primary).toBe("azure:gpt-5.4-mini");
  });

  it("Test runs a task on its sample, records the run, and a switched-off task refuses", async () => {
    const ok = (await call("POST", "/api/admin/ai/test/live_coach")).json();
    expect(ok).toMatchObject({ ok: true, output: nextQ });
    const runs = (await call("GET", "/api/admin/ai/runs")).json().runs;
    expect(runs[0]).toMatchObject({ task: "live_coach", interviewId: "admin-test", ok: true, inputTokens: 50 });

    await call("PUT", "/api/admin/ai/config/live_coach", { enabled: false });
    expect((await call("POST", "/api/admin/ai/test/live_coach")).json()).toMatchObject({ ok: false, error: { code: "disabled" } });
  });

  it("answers 501 when AI is not configured", async () => {
    const bare = buildApp({ store: new InMemoryStore(), controller: fakeController(), aliasDomain: "x.test", intakeToken: "api-token", enableDevRoutes: false });
    expect((await bare.inject({ method: "GET", url: "/api/admin/ai/config", headers: H })).statusCode).toBe(501);
  });
});
