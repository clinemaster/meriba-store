"use client";

import { useState } from "react";

import { Alert, Field, Modal, PageTitle, Spinner, StatusBadge, useConfirm } from "@/components/ui";
import { ColumnPicker } from "@/components/ColumnPicker";
import type { ColumnDef } from "@/lib/columns";
import { useColumnVisibility } from "@/lib/useColumnVisibility";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { centsToApi, formatDate, formatTZS, toCents } from "@/lib/money";
import type { CurrentDay, Day, Shift } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

function varianceText(value: string | null) {
  const cents = toCents(value);
  return cents === 0 ? "None" : cents < 0 ? `Short ${formatTZS(-cents, true)}` : `Over ${formatTZS(cents, true)}`;
}

const SHIFT_COLUMNS: ColumnDef[] = [
  { key: "day", label: "Day", essential: true }, { key: "cashier", label: "Cashier" }, { key: "sales", label: "Sales" },
  { key: "expected", label: "Cash expected" }, { key: "counted", label: "Cash counted" }, { key: "diff", label: "Difference" }, { key: "status", label: "Status" },
];
const DAY_COLUMNS: ColumnDef[] = [
  { key: "day", label: "Business day", essential: true }, { key: "opening", label: "Opening balance" }, { key: "gross", label: "Gross sales" },
  { key: "cancelled", label: "Cancelled" }, { key: "refunds", label: "Refunds" }, { key: "corrections", label: "Corrections" },
  { key: "net", label: "Net sales" }, { key: "closing", label: "Closing balance" }, { key: "status", label: "Status" },
];

