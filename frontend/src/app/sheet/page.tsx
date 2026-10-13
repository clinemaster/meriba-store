"use client";

import Link from "next/link";
import { useState } from "react";

import { Alert, Field, Modal, PageTitle, Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { formatDate, formatQty, formatTZS } from "@/lib/money";
import type { CurrentDay } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

import { SheetSale } from "./SheetSale";

/** The Daily Sheet: the shop's Excel worksheet for one day, with the workbook's headings, order and formulas. */
type Line = {
  number: number; product: number | null; details: string; unit: string; opening: string | null; purchases: string | null;
  total_stock: string | null; sales: string | null; closing_stock: string | null; purchase_price?: string | null;
  sales_price: string | null; total_sales: string | null; profit?: string | null; stock: string | null; total_purchases?: string | null;
  other_movements: string; recorded_sales_value: string | null; differs_from_recorded: boolean;
  source?: string; formula_differs?: string[]; incomplete?: boolean; approved_profit?: string | null;
};
type EmptyCell = {
  id: number; date: string; worksheet: string; row: number; product: string; sales: string; purchase_price: string | null;
  sales_price: string | null; formula_would_give: string | null;
  correction: { approved_value: string; reason: string; approved_by: string; approved_at: string } | null;
};
type EmptyCells = { cells: EmptyCell[]; count: number; awaiting_review: number };
type Sheet = {
  date: string; source: "LIVE" | "CLOSED" | "EXCEL" | "NONE"; note: string; lines: Line[];
  totals: Record<string, string>;
  previous_date: string | null; next_date: string | null; columns: { key: string; label: string }[];
  lines_with_other_movements: number; lines_differing_from_recorded: number; lines_where_formula_differs: number;
};

// Shown as plain numbers with thousands separators, the way the workbook shows them (no "TZS" on every cell).
const n = (value: string | null | undefined, blankZero = false) =>
  value === null || value === undefined || value === "" ? "" : blankZero && Number(value) === 0 ? "" : formatQty(value);

const KIND = { LIVE: "info", CLOSED: "success", EXCEL: "warning", NONE: "info" } as const;
const BLANK_ZERO = new Set(["purchases", "sales"]);

export default function DailySheetPage() {
  const [date, setDate] = useState("");
  const sheet = useLoad<Sheet>(`/daily-sheet/${date ? `?date=${date}` : ""}`);
  const current = useLoad<CurrentDay>("/day/current/");
  const [typed, setTyped] = useState<Record<number, string>>({});
  const [entry, setEntry] = useState<{ line: Line; quantity: number } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const data = sheet.data;
  const words = find.toLowerCase().split(/\s+/).filter(Boolean);
  const visible = (data?.lines ?? []).filter((l) => words.every((w) => l.details.toLowerCase().includes(w)));

  // Purchase prices and profit are sent to the Owner and Accountant only; the cashier's sheet has no such columns.
  const office = !!data?.columns.some((c) => c.key === "profit");
  // Sales are typed on today's sheet by whoever has started their day at the till.
  const canType = data?.source === "LIVE" && !!current.data?.shift && data.date === current.data.today;

  function begin(line: Line) {
    const quantity = Number(typed[line.number]);
    if (!Number.isInteger(quantity) || quantity <= 0) return;
    setSaved(null);
    setEntry({ line, quantity });
  }

  return (
    <div className="space-y-4">
      <PageTitle title="Daily Sheet"
        help="The same sheet you keep in Excel, one for each day, with the same columns and the same sums. Type the quantity sold against a product and the sheet works out the rest, and carries each product's closing stock forward as the next day's opening stock." />

      {office && (
        <div className="card flex flex-wrap items-end gap-3">
          <button className="btn-secondary" disabled={!data?.previous_date} onClick={() => data?.previous_date && setDate(data.previous_date)}>← Previous sheet</button>
          <div className="w-52"><Field label="Sheet for">{(p) => <input {...p} type="date" className="input" value={date || data?.date || ""} onChange={(e) => setDate(e.target.value)} />}</Field></div>
          <button className="btn-secondary" disabled={!data?.next_date} onClick={() => data?.next_date && setDate(data.next_date)}>Next sheet →</button>
          <button className="btn-secondary" onClick={() => setDate("")}>Today</button>
          {data && data.lines.length > 0 && <a className="btn-secondary ml-auto" href={`/api/v1/daily-sheet/?date=${data.date}&download=csv`}>Download for Excel (CSV)</a>}
        </div>
      )}

      {sheet.loading && !data ? <Spinner /> : sheet.error || !data ? <Alert kind="error">{sheet.error}</Alert> : (
        <>
          <Alert kind={KIND[data.source]}><strong>{formatDate(data.date)}.</strong> {data.note}</Alert>
          {saved && <Alert kind="success">{saved}</Alert>}
          {canType && <Alert kind="info">To record a sale, type the quantity sold in the “Add to Sales” box beside the product and press Save. You can do this as often as you need during the day; each entry is added to the Sales column.</Alert>}
          {data.lines.length > 1 && (
            <div className="max-w-md"><Field label="Find a product on the sheet">{(p) => <input {...p} className="input" value={find} autoComplete="off" placeholder="Type part of the name" onChange={(e) => setFind(e.target.value)} />}</Field></div>
          )}
          {data.source === "NONE" && !office && (
            <div className="card max-w-xl space-y-3"><p>Start your day to open today&apos;s sheet.</p><Link href="/day/start" className="btn-primary">Start Day</Link></div>
          )}
          {data.source === "LIVE" && !current.loading && !current.data?.shift && (
            <Alert kind="info">Sales can be typed on this sheet by the person who has started their day at the till. <Link className="font-semibold underline" href="/day/start">Start Day</Link></Alert>
          )}
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
            {data.lines.length === 0 ? <p className="p-6 text-slate-600">{data.note}{office && " Use the arrows to move to a day that has a sheet."}</p> : (
              <table className="table min-w-[1200px]">
                <thead className="sticky top-0 bg-white">
                  <tr>
                    {data.columns.map((c, i) => <th key={c.key} className={i >= 2 ? "num" : ""}>{c.label}</th>)}
                    {data.lines_with_other_movements > 0 && <th className="num">Other</th>}
                    {canType && <th>Add to Sales</th>}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((l) => {
                    const flagged = new Set(l.formula_differs ?? []);
                    const left = Number(l.closing_stock ?? 0);
                    return (
                      <tr key={`${l.number}-${l.details}`}>
                        {data.columns.map((c) => {
                          const value = (l as unknown as Record<string, string | number | null>)[c.key];
                          if (c.key === "number") return <td key={c.key}>{l.number}</td>;
                          if (c.key === "details") return (
                            <td key={c.key} className="whitespace-nowrap font-semibold" title={l.source}>{l.details}{l.incomplete && <span className="ml-1 text-sm font-normal text-amber-800" title="Affected by an open exception in Excel History">⚠</span>}</td>
                          );
                          const text = n(value as string | null, BLANK_ZERO.has(c.key));
                          const warn = flagged.has(c.key);
                          return (
                            <td key={c.key} className={`num ${c.key === "closing_stock" ? "font-semibold" : ""} ${warn ? "bg-amber-50 font-semibold" : ""}`}
                              title={warn ? "Written differently in the workbook from what its formula gives" : undefined}>
                              {warn ? `⚠ ${text || "(empty)"}` : text}
                              {c.key === "profit" && l.approved_profit && <span className="block text-sm font-normal text-slate-700" title="Approved by the Owner. The workbook's cell is still empty.">Owner approved {n(l.approved_profit)}</span>}
                              {c.key === "total_sales" && l.differs_from_recorded && <span className="block text-sm text-slate-600" title="Money actually taken for this product, after refunds">taken {n(l.recorded_sales_value)}</span>}
                            </td>
                          );
                        })}
                        {data.lines_with_other_movements > 0 && <td className="num">{Number(l.other_movements) ? `${Number(l.other_movements) > 0 ? "+" : ""}${n(l.other_movements)}` : ""}</td>}
                        {canType && (
                          <td>
                            {l.product && left > 0 ? (
                              <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); begin(l); }}>
                                <input aria-label={`Quantity of ${l.details} sold`} className="input min-h-[2.5rem] w-20 text-center" inputMode="numeric" placeholder="0"
                                  value={typed[l.number] ?? ""} onChange={(e) => setTyped((t) => ({ ...t, [l.number]: e.target.value.replace(/\D/g, "") }))} />
                                <button className="btn-secondary min-h-[2.5rem] px-3" disabled={!Number(typed[l.number])} aria-label={`Save sale of ${l.details}`}>Save</button>
                              </form>
                            ) : <span className="text-sm text-slate-600">{l.product ? "Out of stock" : ""}</span>}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="font-bold">
                    {data.columns.map((c) => <td key={c.key} className={c.key === "details" ? "" : "num"}>{c.key === "details" ? "TOTAL" : n(data.totals[c.key])}</td>)}
                    {data.lines_with_other_movements > 0 && <td />}
                    {canType && <td />}
                  </tr>
                </tfoot>
              </table>
            )}
          </div>

          {office && <EmptyProfitCells onOpen={setDate} onChanged={sheet.reload} />}

          <details className="card text-sm text-slate-700">
            <summary className="cursor-pointer font-semibold">How each column is worked out (the same sums as the Excel workbook)</summary>
            <ul className="ml-5 mt-2 list-disc space-y-1">
              <li><strong>Opening stock</strong> = the previous sheet&apos;s Closing stock.</li>
              <li><strong>Total stock</strong> = Opening stock + Add Purchases.</li>
              <li><strong>Closing stock</strong> = Total stock − Sales.</li>
              <li><strong>Total Sales</strong> = Sales × Sales price.</li>
              {office && <li><strong>Profit</strong> = Sales × (Sales price − Purchase price).</li>}
              <li><strong>Stock</strong> = Closing stock × Sales price (the value of what is left, at selling price).</li>
              {office && <li><strong>T.Purchases</strong> = Add Purchases × Purchase price.</li>}
            </ul>
          </details>
        </>
      )}

      {entry && (
        <SheetSale line={entry.line} quantity={entry.quantity} onClose={() => setEntry(null)}
          onSaved={(sale) => {
            setTyped((t) => ({ ...t, [entry.line.number]: "" }));
            setSaved(`Saved: ${sale.items.map((i) => `${formatQty(i.quantity)} ${i.unit_name} × ${i.product_name}`).join(", ")}, ${formatTZS(sale.total)}. Receipt ${sale.receipt_number}.`);
            sheet.reload();
          }} />
      )}
    </div>
  );
}

/** Profit cells the workbook left empty on a line with sales. They stay empty; only the Owner may approve a figure. */
function EmptyProfitCells({ onOpen, onChanged }: { onOpen: (date: string) => void; onChanged: () => void }) {
  const cells = useLoad<EmptyCells>("/history/empty-profit-cells/");
  const me = useLoad<{ role: string }>("/auth/me/");
  const [open, setOpen] = useState<EmptyCell | null>(null);
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!cells.data || cells.data.count === 0) return null;

  async function approve() {
    if (!open || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await api(`/history/empty-profit-cells/${open.id}/correct/`, { method: "POST", body: { approved_value: value, reason } });
      setOpen(null);
      cells.reload();
      onChanged();
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="card">
      <summary className="cursor-pointer font-semibold">
        Empty Profit cells in the Excel workbook: {cells.data.count} ({cells.data.awaiting_review} waiting for the Owner&apos;s review)
      </summary>
      <p className="mt-2 text-sm text-slate-700">On these lines the workbook shows sales but its Profit cell is empty. They are kept empty here and are not counted in the workbook&apos;s totals. Nothing is filled in automatically. If the Owner approves a figure, it is recorded beside the cell with the reason, the name and the date.</p>
      <div className="mt-3 overflow-x-auto">
        <table className="table">
          <thead><tr><th>Sheet</th><th>Row</th><th>Product</th><th className="num">Sales</th><th className="num">Purchase price</th><th className="num">Sales price</th><th className="num">Profit in workbook</th><th className="num">The workbook&apos;s sum would give</th><th>Owner&apos;s decision</th></tr></thead>
          <tbody>
            {cells.data.cells.map((c) => (
              <tr key={c.id}>
                <td><button className="font-semibold text-brand-700 underline" onClick={() => onOpen(c.date)}>{c.worksheet}</button></td>
                <td>{c.row}</td><td>{c.product}</td><td className="num">{n(c.sales)}</td><td className="num">{n(c.purchase_price)}</td><td className="num">{n(c.sales_price)}</td>
                <td className="num">(empty)</td><td className="num">{n(c.formula_would_give)}</td>
                <td>{c.correction
                  ? <span className="text-sm">Approved {n(c.correction.approved_value)} by {c.correction.approved_by}, {formatDate(c.correction.approved_at)}. {c.correction.reason}</span>
                  : me.data?.role === "OWNER"
                    ? <button className="btn-secondary min-h-[2.5rem]" onClick={() => { setOpen(c); setValue(""); setReason(""); setProblem(null); }}>Approve a figure…</button>
                    : <span className="text-sm text-slate-600">Waiting for the Owner</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && (
        <Modal title="Approve a Profit figure" onClose={() => setOpen(null)}>
          <div className="space-y-4">
            <p>{open.worksheet}, row {open.row}: <strong>{open.product}</strong>. {n(open.sales)} sold at {n(open.sales_price)}, purchase price {n(open.purchase_price)}. The workbook&apos;s sum would give {n(open.formula_would_give) || "no figure"}.</p>
            <p className="text-sm text-slate-700">The workbook&apos;s cell stays empty. Your figure is recorded beside it and cannot be replaced afterwards.</p>
            <Field label="Approved Profit (TZS)">{(p) => <input {...p} className="input" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value.replace(/[^0-9.-]/g, ""))} />}</Field>
            <Field label="Reason">{(p) => <textarea {...p} className="input" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
            {problem && <Alert kind="error">{problem}</Alert>}
            <div className="flex flex-wrap gap-3">
              <button className="btn-primary" disabled={busy || value === "" || reason.trim().length < 5} onClick={approve}>{busy ? "Saving…" : "Record the approved figure"}</button>
              <button className="btn-secondary" disabled={busy} onClick={() => setOpen(null)}>Cancel</button>
            </div>
          </div>
        </Modal>
      )}
    </details>
  );
}
