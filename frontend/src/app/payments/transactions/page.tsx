"use client";

import { useEffect, useMemo, useState } from "react";

import { ColumnPicker } from "@/components/ColumnPicker";
import { Alert, Field, Modal, PageTitle, Spinner, StatusBadge } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { ColumnDef } from "@/lib/columns";
import { formatDate, formatTZS } from "@/lib/money";
import { iconFor, paymentQuery, periodPresets, readPaymentQuery, type TransactionQuery } from "@/lib/payments";
import type { CurrentDay, PaymentMethod, PaymentSummary, PaymentTransaction, PaymentTransactionPage } from "@/lib/types";
import { useColumnVisibility } from "@/lib/useColumnVisibility";
import { useLoad } from "@/lib/useLoad";

const COLUMNS: (ColumnDef & { sort?: string; num?: boolean })[] = [
  { key: "number", label: "Transaction", essential: true, sort: "number" },
  { key: "receipt_number", label: "Receipt", sort: "receipt" },
  { key: "date_time", label: "Date and time", sort: "date" },
  { key: "cashier", label: "Cashier", sort: "cashier" },
  { key: "branch", label: "Branch", defaultHidden: true },
  { key: "category", label: "Category", sort: "category" },
  { key: "provider", label: "Provider", sort: "provider" },
  { key: "amount", label: "Amount", sort: "amount", num: true },
  { key: "reference", label: "Reference" },
  { key: "status", label: "Status", sort: "status" },
];

const STATUS_TONE: Record<string, string> = { RECORDED: "PENDING", VERIFIED: "APPROVED", REVERSED: "VOIDED", REFUNDED: "REFUNDED" };

