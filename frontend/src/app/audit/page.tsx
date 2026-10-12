"use client";

import { useState } from "react";

import { Alert, Field, Modal, PageTitle, Spinner } from "@/components/ui";
import { type Page } from "@/lib/api";
import { formatDate, formatTime } from "@/lib/money";
import { useLoad } from "@/lib/useLoad";

type Entry = {
  id: number; created_at: string; actor_username: string; action: string; entity_type: string; entity_id: string;
  summary: string; reason: string; before: unknown; after: unknown;
};

const AREAS = [
  ["", "Everything"], ["sale", "Sales, cancellations and refunds"], ["shift", "Cashier shifts"], ["day", "Business days and corrections"],
  ["stock", "Stock counts, deliveries and adjustments"], ["product", "Products and prices"], ["expense", "Expenses"],
  ["user", "User accounts"], ["auth", "Sign-ins"], ["settings", "Settings"], ["payment_method", "Payment methods"],
  ["setup", "Setup and go-live"], ["history", "Excel history review"], ["report", "Report downloads"],
] as const;

function pretty(value: unknown): string {
  return value === null || value === undefined ? "—" : JSON.stringify(value, null, 2);
}

export default function AuditPage() {
  const [area, setArea] = useState("");
  const [user, setUser] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<Entry | null>(null);
  const query = `?page=${page}&page_size=50${area ? `&action=${area}` : ""}${user.trim() ? `&user=${encodeURIComponent(user.trim())}` : ""}${from ? `&date_from=${from}` : ""}${to ? `&date_to=${to}` : ""}`;
  const list = useLoad<Page<Entry>>(`/audit-log/${query}`);
  const pages = Math.max(1, Math.ceil((list.data?.count ?? 0) / 50));
  const reset = () => setPage(1);

  return (
    <div className="space-y-5">
      <PageTitle title="Audit History" help="Who did what, and when. Entries are written automatically and cannot be edited or deleted by anyone." />
      <div className="card grid gap-4 sm:grid-cols-4">
        <Field label="Area">{(p) => (
          <select {...p} className="input" value={area} onChange={(e) => { setArea(e.target.value); reset(); }}>
            {AREAS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>)}</Field>
        <Field label="Username">{(p) => <input {...p} className="input" value={user} onChange={(e) => { setUser(e.target.value); reset(); }} />}</Field>
        <Field label="From">{(p) => <input {...p} type="date" className="input" value={from} onChange={(e) => { setFrom(e.target.value); reset(); }} />}</Field>
        <Field label="To">{(p) => <input {...p} type="date" className="input" value={to} onChange={(e) => { setTo(e.target.value); reset(); }} />}</Field>
      </div>
      <div className="card overflow-x-auto">
        {list.loading && !list.data ? <Spinner /> : list.error ? <Alert kind="error">{list.error}</Alert> : (list.data?.results.length ?? 0) === 0 ? (
          <p className="p-4 text-slate-600">No entries match.</p>
        ) : (
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>What happened</th><th>Reason given</th><th /></tr></thead>
            <tbody>
              {list.data!.results.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap">{formatDate(e.created_at)} {formatTime(e.created_at)}</td>
                  <td>{e.actor_username || "—"}</td>
                  <td>{e.summary || e.action}</td>
                  <td>{e.reason}</td>
                  <td className="text-right"><button className="btn-secondary min-h-[2.5rem]" onClick={() => setOpen(e)}>Details</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {pages > 1 && (
          <div className="mt-3 flex items-center justify-end gap-3">
            <button className="btn-secondary min-h-[2.5rem]" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button><span>Page {page} of {pages}</span>
            <button className="btn-secondary min-h-[2.5rem]" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        )}
      </div>
      {open && (
        <Modal title={open.summary || open.action} onClose={() => setOpen(null)} wide>
          <table className="table mb-3"><tbody>
            <tr><td>When</td><td>{formatDate(open.created_at)} {formatTime(open.created_at)}</td></tr>
            <tr><td>Who</td><td>{open.actor_username || "—"}</td></tr>
            <tr><td>Record</td><td>{open.entity_type} {open.entity_id}</td></tr>
            {open.reason && <tr><td>Reason</td><td>{open.reason}</td></tr>}
          </tbody></table>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><div className="font-semibold">Before</div><pre className="max-h-64 overflow-auto rounded-lg bg-slate-100 p-3 text-sm">{pretty(open.before)}</pre></div>
            <div><div className="font-semibold">After</div><pre className="max-h-64 overflow-auto rounded-lg bg-slate-100 p-3 text-sm">{pretty(open.after)}</pre></div>
          </div>
          <button className="btn-secondary mt-4" onClick={() => setOpen(null)}>Close</button>
        </Modal>
      )}
    </div>
  );
}
