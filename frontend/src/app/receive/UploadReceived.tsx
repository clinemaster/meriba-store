"use client";

import { useMemo, useState } from "react";

import { Alert, ConfirmToast, Field, Modal } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";
import { formatDate, formatQty, formatTime } from "@/lib/money";
import type { Product } from "@/lib/types";

type Problem = { problem: string; fix: string };
type ProductInfo = { id: number; label: string; base_unit: string; volume_ml: number | null; serial_number: number | null };
type MatchStatus = "MATCHED" | "DUPLICATE" | "NEEDS_REVIEW" | "UNMATCHED" | "EXCLUDED" | "SKIPPED";
type Edit = { product?: number; unit?: string; volume?: string; quantity?: string; excluded?: boolean };
export type ImportRow = {
  row: number; sheet: string; sn: string; details: string; unit: string; unit_name?: string | null; volume: string; quantity: string;
  uploaded: { details: string; unit: string; volume: string; quantity: string }; edited: string[]; excluded: boolean; chosen: boolean;
  status: "READY" | "UNMATCHED" | "AMBIGUOUS" | "INVALID" | "SKIPPED" | "EXCLUDED"; status_label: string;
  match_status: MatchStatus; match_label: string; name_differs: boolean;
  problems: Problem[]; notes: string[]; product: ProductInfo | null; candidates: ProductInfo[];
  factor: string | null; adds: string | null; stock_before: string | null; stock_after?: string; duplicate: boolean;
};
type Result = {
  batch: string; file: string; receipts: number[]; rows_added: number; products_updated: number;
  added: { row: number; details: string; product: string; added: string; base_unit: string; receipt: number }[];
  skipped: { row: number; details: string; status: string; problems: string[] }[];
};
type Summary = {
  total_rows: number; matched: number; needs_review: number; unmatched: number; duplicate_rows: number; ready: number;
  excluded: number; not_product_rows: number; blocking: number; undecided_duplicates: number; can_confirm: boolean;
  received_by_unit: { unit: string; quantity: string }[];
};
export type Preview = {
  batch: string; file: string; status: "PREVIEW" | "CONFIRMED"; is_live: boolean;
  already_imported: { batch: string; imported_at: string; by: string; receipts: number[] } | null;
  rows: ImportRow[]; summary: Summary; edits: Record<string, Edit>; decisions: Record<string, "combine" | "separate">;
  duplicates: { product: number; label: string; rows: number[]; ready_rows: number[]; total: string; decision: string | null }[];
  result: Result | null;
};

const MATCH_STYLE: Record<MatchStatus, { icon: string; tone: string; row: string }> = {
  MATCHED: { icon: "✔", tone: "border-green-300 bg-green-50 text-green-900", row: "" },
  DUPLICATE: { icon: "⧉", tone: "border-amber-300 bg-amber-50 text-amber-900", row: "bg-amber-50/50" },
  NEEDS_REVIEW: { icon: "⚠", tone: "border-amber-400 bg-amber-100 text-amber-950", row: "bg-amber-50" },
  UNMATCHED: { icon: "✕", tone: "border-red-300 bg-red-50 text-red-900", row: "bg-red-50/60" },
  EXCLUDED: { icon: "⊘", tone: "border-slate-300 bg-slate-100 text-slate-700", row: "text-slate-500" },
  SKIPPED: { icon: "–", tone: "border-slate-300 bg-slate-50 text-slate-700", row: "text-slate-500" },
};
const UNITS = ["Bottle", "Crate", "Carton", "Box", "Pack"];
const BASE = "/stock/receipt-imports/";
// Match Status and Action stay pinned at the right on a narrow screen; only the figures in between scroll sideways.
const PIN_STATUS = "sticky right-28 z-[1] w-44 min-w-[11rem] max-w-[11rem] bg-white shadow-[-6px_0_6px_-6px_rgba(0,0,0,0.25)]";
const PIN_ACTION = "sticky right-0 z-[1] w-28 min-w-[7rem] bg-white";
/** "Bottle" -> "bottles" (or "bottle" for one), "Box" -> "boxes". Only for the shop's own unit names. */
const plural = (unit: string, n: number | string) => `${unit.toLowerCase()}${Number(n) === 1 ? "" : unit.toLowerCase().endsWith("x") ? "es" : "s"}`;
/** The unit as the shop names it when the file's word is one of them, otherwise the file's word as written. */
const unitText = (r: ImportRow) => (r.unit_name ? plural(r.unit_name, r.quantity) : r.unit);

