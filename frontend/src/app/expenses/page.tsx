"use client";

import { useRef, useState } from "react";

import { Alert, Field, PageTitle, StatusBadge, useConfirm } from "@/components/ui";
import { ColumnPicker } from "@/components/ColumnPicker";
import { ActionButton, DataTable, TableToolbar } from "@/components/DataTable";
import type { TableColumn } from "@/lib/table";
import { useColumnVisibility } from "@/lib/useColumnVisibility";
import { api, errorMessage, type Page } from "@/lib/api";
import { formatTZS, toCents, centsToApi } from "@/lib/money";
import type { CurrentDay, PaymentMethod } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

type Expense = {
  id: number; business_date: string; category: string; description: string; amount: string; method_name: string;
  paid_from_drawer_of: string; status: string; status_label: string; void_reason: string; recorded_by_name: string;
};

const COLUMNS: TableColumn<Expense>[] = [
  { key: "date", label: "Date", type: "date", accessor: "business_date", className: "whitespace-nowrap" },
  { key: "category", label: "Category" },
  { key: "description", label: "Description", essential: true,
    render: (x) => <>{x.description}{x.void_reason && <span className="block text-sm">Cancelled: {x.void_reason}</span>}</> },
  { key: "method", label: "Paid by",
    render: (x) => <>{x.method_name}{x.paid_from_drawer_of && <span className="block text-sm text-slate-600">from {x.paid_from_drawer_of}&apos;s drawer</span>}</> },
  { key: "amount", label: "Amount", type: "currency", className: (x) => `font-semibold ${x.status === "VOIDED" ? "line-through" : ""}` },
  { key: "status", label: "Status", render: (x) => <StatusBadge status={x.status === "RECORDED" ? "COMPLETED" : "VOIDED"} label={x.status_label} /> },
  { key: "by", label: "Recorded by", accessor: "recorded_by_name" },
];

export default function ExpensesPage() {
  const cols = useColumnVisibility("expenses", COLUMNS);
  const list = useLoad<Page<Expense>>("/expenses/?page_size=40");
  const categories = useLoad<string[]>("/expenses/categories/");
  const methods = useLoad<PaymentMethod[]>("/payment-methods/");
  const current = useLoad<CurrentDay>("/day/current/");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [methodId, setMethodId] = useState("");
  const [drawer, setDrawer] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const requestKey = useRef(crypto.randomUUID());
  const { confirm, confirmation, asking } = useConfirm();

  const active = (methods.data ?? []).filter((m) => m.is_active);
  const method = active.find((m) => String(m.id) === methodId);
  const openShifts = current.data?.open_shifts ?? [];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!category || description.trim().length < 3 || toCents(amount) <= 0 || !method) {
      return setProblem("Choose a category and how it was paid, describe the expense, and enter an amount greater than zero.");
    }
    setBusy(true);
    setProblem(null);
    setSaved(null);
    try {
      await api("/expenses/", {
        method: "POST",
        body: {
          request_key: requestKey.current, category, description, amount: centsToApi(toCents(amount)), method: method.id,
          shift: method.is_cash && drawer ? Number(drawer) : null, business_date: date || null,
        },
      });
      requestKey.current = crypto.randomUUID();
      setSaved(`Expense of ${formatTZS(toCents(amount), true)} saved.`);
      setDescription("");
      setAmount("");
      setDrawer("");
      list.reload();
      current.reload();
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function cancel(expense: Expense) {
    confirm({
      message: `Cancel the expense "${expense.description}" of ${formatTZS(expense.amount)}? It stays on record as cancelled.`,
      yes: "Yes, cancel it", danger: true, input: { label: "Reason for cancelling" },
      run: (reason) => cancelNow(expense, reason),
    });
  }

  async function cancelNow(expense: Expense, reason: string) {
    try {
      await api(`/expenses/${expense.id}/void/`, { method: "POST", body: { reason } });
      list.reload();
      current.reload();
    } catch (err) {
      setProblem(errorMessage(err));
    }
  }

  return (
    <div className="space-y-6">
      <PageTitle title="Expenses" help="Money spent running the shop, such as rent, transport or electricity. Expenses are kept separately and are never taken off the cumulative sales balance." />
      {saved && <Alert kind="success">{saved}</Alert>}
      {problem && <Alert kind="error">{problem}</Alert>}

      <form onSubmit={save} className="card space-y-4" noValidate>
        <h2 className="text-xl font-bold">Record an expense</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Category">
            {(p) => (
              <select {...p} className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">— Choose —</option>
                {(categories.data ?? []).map((c) => <option key={c}>{c}</option>)}
              </select>
            )}
          </Field>
          <Field label="Amount (TZS)">{(p) => <input {...p} className="input" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
          <Field label="Date" hint="Leave empty for today.">{(p) => <input {...p} className="input" type="date" value={date} disabled={!!drawer} onChange={(e) => setDate(e.target.value)} />}</Field>
        </div>
        <Field label="What was it for?" hint="For example: boda boda to collect crates from the depot.">
          {(p) => <input {...p} className="input" maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="How was it paid?">
            {(p) => (
              <select {...p} className="input" value={methodId} onChange={(e) => { setMethodId(e.target.value); setDrawer(""); }}>
                <option value="">— Choose —</option>
                {active.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            )}
          </Field>
          {method?.is_cash && (
            <Field label="Where did the cash come from?" hint="If it came out of a cashier's drawer, that drawer's expected cash is reduced.">
              {(p) => (
                <select {...p} className="input" value={drawer} onChange={(e) => setDrawer(e.target.value)}>
                  <option value="">Not from a cashier&apos;s drawer</option>
                  {openShifts.map((s) => <option key={s.id} value={s.id}>{s.cashier_name}&apos;s drawer (open now)</option>)}
                </select>
              )}
            </Field>
          )}
        </div>
        <button className="btn-primary" disabled={busy}>{busy ? "Saving…" : "Save Expense"}</button>
      </form>

      <section className="card">
        <TableToolbar summary={<h2 className="text-xl font-bold">Latest expenses</h2>}>
          {(list.data?.results.length ?? 0) > 0 && <ColumnPicker visibility={cols} />}
        </TableToolbar>
        <DataTable label="Latest expenses" columns={COLUMNS} visibility={cols} rows={list.data?.results} rowKey={(x) => x.id}
          loading={list.loading && !list.data} error={list.error} empty="No expenses recorded yet."
          rowClassName={(x) => (x.status === "VOIDED" ? "text-slate-500" : "")}
          actions={(x) => x.status === "RECORDED" && (
            <ActionButton aria-label={`Cancel expense: ${x.description}`} disabled={asking} onClick={() => cancel(x)}>Cancel…</ActionButton>
          )} />
      </section>
      {confirmation}
    </div>
  );
}
