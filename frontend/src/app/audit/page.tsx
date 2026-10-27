"use client";

import { useState } from "react";

import { Alert, Field, Modal, PageTitle, Spinner } from "@/components/ui";
import { ColumnPicker } from "@/components/ColumnPicker";
import { useBackState } from "@/lib/backNav";
import type { ColumnDef } from "@/lib/columns";
import { useColumnVisibility } from "@/lib/useColumnVisibility";
import { type Page } from "@/lib/api";
import { type AuditEntry as Entry, QUANTITY_MAPS, changeRows, fieldLabel, plainValue, productName, recordLabel, words } from "@/lib/auditDetails";
import { formatDate, formatQty, formatTime } from "@/lib/money";
import { useLoad } from "@/lib/useLoad";

const AREAS = [
  ["", "Everything"], ["sale", "Sales, cancellations and refunds"], ["shift", "Cashier shifts"], ["day", "Business days and corrections"],
  ["stock", "Stock counts, deliveries and adjustments"], ["product", "Products and prices"], ["expense", "Expenses"],
  ["user", "User accounts"], ["auth", "Sign-ins"], ["settings", "Settings"], ["payment_method", "Payment methods"],
  ["setup", "Setup and go-live"], ["history", "Excel history review"], ["report", "Report downloads"],
] as const;

function pretty(value: unknown): string {
  return value === null || value === undefined ? "—" : JSON.stringify(value, null, 2);
}

/** One recorded value in words; maps and lists of records become a short list. */
function Value({ field, value, entry }: { field: string; value: unknown; entry: Entry }) {
  const text = plainValue(field, value, entry);
  if (text || value === null || typeof value !== "object") return <>{text}</>;
  if (Array.isArray(value)) return <div className="space-y-2">{value.map((item, i) => <Value key={i} field={field} value={item} entry={entry} />)}</div>;
  const map = value as Record<string, unknown>;
  const keys = Object.keys(map).filter((k) => k !== "source_product");
  if (keys.length === 0) return <>None</>;
  const products = QUANTITY_MAPS.has(field);
  return (
    <ul className="space-y-0.5">
      {keys.map((k) => (
        <li key={k}>
          <span className="text-slate-600">{products ? productName(entry, k) : field === "payments" ? words(k) : fieldLabel(k)}:</span>{" "}
          {products ? formatQty(String(map[k])) : <Value field={k} value={map[k]} entry={entry} />}
        </li>
      ))}
    </ul>
  );
}

/** What the entry recorded, one row per item; for a change, the new value is in bold where it differs. */
function Changes({ entry }: { entry: Entry }) {
  const { rows, both, side } = changeRows(entry);
  if (rows.length === 0) return <p className="text-slate-600">No values were recorded for this entry.</p>;
  return (
    <table className="table">
      <thead><tr><th>Item</th>{both ? <><th>Before</th><th>After</th></> : <th>{side}</th>}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="font-medium">{r.label}</td>
            {both ? (
              <>
                <td className="text-slate-600">{r.before === undefined ? "—" : <Value field={r.key} value={r.before} entry={entry} />}</td>
                <td className={r.changed ? "font-semibold" : ""}>{r.after === undefined ? "—" : <Value field={r.key} value={r.after} entry={entry} />}</td>
              </>
            ) : <td><Value field={r.key} value={side === "Before" ? r.before : r.after} entry={entry} /></td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const COLUMNS: ColumnDef[] = [
  { key: "when", label: "When" }, { key: "who", label: "Who" }, { key: "what", label: "What happened", essential: true }, { key: "reason", label: "Reason given" },
];

export default function AuditPage() {
  const cols = useColumnVisibility("audit", COLUMNS);
  const [area, setArea] = useBackState("area", "");
  const [user, setUser] = useBackState("user", "");
  const [from, setFrom] = useBackState("from", "");
  const [to, setTo] = useBackState("to", "");
  const [page, setPage] = useBackState("page", 1);
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
        {(list.data?.results.length ?? 0) > 0 && <div className="mb-3 flex justify-end"><ColumnPicker visibility={cols} /></div>}
        {list.loading && !list.data ? <Spinner /> : list.error ? <Alert kind="error">{list.error}</Alert> : (list.data?.results.length ?? 0) === 0 ? (
          <p className="p-4 text-slate-600">No entries match.</p>
        ) : (
          <table className="table">
            <thead><tr>{cols.show("when") && <th>When</th>}{cols.show("who") && <th>Who</th>}{cols.show("what") && <th>What happened</th>}{cols.show("reason") && <th>Reason given</th>}<th /></tr></thead>
            <tbody>
              {list.data!.results.map((e) => (
                <tr key={e.id}>
                  {cols.show("when") && <td className="whitespace-nowrap">{formatDate(e.created_at)} {formatTime(e.created_at)}</td>}
                  {cols.show("who") && <td>{e.actor_username || "—"}</td>}
                  {cols.show("what") && <td>{e.summary || e.action}</td>}
                  {cols.show("reason") && <td>{e.reason}</td>}
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
            {open.entity_type && <tr><td>Record</td><td>{recordLabel(open)}</td></tr>}
            {open.reason && <tr><td>Reason</td><td>{open.reason}</td></tr>}
          </tbody></table>
          <div className="mb-1 font-semibold">What was recorded</div>
          <div className="max-h-96 overflow-auto"><Changes entry={open} /></div>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-slate-600">Technical details</summary>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <div><div className="font-semibold">Before</div><pre className="max-h-64 overflow-auto rounded-lg bg-slate-100 p-3">{pretty(open.before)}</pre></div>
              <div><div className="font-semibold">After</div><pre className="max-h-64 overflow-auto rounded-lg bg-slate-100 p-3">{pretty(open.after)}</pre></div>
            </div>
          </details>
          <button className="btn-secondary mt-4" onClick={() => setOpen(null)}>Close</button>
        </Modal>
      )}
    </div>
  );
}
