"use client";

import { useState } from "react";

import { Alert, Field, Modal, PageTitle, Spinner, StatusBadge } from "@/components/ui";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { centsToApi, formatDate, formatTZS, toCents } from "@/lib/money";
import type { CurrentDay, Day, Shift } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

function varianceText(value: string | null) {
  const cents = toCents(value);
  return cents === 0 ? "None" : cents < 0 ? `Short ${formatTZS(-cents, true)}` : `Over ${formatTZS(cents, true)}`;
}

export default function ClosingPage() {
  const { user } = useAuth();
  const current = useLoad<CurrentDay>("/day/current/");
  const shifts = useLoad<Page<Shift>>("/shifts/?page_size=30");
  const days = useLoad<Page<Day>>("/days/?page_size=31");
  const [review, setReview] = useState<Shift | null>(null);
  const [ticked, setTicked] = useState<number[]>([]);
  const [note, setNote] = useState("");
  const [closing, setClosing] = useState<Shift | null>(null);
  const [counted, setCounted] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reloadAll() {
    current.reload();
    shifts.reload();
    days.reload();
  }

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await action();
      setReview(null);
      setClosing(null);
      setNote("");
      setCounted("");
      setTicked([]);
      reloadAll();
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const figures = current.data?.day_figures;

  return (
    <div className="space-y-6">
      <PageTitle title="Daily Closing" help="Review each cashier's closing, check non-cash payments against the phone or bank records, and see the cumulative sales balance day by day." />

      {current.data?.day && figures && (
        <section className="card">
          <h2 className="mb-1 text-xl font-bold">Open day · {formatDate(current.data.day.date)}</h2>
          <p className="mb-3 text-slate-600">The day closes automatically when the last open shift is closed.</p>
          <table className="table max-w-xl">
            <tbody>
              <tr><td>Opening cumulative sales balance</td><td className="num">{formatTZS(figures.opening_cumulative_sales)}</td></tr>
              <tr><td>Gross sales today</td><td className="num">{formatTZS(figures.gross_sales)}</td></tr>
              <tr><td>Less cancelled sales</td><td className="num">− {formatTZS(figures.voids)}</td></tr>
              <tr><td className="font-semibold">Net sales today (so far)</td><td className="num font-semibold">{formatTZS(figures.net_sales)}</td></tr>
              <tr><td className="font-semibold">Cumulative sales balance (so far)</td><td className="num font-semibold">{formatTZS(figures.closing_cumulative_sales)}</td></tr>
            </tbody>
          </table>
          {(current.data.open_shifts ?? []).map((s) => (
            <div key={s.id} className="mt-3 flex flex-wrap items-center gap-3">
              <span>{s.cashier_name}&apos;s shift is still open.</span>
              <button className="btn-secondary min-h-[2.5rem]" onClick={() => { setClosing(s); setProblem(null); }}>Close it for them…</button>
            </div>
          ))}
        </section>
      )}

      <section className="card overflow-x-auto">
        <h2 className="mb-3 text-xl font-bold">Cashier shifts</h2>
        {shifts.loading && !shifts.data ? <Spinner /> : shifts.error ? <Alert kind="error">{shifts.error}</Alert> : (shifts.data?.results.length ?? 0) === 0 ? (
          <p className="text-slate-600">No shifts yet. They appear here once a cashier starts a day.</p>
        ) : (
          <table className="table">
            <thead><tr><th>Day</th><th>Cashier</th><th className="num">Sales</th><th className="num">Cash expected</th><th className="num">Cash counted</th><th>Difference</th><th>Status</th><th /></tr></thead>
            <tbody>
              {shifts.data!.results.map((s) => (
                <tr key={s.id}>
                  <td>{formatDate(s.business_date)}</td>
                  <td>{s.cashier_name}</td>
                  <td className="num">{s.sales_total === null ? "—" : formatTZS(s.sales_total)}</td>
                  <td className="num">{s.expected_cash === null ? "—" : formatTZS(s.expected_cash)}</td>
                  <td className="num">{s.counted_cash === null ? "—" : formatTZS(s.counted_cash)}</td>
                  <td>{s.cash_variance === null ? "—" : varianceText(s.cash_variance)}</td>
                  <td><StatusBadge status={s.status} label={s.status_label} /></td>
                  <td className="text-right">
                    {s.status !== "OPEN" && s.status !== "APPROVED" && (
                      <button className="btn-secondary min-h-[2.5rem]" onClick={() => { setReview(s); setTicked([]); setNote(""); setProblem(null); }}>Review</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card overflow-x-auto">
        <h2 className="mb-1 text-xl font-bold">Cumulative sales balance history</h2>
        <p className="mb-3 text-slate-600">Closing balance = opening balance + net sales for the day. Each day opens with the previous day&apos;s closing balance. This is a running total of sales, not cash, profit or stock.</p>
        {days.loading && !days.data ? <Spinner /> : days.error ? <Alert kind="error">{days.error}</Alert> : (days.data?.results.length ?? 0) === 0 ? (
          <p className="text-slate-600">No business days yet.</p>
        ) : (
          <table className="table">
            <thead><tr><th>Business day</th><th className="num">Opening balance</th><th className="num">Gross sales</th><th className="num">Cancelled</th><th className="num">Net sales</th><th className="num">Closing balance</th><th>Status</th></tr></thead>
            <tbody>
              {days.data!.results.map((d) => (
                <tr key={d.id}>
                  <td>{formatDate(d.date)}</td>
                  <td className="num">{formatTZS(d.opening_cumulative_sales)}</td>
                  <td className="num">{d.status === "OPEN" ? "—" : formatTZS(d.gross_sales)}</td>
                  <td className="num">{d.status === "OPEN" ? "—" : formatTZS(d.voids)}</td>
                  <td className="num">{d.status === "OPEN" ? "—" : formatTZS(d.net_sales)}</td>
                  <td className="num font-semibold">{d.closing_cumulative_sales === null ? "—" : formatTZS(d.closing_cumulative_sales)}</td>
                  <td><StatusBadge status={d.status} label={d.status_label} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {review && (
        <Modal title={`Review ${review.cashier_name}'s shift · ${formatDate(review.business_date)}`} onClose={() => setReview(null)} wide>
          <table className="table mb-3">
            <tbody>
              <tr><td>Sales</td><td className="num">{formatTZS(review.sales_total)}</td></tr>
              <tr><td>Cash expected (float {formatTZS(review.opening_float)} + cash sales)</td><td className="num">{formatTZS(review.expected_cash)}</td></tr>
              <tr><td>Cash counted</td><td className="num">{formatTZS(review.counted_cash)}</td></tr>
              <tr><td className="font-semibold">Difference</td><td className="num font-semibold">{varianceText(review.cash_variance)}</td></tr>
            </tbody>
          </table>
          {review.closing_note && <p className="mb-3">Cashier&apos;s note: <em>{review.closing_note}</em></p>}
          {review.payment_totals.filter((t) => !t.is_cash).length > 0 && (
            <fieldset className="mb-3">
              <legend className="mb-1 font-semibold">Tick each total after checking it against the phone or bank record</legend>
              {review.payment_totals.filter((t) => !t.is_cash).map((t) => (
                <label key={t.method} className="flex items-center gap-3 py-1">
                  <input type="checkbox" className="h-6 w-6" disabled={t.is_verified} checked={t.is_verified || ticked.includes(t.method)}
                    onChange={(e) => setTicked((list) => (e.target.checked ? [...list, t.method] : list.filter((id) => id !== t.method)))} />
                  <span>{t.name}: <span className="font-semibold">{formatTZS(t.amount)}</span> in {t.count} sale(s){t.is_verified ? " · already checked" : ""}</span>
                </label>
              ))}
            </fieldset>
          )}
          <Field label={review.status === "DISCREPANCY" ? "How was the cash difference resolved?" : "Note (optional)"}>
            {(p) => <textarea {...p} className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          {review.cashier === user?.id && <div className="mt-3"><Alert kind="warning">This is your own shift. Another Owner or Accountant must approve it.</Alert></div>}
          {problem && <div className="mt-3"><Alert kind="error">{problem}</Alert></div>}
          <div className="mt-4 flex gap-3">
            <button className="btn-primary" disabled={busy || review.cashier === user?.id}
              onClick={() => run(() => api(`/shifts/${review.id}/review/`, { method: "POST", body: { note, verified_methods: ticked } }))}>
              {busy ? "Saving…" : "Approve this shift"}
            </button>
            <button className="btn-secondary" onClick={() => setReview(null)}>Cancel</button>
          </div>
        </Modal>
      )}

      {closing && (
        <Modal title={`Close ${closing.cashier_name}'s shift`} onClose={() => setClosing(null)}>
          <p className="mb-3 text-slate-700">Use this only when the cashier cannot close their own shift. Your name is recorded as the person who closed it.</p>
          <div className="space-y-3">
            <Field label="Cash counted in the drawer (TZS)">{(p) => <input {...p} className="input" inputMode="numeric" value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus />}</Field>
            <Field label="Note" hint="Needed if the cash does not match.">{(p) => <textarea {...p} className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          </div>
          {problem && <div className="mt-3"><Alert kind="error">{problem}</Alert></div>}
          <div className="mt-4 flex gap-3">
            <button className="btn-primary" disabled={busy || counted.trim() === ""}
              onClick={() => run(() => api(`/shifts/${closing.id}/close/`, { method: "POST", body: { counted_cash: centsToApi(toCents(counted)), note } }))}>
              {busy ? "Closing…" : "Close this shift"}
            </button>
            <button className="btn-secondary" onClick={() => setClosing(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