/**
 * Upload Received Stock (Owner only; the server refuses anyone else). The file is matched to the products, put in the
 * Products page's order and shown for checking. The Owner can change a match, correct a unit, volume or quantity,
 * or exclude a row. Stock changes only when every row is ready or excluded and the Owner confirms.
 */
export function UploadReceived({ suppliers, products, onClose, onImported }: {
  suppliers: { id: number; name: string; is_active: boolean }[]; products: Product[]; onClose: () => void; onImported: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reviewing, setReviewing] = useState<ImportRow | null>(null);
  const [supplierId, setSupplierId] = useState("");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [onlyAttention, setOnlyAttention] = useState(false);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  async function send() {
    if (!file || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const form = new FormData();
      form.append("file", file);
      setPreview(await api<Preview>(BASE, { method: "POST", form }));
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  /** Save corrections or combine/separate choices on the upload and show the rows checked again. Stock is not touched. */
  async function saveReview(body: { edits?: Record<string, Edit>; decisions?: Record<string, string> }) {
    if (!preview) return false;
    setProblem(null);
    try {
      setPreview(await api<Preview>(`${BASE}${preview.batch}/`, { method: "POST", body }));
      return true;
    } catch (err) {
      setProblem(errorMessage(err));
      return false;
    }
  }

  async function setEdit(row: number, edit: Edit | null) {
    if (!preview) return false;
    const edits = { ...preview.edits };
    if (edit && Object.keys(edit).length) edits[row] = edit; else delete edits[row];
    return saveReview({ edits });
  }

  async function confirm() {
    if (!preview || busy) return;
    setAsking(false);
    setBusy(true);
    setProblem(null);
    try {
      const done = await api<{ result: Result }>(`${BASE}${preview.batch}/confirm/`, {
        method: "POST", body: { supplier: supplierId ? Number(supplierId) : null, reference, reimport_reason: reason },
      });
      setResult(done.result);
      onImported();
    } catch (err) {
      setProblem(errorMessage(err));
      // The products or stock may have changed since the preview: show the rows as they stand now.
      if (err instanceof ApiError && err.status !== 403) {
        try { setPreview(await api<Preview>(`${BASE}${preview.batch}/`)); } catch { /* keep the old preview */ }
      }
    } finally {
      setBusy(false);
    }
  }

  const s = preview?.summary;
  const repeatBlocked = !!preview?.already_imported && reason.trim().length < 10;
  const ready = !!preview && !!s?.can_confirm && preview.is_live && !repeatBlocked;
  const shown = (preview?.rows ?? []).filter((r) => !onlyAttention || (r.match_status !== "MATCHED" && r.match_status !== "SKIPPED"));
  const openDuplicates = (preview?.duplicates ?? []).filter((d) => d.ready_rows.length > 1);

  return (
    <section aria-label="Upload Received Stock" className="card space-y-4 border-2 border-brand-600">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Upload Received Stock</h2>
          <p className="max-w-3xl text-slate-600">
            Add a whole delivery from an Excel file. Every row is matched to a product and shown here first. Stock changes only when you press Confirm and Import Stock.
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
      </div>
      {problem && <Alert kind="error">{problem}</Alert>}

      {result ? (
        <ImportSummary result={result} onDone={onClose} />
      ) : !preview || !s ? (
        <div className="space-y-3">
          <p>
            The file must have these columns, in this order: <strong>S/N, Details, Counted by or Unit, Volume (ml), Quantity received</strong>.{" "}
            <a className="font-semibold text-brand-700 underline" href={`/api/v1${BASE}template/`}>Download the template (Excel)</a>
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Excel file (.xlsx)">
              {(p) => <input {...p} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="input"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
            </Field>
            <button type="button" className="btn-primary" disabled={!file || busy} onClick={send}>{busy ? "Reading the file…" : "Upload and check"}</button>
          </div>
          <p className="text-sm text-slate-600">An older .xls file can be saved as .xlsx in Excel first (File → Save As → Excel Workbook).</p>
        </div>
      ) : (
        <div className="space-y-4">
          <div aria-label="Import summary" className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="mb-2"><strong>{preview.file}</strong> · nothing has been added to stock yet.</p>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
              {([
                ["Rows uploaded", s.total_rows, ""], ["Matched", s.matched, "text-green-800"], ["Needs review", s.needs_review, "text-amber-800"],
                ["Unmatched", s.unmatched, "text-red-800"], ["Duplicate rows", s.duplicate_rows, "text-amber-800"],
                ["Excluded", s.excluded, "text-slate-700"], ["Ready for import", s.ready, "text-green-800"],
              ] as const).map(([label, value, tone]) => (
                <div key={label} className="rounded-lg bg-white p-2">
                  <dt className="text-xs font-semibold text-slate-600">{label}</dt>
                  <dd className={`text-2xl font-bold tabular-nums ${tone}`}>{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-sm">
              <strong>Will be added to stock:</strong>{" "}
              {s.received_by_unit.length ? s.received_by_unit.map((u) => `${formatQty(u.quantity)} ${plural(u.unit, u.quantity)}`).join(" · ") : "nothing yet"}
              <span className="text-slate-600"> (each unit counted on its own, never added together)</span>
            </p>
          </div>

          {!preview.is_live && <Alert kind="error">Stock can be received after the shop goes live.</Alert>}
          {preview.already_imported && (
            <Alert kind="warning">
              This same file was already imported on {formatDate(preview.already_imported.imported_at)} at {formatTime(preview.already_imported.imported_at)} by{" "}
              {preview.already_imported.by}. Its stock is already in. Importing it again would add the same quantities a second time.
              <div className="mt-2 max-w-xl"><Field label="Only if it really is a second delivery: why import it again?" hint="At least 10 characters. Recorded in Audit History.">
                {(p) => <input {...p} className="input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />}
              </Field></div>
            </Alert>
          )}

          {openDuplicates.length > 0 && (
            <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-3">
              <h3 className="font-bold">The same product is on more than one row</h3>
              <p className="text-sm text-slate-700">They may be separate deliveries. Choose for each.</p>
              <ul className="mt-2 space-y-2">
                {openDuplicates.map((d) => (
                  <li key={d.product}>
                    <fieldset>
                      <legend className="font-semibold">{d.label}: Excel rows {d.ready_rows.join(", ")}</legend>
                      {(["combine", "separate"] as const).map((choice) => (
                        <label key={choice} className="mr-4 inline-flex items-center gap-2">
                          <input type="radio" name={`dup-${d.product}`} checked={d.decision === choice}
                            onChange={() => {
                              // Shown as chosen straight away; the saved answer from the server follows.
                              setPreview({ ...preview, duplicates: preview.duplicates.map((x) => (x.product === d.product ? { ...x, decision: choice } : x)) });
                              saveReview({ decisions: { ...preview.decisions, [d.product]: choice } });
                            }} />
                          {choice === "combine" ? `Add together as one delivery (${formatQty(d.total)})` : "Keep as separate deliveries"}
                        </label>
                      ))}
                    </fieldset>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-5 w-5" checked={onlyAttention} onChange={(e) => setOnlyAttention(e.target.checked)} /> Show only rows that are not a plain match
          </label>
          <div className="max-h-[60vh] overflow-auto">
            <table className="table min-w-[940px] text-sm">
              <thead className="sticky top-0 z-10 bg-white">
                <tr>
                  <th>S/N</th><th>Uploaded Product Details</th><th>Matched System Product</th><th>Unit</th><th>Volume (ml)</th>
                  <th className="num">Existing Stock</th><th className="num">Quantity Received</th><th className="num">Projected Stock</th>
                  <th className={PIN_STATUS}>Match Status</th><th className={PIN_ACTION}>Action</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const style = MATCH_STYLE[r.match_status];
                  const base = r.product?.base_unit;
                  return (
                    <tr key={`${r.sheet}-${r.row}`} className={style.row}>
                      <td className="whitespace-nowrap"><span className="block">{r.sn || "—"}</span><span className="text-xs text-slate-600">Excel row {r.row}</span></td>
                      <td className="font-semibold">{r.uploaded.details || "—"}</td>
                      <td>
                        {r.product ? <span className="font-semibold">{r.product.label}</span> : <span className="text-red-800">No product</span>}
                        {r.name_differs && <span className="mt-1 block text-xs font-semibold text-amber-900">⚠ Different name from the file: check it</span>}
                        {r.chosen && <span className="block text-xs text-slate-600">Chosen by you</span>}
                      </td>
                      <td className="whitespace-nowrap">
                        <Edited value={r.unit} was={r.uploaded.unit} changed={r.edited.includes("unit")} />
                        {base && <span className="block text-xs text-slate-600">System: {base}{r.factor && Number(r.factor) !== 1 ? ` (1 ${(r.unit_name ?? r.unit).toLowerCase()} = ${formatQty(r.factor)})` : ""}</span>}
                      </td>
                      <td className="whitespace-nowrap">
                        <Edited value={r.volume || "—"} was={r.uploaded.volume || "—"} changed={r.edited.includes("volume")} />
                        {r.product && <span className="block text-xs text-slate-600">System: {r.product.volume_ml ?? "—"}</span>}
                      </td>
                      <td className="num">{r.stock_before !== null && base ? `${formatQty(r.stock_before)} ${plural(base, r.stock_before)}` : "—"}</td>
                      <td className="num">
                        <Edited value={`${r.quantity} ${unitText(r)}`} was={r.uploaded.quantity} changed={r.edited.includes("quantity")} />
                        {r.adds && base && Number(r.factor) !== 1 && <span className="block text-xs text-slate-600">= {formatQty(r.adds)} {plural(base, r.adds)}</span>}
                      </td>
                      <td className="num font-semibold">{r.stock_after !== undefined && base ? `${formatQty(r.stock_after)} ${plural(base, r.stock_after)}` : "—"}</td>
                      <td className={PIN_STATUS}>
                        <span className={`inline-flex whitespace-nowrap items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${style.tone}`}>
                          <span aria-hidden>{style.icon}</span>{r.match_label}
                        </span>
                        {r.status !== "EXCLUDED" && r.problems.map((p, i) => <p key={i} className="mt-1 text-sm"><strong>{p.problem}</strong> {p.fix}</p>)}
                      </td>
                      <td className={PIN_ACTION}>
                        {r.match_status === "SKIPPED" ? null : r.excluded ? (
                          <button type="button" className="btn-secondary min-h-[2.25rem] whitespace-nowrap" onClick={() => setEdit(r.row, { ...preview.edits[r.row], excluded: undefined })}>Include again</button>
                        ) : (
                          <button type="button" className={`${r.match_status === "MATCHED" ? "btn-secondary" : "btn-primary"} min-h-[2.25rem] whitespace-nowrap`}
                            aria-label={`Review Excel row ${r.row}`} onClick={() => setReviewing(r)}>
                            {r.match_status === "MATCHED" ? "Change" : "Review"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Supplier (optional)">{(p) => (
              <select {...p} className="input" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">— Not recorded —</option>
                {suppliers.filter((x) => x.is_active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </select>)}</Field>
            <Field label="Invoice or delivery note number (optional)">{(p) => <input {...p} className="input" maxLength={60} value={reference} onChange={(e) => setReference(e.target.value)} />}</Field>
          </div>
          <p className="text-sm text-slate-600">Each product&apos;s current purchase price is recorded as the cost, as on the Receive Stock form.</p>

          {ready ? (
            <button type="button" className="btn-primary btn-big" disabled={busy} onClick={() => setAsking(true)}>
              {busy ? "Adding to stock…" : "Confirm and Import Stock"}
            </button>
          ) : (
            <Alert kind="warning">
              Before importing:{" "}
              {[
                s.blocking > 0 && `review or exclude ${s.blocking} row(s) marked Needs review or Unmatched`,
                s.undecided_duplicates > 0 && "choose add together or keep separate for each repeated product",
                s.ready === 0 && "at least one row must be ready",
                repeatBlocked && "write why the same file is imported again",
                !preview.is_live && "the shop must be live",
              ].filter(Boolean).join("; ")}.
            </Alert>
          )}
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => { setPreview(null); setFile(null); setReason(""); }}>Choose another file</button>
          {asking && (
            <ConfirmToast
              message={`Add ${s.ready} row(s) to stock (${s.received_by_unit.map((u) => `${formatQty(u.quantity)} ${plural(u.unit, u.quantity)}`).join(", ")})? ${s.excluded + s.not_product_rows} row(s) are left out. Deliveries cannot be edited afterwards; a mistake is fixed with a stock adjustment.`}
              yes="Yes, import the stock" busy={busy} onNo={() => setAsking(false)} onYes={confirm} />
          )}
        </div>
      )}

      {reviewing && preview && (
        <ReviewRow row={reviewing} edit={preview.edits[reviewing.row] ?? {}} products={products} onClose={() => setReviewing(null)}
          onSave={async (edit) => { if (await setEdit(reviewing.row, edit)) setReviewing(null); }} />
      )}
    </section>
  );
}

function Edited({ value, was, changed }: { value: string; was: string; changed: boolean }) {
  if (!changed) return <span>{value}</span>;
  return <span><span className="font-semibold">{value}</span> <span className="block text-xs text-slate-600">file: <s>{was || "empty"}</s> · corrected</span></span>;
}

/** One row: change the product, correct the unit, volume or quantity, or exclude it. Saved on the upload; stock is not touched. */
function ReviewRow({ row, edit, products, onClose, onSave }: {
  row: ImportRow; edit: Edit; products: Product[]; onClose: () => void; onSave: (edit: Edit | null) => void;
}) {
  const [productId, setProductId] = useState(edit.product ? String(edit.product) : "");
  const [unit, setUnit] = useState(row.unit);
  const [volume, setVolume] = useState(row.volume);
  const [quantity, setQuantity] = useState(row.quantity);
  const [find, setFind] = useState("");
  const candidateIds = new Set(row.candidates.map((c) => c.id));
  const choices = useMemo(() => {
    const words = find.toLowerCase().split(/\s+/).filter(Boolean);
    return products
      .filter((p) => !candidateIds.has(p.id) && words.every((w) => `${p.name} ${p.package_size}`.toLowerCase().includes(w)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [products, find, row.candidates]);
  const label = (p: { label?: string; name?: string; package_size?: string; base_unit: string; volume_ml: number | null }) =>
    `${p.label ?? `${p.name} ${p.package_size}`.trim()} · ${p.base_unit}${p.volume_ml ? ` · ${p.volume_ml} ml` : ""}`;

  function save() {
    const next: Edit = {};
    if (productId) next.product = Number(productId);
    if (unit !== row.uploaded.unit) next.unit = unit;
    if (volume !== row.uploaded.volume) next.volume = volume;
    if (quantity !== row.uploaded.quantity) next.quantity = quantity;
    onSave(next);
  }

  return (
    <Modal title={`Review Excel row ${row.row}`} onClose={onClose} wide>
      <div className="space-y-3">
        <p>The file says: <strong>{row.uploaded.details || "(no details)"}</strong> · {row.uploaded.unit || "no unit"} · {row.uploaded.volume || "no volume"} ml · quantity {row.uploaded.quantity || "empty"}</p>
        {row.problems.map((p, i) => <Alert key={i} kind="warning"><strong>{p.problem}</strong> {p.fix}</Alert>)}
        {row.notes.map((n, i) => <p key={i} className="text-sm text-slate-600">{n}</p>)}

        <Field label="Find a product" hint="Type part of the name to shorten the list.">{(p) => <input {...p} className="input" value={find} onChange={(e) => setFind(e.target.value)} />}</Field>
        <Field label="System product" hint={row.product && !edit.product ? `Matched automatically: ${row.product.label}. Choose another only if that is wrong.` : undefined}>
          {(p) => (
            <select {...p} className="input" value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">{row.product && !edit.product ? `Keep the automatic match (${row.product.label})` : "— Choose the product —"}</option>
              {row.candidates.length > 0 && (
                <optgroup label={`Products called “${row.uploaded.details}”`}>
                  {row.candidates.map((c) => <option key={c.id} value={c.id}>{label(c)}</option>)}
                </optgroup>
              )}
              <optgroup label="All products on sale">
                {choices.map((c) => <option key={c.id} value={c.id}>{label(c)}</option>)}
              </optgroup>
            </select>
          )}
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Unit">{(p) => (
            <select {...p} className="input" value={unit} onChange={(e) => setUnit(e.target.value)}>
              {!UNITS.includes(unit) && <option value={unit}>{unit || "(empty)"} (from the file)</option>}
              {UNITS.map((u) => <option key={u}>{u}</option>)}
            </select>)}</Field>
          <Field label="Volume (ml)" hint="Leave empty if not known.">{(p) => <input {...p} className="input" inputMode="numeric" value={volume} onChange={(e) => setVolume(e.target.value.replace(/[^\d]/g, ""))} />}</Field>
          <Field label="Quantity received">{(p) => <input {...p} className="input" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value.replace(/[^\d]/g, ""))} />}</Field>
        </div>
        <p className="text-sm text-slate-600">The file itself is not changed; your corrections are kept with this upload and recorded when it is imported.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary" onClick={save}>Save and check again</button>
          <button type="button" className="btn-secondary" onClick={() => onSave({ ...edit, excluded: true })}>Exclude this row</button>
          {Object.keys(edit).length > 0 && <button type="button" className="btn-secondary" onClick={() => onSave(null)}>Back to the file&apos;s values</button>}
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

function ImportSummary({ result, onDone }: { result: Result; onDone: () => void }) {
  return (
    <div className="space-y-3">
      <Alert kind="success">
        Stock increased for {result.products_updated} product(s) from {result.rows_added} row(s). Delivery record(s): {result.receipts.map((r) => `#${r}`).join(", ")}.
        Import number {result.batch.slice(0, 8)}.
      </Alert>
      {result.added.length > 0 && (
        <details open>
          <summary className="cursor-pointer font-semibold">Added to stock</summary>
          <table className="table mt-2">
            <thead><tr><th>Excel row</th><th>Details</th><th>Product</th><th className="num">Added</th><th>Delivery</th></tr></thead>
            <tbody>{result.added.map((a) => (
              <tr key={a.row}><td>{a.row}</td><td>{a.details}</td><td>{a.product}</td><td className="num">+{formatQty(a.added)} {plural(a.base_unit, a.added)}</td><td>#{a.receipt}</td></tr>
            ))}</tbody>
          </table>
        </details>
      )}
      {result.skipped.length > 0 && (
        <div>
          <h3 className="font-bold">Left out ({result.skipped.length})</h3>
          <ul className="ml-5 list-disc text-sm">
            {result.skipped.map((x) => <li key={x.row}>Row {x.row} {x.details && `(${x.details})`}: {x.status}. {x.problems.join(" ")}</li>)}
          </ul>
        </div>
      )}
      <button type="button" className="btn-primary" onClick={onDone}>Done</button>
    </div>
  );
}
