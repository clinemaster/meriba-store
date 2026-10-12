"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Alert, Field, PageTitle, Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { centsToApi, formatDate, formatTZS, toCents } from "@/lib/money";
import type { SetupStatus } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

const WHERE: Record<string, { href: string; action: string; ownerOnly?: boolean }> = {
  products: { href: "/products", action: "Go to Products" },
  prices: { href: "/products", action: "Go to Products" },
  opening_stock: { href: "/stock", action: "Open the count sheet" },
  cashier: { href: "/users", action: "Go to Users", ownerOnly: true },
  price_questions: { href: "/history", action: "Open Excel History" },
};

export default function SetupPage() {
  const { user } = useAuth();
  const isOwner = user?.role === "OWNER";
  const status = useLoad<SetupStatus>("/setup/status/");
  const [amount, setAmount] = useState("");
  const [asOf, setAsOf] = useState("");
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [newBaseline, setNewBaseline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // Show whatever has been prepared so far, without overwriting what is being typed.
  useEffect(() => {
    const d = status.data;
    if (!d) return;
    setAmount((v) => v || (d.prepared_opening_cumulative_sales !== null ? String(Number(d.prepared_opening_cumulative_sales)) : ""));
    setAsOf((v) => v || d.opening_balance_as_of || "");
    setNote((v) => v || d.opening_balance_note || "");
  }, [status.data]);

  async function act(action: () => Promise<unknown>, done?: string) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setSaved(null);
    try {
      await action();
      await status.reload();
      if (done) setSaved(done);
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (status.loading && !status.data) return <Spinner />;
  if (status.error || !status.data) return <Alert kind="error">{status.error}</Alert>;
  const d = status.data;

  if (d.is_live) {
    return (
      <div className="max-w-2xl space-y-4">
        <PageTitle title="Setup" />
        <Alert kind="success">
          The shop went live{d.went_live_at ? ` on ${formatDate(d.went_live_at)}` : ""} with an approved opening cumulative sales balance of{" "}
          <span className="font-semibold">{formatTZS(d.opening_cumulative_sales)}</span>
          {d.opening_balance_as_of ? ` as of ${formatDate(d.opening_balance_as_of)}` : ""}. Cashiers can start their day and sell.
        </Alert>
      </div>
    );
  }

  const amountTyped = amount.trim() !== "" && Number.isFinite(Number(amount.replace(/,/g, ""))) && toCents(amount) >= 0;
  const isZero = amountTyped && toCents(amount) === 0;
  const balanceBody = { opening_cumulative_sales: centsToApi(toCents(amount)), as_of_date: asOf, note };
  const canGoLive = isOwner && d.ready_to_go_live && amountTyped && asOf !== "" && confirm && (!isZero || newBaseline);

  return (
    <div className="max-w-3xl space-y-5">
      <PageTitle title="First-time Setup"
        help="Finish each step below. The Accountant can prepare the stock count and the opening balance; only the Owner can approve them and switch live selling on. Cashiers cannot sell until then." />
      {problem && <Alert kind="error">{problem}</Alert>}
      {saved && <Alert kind="success">{saved}</Alert>}
      <ol className="space-y-3">
        {d.steps.map((step, i) => (
          <li key={step.key} className="card flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-lg font-semibold"><span aria-hidden>{step.done ? "✔" : "○"}</span> Step {i + 1}. {step.title}</div>
              <div className="text-slate-600">{step.done ? "Done" : "Not done yet"}{step.detail ? ` · ${step.detail}` : ""}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              {WHERE[step.key] && (!WHERE[step.key].ownerOnly || isOwner) && <Link href={WHERE[step.key].href} className="btn-secondary">{WHERE[step.key].action}</Link>}
              {step.key === "opening_stock" && d.opening_stock.pending && <span className="self-center text-sm font-semibold text-amber-800">{isOwner ? "A count sheet is waiting for your approval" : "Waiting for the Owner's approval"}</span>}
            </div>
          </li>
        ))}
      </ol>

      <section className="card space-y-4">
        <h2 className="text-xl font-bold">Opening cumulative sales balance</h2>
        <p className="text-slate-700">
          This is the verified running total of sales up to the agreed cutover date. The first live day opens with it.
          Enter the figure you have reconciled. Enter <strong>0</strong> only if cumulative tracking is deliberately starting fresh —
          not because the past total is unknown.
        </p>
        {d.opening_balance_prepared_by && d.prepared_opening_cumulative_sales !== null && (
          <Alert kind="info">
            Prepared by {d.opening_balance_prepared_by}: <span className="font-semibold">{formatTZS(d.prepared_opening_cumulative_sales)}</span>
            {d.opening_balance_as_of ? ` as of ${formatDate(d.opening_balance_as_of)}` : ""}. Not yet approved.
          </Alert>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Verified balance (TZS)" hint="No figure is filled in for you. Type the reconciled amount.">
            {(p) => <input {...p} className="input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <Field label="Correct as of (cutover date)" hint="The last day covered by this balance.">
            {(p) => <input {...p} className="input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />}
          </Field>
        </div>
        <Field label="How was it verified?" hint="For example: agreed with the Owner from the September and October daily sheets.">
          {(p) => <input {...p} className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <button className="btn-secondary" disabled={busy || !amountTyped || asOf === ""}
          onClick={() => act(() => api("/setup/opening-balance/", { method: "PUT", body: balanceBody }), "Saved for the Owner's approval. Nothing is live yet.")}>
          Save for approval
        </button>
      </section>

      {isOwner ? (
        <section className="card space-y-4">
          <h2 className="text-xl font-bold">Final step. Approve and go live</h2>
          {isZero && (
            <label className="flex items-start gap-3 rounded-lg border-2 border-amber-400 bg-amber-50 p-3">
              <input type="checkbox" className="mt-1 h-6 w-6" checked={newBaseline} onChange={(e) => setNewBaseline(e.target.checked)} />
              <span>I confirm that <strong>TZS 0</strong> is a genuinely new starting point for cumulative sales, not a stand-in for an unknown past total.</span>
            </label>
          )}
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1 h-6 w-6" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            <span>
              I approve the products, prices and opening stock, and an opening cumulative sales balance of{" "}
              <span className="font-semibold">{amountTyped ? formatTZS(toCents(amount), true) : "— (enter it above)"}</span>
              {asOf ? ` as of ${formatDate(asOf)}` : ""}. This cannot be changed afterwards except by a recorded correction.
            </span>
          </label>
          {!d.ready_to_go_live && <Alert kind="info">Finish and approve the steps above first.</Alert>}
          <button className="btn-primary" disabled={busy || !canGoLive}
            onClick={() => act(() => api("/setup/go-live/", { method: "POST", body: { ...balanceBody, confirm: true, confirm_new_baseline: newBaseline } }))}>
            {busy ? "Working…" : "Approve and start live selling"}
          </button>
        </section>
      ) : (
        <Alert kind="info">Only the Owner can approve the opening figures and start live selling.</Alert>
      )}
    </div>
  );
}