export default function ClosingPage() {
  const c1 = useColumnVisibility("closing-shifts", SHIFT_COLUMNS);
  const c2 = useColumnVisibility("closing-days", DAY_COLUMNS);
  const { user } = useAuth();
  const current = useLoad<CurrentDay>("/day/current/");
  const shifts = useLoad<Page<Shift>>("/shifts/?page_size=30");
  const days = useLoad<Page<Day>>("/days/?page_size=31");
  const [review, setReview] = useState<Shift | null>(null);
  const [ticked, setTicked] = useState<number[]>([]);
  const [note, setNote] = useState("");
  const [closing, setClosing] = useState<Shift | null>(null);
  const [correcting, setCorrecting] = useState<Day | null>(null);
  const [corrAmount, setCorrAmount] = useState("");
  const [corrDirection, setCorrDirection] = useState<"down" | "up">("down");
  const [corrKey, setCorrKey] = useState("");
  const [counted, setCounted] = useState("");
  // Owner only: change an open shift's float, or the open day's opening balance.
  const [floatFor, setFloatFor] = useState<Shift | null>(null);
  const [editingOpening, setEditingOpening] = useState(false);
  const [amount, setAmount] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm, confirmation, asking } = useConfirm();

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
      setCorrecting(null);
      setFloatFor(null);
      setEditingOpening(false);
      setAmount("");
      setCorrAmount("");
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
  const isOwner = user?.role === "OWNER";
  const openDay = current.data?.day;
  const amountCents = toCents(amount);
  const amountInvalid = amount.trim() === "" || amountCents < 0 || Number.isNaN(Number(amount.replace(/,/g, "")));
  const startChange = (value: string) => { setAmount(String(Math.round(toCents(value) / 100))); setNote(""); setProblem(null); };

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
              <tr><td>Less refunds given today</td><td className="num">− {formatTZS(figures.refunds)}</td></tr>
              <tr><td className="font-semibold">Net sales today (so far)</td><td className="num font-semibold">{formatTZS(figures.net_sales)}</td></tr>
              <tr><td className="font-semibold">Cumulative sales balance (so far)</td><td className="num font-semibold">{formatTZS(figures.closing_cumulative_sales)}</td></tr>
            </tbody>
          </table>
          {current.data.day.opening_changes.length > 0 && (
            <div className="mt-2 text-sm text-slate-700">
              {current.data.day.opening_changes.map((c) => (
                <div key={c.id}>Opening balance changed by {c.authorised_by}: {formatTZS(c.opening_before)} → {formatTZS(c.opening_after)} · {c.reason}</div>
              ))}
            </div>
          )}
          {isOwner && (
            <button className="btn-secondary mt-3 min-h-[2.5rem]" onClick={() => { setEditingOpening(true); startChange(figures.opening_cumulative_sales); }}>
              Change opening balance…
            </button>
          )}
          {(current.data.open_shifts ?? []).map((s) => (
            <div key={s.id} className="mt-3 flex flex-wrap items-center gap-3">
              <span>{s.cashier_name}&apos;s shift is still open (float {formatTZS(s.opening_float)}).</span>
              {isOwner && <button className="btn-secondary min-h-[2.5rem]" onClick={() => { setFloatFor(s); startChange(s.opening_float); }}>Change float…</button>}
              <button className="btn-secondary min-h-[2.5rem]" onClick={() => { setClosing(s); setProblem(null); }}>Close it for them…</button>
            </div>
          ))}
        </section>
      )}

      <section className="card overflow-x-auto">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-bold">Cashier shifts</h2>
          {(shifts.data?.results.length ?? 0) > 0 && <ColumnPicker visibility={c1} />}
        </div>
        {shifts.loading && !shifts.data ? <Spinner /> : shifts.error ? <Alert kind="error">{shifts.error}</Alert> : (shifts.data?.results.length ?? 0) === 0 ? (
          <p className="text-slate-600">No shifts yet. They appear here once a cashier starts a day.</p>
        ) : (
          <table className="table">
            <thead><tr>
              {c1.show("day") && <th>Day</th>}{c1.show("cashier") && <th>Cashier</th>}{c1.show("sales") && <th className="num">Sales</th>}
              {c1.show("expected") && <th className="num">Cash expected</th>}{c1.show("counted") && <th className="num">Cash counted</th>}
              {c1.show("diff") && <th>Difference</th>}{c1.show("status") && <th>Status</th>}<th />
            </tr></thead>
            <tbody>
              {shifts.data!.results.map((s) => (
                <tr key={s.id}>
                  {c1.show("day") && <td>{formatDate(s.business_date)}</td>}
                  {c1.show("cashier") && <td>{s.cashier_name}</td>}
                  {c1.show("sales") && <td className="num">{s.sales_total === null ? "—" : formatTZS(s.sales_total)}</td>}
                  {c1.show("expected") && <td className="num">{s.expected_cash === null ? "—" : formatTZS(s.expected_cash)}</td>}
                  {c1.show("counted") && <td className="num">{s.counted_cash === null ? "—" : formatTZS(s.counted_cash)}</td>}
                  {c1.show("diff") && <td>{s.cash_variance === null ? "—" : varianceText(s.cash_variance)}</td>}
                  {c1.show("status") && <td><StatusBadge status={s.status} label={s.status_label} /></td>}
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
        <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-bold">Cumulative sales balance history</h2>
          {(days.data?.results.length ?? 0) > 0 && <ColumnPicker visibility={c2} />}
        </div>
        <p className="mb-3 text-slate-600">Closing balance = opening balance + net sales for the day. Each day opens with the previous day&apos;s closing balance, unless the Owner changed it (marked “Changed by Owner”). This is a running total of sales, not cash, profit or stock.</p>
        {days.loading && !days.data ? <Spinner /> : days.error ? <Alert kind="error">{days.error}</Alert> : (days.data?.results.length ?? 0) === 0 ? (
          <p className="text-slate-600">No business days yet.</p>
        ) : (
          <table className="table">
            <thead><tr>
              {c2.show("day") && <th>Business day</th>}{c2.show("opening") && <th className="num">Opening balance</th>}{c2.show("gross") && <th className="num">Gross sales</th>}
              {c2.show("cancelled") && <th className="num">Cancelled</th>}{c2.show("refunds") && <th className="num">Refunds</th>}{c2.show("corrections") && <th className="num">Corrections</th>}
              {c2.show("net") && <th className="num">Net sales</th>}{c2.show("closing") && <th className="num">Closing balance</th>}{c2.show("status") && <th>Status</th>}<th />
            </tr></thead>
            <tbody>
              {days.data!.results.map((d) => (
                <tr key={d.id}>
                  {c2.show("day") && <td>{formatDate(d.date)}</td>}
                  {c2.show("opening") && (
                    <td className="num">
                      {formatTZS(d.opening_cumulative_sales)}
                      {d.opening_changes.length > 0 && <div className="text-xs font-semibold text-amber-800" title={d.opening_changes.map((c) => `${c.authorised_by}: ${c.reason}`).join("\n")}>Changed by Owner</div>}
                    </td>
                  )}
                  {c2.show("gross") && <td className="num">{d.status === "OPEN" ? "—" : formatTZS(d.gross_sales)}</td>}
                  {c2.show("cancelled") && <td className="num">{d.status === "OPEN" ? "—" : formatTZS(d.voids)}</td>}
                  {c2.show("refunds") && <td className="num">{d.status === "OPEN" ? "—" : formatTZS(d.refunds)}</td>}
                  {c2.show("corrections") && <td className="num">{Number(d.adjustments) === 0 ? "—" : formatTZS(d.adjustments)}</td>}
                  {c2.show("net") && <td className="num">{d.status === "OPEN" ? "—" : formatTZS(d.net_sales)}</td>}
                  {c2.show("closing") && <td className="num font-semibold">{d.closing_cumulative_sales === null ? "—" : formatTZS(d.closing_cumulative_sales)}</td>}
                  {c2.show("status") && <td><StatusBadge status={d.status} label={d.status_label} /></td>}
                  <td className="text-right">
                    {user?.role === "OWNER" && d.status === "CLOSED" && (
                      <button className="btn-secondary min-h-[2.5rem]" onClick={() => { setCorrecting(d); setNote(""); setCorrAmount(""); setProblem(null); setCorrKey(crypto.randomUUID()); }}>Correct…</button>
                    )}
                  </td>
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
              {Number(review.cash_refunds) > 0 && <tr><td>Cash refunds paid from the drawer</td><td className="num">− {formatTZS(review.cash_refunds)}</td></tr>}
              {Number(review.cash_paid_out) > 0 && <tr><td>Cash expenses paid from the drawer</td><td className="num">− {formatTZS(review.cash_paid_out)}</td></tr>}
              <tr><td>Cash expected (float {formatTZS(review.opening_float)} + cash sales − cash paid out)</td><td className="num">{formatTZS(review.expected_cash)}</td></tr>
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
            <button className="btn-primary" disabled={busy || asking || review.cashier === user?.id}
              onClick={() => confirm({
                message: `Approve ${review.cashier_name}'s shift? It is then locked; its figures can only be changed by the Owner's recorded correction.`,
                yes: "Yes, approve", run: () => run(() => api(`/shifts/${review.id}/review/`, { method: "POST", body: { note, verified_methods: ticked } })),
              })}>
              {busy ? "Saving…" : "Approve this shift"}
            </button>
            <button className="btn-secondary" onClick={() => setReview(null)}>Cancel</button>
          </div>
        </Modal>
      )}

      {correcting && (
        <Modal title={`Correct the closed day of ${formatDate(correcting.date)}`} onClose={() => setCorrecting(null)} wide>
          <Alert kind="warning">
            Use this only for a formal accounting correction. For a normal customer refund, use “Refund items” on the sale instead; that is recorded on today&apos;s day and leaves closed days alone.
          </Alert>
          <table className="table my-3">
            <tbody>
              <tr><td>Net sales as closed</td><td className="num">{formatTZS(correcting.net_sales)}</td></tr>
              <tr><td>Closing cumulative balance as closed</td><td className="num">{formatTZS(correcting.closing_cumulative_sales)}</td></tr>
            </tbody>
          </table>
          {correcting.corrections.length > 0 && (
            <div className="mb-3 text-sm">
              <div className="font-semibold">Earlier corrections to this day</div>
              {correcting.corrections.map((c) => (
                <div key={c.id}>{formatDate(c.created_at)} · {formatTZS(c.amount)} · {c.authorised_by} · {c.reason} (closing {formatTZS(c.closing_before)} → {formatTZS(c.closing_after)})</div>
              ))}
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <fieldset>
              <legend className="mb-1 font-semibold">What should happen to net sales?</legend>
              <label className="flex items-center gap-2 py-1"><input type="radio" className="h-5 w-5" checked={corrDirection === "down"} onChange={() => setCorrDirection("down")} /> Reduce them</label>
              <label className="flex items-center gap-2 py-1"><input type="radio" className="h-5 w-5" checked={corrDirection === "up"} onChange={() => setCorrDirection("up")} /> Increase them</label>
            </fieldset>
            <Field label="By how much (TZS)?">{(p) => <input {...p} className="input" inputMode="numeric" value={corrAmount} onChange={(e) => setCorrAmount(e.target.value)} />}</Field>
          </div>
          <div className="mt-3">
            <Field label="Reason" hint="Explain clearly what was wrong. This is kept permanently with your name.">
              {(p) => <textarea {...p} className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
          </div>
          {toCents(corrAmount) > 0 && (
            <p className="mt-3 font-semibold">
              New closing balance for this day: {formatTZS(toCents(correcting.closing_cumulative_sales) + (corrDirection === "down" ? -1 : 1) * toCents(corrAmount), true)}.
              Every later day&apos;s opening and closing balance will be recalculated by the same amount.
            </p>
          )}
          {problem && <div className="mt-3"><Alert kind="error">{problem}</Alert></div>}
          <div className="mt-4 flex gap-3">
            <button className="btn-danger" disabled={busy || asking || toCents(corrAmount) <= 0 || note.trim().length < 10}
              onClick={() => confirm({
                message: `${corrDirection === "down" ? "Reduce" : "Increase"} net sales of ${formatDate(correcting.date)} by ${formatTZS(toCents(corrAmount), true)}? Every later day's balance is recalculated. This is kept permanently with your name.`,
                yes: "Yes, record the correction",
                run: () => run(() => api(`/days/${correcting.id}/corrections/`, { method: "POST", body: {
                  request_key: corrKey, reason: note, amount: centsToApi((corrDirection === "down" ? -1 : 1) * toCents(corrAmount)) } })),
              })}>
              {busy ? "Saving…" : "Record this correction"}
            </button>
            <button className="btn-secondary" onClick={() => setCorrecting(null)}>Cancel</button>
          </div>
        </Modal>
      )}

      {closing && (        <Modal title={`Close ${closing.cashier_name}'s shift`} onClose={() => setClosing(null)}>
          <p className="mb-3 text-slate-700">Use this only when the cashier cannot close their own shift. Your name is recorded as the person who closed it.</p>
          <div className="space-y-3">
            <Field label="Cash counted in the drawer (TZS)">{(p) => <input {...p} className="input" inputMode="numeric" value={counted} onChange={(e) => setCounted(e.target.value)} autoFocus />}</Field>
            <Field label="Note" hint="Needed if the cash does not match.">{(p) => <textarea {...p} className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
          </div>
          {problem && <div className="mt-3"><Alert kind="error">{problem}</Alert></div>}
          <div className="mt-4 flex gap-3">
            <button className="btn-primary" disabled={busy || asking || counted.trim() === ""}
              onClick={() => confirm({
                message: `Close ${closing.cashier_name}'s shift with ${formatTZS(toCents(counted), true)} counted in the drawer? They cannot sell on it afterwards. Your name is recorded.`,
                yes: "Yes, close the shift",
                run: () => run(() => api(`/shifts/${closing.id}/close/`, { method: "POST", body: { counted_cash: centsToApi(toCents(counted)), note } })),
              })}>
              {busy ? "Closing…" : "Close this shift"}
            </button>
            <button className="btn-secondary" onClick={() => setClosing(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {floatFor && (
        <Modal title={`Change the float of ${floatFor.cashier_name}'s shift`} onClose={() => setFloatFor(null)}>
          <p className="mb-3 text-slate-700">
            The float is the cash put in the drawer for change. It is now {formatTZS(floatFor.opening_float)}. Cash expected at closing follows the new figure.
            Your name and reason are recorded.
          </p>
          <div className="space-y-3">
            <Field label="Correct float (TZS)" error={amountInvalid ? "Enter an amount of 0 or more." : undefined}>
              {(p) => <input {...p} className="input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} onFocus={(e) => e.target.select()} autoFocus />}
            </Field>
            <Field label="Reason" hint="At least 10 characters, for example what was actually put in the drawer.">
              {(p) => <textarea {...p} className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
          </div>
          {problem && <div className="mt-3"><Alert kind="error">{problem}</Alert></div>}
          <div className="mt-4 flex gap-3">
            <button className="btn-primary" disabled={busy || asking || amountInvalid || amountCents === toCents(floatFor.opening_float) || note.trim().length < 10}
              onClick={() => confirm({
                message: `Change ${floatFor.cashier_name}'s float from ${formatTZS(floatFor.opening_float)} to ${formatTZS(amountCents, true)}? Your name and reason are recorded.`,
                yes: "Yes, change the float",
                run: () => run(() => api(`/shifts/${floatFor.id}/float/`, { method: "POST", body: { opening_float: centsToApi(amountCents), reason: note } })),
              })}>
              {busy ? "Saving…" : "Change float"}
            </button>
            <button className="btn-secondary" onClick={() => setFloatFor(null)}>Cancel</button>
          </div>
        </Modal>
      )}

      {editingOpening && openDay && figures && (
        <Modal title={`Change the opening balance of ${formatDate(openDay.date)}`} onClose={() => setEditingOpening(false)}>
          <p className="mb-3 text-slate-700">
            The opening cumulative sales balance is now {formatTZS(figures.opening_cumulative_sales)}. Today&apos;s closing balance, and every later day, follows the new figure.
            This is a running total of sales, not cash. The old figure, your name and reason are kept permanently.
          </p>
          <div className="space-y-3">
            <Field label="Correct opening balance (TZS)" error={amountInvalid ? "Enter an amount of 0 or more." : undefined}>
              {(p) => <input {...p} className="input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} onFocus={(e) => e.target.select()} autoFocus />}
            </Field>
            <Field label="Reason" hint="At least 10 characters, for example how the correct figure was checked.">
              {(p) => <textarea {...p} className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
          </div>
          {problem && <div className="mt-3"><Alert kind="error">{problem}</Alert></div>}
          <div className="mt-4 flex gap-3">
            <button className="btn-primary" disabled={busy || asking || amountInvalid || amountCents === toCents(figures.opening_cumulative_sales) || note.trim().length < 10}
              onClick={() => confirm({
                message: `Change the opening balance of ${formatDate(openDay.date)} from ${formatTZS(figures.opening_cumulative_sales)} to ${formatTZS(amountCents, true)}? This is kept permanently with your name.`,
                yes: "Yes, change the opening balance",
                run: () => run(() => api(`/days/${openDay.id}/opening-balance/`, { method: "POST", body: { opening_cumulative_sales: centsToApi(amountCents), reason: note } })),
              })}>
              {busy ? "Saving…" : "Change opening balance"}
            </button>
            <button className="btn-secondary" onClick={() => setEditingOpening(false)}>Cancel</button>
          </div>
        </Modal>
      )}
      {confirmation}
    </div>
  );
}
