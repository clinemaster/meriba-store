"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Alert, ConfirmToast, Field, PageTitle, Spinner, StatusBadge, StockBadge, useConfirm } from "@/components/ui";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useBackState } from "@/lib/backNav";
import { formatDate, formatQty, formatTime } from "@/lib/money";
import { useLiveReload } from "@/lib/stockLevels";
import type { OpeningCount, Product, ShopSettings } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

type Movement = {
  id: number; created_at: string; business_date: string; product_name: string; type_label: string;
  quantity_delta: string; balance_after: string; user_name: string; reason: string;
};
type OpeningState = { state: { approved: boolean; pending: boolean; uncounted: number; uncounted_names: string[]; complete: boolean }; counts: OpeningCount[] };

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Before go-live: the physical count sheet. Nothing becomes stock until the Owner approves it. */
function OpeningCountSheet({ products, reloadProducts }: { products: Product[]; reloadProducts: () => void }) {
  const { user } = useAuth();
  const isOwner = user?.role === "OWNER";
  const opening = useLoad<OpeningState>("/stock/opening-counts/");
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [countDate, setCountDate] = useState(today());
  const [countedBy, setCountedBy] = useState("");
  const [filter, setFilter] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [confirmApproval, setConfirmApproval] = useState(false);
  const { confirm, confirmation, asking } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const requestKey = useRef(crypto.randomUUID());

  const pending = opening.data?.counts.find((c) => c.status === "PENDING_REVIEW") ?? null;
  const approvedQty = useMemo(() => {
    const map = new Map<number, string>();
    for (const count of [...(opening.data?.counts ?? [])].reverse()) {
      if (count.status === "APPROVED") for (const line of count.lines) map.set(line.product, line.approved_quantity ?? line.counted_quantity);
    }
    return map;
  }, [opening.data]);
  const pendingLine = useMemo(() => new Map((pending?.lines ?? []).map((l) => [l.product, l])), [pending]);

  useEffect(() => {
    if (pending) {
      setCountDate(pending.count_date);
      setCountedBy(pending.counted_by_name);
    }
  }, [pending]);

  const rows = products.filter((p) => `${p.name} ${p.package_size} ${p.sku}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const typed = Object.entries(counts).filter(([, v]) => v.trim() !== "");

  async function run(action: () => Promise<unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    setSaved(null);
    try {
      await action();
      setSaved(done);
      setCounts({});
      setReviewNote("");
      requestKey.current = crypto.randomUUID();
      await opening.reload();
      reloadProducts();
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (typed.length === 0) return setProblem("Type the counted quantity for at least one product.");
    if (countedBy.trim().length < 2) return setProblem("Write the name of the person who did the count.");
    const body = { request_key: requestKey.current, count_date: countDate, counted_by_name: countedBy,
                   lines: typed.map(([id, quantity]) => ({ product: Number(id), quantity })) };
    run(() => (pending ? api(`/stock/opening-counts/${pending.id}/`, { method: "PUT", body }) : api("/stock/opening-counts/", { method: "POST", body })),
      `Saved ${typed.length} counted quantit${typed.length === 1 ? "y" : "ies"} on the count sheet. Stock does not change until the Owner approves the sheet.`);
  }

  if (opening.loading && !opening.data) return <Spinner />;
  const state = opening.data?.state;

  return (
    <div className="space-y-6">
      <PageTitle title="Opening Stock Count"
        help="Before the shop goes live, count every product on the shelves and in the store room, and type what was counted. The Owner then checks and approves the sheet. Only an approved physical count becomes stock; figures from the old Excel sheets are shown for comparison only and are never used." />
      {state?.complete && <Alert kind="success">Opening stock is approved for every product on sale.</Alert>}
      {state && !state.complete && state.approved && state.uncounted > 0 && !state.pending && (
        <Alert kind="warning">{state.uncounted} product(s) on sale have no approved count yet, for example: {state.uncounted_names.slice(0, 5).join(", ")}. Count them (type 0 if there are none) to finish.</Alert>
      )}
      {saved && <Alert kind="success">{saved}</Alert>}
      {problem && <Alert kind="error">{problem}</Alert>}

      <section className="card">
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <Field label="Date of the count">{(p) => <input {...p} type="date" className="input" value={countDate} onChange={(e) => setCountDate(e.target.value)} />}</Field>
          <Field label="Counted by" hint="The person responsible for the count.">{(p) => <input {...p} className="input" maxLength={120} value={countedBy} onChange={(e) => setCountedBy(e.target.value)} />}</Field>
          <Field label="Find a product">{(p) => <input {...p} className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Type part of the name" />}</Field>
        </div>
        {pending && (
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <StatusBadge status="PENDING" label="Count sheet waiting for the Owner's approval" />
            <span className="text-slate-600">{pending.lines.length} product(s) entered · prepared by {pending.prepared_by_name}</span>
          </div>
        )}
        <div className="max-h-[55vh] overflow-auto">
          {rows.length === 0 ? <p className="p-4 text-slate-600">No products to show. Add products first.</p> : (
            <table className="table">
              <thead className="sticky top-0 bg-white">
                <tr><th>Product</th><th>Unit counted in</th><th className="num">Approved so far</th><th className="num">On this sheet</th><th className="num">Excel figure (reference only)</th><th className="num">Difference</th><th className="w-40">Quantity counted</th></tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const line = pendingLine.get(p.id);
                  return (
                    <tr key={p.id}>
                      <td><span className="font-semibold">{p.name}</span> {p.package_size}</td>
                      <td>{p.base_unit}</td>
                      <td className="num">{approvedQty.has(p.id) ? formatQty(approvedQty.get(p.id)!) : "Not counted"}</td>
                      <td className="num">{line ? formatQty(line.counted_quantity) : "—"}</td>
                      <td className="num" title={line?.reference_source}>{line?.reference_quantity != null ? formatQty(line.reference_quantity) : "—"}</td>
                      <td className="num">{line?.variance != null ? `${Number(line.variance) > 0 ? "+" : ""}${formatQty(line.variance)}` : "—"}</td>
                      <td>
                        <input aria-label={`Quantity counted for ${p.name} ${p.package_size}`} className="input min-h-[2.5rem]" inputMode="numeric"
                          value={counts[p.id] ?? ""} onChange={(e) => setCounts((c) => ({ ...c, [p.id]: e.target.value.replace(/[^\d]/g, "") }))} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className="btn-primary" disabled={busy || typed.length === 0} onClick={save}>
            {busy ? "Saving…" : typed.length === 0 ? "Type a counted quantity to save" : `Save ${typed.length} to the count sheet`}
          </button>
          <span className="text-sm text-slate-600">Type 0 for a product with none in stock. Rows left empty are not changed.</span>
        </div>
      </section>

      {pending && (
        <section className="card space-y-3">
          <h2 className="text-xl font-bold">Owner&apos;s approval</h2>
          <p className="text-slate-700">
            Count sheet of {formatDate(pending.count_date)}, counted by {pending.counted_by_name}: {pending.lines.length} product(s).
            Approving makes these counted quantities the live stock. Where an Excel figure is shown, it is only for comparison.
          </p>
          {isOwner ? (
            <>
              <Field label="Note" hint="Needed if you reject the sheet, so it can be recounted.">
                {(p) => <input {...p} className="input" maxLength={300} value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} />}
              </Field>
              <div className="flex flex-wrap gap-3">
                <button className="btn-primary" disabled={busy || confirmApproval} onClick={() => setConfirmApproval(true)}>
                  Approve the count
                </button>
                {confirmApproval && (
                  <ConfirmToast
                    message={`Approve this physical count of ${pending.lines.length} product(s)? The counted quantities become live stock.`}
                    yes="Yes, approve" busy={busy} onNo={() => setConfirmApproval(false)}
                    onYes={() => {
                      setConfirmApproval(false);
                      run(() => api(`/stock/opening-counts/${pending.id}/review/`, { method: "POST", body: { approve: true, note: reviewNote } }), "Count sheet approved. The counted quantities are now stock.");
                    }} />
                )}
                <button className="btn-secondary" disabled={busy || confirmApproval || asking}
                  onClick={() => {
                    if (reviewNote.trim().length < 3) return setProblem("Write in the note why the sheet is rejected, so it can be recounted.");
                    setProblem(null);
                    confirm({
                      message: `Reject this count sheet of ${pending.lines.length} product(s)? Nothing becomes stock, and the products must be counted again on a new sheet.`,
                      yes: "Yes, reject", danger: true,
                      run: () => run(() => api(`/stock/opening-counts/${pending.id}/review/`, { method: "POST", body: { approve: false, note: reviewNote } }), "Count sheet rejected. Start a new sheet for the recount."),
                    });
                  }}>
                  Reject for a recount
                </button>
                {confirmation}
              </div>
            </>
          ) : (
            <Alert kind="info">Only the Owner can approve the count.</Alert>
          )}
        </section>
      )}

      {(opening.data?.counts ?? []).some((c) => c.status !== "PENDING_REVIEW") && (
        <section className="card overflow-x-auto">
          <h2 className="mb-3 text-xl font-bold">Earlier count sheets</h2>
          <table className="table">
            <thead><tr><th>Count date</th><th>Counted by</th><th>Prepared by</th><th className="num">Products</th><th>Status</th><th>Reviewed by</th><th>Note</th></tr></thead>
            <tbody>
              {opening.data!.counts.filter((c) => c.status !== "PENDING_REVIEW").map((c) => (
                <tr key={c.id}>
                  <td>{formatDate(c.count_date)}</td><td>{c.counted_by_name}</td><td>{c.prepared_by_name}</td><td className="num">{c.lines.length}</td>
                  <td><StatusBadge status={c.status} label={c.status_label} /></td><td>{c.reviewed_by_name}</td><td>{c.review_note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

export default function StockPage() {
  const shop = useLoad<ShopSettings>("/settings/");
  const products = useLoad<Page<Product>>("/products/?page_size=500&active=true");
  const movements = useLoad<Page<Movement>>("/stock/movements/?page_size=30");
  useLiveReload(() => { products.reload(); movements.reload(); });
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("");
  const [filter, setFilter] = useBackState("filter", "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [confirmSave, setConfirmSave] = useState(false);
  const requestKey = useRef(crypto.randomUUID());

  const rows = useMemo(
    () => (products.data?.results ?? []).filter((p) => `${p.name} ${p.package_size} ${p.sku}`.toLowerCase().includes(filter.trim().toLowerCase())),
    [products.data, filter],
  );
  const changed = Object.entries(counts).filter(([, v]) => v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0);

  function askToSave() {
    if (busy || changed.length === 0) return;
    if (reason.trim().length < 3) return setProblem("Write the reason for this stock change.");
    setProblem(null);
    setConfirmSave(true);
  }

  async function save() {
    setConfirmSave(false);
    if (busy || changed.length === 0) return;
    setBusy(true);
    setProblem(null);
    setSaved(null);
    try {
      await api("/stock/adjustments/", {
        method: "POST",
        body: { request_key: requestKey.current, reason: reason.trim(), lines: changed.map(([id, quantity]) => ({ product: Number(id), quantity })) },
      });
      requestKey.current = crypto.randomUUID();
      setCounts({});
      setReason("");
      setSaved(`Saved the counted quantity for ${changed.length} product(s).`);
      products.reload();
      movements.reload();
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (shop.loading || (products.loading && !products.data)) return <Spinner />;
  if (!shop.data?.is_live) return <OpeningCountSheet products={products.data?.results ?? []} reloadProducts={products.reload} />;

  return (
    <div className="space-y-6">
      <PageTitle title="Stock" help="Stock goes down automatically with every sale and up with every delivery. If a physical count is different, type the counted quantity and the reason. Every change is recorded with your name." />
      {saved && <Alert kind="success">{saved}</Alert>}
      {problem && <Alert kind="error">{problem}</Alert>}

      <section className="card">
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <Field label="Find a product">{(p) => <input {...p} className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Type part of the name" />}</Field>
          <Field label="Reason for the change" hint="e.g. Monthly count, 2 bottles broken">
            {(p) => <input {...p} className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}
          </Field>
        </div>
        <div className="max-h-[55vh] overflow-auto">
          {rows.length === 0 ? <p className="p-4 text-slate-600">No products to show.</p> : (
            <table className="table">
              <thead className="sticky top-0 bg-white"><tr><th>Product</th><th>Counted by</th><th className="num">In the system now</th><th className="w-44">Quantity counted</th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td><span className="font-semibold">{p.name}</span> {p.package_size}</td>
                    <td>{p.base_unit}</td>
                    <td className="num"><StockBadge status={p.stock_status} quantity={p.stock_on_hand} /></td>
                    <td>
                      <input aria-label={`Quantity counted for ${p.name} ${p.package_size}`} className="input min-h-[2.5rem]" inputMode="numeric"
                        value={counts[p.id] ?? ""} onChange={(e) => setCounts((c) => ({ ...c, [p.id]: e.target.value.replace(/[^\d]/g, "") }))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className="btn-primary" disabled={busy || confirmSave || changed.length === 0} onClick={askToSave}>
            {busy ? "Saving…" : changed.length === 0 ? "Type a counted quantity to save" : `Save ${changed.length} counted quantit${changed.length === 1 ? "y" : "ies"}`}
          </button>
          {confirmSave && (
            <ConfirmToast
              message={`Change the stock of ${changed.length} product(s) to the counted quantities? This is recorded under your name.`}
              yes="Yes, change the stock" busy={busy} onNo={() => setConfirmSave(false)} onYes={save} />
          )}
          <span className="text-sm text-slate-600">Rows you leave empty are not changed.</span>
        </div>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="mb-3 text-xl font-bold">Latest stock movements</h2>
        {movements.loading && !movements.data ? <Spinner /> : movements.error ? <Alert kind="error">{movements.error}</Alert> : (movements.data?.results.length ?? 0) === 0 ? (
          <p className="text-slate-600">No stock movements yet.</p>
        ) : (
          <table className="table">
            <thead><tr><th>When</th><th>Product</th><th>What happened</th><th className="num">Change</th><th className="num">Stock after</th><th>By</th><th>Reason</th></tr></thead>
            <tbody>
              {movements.data!.results.map((m) => (
                <tr key={m.id}>
                  <td className="whitespace-nowrap">{formatDate(m.created_at)} {formatTime(m.created_at)}</td>
                  <td>{m.product_name}</td>
                  <td>{m.type_label}</td>
                  <td className="num font-semibold">{Number(m.quantity_delta) > 0 ? "+" : ""}{formatQty(m.quantity_delta)}</td>
                  <td className="num">{formatQty(m.balance_after)}</td>
                  <td>{m.user_name}</td>
                  <td>{m.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
