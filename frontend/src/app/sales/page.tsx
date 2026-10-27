"use client";

import { useMemo, useState } from "react";

import { Receipt } from "@/components/Receipt";
import { ShareReceipt } from "@/components/ShareReceipt";
import { ColumnPicker } from "@/components/ColumnPicker";
import { useBackState } from "@/lib/backNav";
import type { ColumnDef } from "@/lib/columns";
import { useColumnVisibility } from "@/lib/useColumnVisibility";
import { RefundForm } from "@/components/RefundForm";
import { Alert, Field, Modal, PageTitle, Spinner, StatusBadge, useConfirm } from "@/components/ui";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatTime, formatTZS } from "@/lib/money";
import type { CurrentDay, Sale, ShopSettings } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

const COLUMNS: ColumnDef[] = [
  { key: "time", label: "Time" }, { key: "receipt", label: "Receipt", essential: true }, { key: "cashier", label: "Cashier" },
  { key: "paid", label: "Paid by" }, { key: "total", label: "Total" }, { key: "status", label: "Status" },
];

export default function SalesPage() {
  const { user } = useAuth();
  const office = user?.role !== "CASHIER";
  const defs = useMemo(() => COLUMNS.filter((c) => office || c.key !== "cashier"), [office]);
  const cols = useColumnVisibility("sales", defs);
  const current = useLoad<CurrentDay>("/day/current/");
  const shop = useLoad<ShopSettings>("/settings/");
  const [pickedDate, setPickedDate] = useBackState("pickedDate", "");
  const [page, setPage] = useBackState("page", 1);
  const date = pickedDate || current.data?.day?.date || current.data?.today || "";
  const sales = useLoad<Page<Sale>>(date ? `/sales/?date=${date}&page=${page}` : null);
  const [open, setOpen] = useState<Sale | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm, confirmation, asking } = useConfirm();

  function close() {
    setOpen(null);
    setRefunding(false);
    setVoiding(false);
    setReason("");
    setProblem(null);
  }

  function askToCancel() {
    if (!open || busy) return;
    if (reason.trim().length < 5) return setProblem("Write the reason for cancelling this sale.");
    setProblem(null);
    confirm({
      message: `Cancel sale ${open.receipt_number} of ${formatTZS(open.total)}? The items go back into stock and this cannot be undone.`,
      yes: "Yes, cancel this sale", run: cancelSale,
    });
  }

  async function cancelSale() {
    if (!open || busy) return;
    setBusy(true);
    try {
      const updated = await api<Sale>(`/sales/${open.id}/void/`, { method: "POST", body: { reason } });
      setOpen(updated);
      setVoiding(false);
      setProblem(null);
      sales.reload();
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const rows = sales.data?.results ?? [];
  const pages = Math.max(1, Math.ceil((sales.data?.count ?? 0) / 25));

  return (
    <div>
      <PageTitle
        title={office ? "Sales" : "Today's Sales"}
        help={office ? "All sales for the chosen day. Open a sale to see or print its receipt." : "The sales you have made. Open a sale to see or print its receipt again."}
        action={
          <div className="w-56">
            <Field label="Day">{(p) => <input {...p} type="date" className="input" value={date} onChange={(e) => { setPickedDate(e.target.value); setPage(1); }} />}</Field>
          </div>
        }
      />
      <div className="card overflow-x-auto">
        {rows.length > 0 && <div className="mb-3 flex justify-end"><ColumnPicker visibility={cols} /></div>}
        {sales.loading && !sales.data ? <Spinner /> : sales.error ? <Alert kind="error">{sales.error}</Alert> : rows.length === 0 ? (
          <p className="p-4 text-slate-600">No sales recorded for {formatDate(date)}.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                {cols.show("time") && <th>Time</th>}<th>Receipt</th>{office && cols.show("cashier") && <th>Cashier</th>}
                {cols.show("paid") && <th>Paid by</th>}{cols.show("total") && <th className="num">Total</th>}{cols.show("status") && <th>Status</th>}
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className={s.status === "VOIDED" ? "text-slate-500" : ""}>
                  {cols.show("time") && <td>{formatTime(s.created_at)}</td>}
                  <td className="font-mono">{s.receipt_number}</td>
                  {office && cols.show("cashier") && <td>{s.cashier_name}</td>}
                  {cols.show("paid") && <td>{s.payments.map((p) => p.method_name).join(" + ")}</td>}
                  {cols.show("total") && <td className={`num font-semibold ${s.status === "VOIDED" ? "line-through" : ""}`}>{formatTZS(s.total)}</td>}
                  {cols.show("status") && <td><StatusBadge status={s.status} label={s.status_label} /></td>}
                  <td className="text-right"><button className="btn-secondary min-h-[2.5rem]" onClick={() => setOpen(s)}>View</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {pages > 1 && (
          <div className="mt-3 flex items-center justify-end gap-3">
            <button className="btn-secondary min-h-[2.5rem]" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <span>Page {page} of {pages}</span>
            <button className="btn-secondary min-h-[2.5rem]" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        )}
      </div>

      {open && (
        <Modal title={`Receipt ${open.receipt_number}`} onClose={close} wide={refunding}>
          {open.status === "VOIDED" && (
            <div className="no-print mb-3"><Alert kind="warning">Cancelled by {open.voided_by_name}. Reason: {open.void_reason}</Alert></div>
          )}
          {(open.refunds ?? []).map((r) => (
            <div key={r.id} className="no-print mb-3"><Alert kind="info">Refund of {formatTZS(r.total)} by {r.method_name} on {formatDate(r.business_date)} ({r.created_by_name}). Reason: {r.reason}</Alert></div>
          ))}
          <Receipt sale={open} shop={shop.data} />
          {problem && <div className="no-print mt-3"><Alert kind="error">{problem}</Alert></div>}
          {refunding ? (
            <RefundForm sale={open} current={current.data} onCancel={() => setRefunding(false)} onDone={(updated) => { setOpen(updated); setRefunding(false); sales.reload(); }} />
          ) : voiding ? (
            <div className="no-print mt-4 space-y-3">
              <Alert kind="warning">Cancelling puts the items back into stock and removes {formatTZS(open.total)} from today&apos;s sales. The sale stays on record as cancelled. This cannot be undone.</Alert>
              <Field label="Reason for cancelling" hint="For example: wrong product entered, customer returned immediately.">
                {(p) => <input {...p} className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} autoFocus />}
              </Field>
              <div className="flex gap-3">
                <button className="btn-danger" disabled={busy || asking} onClick={askToCancel}>{busy ? "Cancelling…" : "Cancel this sale"}</button>
                <button className="btn-secondary" onClick={() => setVoiding(false)}>Keep the sale</button>
              </div>
            </div>
          ) : (
            <div className="no-print mt-4 flex flex-wrap gap-3">
              <button className="btn-primary" onClick={() => window.print()}>Print Receipt</button>
              {open.status === "COMPLETED" && <ShareReceipt sale={open} shop={shop.data} />}
              <button className="btn-secondary" onClick={close}>Close</button>
              {office && open.status === "COMPLETED" && (
                <span className="ml-auto flex gap-2">
                  <button className="btn-secondary" onClick={() => { setProblem(null); setRefunding(true); }}>Refund items…</button>
                  {(open.refunds ?? []).length === 0 && <button className="btn-danger" onClick={() => setVoiding(true)}>Cancel this sale…</button>}
                </span>
              )}
            </div>
          )}
        </Modal>
      )}
      {confirmation}
    </div>
  );
}
