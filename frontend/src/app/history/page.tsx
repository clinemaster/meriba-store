"use client";

import { useMemo, useState } from "react";

import { Alert, Field, Modal, PageTitle, Spinner, Stat, StatusBadge, useConfirm } from "@/components/ui";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useBackState } from "@/lib/backNav";
import { formatDate, formatQty, formatTZS } from "@/lib/money";
import type { Product } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

/* eslint-disable @typescript-eslint/no-explicit-any */
type PriceRun = { amount: string; from: string; to: string };
type Dashboard = {
  has_data: boolean; reconciled: boolean; statement: string; can_be_accepted: boolean;
  blockers: { exceptions: number; unlabelled_rows: number; product_mappings: number };
  acceptance: { by: string; at: string; note: string; still_valid: boolean } | null;
  date_from: string | null; date_to: string | null; days_with_records: number; missing_dates: string[];
  records: Record<string, number>; imports: number;
};
type Preview = {
  summary: Record<string, any>; statement: string;
  worksheets: { worksheet: string; date: string | null; error: string | null; product_rows: number; other_rows: number; total_sales: string | null }[];
  exceptions: { key: string; kind: string; severity: string; title: string; is_new: boolean; records_affected: number }[];
  row_problems: { worksheet: string; row: number; product: string; status: string; problems: string[] }[];
};
type Item = {
  id: number; kind: string; kind_label: string; severity: string; title: string; details: any; status: string; status_label: string;
  resolution_label: string; note: string; evidence_reference: string; decided_by_name: string; decided_at: string | null; owner_only: boolean;
  allowed_resolutions: { code: string; label: string }[]; records_affected: number;
  source_products: { id: number; source_name: string; serial_number: number; selling_prices: PriceRun[]; purchase_prices: PriceRun[] }[];
  notes: { id: number; text: string; evidence_reference: string; source_reference: string; author: string; created_at: string }[];
};
type SourceProduct = {
  id: number; serial_number: number; source_name: string; pack_text: string; description_text: string; first_seen: string; last_seen: string;
  record_count: number; selling_prices: PriceRun[]; purchase_prices: PriceRun[]; flags: string[]; proposed_name: string; proposed_unit: string;
  proposed_package_size: string; review_status: string; status_label: string; product: number | null; product_name: string;
  product_is_active: boolean | null; decision_note: string; open_exceptions: { id: number; title: string }[]; price_unresolved: boolean;
};
type Row = {
  id: number; business_date: string; worksheet: string; source_row: number; original: { column: string; value: string }[];
  proposed_classification: string; proposal_basis: string; status: string; status_label: string; classification: string; reason: string;
  decided_by_name: string; history: { status_label: string; classification: string; reason: string; reviewer: string; decided_at: string }[];
};
type HistRecord = {
  id: number; business_date: string; worksheet: string; source_row: number; source_name: string; opening_qty: string | null;
  purchases_qty: string | null; sold_qty: string | null; closing_qty: string | null; purchase_price: string | null; sales_price: string | null;
  total_sales: string | null; validation_status: string; validation_messages: string[]; import_status_label: string; import_status: string; incomplete: boolean;
};

const FLAG_LABEL: Record<string, string> = {
  NAME_VARIANT: "Name differs between sheets", UNIT_NOT_STATED: "Unit not stated", PACK_SIZE_AMBIGUOUS: "Is one unit a bottle or a box?",
  SELLING_PRICE_CHANGED: "Selling price changed", PURCHASE_PRICE_CHANGED: "Purchase price changed", MISSING_PRICE: "No selling price",
};
const prices = (runs: PriceRun[]) => runs.length === 0 ? "—" : runs.map((r) => `${formatTZS(r.amount)} (${formatDate(r.from)}${r.from === r.to ? "" : ` to ${formatDate(r.to)}`})`).join("; ");
const q = (v: string | null) => (v === null ? "" : formatQty(v));
const src = (s: { worksheet: string; row: number }) => `${s.worksheet} row ${s.row}`;

