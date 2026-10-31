"use client";

import { useEffect, useMemo, useState } from "react";

import { Alert, Field, PageTitle, Spinner, StockBadge } from "@/components/ui";
import { ColumnPicker } from "@/components/ColumnPicker";
import { useBackState } from "@/lib/backNav";
import type { ColumnDef } from "@/lib/columns";
import { useColumnVisibility } from "@/lib/useColumnVisibility";
import { formatDate, formatQty, formatTZS } from "@/lib/money";
import { STOCK_LEVELS, STOCK_ORDER } from "@/lib/stockLevels";
import { useLoad } from "@/lib/useLoad";

// The stock reports send each product's level as its label ("Low stock"); shown with its colour and icon.
const STOCK_BY_LABEL = new Map(STOCK_ORDER.map((s) => [STOCK_LEVELS[s].label, s]));

type ReportInfo = { key: string; title: string; uses_dates: boolean; section?: string };
type Column = { key: string; label: string; kind: "money" | "quantity" | "text" | "date" };
type Report = {
  title: string; uses_dates: boolean; date_from: string | null; date_to: string | null; columns: Column[];
  rows: Record<string, string | number | null>[]; totals: Record<string, string>;
};

const HELP: Record<string, string> = {
  "daily-sales": "One line per business day. Net sales = gross sales − cancelled sales − refunds + corrections. Closing cumulative = opening + net sales.",
  "sales-by-product": "What was sold in the period, less refunds given in the period.",
  "sales-by-cashier": "Completed and cancelled sales for each cashier.",
  "payment-summary": "Money received by each payment method, less refunds. “Checked” means the Accountant or Owner verified it against phone or bank records.",
  closings: "Each cashier's closing: cash expected, cash counted and the difference.",
  "stock-on-hand": "What the system says is on the shelves now. Value uses each product's purchase cost where one is recorded.",
  "low-stock": "Products at or below their low-stock level. Suggested order = target − in stock.",
  "stock-daily": "For each product: opening + received − sold + returned ± counts = closing. “Ledger check” should always be 0.",
  "damage-register": "Confirmed damage records, their stock movements and price snapshots. Reversed records remain visible but are excluded from damage totals.",
  "damage-daily": "Daily damaged quantity and valuation. Damage at selling price is a retail valuation, not sales revenue or a cash expense.",
  "damage-monthly": "Monthly damaged quantity and valuation, based on the business date recorded at confirmation.",
  "damage-by-product": "Confirmed damage quantity and value by product for the selected period.",
  "damage-by-branch": "Confirmed damage quantity and value by branch for the selected period.",
  purchases: "Deliveries recorded on the Receive Stock page.",
  expenses: "Recorded expenses (cancelled ones are left out).",
  "financial-summary": "Sales, purchases and expenses side by side. This is not a profit figure.",
  "payment-daily": "Per business day: sales beside the money collected by each category. Net collections = collected − refunds paid. Reconciliation difference = net collections − (net sales − corrections − outstanding credit), and should be 0.",
  "payment-weekly": "As the daily reconciliation, one line per week (Monday to Sunday).",
  "payment-monthly": "As the daily reconciliation, one line per month.",
  "payment-providers": "Money collected through each provider (M-PESA, NMB, …). The lines add up to the payments collected. “Checked” means verified against the phone or bank statement.",
  "payment-cashiers": "Money each cashier took, by category, and refunds given on their sales.",
};

function show(value: string | number | null | undefined, kind: Column["kind"]): string {
  if (value === null || value === undefined || value === "") return "—";
  if (kind === "money") return formatTZS(value);
  if (kind === "quantity") return formatQty(value);
  if (kind === "date") return formatDate(String(value));
  return String(value);
}

function firstOfMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export default function ReportsPage() {
  const list = useLoad<ReportInfo[]>("/reports/");
  const [key, setKey] = useBackState("key", "");
  const [from, setFrom] = useBackState("from", firstOfMonth());
  const [to, setTo] = useBackState("to", today());
  // Arriving from a Payments card (/reports?key=payment-daily&date_from=…) opens that report for those dates.
  useEffect(() => {
    const asked = new URLSearchParams(window.location.search);
    const date = (k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(asked.get(k) ?? "") ? asked.get(k)! : null);
    if (asked.get("key")) setKey(asked.get("key")!);
    if (date("date_from")) setFrom(date("date_from")!);
    if (date("date_to")) setTo(date("date_to")!);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!key && list.data?.length) setKey(list.data[0].key);
  }, [key, list.data]);
  const sections = [...new Set((list.data ?? []).map((r) => r.section ?? "Reports"))];

  const info = list.data?.find((r) => r.key === key);
  const badDates = !!info?.uses_dates && (!from || !to || from > to);
  const query = info?.uses_dates ? `?date_from=${from}&date_to=${to}` : "";
  const report = useLoad<Report>(key && !badDates ? `/reports/${key}/${query}` : null);
  const defs = useMemo<ColumnDef[]>(() => (report.data?.columns ?? []).map((c) => ({ key: c.key, label: c.label })), [report.data]);
  const cols = useColumnVisibility(`report-${key}`, defs);
  const shown = (report.data?.columns ?? []).filter((c) => cols.show(c.key));

  if (list.loading && !list.data) return <Spinner />;
  if (list.error) return <Alert kind="error">{list.error}</Alert>;

  return (
    <div className="space-y-5">
      <PageTitle title="Reports" help="Choose a report and the dates. Every figure is worked out from the recorded sales, payments and stock movements." />
      <div className="card no-print grid gap-4 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <Field label="Report">
            {(p) => (
              <select {...p} className="input" value={key} onChange={(e) => setKey(e.target.value)}>
                {sections.map((section) => (
                  <optgroup key={section} label={section}>
                    {(list.data ?? []).filter((r) => (r.section ?? "Reports") === section).map((r) => <option key={r.key} value={r.key}>{r.title}</option>)}
                  </optgroup>
                ))}
              </select>
            )}
          </Field>
        </div>
        {info?.uses_dates && (
          <>
            <Field label="From">{(p) => <input {...p} type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
            <Field label="To">{(p) => <input {...p} type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} />}</Field>
          </>
        )}
      </div>

      {badDates && <Alert kind="error">Choose a “From” date that is on or before the “To” date.</Alert>}
      <section className="card overflow-x-auto">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold">{info?.title}</h2>
            {report.data?.uses_dates && <p className="text-slate-600">{formatDate(report.data.date_from)} to {formatDate(report.data.date_to)}</p>}
            {HELP[key] && <p className="mt-1 max-w-3xl text-sm text-slate-600">{HELP[key]}</p>}
          </div>
          {report.data && report.data.rows.length > 0 && (
            <div className="no-print ml-auto flex flex-wrap items-center justify-end gap-2">
              <ColumnPicker visibility={cols} />
              <a className="btn-secondary" href={`/api/v1/reports/${key}/${query}${query ? "&" : "?"}download=xlsx`}>Download Excel</a>
              <a className="btn-secondary" href={`/api/v1/reports/${key}/${query}${query ? "&" : "?"}download=csv`}>Download CSV</a>
              <button type="button" className="btn-secondary" onClick={() => window.print()} title="Choose “Save as PDF” as the printer">Print / Save as PDF</button>
            </div>
          )}
        </div>
        {report.loading ? <Spinner /> : report.error ? <Alert kind="error">{report.error}</Alert> : !report.data ? null : report.data.rows.length === 0 ? (
          <p className="p-4 text-slate-600">Nothing to show for this choice.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>{shown.map((c) => <th key={c.key} className={c.kind === "money" || c.kind === "quantity" ? "num" : ""}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {report.data.rows.map((row, i) => (
                <tr key={i}>
                  {shown.map((c) => {
                    const level = c.key === "status" ? STOCK_BY_LABEL.get(String(row[c.key])) : undefined;
                    return <td key={c.key} className={c.kind === "money" || c.kind === "quantity" ? "num whitespace-nowrap" : ""}>{level ? <StockBadge status={level} /> : show(row[c.key], c.kind)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
            {Object.keys(report.data.totals).length > 0 && (
              <tfoot>
                <tr className="font-bold">
                  {shown.map((c, i) => (
                    <td key={c.key} className={c.kind === "money" || c.kind === "quantity" ? "num" : ""}>
                      {i === 0 ? "Total" : c.key in report.data!.totals ? show(report.data!.totals[c.key], c.kind) : ""}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </section>
    </div>
  );
}
