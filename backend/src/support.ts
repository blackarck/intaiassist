/**
 * Optional "support us" payments through Stripe Checkout. Nothing in the product is gated on this: a person may pay one of
 * the fixed amounts or not pay at all. Payments are therefore not tracked (no webhook, no database rows); Stripe's own
 * dashboard is the record.
 *
 * Talks to Stripe's REST API with fetch, so there is no SDK dependency. Amounts are fixed here on the server, so a browser
 * cannot ask for an arbitrary price.
 */

/** The amounts a person can choose from, in whole US dollars. */
export const SUPPORT_AMOUNTS_USD = [5, 7, 10] as const;

export interface SupportService {
  amounts: readonly number[];
  /** Creates a Stripe Checkout Session for one of the fixed amounts and returns the hosted payment page URL. */
  createCheckout(amountUsd: number): Promise<string>;
}

export interface SupportOptions {
  /** Stripe secret key (sk_test_... or sk_live_...). */
  secretKey: string;
  /** Public URL of the web app, no trailing slash. Stripe sends the person back here after paying or cancelling. */
  webBaseUrl: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export function stripeSupport(opts: SupportOptions): SupportService {
  const doFetch = opts.fetch ?? fetch;
  const base = opts.webBaseUrl.replace(/\/$/, "");
  return {
    amounts: SUPPORT_AMOUNTS_USD,
    async createCheckout(amountUsd) {
      if (!(SUPPORT_AMOUNTS_USD as readonly number[]).includes(amountUsd)) throw new Error("amount not allowed");
      const form = new URLSearchParams({
        mode: "payment",
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": String(amountUsd * 100),
        "line_items[0][price_data][product_data][name]": "Support Interview Assist",
        success_url: `${base}/?support=thanks`,
        cancel_url: `${base}/?support=cancelled`,
      });
      const res = await doFetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { authorization: `Bearer ${opts.secretKey}`, "content-type": "application/x-www-form-urlencoded" },
        body: form,
      });
      const body = (await res.json().catch(() => undefined)) as { url?: string; error?: { message?: string } } | undefined;
      if (!res.ok || !body?.url) throw new Error(`stripe: ${body?.error?.message ?? `HTTP ${res.status}`}`);
      return body.url;
    },
  };
}