function Overview({ board, reload, isOwner }: { board: Dashboard; reload: () => void; isOwner: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [backup, setBackup] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const { confirm: ask, confirmation, asking } = useConfirm();

  async function downloadPreviewReport() {
    if (!file || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const token = document.cookie.split("; ").find((c) => c.startsWith("csrftoken="))?.slice(10) ?? "";
      const res = await fetch("/api/v1/history/imports/dry-run/?download=csv", { method: "POST", body: form, credentials: "same-origin", headers: { "X-CSRFToken": decodeURIComponent(token) } });
      if (!res.ok) throw new Error();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(await res.blob());
      link.download = "meriba_import_preview.csv";
      link.click();
      URL.revokeObjectURL(link.href);
    } catch {
      setProblem("The preview report could not be downloaded. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function send(commit: boolean) {
    if (!file || busy) return;
    setBusy(true);
    setProblem(null);
    setDone(null);
    try {
      const form = new FormData();
      form.append("file", file);
      if (commit) {
        form.append("confirm", "true");
        form.append("backup_confirmed", "true");
        const result = await api<{ nothing_new: boolean; batch?: { summary: any } }>("/history/imports/", { method: "POST", form });
        setDone(result.nothing_new ? "Everything in this file is already stored. Nothing was added."
          : `Imported ${result.batch?.summary.records_stored} historical records. Live stock and sales were not changed.`);
        setPreview(null);
        setFile(null);
        setBackup(false);
        setConfirm(false);
        reload();
      } else {
        setPreview(await api<Preview>("/history/imports/dry-run/", { method: "POST", form }));
      }
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const s = preview?.summary;
  return (
    <div className="space-y-5">
      <Alert kind={board.reconciled ? "success" : board.has_data ? "warning" : "info"}><strong>{board.statement}</strong></Alert>
      {board.has_data && (
        <section className="card space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Historical records" value={formatQty(board.records.total ?? 0)} note={`${formatDate(board.date_from)} to ${formatDate(board.date_to)}`} />
            <Stat label="Marked incomplete" value={formatQty(board.records.incomplete ?? 0)} note="Affected by an open or unexplained exception" />
            <Stat label="Exceptions waiting" value={String(board.blockers.exceptions)} note="Material items to decide" strong />
            <Stat label="Also waiting" value={`${board.blockers.product_mappings} + ${board.blockers.unlabelled_rows}`} note="Product mappings + unlabelled rows" />
          </div>
          {board.missing_dates.length > 0 && (
            <p><strong>Dates with no sheet:</strong> {board.missing_dates.map((d) => formatDate(d)).join(", ")}. Nothing has been filled in for them.</p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <a className="btn-secondary" href="/api/v1/history/exception-report/">Download the exception report (CSV)</a>
            {board.acceptance && <span className="text-sm text-slate-600">Last accepted by {board.acceptance.by} on {formatDate(board.acceptance.at)}{board.acceptance.still_valid ? "" : " (no longer current: something changed afterwards)"}</span>}
          </div>
          {isOwner && board.can_be_accepted && (
            <div className="space-y-2 rounded-lg border-2 border-brand-600 p-4">
              <p className="font-semibold">Everything has been reviewed. You can now accept the historical data as reconciled.</p>
              <Field label="On what basis do you accept it?">{(p) => <input {...p} className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
              <button className="btn-primary" disabled={busy || asking || note.trim().length < 10}
                onClick={() => ask({
                  message: "Accept the historical data as reconciled? This is recorded under your name. Any later import or reopened decision withdraws it.",
                  yes: "Yes, accept",
                  run: async () => { try { await api("/history/accept/", { method: "POST", body: { note } }); reload(); } catch (err) { setProblem(errorMessage(err)); } },
                })}>
                Accept as reconciled
              </button>
            </div>
          )}
          {confirmation}
        </section>
      )}

      <section className="card space-y-4">
        <h2 className="text-xl font-bold">{board.has_data ? "Import another workbook" : "Import the Excel workbook"}</h2>
        <p className="text-slate-700">
          Step 1 checks the file and shows what it contains; nothing is saved. Step 2, for the Owner, stores the daily lines as historical
          reference. Historical records are never added to live stock, sales or balances, and the same line is never stored twice.
        </p>
        {problem && <Alert kind="error">{problem}</Alert>}
        {done && <Alert kind="success">{done}</Alert>}
        <Field label="Excel workbook (.xlsx)">
          {(p) => <input {...p} type="file" accept=".xlsx" className="input" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setPreview(null); }} />}
        </Field>
        <button className="btn-primary" disabled={!file || busy} onClick={() => send(false)}>{busy && !preview ? "Reading the file…" : "Step 1 · Check the file (nothing is saved)"}</button>

        {preview && s && (
          <div className="space-y-4 border-t border-slate-200 pt-4">
            <Alert kind="info">{preview.statement}</Alert>
            <button className="btn-secondary" disabled={busy} onClick={downloadPreviewReport}>Download this preview as an exception report (CSV)</button>
            {s.already_imported_file && <Alert kind="warning">This exact file has been imported before. Importing it again will add nothing.</Alert>}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Sheets read" value={`${s.worksheets_read} of ${s.worksheets}`} note={`${formatDate(s.date_from)} to ${formatDate(s.date_to)}`} />
              <Stat label="New lines to store" value={formatQty(s.accepted_new)} note={`${s.duplicates_skipped} already stored · ${s.conflicts_not_imported} conflicting`} strong />
              <Stat label="Lines with problems" value={`${s.rows_with_errors} + ${s.rows_with_warnings}`} note="Unreadable + do not add up" />
              <Stat label="Total sales in the file" value={formatTZS(s.workbook_total_sales)} note="As written in the sheets; unverified" />
              <Stat label="Source products" value={String(s.source_products)} note={`${s.source_products_new} new`} />
              <Stat label="Unlabelled rows" value={String(s.unlabelled_rows)} note="Kept as written, never imported as transactions" />
              <Stat label="Exceptions found" value={String(s.exceptions)} note={`${s.exceptions_new} new · ${s.material_exceptions} material`} />
            </div>
            {preview.exceptions.length > 0 && (
              <table className="table">
                <thead><tr><th>Exception</th><th>Severity</th><th className="num">Lines affected</th><th>New?</th></tr></thead>
                <tbody>{preview.exceptions.map((e) => <tr key={e.key}><td>{e.title}</td><td>{e.severity === "MATERIAL" ? "Material" : "For information"}</td><td className="num">{e.records_affected}</td><td>{e.is_new ? "New" : "Already listed"}</td></tr>)}</tbody>
              </table>
            )}
            {preview.worksheets.some((w) => w.error) && (
              <Alert kind="warning">Not read: {preview.worksheets.filter((w) => w.error).map((w) => `“${w.worksheet}” (${w.error})`).join("; ")}</Alert>
            )}
            {preview.row_problems.length > 0 && (
              <details><summary className="cursor-pointer font-semibold">{preview.row_problems.length} line(s) with problems</summary>
                <table className="table"><tbody>{preview.row_problems.map((r, i) => <tr key={i}><td>{r.worksheet} row {r.row}</td><td>{r.product}</td><td>{r.problems.join(" ")}</td></tr>)}</tbody></table>
              </details>
            )}
            {isOwner ? (
              <div className="space-y-2">
                <label className="flex items-start gap-3"><input type="checkbox" className="mt-1 h-6 w-6" checked={backup} onChange={(e) => setBackup(e.target.checked)} /><span>I have taken a backup of the database (see the Backup and Restore guide).</span></label>
                <label className="flex items-start gap-3"><input type="checkbox" className="mt-1 h-6 w-6" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /><span>I have read this preview. Store these lines as historical reference, to be reviewed.</span></label>
                <button className="btn-primary" disabled={busy || !backup || !confirm} onClick={() => send(true)}>{busy ? "Importing…" : "Step 2 · Import as historical reference"}</button>
              </div>
            ) : <Alert kind="info">Only the Owner can carry out the import.</Alert>}
          </div>
        )}
      </section>
    </div>
  );
}

function Exceptions({ isOwner, onChange }: { isOwner: boolean; onChange: () => void }) {
  const [status, setStatus] = useBackState("exceptions.status", "PENDING_REVIEW");
  const list = useLoad<Page<Item>>(`/history/review-items/?page_size=200${status ? `&status=${status}` : ""}`);
  const [open, setOpen] = useState<Item | null>(null);
  const [resolution, setResolution] = useState("");
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState("");
  const [extra, setExtra] = useState<Record<number, { name: string; size: string; unit: string; type: string; amount: string; date: string }>>({});
  const [newNote, setNewNote] = useState({ text: "", evidence: "", source: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm, confirmation, asking } = useConfirm();

  function show(item: Item) {
    setOpen(item); setResolution(""); setNote(""); setEvidence(""); setExtra({}); setProblem(null); setNewNote({ text: "", evidence: "", source: "" });
  }
  async function act(action: () => Promise<Item>, close = false) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const updated = await action();
      // Refresh the list before the window closes, so a decided item is never left on show to be picked again.
      await list.reload();
      setOpen(close ? null : updated);
      setNewNote({ text: "", evidence: "", source: "" });
      onChange();
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  function decide() {
    if (!open) return;
    const entries = Object.entries(extra);
    act(() => api<Item>(`/history/review-items/${open.id}/decide/`, { method: "POST", body: {
      resolution, note, evidence_reference: evidence,
      identities: entries.filter(([, v]) => v.name.trim()).map(([id, v]) => ({ source_product: Number(id), confirmed_name: v.name, confirmed_package_size: v.size, confirmed_unit: v.unit })),
      approved_prices: entries.filter(([, v]) => v.amount.trim() && v.date).map(([id, v]) => ({ source_product: Number(id), price_type: v.type || "SELLING", amount: v.amount.replace(/,/g, ""), effective_date: v.date })),
    } }), true);
  }
  const setFor = (id: number, patch: Partial<{ name: string; size: string; unit: string; type: string; amount: string; date: string }>) =>
    setExtra((x) => ({ ...x, [id]: { ...(x[id] ?? { name: "", size: "", unit: "", type: "SELLING", amount: "", date: "" }), ...patch } }));
  const REQUIRED: Record<string, string> = {
    SAME_NAME_DIFFERENT_PRICE: "Required for each line before this can be closed: the confirmed product name, its package size, the approved price, which price type it is, and the date it applies from.",
    PRICE_ANOMALY: "Required before this can be closed: which price type this figure is, the amount that applies, and the date it applies from. The recorded values are never changed.",
    MISSING_PRICE: "To approve a selling price you must also confirm the product name and its unit or package size. Until a selling price is approved the product cannot be sold.",
  };
  const d = open?.details ?? {};
  const mayDecide = open && open.status === "PENDING_REVIEW" && (isOwner || !open.owner_only);

  return (
    <div className="card overflow-x-auto">
      <div className="mb-3 w-64">
        <Field label="Show">{(p) => (
          <select {...p} className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="PENDING_REVIEW">Waiting for review</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option><option value="">All</option>
          </select>)}</Field>
      </div>
      {list.loading && !list.data ? <Spinner /> : list.error ? <Alert kind="error">{list.error}</Alert> : (list.data?.results.length ?? 0) === 0 ? (
        <p className="p-4 text-slate-600">Nothing here.</p>
      ) : (
        <table className="table">
          <thead><tr><th>Type</th><th>What was found</th><th className="num">Lines</th><th>Status</th><th>Decision</th><th /></tr></thead>
          <tbody>
            {list.data!.results.map((item) => (
              <tr key={item.id}>
                <td>{item.kind_label}{item.severity === "INFO" && <span className="block text-sm text-slate-600">For information</span>}</td>
                <td>{item.title}</td>
                <td className="num">{item.records_affected}</td>
                <td><StatusBadge status={item.status === "PENDING_REVIEW" ? "PENDING" : item.status} label={item.status_label} /></td>
                <td>{item.resolution_label}{item.decided_by_name && <span className="block text-sm text-slate-600">{item.decided_by_name}</span>}</td>
                <td className="text-right"><button className="btn-secondary min-h-[2.5rem]" onClick={() => show(item)}>{item.status === "PENDING_REVIEW" ? "Review" : "View"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {open && (
        <Modal title={open.kind_label} onClose={() => setOpen(null)} wide>
          <p className="mb-2 font-semibold">{open.title}</p>
          {d.statement && <Alert kind="info">{d.statement}</Alert>}
          {d.missing_dates && <p className="mt-2"><strong>Missing dates:</strong> {d.missing_dates.map((x: string) => formatDate(x)).join(", ")}</p>}
          {d.old_value !== undefined && (
            <table className="table my-2"><tbody>
              <tr><td>Column in the workbook</td><td>{d.workbook_column} (read as: {d.price_type_as_labelled === "PURCHASE_COST" ? "purchase cost" : "selling price"})</td></tr>
              <tr><td>Before</td><td>{formatTZS(d.old_value)} · {src(d.old_source)}</td></tr>
              <tr><td>After</td><td>{formatTZS(d.new_value)} · {src(d.new_source)} · on {d.sheets_with_new_value} sheet(s)</td></tr>
              <tr><td>Other prices that day</td><td>Sales price {formatTZS(d.other_prices_on_that_day?.sales_price)} · purchase price {formatTZS(d.other_prices_on_that_day?.purchase_price)}</td></tr>
            </tbody></table>
          )}
          {(d.affected_products?.length ?? 0) > 0 && (
            <div className="my-2 max-h-56 overflow-auto"><table className="table">
              <thead><tr><th>Product</th><th>Closing before</th><th>Opening after</th><th className="num">Difference</th></tr></thead>
              <tbody>{d.affected_products.map((a: any, i: number) => <tr key={i}><td>{a.product}</td><td>{a.closing_before} · {src(a.before)}</td><td>{a.opening_after} · {src(a.after)}</td><td className="num">{a.difference}</td></tr>)}</tbody>
            </table></div>
          )}
          {d.lines?.[0]?.sales_price_history && (
            <table className="table my-2"><thead><tr><th>Line</th><th>Sales price as recorded</th><th>Purchase price as recorded</th><th>Seen</th></tr></thead>
              <tbody>{d.lines.map((l: any) => <tr key={l.serial}><td>S/N {l.serial} · {l.name}</td><td>{prices(l.sales_price_history)}</td><td>{prices(l.purchase_price_history)}</td><td>{src(l.first)} to {src(l.last)}</td></tr>)}</tbody></table>
          )}
          {d.lines?.[0]?.problems && (
            <div className="my-2 max-h-56 overflow-auto"><table className="table"><tbody>{d.lines.map((l: any, i: number) => <tr key={i}><td>{l.product}</td><td>{src(l)}</td><td>{l.problems.join(" ")}</td></tr>)}</tbody></table></div>
          )}
          {d.lines?.[0]?.already_stored && (
            <table className="table my-2"><thead><tr><th>Product</th><th>Already stored</th><th>In this file (not imported)</th></tr></thead>
              <tbody>{d.lines.map((l: any, i: number) => <tr key={i}><td>{l.product}</td><td>sold {l.already_stored.sold_qty ?? "—"}, closing {l.already_stored.closing_qty ?? "—"} · {l.already_stored.worksheet} row {l.already_stored.row}</td><td>sold {l.in_this_file.sold_qty ?? "—"}, closing {l.in_this_file.closing_qty ?? "—"} · {l.in_this_file.worksheet} row {l.in_this_file.row}</td></tr>)}</tbody></table>
          )}
          {d.reason && <p className="my-2">{d.reason}</p>}

          <h3 className="mt-4 font-bold">Explanations and evidence</h3>
          {open.notes.length === 0 ? <p className="text-slate-600">None yet.</p> : open.notes.map((n) => (
            <p key={n.id} className="border-b border-slate-100 py-1"><strong>{n.author}</strong>, {formatDate(n.created_at)}: {n.text}{n.evidence_reference && ` · Evidence: ${n.evidence_reference}`}{n.source_reference && ` · Source: ${n.source_reference}`}</p>
          ))}
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <input aria-label="Explanation" className="input sm:col-span-3" placeholder="Add a verified explanation" value={newNote.text} onChange={(e) => setNewNote({ ...newNote, text: e.target.value })} />
            <input aria-label="Where the evidence is" className="input" placeholder="Evidence (e.g. stock book p.14)" value={newNote.evidence} onChange={(e) => setNewNote({ ...newNote, evidence: e.target.value })} />
            <input aria-label="Source reference" className="input" placeholder="Source reference (e.g. invoice no.)" value={newNote.source} onChange={(e) => setNewNote({ ...newNote, source: e.target.value })} />
            <button className="btn-secondary" disabled={busy || newNote.text.trim().length < 5}
              onClick={() => act(() => api<Item>(`/history/review-items/${open.id}/notes/`, { method: "POST", body: { text: newNote.text, evidence_reference: newNote.evidence, source_reference: newNote.source } }))}>Add explanation</button>
          </div>

          {open.status !== "PENDING_REVIEW" ? (
            <div className="mt-4 space-y-2">
              <Alert kind="success">{open.resolution_label} — {open.decided_by_name}{open.decided_at ? `, ${formatDate(open.decided_at)}` : ""}. {open.note}{open.evidence_reference && ` Evidence: ${open.evidence_reference}.`}</Alert>
              {isOwner && <button className="btn-secondary" disabled={busy || asking} onClick={() => confirm({
                message: "Reopen this decision? It goes back to waiting for review, and the history stops counting as reconciled until it is decided again.",
                yes: "Yes, reopen", input: { label: "Why is this decision being reopened?" },
                run: (reason) => act(() => api<Item>(`/history/review-items/${open.id}/reopen/`, { method: "POST", body: { reason } })),
              })}>Reopen this decision…</button>}
              {confirmation}
            </div>
          ) : !mayDecide ? (
            <div className="mt-4"><Alert kind="info">Only the Owner can decide on product identity and prices. You can add an explanation above for the Owner.</Alert></div>
          ) : (
            <div className="mt-4 space-y-3 border-t border-slate-200 pt-3">
              <fieldset><legend className="mb-1 font-bold">Decision</legend>
                {open.allowed_resolutions.map((r) => (
                  <label key={r.code} className="flex items-center gap-2 py-1"><input type="radio" name="resolution" className="h-5 w-5" checked={resolution === r.code} onChange={() => setResolution(r.code)} /> {r.label}</label>
                ))}
              </fieldset>
              {REQUIRED[open.kind] && <Alert kind="info">{REQUIRED[open.kind]}</Alert>}
              {open.owner_only && open.source_products.map((sp) => (
                <div key={sp.id} className="rounded-lg border border-slate-200 p-3">
                  <div className="mb-2 font-semibold">S/N {sp.serial_number} · {sp.source_name}</div>
                  <div className="grid gap-2 sm:grid-cols-6">
                    <input aria-label={`Confirmed name for line ${sp.serial_number}`} className="input sm:col-span-2" placeholder="Confirmed product name" value={extra[sp.id]?.name ?? ""} onChange={(e) => setFor(sp.id, { name: e.target.value })} />
                    <input aria-label={`Package size for line ${sp.serial_number}`} className="input" placeholder="Size, e.g. 330ml" value={extra[sp.id]?.size ?? ""} onChange={(e) => setFor(sp.id, { size: e.target.value })} />
                    <input aria-label={`Unit for line ${sp.serial_number}`} className="input" placeholder="Unit, e.g. Bottle" value={extra[sp.id]?.unit ?? ""} onChange={(e) => setFor(sp.id, { unit: e.target.value })} />
                    <select aria-label={`Price type for line ${sp.serial_number}`} className="input" value={extra[sp.id]?.type ?? "SELLING"} onChange={(e) => setFor(sp.id, { type: e.target.value })}>
                      <option value="SELLING">Selling price</option><option value="PURCHASE_COST">Purchase cost</option><option value="OTHER">Other</option>
                    </select>
                    <input aria-label={`Approved amount for line ${sp.serial_number}`} className="input" inputMode="numeric" placeholder="Approved amount" value={extra[sp.id]?.amount ?? ""} onChange={(e) => setFor(sp.id, { amount: e.target.value })} />
                    <label className="text-sm sm:col-span-6">Applies from (effective date) <input type="date" className="input mt-1 max-w-xs" value={extra[sp.id]?.date ?? ""} onChange={(e) => setFor(sp.id, { date: e.target.value })} /></label>
                  </div>
                </div>
              ))}
              <Field label="Note explaining the decision">{(p) => <textarea {...p} className="input" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
              {!open.owner_only && <Field label="Where is the evidence?" hint="Needed for “Explained with evidence”.">{(p) => <input {...p} className="input" maxLength={300} value={evidence} onChange={(e) => setEvidence(e.target.value)} />}</Field>}
              <button className="btn-primary" disabled={busy || !resolution || note.trim().length < 10} onClick={decide}>{busy ? "Saving…" : "Record the decision"}</button>
            </div>
          )}
          {problem && <div className="mt-3"><Alert kind="error">{problem}</Alert></div>}
        </Modal>
      )}
    </div>
  );
}

function Mapping({ isOwner, onChange }: { isOwner: boolean; onChange: () => void }) {
  const [status, setStatus] = useBackState("mapping.status", "PENDING_REVIEW");
  const [search, setSearch] = useBackState("mapping.search", "");
  const list = useLoad<Page<SourceProduct>>(`/history/source-products/?page_size=300${status ? `&status=${status}` : ""}${search ? `&search=${encodeURIComponent(search)}` : ""}`);
  const live = useLoad<Page<Product>>("/products/?page_size=500");
  const [open, setOpen] = useState<SourceProduct | null>(null);
  const [form, setForm] = useState({ name: "", unit: "", size: "", mode: "create", product: "", price: "", cost: "", note: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function show(sp: SourceProduct) {
    setOpen(sp);
    setProblem(null);
    setForm({ name: sp.proposed_name, unit: sp.proposed_unit, size: sp.proposed_package_size, mode: "create", product: "",
      price: sp.selling_prices.length && Number(sp.selling_prices.at(-1)!.amount) > 0 ? sp.selling_prices.at(-1)!.amount : "",
      cost: "", note: "" });
  }
  async function decide(approve: boolean) {
    if (!open || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await api(`/history/source-products/${open.id}/decide/`, { method: "POST", body: approve ? {
        approve: true, confirmed_name: form.name, confirmed_unit: form.unit, confirmed_package_size: form.size, note: form.note,
        create_product: form.mode === "create", product: form.mode === "existing" && form.product ? Number(form.product) : null,
        selling_price: form.mode === "create" && form.price.trim() ? form.price.replace(/,/g, "") : null,
        cost_price: form.mode === "create" && form.cost.trim() ? form.cost.replace(/,/g, "") : null,
      } : { approve: false, note: form.note } });
      await list.reload();
      setOpen(null);
      live.reload();
      onChange();
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card overflow-x-auto">
      <p className="mb-3 text-slate-700">Every product name found in the sheets. Similar names are never merged for you, and no unit or price is assumed. The Owner confirms what each one is.</p>
      <div className="mb-3 grid max-w-2xl gap-3 sm:grid-cols-2">
        <Field label="Show">{(p) => (
          <select {...p} className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="PENDING_REVIEW">Waiting for review</option><option value="APPROVED">Approved</option><option value="REJECTED">Not mapped</option><option value="">All</option>
          </select>)}</Field>
        <Field label="Search">{(p) => <input {...p} className="input" value={search} onChange={(e) => setSearch(e.target.value)} />}</Field>
      </div>
      {list.loading && !list.data ? <Spinner /> : list.error ? <Alert kind="error">{list.error}</Alert> : (list.data?.results.length ?? 0) === 0 ? <p className="p-4 text-slate-600">Nothing here.</p> : (
        <table className="table">
          <thead><tr><th>S/N</th><th>Name in the sheets</th><th>Pack / size text</th><th>Sales price recorded</th><th>Purchase price recorded</th><th>Needs attention</th><th>Status</th><th /></tr></thead>
          <tbody>
            {list.data!.results.map((sp) => (
              <tr key={sp.id}>
                <td>{sp.serial_number}</td>
                <td className="font-semibold">{sp.source_name}<span className="block text-sm font-normal text-slate-600">{formatDate(sp.first_seen)} to {formatDate(sp.last_seen)} · {sp.record_count} sheets</span></td>
                <td>{[sp.pack_text, sp.description_text].filter(Boolean).join(" · ") || "—"}</td>
                <td>{sp.price_unresolved ? <span className="font-semibold text-red-800">⚠ Price unresolved</span> : prices(sp.selling_prices)}</td>
                <td>{prices(sp.purchase_prices)}</td>
                <td>{[...sp.flags.map((f) => FLAG_LABEL[f] ?? f), ...sp.open_exceptions.map((e) => `Open: ${e.title}`)].join("; ") || "—"}</td>
                <td><StatusBadge status={sp.review_status === "PENDING_REVIEW" ? "PENDING" : sp.review_status} label={sp.status_label} />
                  {sp.product_name && <span className="block text-sm">→ {sp.product_name}{sp.product_is_active === false ? " (not on sale)" : ""}</span>}</td>
                <td className="text-right">{isOwner && <button className="btn-secondary min-h-[2.5rem]" onClick={() => show(sp)}>Decide</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {open && (
        <Modal title={`S/N ${open.serial_number} · ${open.source_name}`} onClose={() => setOpen(null)} wide>
          <p className="text-slate-700">Sales price recorded: {prices(open.selling_prices)}. Purchase price recorded: {prices(open.purchase_prices)}.</p>
          {open.open_exceptions.length > 0 && <div className="mt-2"><Alert kind="warning">Open question(s): {open.open_exceptions.map((e) => e.title).join("; ")}</Alert></div>}
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <Field label="Confirmed product name">{(p) => <input {...p} className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <Field label="Unit counted and sold in" hint={open.proposed_unit ? "From the sheet" : "Not stated in the sheets: please choose."}>{(p) => (
              <select {...p} className="input" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}>
                <option value="">— Choose —</option>{["Bottle", "Crate", "Carton", "Box", "Pack"].map((u) => <option key={u}>{u}</option>)}
              </select>)}</Field>
            <Field label="Size (optional)" hint="For example 750ml: the volume of one bottle.">{(p) => <input {...p} className="input" value={form.size} onChange={(e) => setForm({ ...form, size: e.target.value })} />}</Field>
          </div>
          <fieldset className="mt-3"><legend className="mb-1 font-semibold">In the live product list</legend>
            <label className="flex items-center gap-2 py-1"><input type="radio" className="h-5 w-5" checked={form.mode === "create"} onChange={() => setForm({ ...form, mode: "create" })} /> Create a new product</label>
            <label className="flex items-center gap-2 py-1"><input type="radio" className="h-5 w-5" checked={form.mode === "existing"} onChange={() => setForm({ ...form, mode: "existing" })} /> It is a product that already exists</label>
          </fieldset>
          {form.mode === "create" ? (
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              <Field label="Approved selling price (TZS)" hint="Leave empty if not yet agreed: the product is created but cannot be sold.">{(p) => <input {...p} className="input" inputMode="numeric" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />}</Field>
              <Field label="Approved purchase cost (TZS, optional)">{(p) => <input {...p} className="input" inputMode="numeric" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} />}</Field>
            </div>
          ) : (
            <div className="mt-2"><Field label="Existing product">{(p) => (
              <select {...p} className="input" value={form.product} onChange={(e) => setForm({ ...form, product: e.target.value })}>
                <option value="">— Choose —</option>{(live.data?.results ?? []).map((x) => <option key={x.id} value={x.id}>{x.name} {x.package_size}</option>)}
              </select>)}</Field></div>
          )}
          <div className="mt-3"><Field label="Note" hint="Needed if you choose not to map this name.">{(p) => <input {...p} className="input" maxLength={500} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}</Field></div>
          <p className="mt-2 text-sm text-slate-600">Mapping never gives a product any stock. Opening stock comes only from the approved physical count.</p>
          {problem && <div className="mt-3"><Alert kind="error">{problem}</Alert></div>}
          <div className="mt-4 flex flex-wrap gap-3">
            <button className="btn-primary" disabled={busy} onClick={() => decide(true)}>{busy ? "Saving…" : "Approve this mapping"}</button>
            <button className="btn-secondary" disabled={busy} onClick={() => decide(false)}>Do not map (keep history only)</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function UnlabelledRows({ onChange }: { onChange: () => void }) {
  const list = useLoad<Page<Row>>("/history/unclassified-rows/?page_size=500");
  const [label, setLabel] = useState<Record<number, string>>({});
  const [reason, setReason] = useState<Record<number, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const groups = useMemo(() => {
    const map = new Map<number, Row[]>();
    for (const row of list.data?.results ?? []) map.set(row.source_row, [...(map.get(row.source_row) ?? []), row]);
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [list.data]);

  async function decide(rowNumber: number, rows: Row[], action: "CLASSIFY" | "EXCLUDE" | "FLAG") {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await api("/history/unclassified-rows/decide/", { method: "POST", body: {
        ids: rows.map((r) => r.id), action, classification: label[rowNumber] ?? "", reason: reason[rowNumber] ?? "" } });
      await list.reload();
      onChange();
    } catch (err) {
      setProblem(`Row ${rowNumber}: ${errorMessage(err)}`);
    } finally {
      setBusy(false);
    }
  }

  if (list.loading && !list.data) return <Spinner />;
  return (
    <div className="space-y-4">
      <div className="card"><p className="text-slate-700">
        These rows sit under the product list in each sheet and have no label. They are kept exactly as written. You can say what a row is,
        exclude it, or flag it for investigation. Whatever you choose, a row is never imported as a sale, payment, expense or stock movement.
        The same row number across all sheets is decided together.</p>
        {problem && <div className="mt-3"><Alert kind="error">{problem}</Alert></div>}
      </div>
      {groups.length === 0 && <div className="card text-slate-600">No unlabelled rows.</div>}
      {groups.map(([rowNumber, rows]) => {
        const statuses = [...new Set(rows.map((r) => r.status_label))];
        const proposals = [...new Set(rows.map((r) => r.proposed_classification))];
        return (
          <section key={rowNumber} className="card">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-lg font-bold">Row {rowNumber} · in {rows.length} sheet(s)</h3>
              <span>{statuses.map((s) => <StatusBadge key={s} status={s === "Classified" ? "APPROVED" : s === "Excluded" ? "VOIDED" : "PENDING"} label={s} />)}</span>
            </div>
            <p className="text-slate-700"><strong>Proposed:</strong> {proposals.join(" / ")}. <span className="text-slate-600">{rows[0].proposal_basis}</span></p>
            {rows[0].classification && <p><strong>Decided as:</strong> {rows[0].classification}{rows[0].reason && ` · ${rows[0].reason}`}{rows[0].decided_by_name && ` · reviewer: ${rows[0].decided_by_name}`}</p>}
            {rows[0].history.length > 0 && (
              <details className="mt-1"><summary className="cursor-pointer font-semibold">Decision history ({rows[0].history.length})</summary>
                <ul className="ml-5 list-disc text-sm">
                  {rows[0].history.map((h, i) => <li key={i}>{formatDate(h.decided_at)} · {h.reviewer} · {h.status_label}{h.classification && ` as “${h.classification}”`}{h.reason && ` · ${h.reason}`}</li>)}
                </ul>
              </details>
            )}
            <details className="mt-2"><summary className="cursor-pointer font-semibold">Show the original values in each sheet</summary>
              <div className="max-h-56 overflow-auto"><table className="table"><thead><tr><th>Sheet</th><th>Original cells</th><th>Proposed</th><th>Status</th></tr></thead>
                <tbody>{rows.map((r) => <tr key={r.id}><td>{r.worksheet} row {r.source_row}</td><td className="font-mono">{r.original.map((c) => `${c.column}: ${c.value}`).join("   ")}</td><td>{r.proposed_classification}</td><td>{r.status_label}</td></tr>)}</tbody></table></div>
            </details>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <input aria-label={`What row ${rowNumber} is`} className="input" placeholder={`What is it? e.g. ${proposals[0] === "Not known" ? "Cash banked" : proposals[0]}`} value={label[rowNumber] ?? ""} onChange={(e) => setLabel({ ...label, [rowNumber]: e.target.value })} />
              <input aria-label={`Reason for row ${rowNumber}`} className="input" placeholder="Reason (needed to exclude or to change a decision)" value={reason[rowNumber] ?? ""} onChange={(e) => setReason({ ...reason, [rowNumber]: e.target.value })} />
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button className="btn-primary min-h-[2.5rem]" disabled={busy || !(label[rowNumber] ?? "").trim()} onClick={() => decide(rowNumber, rows, "CLASSIFY")}>Classify</button>
              <button className="btn-secondary min-h-[2.5rem]" disabled={busy} onClick={() => decide(rowNumber, rows, "EXCLUDE")}>Exclude</button>
              <button className="btn-secondary min-h-[2.5rem]" disabled={busy} onClick={() => decide(rowNumber, rows, "FLAG")}>Flag for investigation</button>
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Records() {
  const [date, setDate] = useBackState("records.date", "");
  const [search, setSearch] = useBackState("records.search", "");
  const [incomplete, setIncomplete] = useBackState("records.incomplete", false);
  const [page, setPage] = useBackState("records.page", 1);
  const list = useLoad<Page<HistRecord>>(`/history/records/?page=${page}&page_size=50${date ? `&date=${date}` : ""}${search ? `&search=${encodeURIComponent(search)}` : ""}${incomplete ? "&incomplete=true" : ""}`);
  const pages = Math.max(1, Math.ceil((list.data?.count ?? 0) / 50));
  return (
    <div className="card overflow-x-auto">
      <p className="mb-3 text-slate-700">Each line is a dated snapshot copied from a daily sheet, shown as it was written. These are not transactions and have not changed live stock. Lines marked “Incomplete” are affected by an exception that is open or was accepted without explanation.</p>
      <div className="mb-3 grid max-w-3xl gap-3 sm:grid-cols-3">
        <Field label="Day">{(p) => <input {...p} type="date" className="input" value={date} onChange={(e) => { setDate(e.target.value); setPage(1); }} />}</Field>
        <Field label="Product name">{(p) => <input {...p} className="input" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />}</Field>
        <label className="flex items-center gap-3 self-end pb-2"><input type="checkbox" className="h-6 w-6" checked={incomplete} onChange={(e) => { setIncomplete(e.target.checked); setPage(1); }} /> Only incomplete lines</label>
      </div>
      {list.loading && !list.data ? <Spinner /> : list.error ? <Alert kind="error">{list.error}</Alert> : (list.data?.results.length ?? 0) === 0 ? <p className="p-4 text-slate-600">No historical records match.</p> : (
        <table className="table">
          <thead><tr><th>Date</th><th>Source</th><th>Product</th><th className="num">Opening</th><th className="num">Bought</th><th className="num">Sold</th><th className="num">Closing</th><th className="num">Purchase price</th><th className="num">Sales price</th><th className="num">Total sales</th><th>Checks</th><th>Status</th></tr></thead>
          <tbody>
            {list.data!.results.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">{formatDate(r.business_date)}</td><td className="whitespace-nowrap">{r.worksheet} row {r.source_row}</td><td>{r.source_name}</td>
                <td className="num">{q(r.opening_qty)}</td><td className="num">{q(r.purchases_qty)}</td><td className="num">{q(r.sold_qty)}</td><td className="num">{q(r.closing_qty)}</td>
                <td className="num">{r.purchase_price === null ? "" : formatTZS(r.purchase_price)}</td><td className="num">{r.sales_price === null ? "" : formatTZS(r.sales_price)}</td>
                <td className="num">{r.total_sales === null ? "" : formatTZS(r.total_sales)}</td>
                <td title={r.validation_messages.join(" ")}>{r.validation_status === "VALID" ? "OK" : r.validation_status === "WARNING" ? "⚠ Does not add up" : "⚠ Unreadable"}</td>
                <td>{r.import_status_label}{r.incomplete && <span className="block text-sm font-semibold text-amber-800">⚠ Incomplete</span>}</td>
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
  );
}

const TABS = [["overview", "Overview and import"], ["exceptions", "Exceptions"], ["mapping", "Product Mapping Review"], ["rows", "Unlabelled rows"], ["records", "Historical Daily Records"]] as const;

export default function HistoryPage() {
  const { user } = useAuth();
  const isOwner = user?.role === "OWNER";
  const board = useLoad<Dashboard>("/history/dashboard/");
  const [tab, setTab] = useBackState<(typeof TABS)[number][0]>("tab", "overview");
  if (board.loading && !board.data) return <Spinner />;
  if (board.error || !board.data) return <Alert kind="error">{board.error}</Alert>;
  const counts: Record<string, number> = { exceptions: board.data.blockers.exceptions, mapping: board.data.blockers.product_mappings, rows: board.data.blockers.unlabelled_rows };

  return (
    <div className="space-y-5">
      <PageTitle title="Excel History" help="The old daily Excel sheets, kept for reference and reviewed here. They stay separate from the live system: nothing on this page changes live stock, sales or balances." />
      {tab !== "overview" && !board.data.reconciled && board.data.has_data && <Alert kind="warning"><strong>{board.data.statement}</strong></Alert>}
      <div role="tablist" aria-label="Excel history sections" className="flex flex-wrap gap-2">
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={`btn min-h-[2.75rem] border-2 ${tab === key ? "border-brand-700 bg-brand-600 text-white" : "border-slate-300 bg-white"}`}>
            {label}{counts[key] ? ` (${counts[key]})` : ""}
          </button>
        ))}
      </div>
      {tab === "overview" && <Overview board={board.data} reload={board.reload} isOwner={isOwner} />}
      {tab === "exceptions" && <Exceptions isOwner={isOwner} onChange={board.reload} />}
      {tab === "mapping" && <Mapping isOwner={isOwner} onChange={board.reload} />}
      {tab === "rows" && <UnlabelledRows onChange={board.reload} />}
      {tab === "records" && <Records />}
    </div>
  );
}