export default function PaymentTransactionsPage() {
  const { user } = useAuth();
  const office = user?.role !== "CASHIER";
  const current = useLoad<CurrentDay>("/day/current/");
  const methods = useLoad<PaymentMethod[]>("/payment-methods/");
  const [q, setQ] = useState<TransactionQuery | null>(null);
  const [searchBox, setSearchBox] = useState("");
  const [fixing, setFixing] = useState<PaymentTransaction | null>(null);
  const cols = useColumnVisibility("payment-transactions", COLUMNS);

  useEffect(() => {
    if (q || !current.data) return;
    const read = readPaymentQuery(new URLSearchParams(window.location.search), current.data.day?.date ?? current.data.today);
    setQ(read);
    setSearchBox(read.search ?? "");
  }, [current.data, q]);
  // Search waits for a pause in typing, then goes to the server.
  useEffect(() => {
    const t = setTimeout(() => setQ((was) => (was && was.search !== searchBox.trim() ? { ...was, search: searchBox.trim(), page: 1 } : was)), 350);
    return () => clearTimeout(t);
  }, [searchBox]);

  const query = q ? paymentQuery(q) : null;
  useEffect(() => {
    if (query !== null) window.history.replaceState(window.history.state, "", `/payments/transactions?${query}`);
  }, [query]);
  const list = useLoad<PaymentTransactionPage>(query !== null ? `/payment-transactions/?${query}` : null);
  // Only for the cashier list in the filters (and to check the list against the card it came from).
  const summary = useLoad<PaymentSummary>(q && office ? `/payment-summary/?${paymentQuery({ from: q.from, to: q.to })}` : null);

  const set = (change: Partial<TransactionQuery>) => setQ((was) => (was ? { ...was, page: 1, ...change } : was));
  const category = (methods.data ?? []).find((m) => m.id === q?.category);
  const providers = category?.providers ?? [];
  const title = useMemo(() => {
    if (!q) return "Payments";
    const provider = q.provider === "none" ? "Provider not recorded" : providers.find((p) => p.id === q.provider)?.name;
    const what = [category?.name, provider].filter(Boolean).join(" · ");
    return `${q.kind === "refund" ? "Refunds" : "Payments"}${what ? `: ${what}` : ""}`;
  }, [q, category, providers]);

  if (!q) return <Spinner />;
  const data = list.data;
  const shown = COLUMNS.filter((c) => cols.show(c.key));
  const sortBy = (key?: string) => key && set({ ordering: q.ordering === `-${key}` ? key : `-${key}` });
  const download = (fmt: "csv" | "xlsx") => `/api/v1/payment-transactions/?${paymentQuery({ ...q, page: 1 }, { download: fmt })}`;

  return (
    <div className="space-y-5">
      <PageTitle title={title} help="Every payment behind the figure you clicked. Change the filters here; the total, the pages and the downloads all follow them." />

      <section className="card no-print grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Filters">
        <label className="block"><span className="mb-1 block font-semibold">From</span>
          <input type="date" className="input" value={q.from} max={q.to} onChange={(e) => set({ from: e.target.value })} /></label>
        <label className="block"><span className="mb-1 block font-semibold">To</span>
          <input type="date" className="input" value={q.to} min={q.from} onChange={(e) => set({ to: e.target.value })} /></label>
        <label className="block"><span className="mb-1 block font-semibold">Category</span>
          <select className="input" value={q.category ?? ""} onChange={(e) => set({ category: e.target.value ? Number(e.target.value) : null, provider: null })}>
            <option value="">All categories</option>
            {(methods.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}{m.is_active ? "" : " (switched off)"}</option>)}
          </select></label>
        <label className="block"><span className="mb-1 block font-semibold">Provider</span>
          <select className="input" value={q.provider ?? ""} disabled={!category || (!category.requires_provider && providers.length === 0)}
            onChange={(e) => set({ provider: e.target.value === "" ? null : e.target.value === "none" ? "none" : Number(e.target.value) })}>
            <option value="">{category ? `All ${category.name} providers` : "Choose a category first"}</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}{p.is_active ? "" : " (switched off)"}</option>)}
            {category?.requires_provider && <option value="none">Provider not recorded</option>}
          </select></label>
        {office && summary.data?.options.cashiers && (
          <label className="block"><span className="mb-1 block font-semibold">Cashier</span>
            <select className="input" value={q.cashier ?? ""} onChange={(e) => set({ cashier: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Everyone</option>
              {summary.data.options.cashiers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></label>
        )}
        {(summary.data?.options.branches.length ?? 0) > 1 && (
          <label className="block"><span className="mb-1 block font-semibold">Branch</span>
            <select className="input" value={q.branch ?? ""} onChange={(e) => set({ branch: e.target.value ? Number(e.target.value) : null })}>
              <option value="">All branches</option>
              {summary.data!.options.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select></label>
        )}
        <label className="block"><span className="mb-1 block font-semibold">Show</span>
          <select className="input" value={q.kind === "refund" ? "refund" : q.status} onChange={(e) => (e.target.value === "refund"
            ? set({ kind: "refund", status: "collected" }) : set({ kind: "payment", status: e.target.value }))}>
            <option value="collected">Payments collected</option>
            <option value="VERIFIED">Checked payments only</option>
            <option value="RECORDED">Not yet checked</option>
            <option value="REVERSED">Reversed (cancelled sales)</option>
            <option value="all">All payments</option>
            <option value="refund">Refunds paid</option>
          </select></label>
        <label className="block"><span className="mb-1 block font-semibold">Search</span>
          <input className="input" type="search" placeholder="Receipt, reference or provider" value={searchBox} onChange={(e) => setSearchBox(e.target.value)} /></label>
        <div className="flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-4">
          {periodPresets(current.data?.today ?? q.from).slice(0, 4).map((p) => (
            <button key={p.key} type="button" className="btn-secondary min-h-[2.5rem]" aria-pressed={q.from === p.from && q.to === p.to}
              onClick={() => set({ from: p.from, to: p.to })}>{p.label}</button>
          ))}
        </div>
      </section>

      <section className="card overflow-x-auto">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div aria-live="polite">
            <p className="text-slate-600">{q.from === q.to ? formatDate(q.from) : `${formatDate(q.from)} to ${formatDate(q.to)}`}</p>
            {data && (
              <p className="text-lg">
                <span className="font-bold tabular-nums">{formatTZS(data.totals.amount)}</span> in {data.totals.count} {q.kind === "refund" ? "refund" : "payment"}{data.totals.count === 1 ? "" : "s"}
                {list.loading && <span className="ml-2 text-sm text-slate-500">Updating…</span>}
              </p>
            )}
          </div>
          {data && data.count > 0 && (
            <div className="no-print flex flex-wrap items-center gap-2">
              <ColumnPicker visibility={cols} />
              <a className="btn-secondary" href={download("xlsx")}>Download Excel</a>
              <a className="btn-secondary" href={download("csv")}>Download CSV</a>
            </div>
          )}
        </div>

        {list.error ? <Alert kind="error">{list.error}</Alert> : !data ? <TableSkeleton /> : data.count === 0 ? (
          <p className="p-4 text-slate-600">No {q.kind === "refund" ? "refunds" : "payments"} match these filters.</p>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  {shown.map((c) => (
                    <th key={c.key} className={c.num ? "num" : ""} aria-sort={q.ordering === c.sort ? "ascending" : q.ordering === `-${c.sort}` ? "descending" : undefined}>
                      {c.sort ? (
                        <button type="button" className="font-semibold underline-offset-2 hover:underline" onClick={() => sortBy(c.sort)}>
                          {c.label}{q.ordering === c.sort ? " ▲" : q.ordering === `-${c.sort}` ? " ▼" : ""}
                        </button>
                      ) : c.label}
                    </th>
                  ))}
                  {office && <th className="no-print" />}
                </tr>
              </thead>
              <tbody>
                {data.results.map((r) => (
                  <tr key={`${r.kind}-${r.id}`}>
                    {cols.show("number") && <td className="font-mono text-sm">{r.number}</td>}
                    {cols.show("receipt_number") && <td>{r.receipt_number}</td>}
                    {cols.show("date_time") && <td className="whitespace-nowrap">{r.date_time}</td>}
                    {cols.show("cashier") && <td>{r.cashier}</td>}
                    {cols.show("branch") && <td>{r.branch}</td>}
                    {cols.show("category") && <td><span aria-hidden>{iconFor(r.category_icon)} </span>{r.category}</td>}
                    {cols.show("provider") && <td className={r.needs_provider ? "font-semibold text-amber-900" : ""}>{r.needs_provider ? "⚠ " : ""}{r.provider || "—"}</td>}
                    {cols.show("amount") && <td className="num">{r.kind === "refund" ? "− " : ""}{formatTZS(r.amount)}</td>}
                    {cols.show("reference") && <td className="text-sm">{r.reference || "—"}{r.reason ? <span className="block text-slate-600">{r.reason}</span> : null}</td>}
                    {cols.show("status") && <td><StatusBadge status={STATUS_TONE[r.status_code] ?? "PENDING"} label={r.status} /></td>}
                    {office && (
                      <td className="no-print text-right">
                        {r.kind === "payment" && r.status_code !== "REVERSED" && (r.needs_provider || (methods.data ?? []).find((m) => m.id === r.category_id)?.requires_provider) && (
                          <button type="button" className="btn-secondary min-h-[2.25rem] text-sm" onClick={() => setFixing(r)}>
                            {r.needs_provider ? "Record provider…" : "Correct provider…"}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-bold">
                  {shown.map((c, i) => <td key={c.key} className={c.num ? "num" : ""}>{i === 0 ? `Total (${data.totals.count})` : c.key === "amount" ? formatTZS(data.totals.amount) : ""}</td>)}
                  {office && <td />}
                </tr>
              </tfoot>
            </table>
            {data.pages > 1 && (
              <nav className="no-print mt-4 flex flex-wrap items-center gap-3" aria-label="Pages">
                <button className="btn-secondary min-h-[2.5rem]" disabled={data.page <= 1} onClick={() => setQ({ ...q, page: data.page - 1 })}>← Previous</button>
                <span>Page {data.page} of {data.pages}</span>
                <button className="btn-secondary min-h-[2.5rem]" disabled={data.page >= data.pages} onClick={() => setQ({ ...q, page: data.page + 1 })}>Next →</button>
              </nav>
            )}
          </>
        )}
      </section>

      {fixing && (
        <ProviderCorrection payment={fixing} methods={methods.data ?? []} onClose={() => setFixing(null)}
          onDone={() => { setFixing(null); list.reload(); summary.reload(); }} />
      )}
    </div>
  );
}

function TableSkeleton() {
  return <div className="space-y-2" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <div key={i} className="h-10 animate-pulse rounded bg-slate-200" />)}</div>;
}

/** Owner/Accountant: say which provider carried a payment. Amount and category never change; the reason is kept. */
function ProviderCorrection({ payment, methods, onClose, onDone }: {
  payment: PaymentTransaction; methods: PaymentMethod[]; onClose: () => void; onDone: () => void;
}) {
  const category = methods.find((m) => m.id === payment.category_id);
  const choices = (category?.providers ?? []).filter((p) => p.id !== payment.provider_id && (p.is_active || payment.needs_provider));
  const [provider, setProvider] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function save() {
    if (busy || provider === null) return;
    setBusy(true);
    setProblem(null);
    try {
      await api(`/payments/${payment.id}/provider/`, { method: "POST", body: { provider, reason } });
      onDone();
    } catch (err) {
      setProblem(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={`${payment.needs_provider ? "Record" : "Correct"} the provider of ${payment.number}`} onClose={onClose}>
      <p className="mb-3 text-slate-700">
        {payment.category} payment of <strong>{formatTZS(payment.amount)}</strong> on receipt {payment.receipt_number} ({payment.date_time}).
        {payment.needs_provider ? " It was taken before providers were recorded." : ` Now recorded as ${payment.provider}. A recorded provider can only be corrected while the cashier's shift is still open.`}
        {" "}The amount and category do not change. Your name and reason are kept in the audit history.
      </p>
      <fieldset className="mb-3">
        <legend className="mb-1 font-semibold">Provider</legend>
        <div className="flex flex-wrap gap-2">
          {choices.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={provider === p.id} onClick={() => setProvider(p.id)}
              className={`btn min-h-[2.75rem] border-2 ${provider === p.id ? "border-brand-700 bg-brand-600 text-white" : "border-slate-300 bg-white"}`}>
              {provider === p.id ? "✔ " : ""}{p.name}
            </button>
          ))}
        </div>
      </fieldset>
      <Field label="How do you know?" hint="At least 10 characters, for example: matched on the M-PESA statement, 14:05, same amount.">
        {(p) => <textarea {...p} className="input" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
      {problem && <div className="mt-3"><Alert kind="error">{problem}</Alert></div>}
      <div className="mt-4 flex gap-3">
        <button className="btn-primary" disabled={busy || provider === null || reason.trim().length < 10} onClick={save}>{busy ? "Saving…" : "Save provider"}</button>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
