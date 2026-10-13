"use client";

import { useState } from "react";

import { Alert, Field, PageTitle, Spinner } from "@/components/ui";
import { formatDate, formatQty } from "@/lib/money";
import { useLoad } from "@/lib/useLoad";

/** The Daily Sheet: the shop's Excel worksheet for one day, with the workbook's headings, order and formulas. */
type Line = {
  number: number; details: string; unit: string; opening: string | null; purchases: string | null; total_stock: string | null;
  sales: string | null; closing_stock: string | null; purchase_price: string | null; sales_price: string | null;
  total_sales: string | null; profit: string | null; stock: string | null; total_purchases: string | null;
  other_movements: string; recorded_sales_value: string | null; differs_from_recorded: boolean;
  source?: string; formula_differs?: string[]; incomplete?: boolean;
};
type Sheet = {
  date: string; source: "LIVE" | "CLOSED" | "EXCEL" | "NONE"; note: string; lines: Line[];
  totals: Record<"purchases" | "sales" | "total_sales" | "profit" | "stock" | "total_purchases", string>;
  previous_date: string | null; next_date: string | null; columns: { key: string; label: string }[];
  lines_with_other_movements: number; lines_differing_from_recorded: number; lines_where_formula_differs: number;
};

// Shown as plain numbers with thousands separators, the way the workbook shows them (no "TZS" on every cell).
const n = (value: string | null | undefined, blankZero = false) =>
  value === null || value === undefined || value === "" ? "" : blankZero && Number(value) === 0 ? "" : formatQty(value);

const KIND = { LIVE: "info", CLOSED: "success", EXCEL: "warning", NONE: "info" } as const;

