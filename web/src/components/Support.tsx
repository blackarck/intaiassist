import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api";
import { useLoad } from "../hooks";
import { ErrorNote } from "./ui";

/**
 * Optional, voluntary payment. Nothing in the product depends on it. Renders nothing unless the backend has Stripe set up,
 * and can be dismissed. The amounts come from the backend, which is the only place that decides what may be charged.
 */
export function SupportCard() {
  const { data } = useLoad<{ enabled: boolean; amounts: number[] }>("/api/me/support");
  const [params, setParams] = useSearchParams();
  const [busy, setBusy] = useState<number>();
  const [error, setError] = useState<string>();
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem("support-hidden") === "1";
    } catch {
      return false;
    }
  });

  const result = params.get("support");
  const closeResult = () => setParams((p) => (p.delete("support"), p), { replace: true });

  if (result === "thanks") {
    return (
      <div className="card flex items-center justify-between gap-3 p-4 text-sm">
        <span>Thank you, that really helps keep this running.</span>
        <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={closeResult}>Close</button>
      </div>
    );
  }
  if (!data?.enabled || data.amounts.length === 0 || hidden) return null;

  const pay = async (amount: number) => {
    setBusy(amount);
    setError(undefined);
    try {
      const { url } = await api<{ url: string }>("/api/me/support/checkout", { method: "POST", body: { amount } });
      window.location.assign(url); // Stripe's hosted payment page; it returns here afterwards
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not start the payment.");
      setBusy(undefined);
    }
  };

  const dismiss = () => {
    try {
      localStorage.setItem("support-hidden", "1");
    } catch {
      /* storage blocked: it just comes back next visit */
    }
    setHidden(true);
  };

  return (
    <div className="card space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium">Enjoying Interview Assist?</p>
          <p className="text-sm muted">Everything works without paying. If you want to chip in towards running costs, pick an amount. Entirely optional.</p>
        </div>
        <button className="btn-ghost !px-2.5 !py-1 text-xs" onClick={dismiss} aria-label="Hide this">Hide</button>
      </div>
      <div className="flex flex-wrap gap-2">
        {data.amounts.map((a) => (
          <button key={a} className="btn-ghost" disabled={busy !== undefined} onClick={() => pay(a)}>{busy === a ? "Opening…" : `$${a}`}</button>
        ))}
      </div>
      {result === "cancelled" && <p className="text-xs muted">No payment was made.</p>}
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

/** A one-line, low-key reminder shown under the interview setup form. Same optional payment as SupportCard; nothing is gated. */
export function SupportNote() {
  const { data } = useLoad<{ enabled: boolean; amounts: number[] }>("/api/me/support");
  const [busy, setBusy] = useState<number>();
  const [error, setError] = useState<string>();
  const amounts = data?.enabled ? data.amounts : [];

  const pay = async (amount: number) => {
    setBusy(amount);
    setError(undefined);
    try {
      const { url } = await api<{ url: string }>("/api/me/support/checkout", { method: "POST", body: { amount } });
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not start the payment.");
      setBusy(undefined);
    }
  };

  return (
    <p className="text-xs muted">
      Found Interview Assist useful? It costs real money to run (servers, the meeting bot and AI models), so a small contribution helps keep it going. Entirely optional.
      {amounts.map((a) => (
        <button key={a} type="button" className="ml-2 underline hover:no-underline disabled:opacity-50" disabled={busy !== undefined} onClick={() => pay(a)}>{busy === a ? "Opening…" : `$${a}`}</button>
      ))}
      {error && <span className="ml-2 text-red-700 dark:text-red-400">{error}</span>}
    </p>
  );
}
