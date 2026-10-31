"use client";

import { useMemo, useState } from "react";

import { Receipt } from "@/components/Receipt";
import { ShareReceipt } from "@/components/ShareReceipt";
import { ColumnPicker } from "@/components/ColumnPicker";
import { ActionButton, DataTable, Pagination, TableToolbar } from "@/components/DataTable";
import { useBackState } from "@/lib/backNav";
import type { TableColumn } from "@/lib/table";
import { useColumnVisibility } from "@/lib/useColumnVisibility";
import { RefundForm } from "@/components/RefundForm";
import { Alert, Field, Modal, PageTitle, StatusBadge, useConfirm } from "@/components/ui";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatTZS } from "@/lib/money";
import { paymentLabel } from "@/lib/payments";
import type { CurrentDay, Sale, ShopSettings } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

const voided = (s: Sale) => s.status === "VOIDED";

const COLUMNS: TableColumn<Sale>[] = [
  { key: "time", label: "Time", type: "time", accessor: "created_at" },
  { key: "receipt", label: "Receipt", essential: true, accessor: "receipt_number", className: "font-mono" },
  { key: "cashier", label: "Cashier", accessor: "cashier_name" },
  { key: "paid", label: "Paid by", accessor: (s) => s.payments.map((p) => paymentLabel(p.method_name, p.provider_name)).join(" + ") },
  { key: "total", label: "Total", type: "currency", className: (s) => `font-semibold ${voided(s) ? "line-through" : ""}` },
  { key: "status", label: "Status", render: (s) => <StatusBadge status={s.status} label={s.status_label} /> },
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
      yes: "Yes, cancel this sale", danger: true, run: cancelSale,
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
      <div className="card">
        {rows.length > 0 && <TableToolbar><ColumnPicker visibility={cols} /></TableToolbar>}
        <DataTable label="Sales" columns={defs} visibility={cols} rows={rows} rowKey={(s) => s.id}
          loading={sales.loading && !sales.data} error={sales.error} empty={`No sales recorded for ${formatDate(date)}.`}
          rowClassName={(s) => (voided(s) ? "text-slate-500" : "")}
          actions={(s) => <ActionButton aria-label={`View receipt ${s.receipt_number}`} onClick={() => setOpen(s)}>View</ActionButton>} />
        <Pagination page={page} pages={pages} onPage={setPage} />
      </div>

      {open && (
        <Modal title={`Receipt ${open.receipt_number}`} onClose={close} wide={refunding}>
          {open.status === "VOIDED" && (
            <div className="no-print mb-3"><Alert kind="warning">Cancelled by {open.voided_by_name}. Reason: {open.void_reason}</Alert></div>
          )}
          {(open.refunds ?? []).map((r) => (
            <div key={r.id} className="no-print mb-3"><Alert kind="info">Refund of {formatTZS(r.total)} by {paymentLabel(r.method_name, r.provider_name)} on {formatDate(r.business_date)} ({r.created_by_name}). Reason: {r.reason}</Alert></div>
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
            <div className="no-print mx-auto mt-4 grid w-full max-w-sm grid-cols-5 gap-1">
              <button className="btn-primary min-h-11 w-full min-w-0 whitespace-normal break-words px-1 py-1 text-center text-xs leading-tight" onClick={() => window.print()}>Print</button>
              {open.status === "COMPLETED" && <ShareReceipt sale={open} shop={shop.data} compact />}
              <button className="btn-secondary min-h-11 w-full min-w-0 whitespace-normal break-words px-1 py-1 text-center text-xs leading-tight" onClick={close}>Close</button>
              {office && open.status === "COMPLETED" && (
                <>
                  <button className="btn-secondary min-h-11 w-full min-w-0 whitespace-normal break-words px-1 py-1 text-center text-xs leading-tight" onClick={() => { setProblem(null); setRefunding(true); }}>Refund</button>
                  {(open.refunds ?? []).length === 0 && <button className="btn-danger min-h-11 w-full min-w-0 whitespace-normal break-words px-1 py-1 text-center text-xs leading-tight" onClick={() => setVoiding(true)}>Cancel sale…</button>}
                </>
              )}
            </div>
          )}
        </Modal>
      )}
      {confirmation}
    </div>
  );
}