export default function DailySheetPage() {
  const [date, setDate] = useState("");
  const sheet = useLoad<Sheet>(`/daily-sheet/${date ? `?date=${date}` : ""}`);
  const data = sheet.data;

  return (
    <div className="space-y-4">
      <PageTitle title="Daily Sheet"
        help="The same sheet you keep in Excel, one for each day, with the same columns and the same sums. The system fills it in from the day's deliveries and sales and carries each product's closing stock forward as the next day's opening stock." />

      <div className="card flex flex-wrap items-end gap-3">
        <button className="btn-secondary" disabled={!data?.previous_date} onClick={() => data?.previous_date && setDate(data.previous_date)}>← Previous sheet</button>
        <div className="w-52"><Field label="Sheet for">{(p) => <input {...p} type="date" className="input" value={date || data?.date || ""} onChange={(e) => setDate(e.target.value)} />}</Field></div>
        <button className="btn-secondary" disabled={!data?.next_date} onClick={() => data?.next_date && setDate(data.next_date)}>Next sheet →</button>
        <button className="btn-secondary" onClick={() => setDate("")}>Today</button>
        {data && data.lines.length > 0 && <a className="btn-secondary ml-auto" href={`/api/v1/daily-sheet/?date=${data.date}&download=csv`}>Download for Excel (CSV)</a>}
      </div>

      {sheet.loading && !data ? <Spinner /> : sheet.error || !data ? <Alert kind="error">{sheet.error}</Alert> : (
        <>
          <Alert kind={KIND[data.source]}><strong>{formatDate(data.date)}.</strong> {data.note}</Alert>
          {data.lines_where_formula_differs > 0 && (
            <Alert kind="warning">On {data.lines_where_formula_differs} line(s) a figure written in the workbook is not what the workbook&apos;s own formula gives (usually an empty cell). They are marked ⚠ and shown as written; nothing has been corrected.</Alert>
          )}
          {data.lines_with_other_movements > 0 && (
            <Alert kind="info">{data.lines_with_other_movements} line(s) also had a return, a count correction or a breakage, which the Excel sheet has no column for. It is shown under “Other” so that closing stock still adds up.</Alert>
          )}
          {data.lines_differing_from_recorded > 0 && (
            <Alert kind="info">On {data.lines_differing_from_recorded} line(s) the money actually taken differs from Sales × Sales price (a refund, a package sold at its own price, or a price changed during the day). The sheet keeps the Excel sum; the amount taken is shown beside it.</Alert>
          )}

          <div className="card overflow-x-auto p-0">
            {data.lines.length === 0 ? <p className="p-6 text-slate-600">{data.note} Use the arrows to move to a day that has a sheet.</p> : (
              <table className="table min-w-[1200px]">
                <thead className="sticky top-0 bg-white">
                  <tr>
                    {data.columns.map((c, i) => <th key={c.key} className={i >= 2 ? "num" : ""}>{c.label}</th>)}
                    {data.lines_with_other_movements > 0 && <th className="num">Other</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.lines.map((l) => {
                    const flagged = new Set(l.formula_differs ?? []);
                    const cell = (key: keyof Line, value: string, extra = "") => (
                      <td className={`num ${extra} ${flagged.has(key as string) ? "bg-amber-50 font-semibold" : ""}`}
                        title={flagged.has(key as string) ? "Written differently in the workbook from what its formula gives" : undefined}>
                        {flagged.has(key as string) ? `⚠ ${value || "(empty)"}` : value}
                      </td>
                    );
                    return (
                      <tr key={`${l.number}-${l.details}`}>
                        <td>{l.number}</td>
                        <td className="whitespace-nowrap font-semibold" title={l.source}>{l.details}{l.incomplete && <span className="ml-1 text-sm font-normal text-amber-800" title="Affected by an open exception in Excel History">⚠</span>}</td>
                        <td className="num">{n(l.opening)}</td>
                        <td className="num">{n(l.purchases, true)}</td>
                        {cell("total_stock", n(l.total_stock))}
                        <td className="num">{n(l.sales, true)}</td>
                        {cell("closing_stock", n(l.closing_stock), "font-semibold")}
                        <td className="num">{n(l.purchase_price)}</td>
                        <td className="num">{n(l.sales_price)}</td>
                        <td className={`num ${flagged.has("total_sales") ? "bg-amber-50" : ""}`}>
                          {n(l.total_sales)}
                          {l.differs_from_recorded && <span className="block text-sm text-slate-600" title="Money actually taken for this product, after refunds">taken {n(l.recorded_sales_value)}</span>}
                        </td>
                        {cell("profit", n(l.profit))}
                        {cell("stock", n(l.stock))}
                        {cell("total_purchases", n(l.total_purchases))}
                        {data.lines_with_other_movements > 0 && <td className="num">{Number(l.other_movements) ? `${Number(l.other_movements) > 0 ? "+" : ""}${n(l.other_movements)}` : ""}</td>}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="font-bold">
                    <td /><td>TOTAL</td><td /><td className="num">{n(data.totals.purchases)}</td><td /><td className="num">{n(data.totals.sales)}</td><td /><td /><td />
                    <td className="num">{n(data.totals.total_sales)}</td><td className="num">{n(data.totals.profit)}</td>
                    <td className="num">{n(data.totals.stock)}</td><td className="num">{n(data.totals.total_purchases)}</td>
                    {data.lines_with_other_movements > 0 && <td />}
                  </tr>
                </tfoot>
              </table>
            )}
          </div>

          <details className="card text-sm text-slate-700">
            <summary className="cursor-pointer font-semibold">How each column is worked out (the same sums as the Excel workbook)</summary>
            <ul className="ml-5 mt-2 list-disc space-y-1">
              <li><strong>Opening stock</strong> = the previous sheet&apos;s Closing stock.</li>
              <li><strong>Total stock</strong> = Opening stock + Add Purchases.</li>
              <li><strong>Closing stock</strong> = Total stock − Sales.</li>
              <li><strong>Total Sales</strong> = Sales × Sales price.</li>
              <li><strong>Profit</strong> = Sales × (Sales price − Purchase price).</li>
              <li><strong>Stock</strong> = Closing stock × Sales price (the value of what is left, at selling price).</li>
              <li><strong>T.Purchases</strong> = Add Purchases × Purchase price.</li>
            </ul>
          </details>
        </>
      )}
    </div>
  );
}
