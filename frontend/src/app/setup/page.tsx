"use client";

import Link from "next/link";
import { useState } from "react";

import { Alert, Field, PageTitle, Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { centsToApi, formatDate, formatTZS, toCents } from "@/lib/money";
import type { SetupStatus } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

const WHERE: Record<string, { href: string; action: string }> = {
  products: { href: "/products", action: "Go to Products" },
  prices: { href: "/products", action: "Go to Products" },
  opening_stock: { href: "/stock", action: "Enter opening stock" },
  cashier: { href: "/users", action: "Go to Users" },
};

export default function SetupPage() {
  const status = useLoad<SetupStatus & { went_live_at?: string }>("/setup/status/");
  const [opening, setOpening] = useState("0");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function act(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await action();
      await status.reload();
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (status.loading && !status.data) return <Spinner />;
  if (status.error || !status.data) return <Alert kind="error">{status.error}</Alert>;
  const { steps, is_live, ready_to_go_live } = status.data;

  if (is_live) {
    return (
      <div className="max-w-2xl space-y-4">
        <PageTitle title="Setup" />
        <Alert kind="success">
          The shop went live{status.data.went_live_at ? ` on ${formatDate(status.data.went_live_at)}` : ""} with an opening cumulative sales balance of{" "}
          <span className="font-semibold">{formatTZS(status.data.opening_cumulative_sales)}</span>. Cashiers can start their day and sell.
        </Alert>
      </div>
    );
  }

  const stockStep = steps.find((s) => s.key === "opening_stock");
  const othersDone = steps.filter((s) => s.key !== "opening_stock").every((s) => s.done);

  return (
    <div className="max-w-3xl space-y-5">
      <PageTitle title="First-time Setup" help="Finish each step below. When every step shows “Done”, confirm the opening figures and switch live selling on. Cashiers cannot sell until then." />
      {problem && <Alert kind="error">{problem}</Alert>}
      <ol className="space-y-3">
        {steps.map((step, i) => (
          <li key={step.key} className="card flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-lg font-semibold">
                <span aria-hidden>{step.done ? "✔" : "○"}</span> Step {i + 1}. {step.title}
              </div>
              <div className="text-slate-600">{step.done ? "Done" : "Not done yet"}{step.detail ? ` · ${step.detail}` : ""}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              {WHERE[step.key] && <Link href={WHERE[step.key].href} className="btn-secondary">{WHERE[step.key].action}</Link>}
              {step.key === "opening_stock" && !step.done && (
                <button className="btn-primary" disabled={busy}
                  onClick={() => window.confirm("Confirm that the opening stock you entered is the real physical count? After going live it can only be changed by a recorded stock adjustment.")
                    && act(() => api("/stock/opening/confirm/", { method: "POST" }))}>
                  I have entered all the counted stock
                </button>
              )}
            </div>
          </li>
        ))}
      </ol>

      <section className="card space-y-4">
        <h2 className="text-xl font-bold">Final step. Go live</h2>
        <Field label="Opening cumulative sales balance (TZS)"
          hint="The running sales total the first day starts from. Leave it at 0 unless you have an approved figure to continue from. It cannot be changed after going live.">
          {(p) => <input {...p} className="input max-w-xs" inputMode="numeric" value={opening} onChange={(e) => setOpening(e.target.value)} />}
        </Field>
        <label className="flex items-start gap-3">
          <input type="checkbox" className="mt-1 h-6 w-6" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          <span>I confirm that the products, prices and opening stock are correct, and that the first day should open with a cumulative sales balance of <span className="font-semibold">{formatTZS(toCents(opening), true)}</span>.</span>
        </label>
        {!ready_to_go_live && <Alert kind="info">Finish the steps above first{othersDone && stockStep && !stockStep.done ? ": confirm the opening stock" : ""}.</Alert>}
        <button className="btn-primary" disabled={busy || !confirm || !ready_to_go_live}
          onClick={() => act(() => api("/setup/go-live/", { method: "POST", body: { opening_cumulative_sales: centsToApi(toCents(opening)), confirm: true } }))}>
          {busy ? "Working…" : "Start live selling"}
        </button>
      </section>
    </div>
  );
}
