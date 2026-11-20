import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { InMemoryStore } from "../src/store.js";
import { stripeSupport } from "../src/support.js";
import { fakeController } from "./helpers.js";

const stripeOk = () => vi.fn(async () => new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test_123" }), { status: 200 }));

function setup(support?: ReturnType<typeof stripeSupport>) {
  const store = new InMemoryStore();
  const app = buildApp({ store, transcripts: store, controller: fakeController(), aliasDomain: "invite.example.com", intakeToken: "op", enableDevRoutes: false, devAuth: true, support });
  const headers = { authorization: "Dev asha@example.com" };
  return { app, headers };
}

describe("optional support payment", () => {
  it("reports disabled and refuses checkout when Stripe is not configured", async () => {
    const { app, headers } = setup();
    expect((await app.inject({ method: "GET", url: "/api/me/support", headers })).json()).toEqual({ enabled: false, amounts: [] });
    expect((await app.inject({ method: "POST", url: "/api/me/support/checkout", headers, payload: { amount: 5 } })).statusCode).toBe(501);
  });

  it("creates a Checkout Session for each fixed amount, in cents, with return URLs", async () => {
    const fetchMock = stripeOk();
    const { app, headers } = setup(stripeSupport({ secretKey: "sk_test_placeholder", webBaseUrl: "https://app.example.com/", fetch: fetchMock as never }));
    expect((await app.inject({ method: "GET", url: "/api/me/support", headers })).json()).toEqual({ enabled: true, amounts: [5, 7, 10] });
    for (const [amount, cents] of [[5, "500"], [7, "700"], [10, "1000"]] as const) {
      const res = await app.inject({ method: "POST", url: "/api/me/support/checkout", headers, payload: { amount } });
      expect(res.json()).toEqual({ url: "https://checkout.stripe.com/c/pay/cs_test_123" });
      const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit];
      const body = new URLSearchParams(init.body as URLSearchParams);
      expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk_test_placeholder");
      expect(body.get("line_items[0][price_data][unit_amount]")).toBe(cents);
      expect(body.get("success_url")).toBe("https://app.example.com/?support=thanks");
      expect(body.get("cancel_url")).toBe("https://app.example.com/?support=cancelled");
    }
  });

  it("rejects any amount that is not on the fixed list, without calling Stripe", async () => {
    const fetchMock = stripeOk();
    const { app, headers } = setup(stripeSupport({ secretKey: "sk_test_placeholder", webBaseUrl: "https://app.example.com", fetch: fetchMock as never }));
    for (const amount of [1, 6, 0, -5, 5.5, "5", null, undefined]) {
      expect((await app.inject({ method: "POST", url: "/api/me/support/checkout", headers, payload: { amount } as never })).statusCode).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 502 without leaking Stripe details when Stripe fails", async () => {
    const failing = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Invalid API Key provided: sk_test_***" } }), { status: 401 }));
    const { app, headers } = setup(stripeSupport({ secretKey: "sk_test_placeholder", webBaseUrl: "https://app.example.com", fetch: failing as never }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await app.inject({ method: "POST", url: "/api/me/support/checkout", headers, payload: { amount: 5 } });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toMatch(/sk_test|Invalid API Key/);
  });

  it("is not available to anonymous callers", async () => {
    const { app } = setup(stripeSupport({ secretKey: "sk_test_placeholder", webBaseUrl: "https://app.example.com", fetch: stripeOk() as never }));
    expect((await app.inject({ method: "POST", url: "/api/me/support/checkout", payload: { amount: 5 } })).statusCode).toBe(401);
  });
});
