"use client";

import Link from "next/link";
import { useState } from "react";

import { Alert, Field, Modal, PageTitle, Spinner, Stat, StatusBadge } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { centsToApi, formatDate, formatTZS, toCents } from "@/lib/money";
import type { CurrentDay, Shift } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

function ClosedSummary({ shift }: { shift: Shift }) {
  const variance = toCents(shift.cash_variance);
  return (
    <div className="card max-w-3xl space-y-4">
      <Alert kind="success">Your shift for {formatDate(shift.business_date)} is closed. No more sales can be added to it.</Alert>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Your sales" value={formatTZS(shift.sales_total)} strong />
        <Stat label="Cash expected" value={formatTZS(shift.expected_cash)} />
        <Stat label="Cash counted" value={formatTZS(shift.counted_cash)}
          note={variance === 0 ? "Matches exactly" : variance < 0 ? `Short by ${formatTZS(-variance, true)}` : `Over by ${formatTZS(variance, true)}`} />
      </div>
      <p>Status: <StatusBadge status={shift.status} label={shift.status_label} /></p>
      {shift.day?.status === "CLOSED" && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Opening cumulative sales" value={formatTZS(shift.day.opening_cumulative_sales)} />
          <Stat label="Net sales for the day" value={formatTZS(shift.day.net_sales)} />
          <Stat label="Closing cumulative sales" value={formatTZS(shift.day.closing_cumulative_sales)} note="Carried forward to the next day" />
        </div>
      )}
      <Link href="/" className="btn-primary">Back to Home</Link>
    </div>
  );
}

export default function CloseDayPage() {
  const { data, error, loading } = useLoad<CurrentDay>("/day/current/");
  const [counted, setCounted] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [closed, setClosed] = useState<Shift | null>(null);

  if (loading && !data) return <Spinner />;
  if (error || !data) return <Alert kind="error">{error}</Alert>;
  if (closed) return <ClosedSummary shift={closed} />;
  if (!data.shift || !data.shift_figures) {
    return data.closed_shift_today ? <ClosedSummary shift={data.closed_shift_today} /> : (
      <div className="card max-w-xl space-y-4">
        <Alert kind="info">You do not have an open shift to close.</Alert>
        <Link href="/" className="btn-primary">Back to Home</Link>
      </div>
    );
  }

  const { shift, shift_figures: f, day } = data;
  const countedCents = toCents(counted);
  const hasCount = counted.trim() !== "" && Number.isFinite(Number(counted.replace(/,/g, ""))) && countedCents >= 0;
  const variance = countedCents - toCents(f.expected_cash);
  const needsNote = hasCount && variance !== 0;

  async function submit() {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      setClosed(await api<Shift>(`/shifts/${shift.id}/close/`, { method: "POST", body: { counted_cash: centsToApi(countedCents), note } }));
    } catch (err) {
      setProblem(errorMessage(err));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-4xl space-y-5">
      <PageTitle title="Close Day" help={`Closing your shift for ${formatDate(shift.business_date)}. Follow the three steps. After closing, no more sales can be added.`} />

      <section className="card">
        <h2 className="mb-3 text-xl font-bold">Step 1 · Check your sales</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Your sales today" value={formatTZS(f.sales_total)} note={`${f.sale_count} sales`} strong />
          {f.payments.map((p) => <Stat key={p.method} label={`Paid by ${p.name}`} value={formatTZS(p.amount)} note={`${p.count} sales`} />)}
        </div>
        {f.voided_count > 0 && <p className="mt-3 text-slate-700">{f.voided_count} cancelled sale(s) worth {formatTZS(f.voided_total)} are not included.</p>}
        <p className="mt-3 text-sm text-slate-600">Something missing or wrong? <Link href="/sales" className="font-semibold underline">Look at today&apos;s sales</Link> and tell the Accountant before closing.</p>
      </section>

      <section className="card">
        <h2 className="mb-3 text-xl font-bold">Step 2 · Count the cash in the drawer</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Cash float at start" value={formatTZS(f.opening_float)} />
          <Stat label="Cash from sales" value={formatTZS(f.cash_sales)} />
          {Number(f.cash_refunds) > 0 && <Stat label="Cash refunds paid out" value={`− ${formatTZS(f.cash_refunds)}`} note="Given back to customers" />}
          {Number(f.cash_paid_out) > 0 && <Stat label="Cash taken for expenses" value={`− ${formatTZS(f.cash_paid_out)}`} note="Recorded by the Accountant or Owner" />}
          <Stat label="Cash that should be there" value={formatTZS(f.expected_cash)} note="Float + cash sales − cash paid out" strong />
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Cash you counted (TZS)" hint="Count all notes and coins in the drawer, including the float.">
            {(p) => <input {...p} className="input text-xl" inputMode="numeric" value={counted} onChange={(e) => setCounted(e.target.value)} />}
          </Field>
          {hasCount && (
            <div className={`rounded-lg border-2 p-4 ${variance === 0 ? "border-green-300 bg-green-50" : "border-amber-400 bg-amber-50"}`} role="status">
              <div className="text-sm font-semibold">Difference</div>
              <div className="text-2xl font-bold tabular-nums">
                {variance === 0 ? "✔ No difference" : variance < 0 ? `⚠ Short by ${formatTZS(-variance, true)}` : `⚠ Over by ${formatTZS(variance, true)}`}
              </div>
            </div>
          )}
        </div>
        {needsNote && (
          <div className="mt-4">
            <Field label="Explain the difference" hint="Count once more first. If it is still different, write what you think happened. The Accountant will review it.">
              {(p) => <textarea {...p} className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="mb-3 text-xl font-bold">Step 3 · Close</h2>
        {day && (
          <p className="mb-3 text-slate-700">
            The day opened with a cumulative sales balance of <span className="font-semibold">{formatTZS(day.opening_cumulative_sales)}</span>.
            When the day is closed, today&apos;s net sales are added to it and carried forward to the next day. This running total is separate from the cash you counted.
          </p>
        )}
        {problem && <div className="mb-3"><Alert kind="error">{problem}</Alert></div>}
        <button className="btn-primary" disabled={!hasCount || (needsNote && note.trim() === "")} onClick={() => setConfirming(true)}>Review and Close…</button>
        {!hasCount && <p className="mt-2 text-sm text-slate-600">Enter the cash you counted to continue.</p>}
      </section>

      {confirming && (
        <Modal title="Close your shift?" onClose={() => !busy && setConfirming(false)}>
          <table className="table mb-4">
            <tbody>
              <tr><td>Your sales</td><td className="num font-semibold">{formatTZS(f.sales_total)}</td></tr>
              <tr><td>Cash that should be there</td><td className="num font-semibold">{formatTZS(f.expected_cash)}</td></tr>
              <tr><td>Cash you counted</td><td className="num font-semibold">{formatTZS(countedCents, true)}</td></tr>
              <tr><td>Difference</td><td className="num font-semibold">{variance === 0 ? "None" : variance < 0 ? `Short ${formatTZS(-variance, true)}` : `Over ${formatTZS(variance, true)}`}</td></tr>
            </tbody>
          </table>
          <Alert kind="warning">After closing you cannot add or change sales for this shift. Only the Owner or Accountant can make corrections.</Alert>
          <div className="mt-4 flex gap-3">
            <button className="btn-primary" disabled={busy} onClick={submit}>{busy ? "Closing…" : "Yes, close my shift"}</button>
            <button className="btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>Go back</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
