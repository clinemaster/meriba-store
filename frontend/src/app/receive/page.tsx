"use client";

import { useMemo, useRef, useState } from "react";

import { Alert, ConfirmToast, Field, PageTitle, Spinner, StockBadge } from "@/components/ui";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatQty, formatTZS, toCents } from "@/lib/money";
import type { Product } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

import { UploadReceived } from "./UploadReceived";

type Supplier = { id: number; name: string; is_active: boolean };
type Receipt = {
  id: number; business_date: string; supplier_name: string; reference: string; total_cost: string | null; received_by_name: string;
  lines: { product_name: string; quantity: string; unit_cost: string | null }[];
};
type Line = { product: Product; quantity: string; cost: string };

export default function ReceiveStockPage() {
  const { user } = useAuth();
  const isOwner = user?.role === "OWNER";  // Upload Received Stock is the Owner's (decision of 21 Oct 2026)
  const products = useLoad<Page<Product>>("/products/?page_size=500&active=true");
  const suppliers = useLoad<Supplier[]>("/suppliers/");
  const history = useLoad<Page<Receipt>>("/stock/receipts/?page_size=15");
  const [filter, setFilter] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [supplierId, setSupplierId] = useState("");
  const [newSupplier, setNewSupplier] = useState("");
  const [reference, setReference] = useState("");
  const [updateCost, setUpdateCost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const requestKey = useRef(crypto.randomUUID());

  const matches = useMemo(() => {
    const text = filter.trim().toLowerCase();
    if (!text) return [];
    return (products.data?.results ?? [])
      .filter((p) => !lines.some((l) => l.product.id === p.id) && `${p.name} ${p.package_size} ${p.sku}`.toLowerCase().includes(text))
      .slice(0, 8);
  }, [filter, products.data, lines]);

  const valid = lines.filter((l) => Number(l.quantity) > 0);
  const totalCents = valid.reduce((sum, l) => sum + Number(l.quantity) * toCents(l.cost), 0);
  const allCosted = valid.length > 0 && valid.every((l) => l.cost.trim() !== "");
  const setLine = (id: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.product.id === id ? { ...l, ...patch } : l)));

  async function save() {
    if (busy || valid.length === 0) return;
    setConfirming(false);
    setBusy(true);
    setProblem(null);
    setSaved(null);
    try {
      let supplier: number | null = supplierId ? Number(supplierId) : null;
      if (supplierId === "new" && newSupplier.trim()) supplier = (await api<Supplier>("/suppliers/", { method: "POST", body: { name: newSupplier.trim() } })).id;
      else if (supplierId === "new") supplier = null;
      await api("/stock/receipts/", {
        method: "POST",
        body: {
          request_key: requestKey.current, supplier, reference, update_cost_price: updateCost,
          lines: valid.map((l) => ({ product: l.product.id, quantity: l.quantity, unit_cost: l.cost.trim() === "" ? null : l.cost.replace(/,/g, "") })),
        },
      });
      requestKey.current = crypto.randomUUID();
      setLines([]);
      setReference("");
      setNewSupplier("");
      setSaved(`Delivery saved. Stock has been increased for ${valid.length} product(s).`);
      products.reload();
      history.reload();
      suppliers.reload();
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (products.loading && !products.data) return <Spinner />;

  return (
    <div className="space-y-6">
      <PageTitle title="Receive Stock" help="Use this when a delivery arrives. Count what actually came in, enter it here and save. Stock goes up as soon as you save."
        action={isOwner && !uploading && <button type="button" className="btn-primary" onClick={() => { setUploading(true); setSaved(null); }}>Upload Received Stock</button>} />
      {isOwner && uploading && (
        <UploadReceived suppliers={suppliers.data ?? []} products={products.data?.results ?? []} onClose={() => setUploading(false)}
          onImported={() => { products.reload(); history.reload(); }} />
      )}
      {saved && <Alert kind="success">{saved}</Alert>}
      {problem && <Alert kind="error">{problem}</Alert>}

      {/* While the upload is open, the typed-delivery form is put away so there is one set of supplier fields. */}
      {!uploading && (
      <section className="card space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Supplier (optional)" hint="Leave empty if you do not know who supplied it.">
            {(p) => (
              <select {...p} className="input" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">— Not recorded —</option>
                {(suppliers.data ?? []).filter((s) => s.is_active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                <option value="new">+ A new supplier…</option>
              </select>
            )}
          </Field>
          {supplierId === "new" ? (
            <Field label="New supplier's name">{(p) => <input {...p} className="input" value={newSupplier} onChange={(e) => setNewSupplier(e.target.value)} />}</Field>
          ) : (
            <Field label="Invoice or delivery note number (optional)" hint="Only if the supplier gave you one.">
              {(p) => <input {...p} className="input" maxLength={60} value={reference} onChange={(e) => setReference(e.target.value)} />}
            </Field>
          )}
        </div>

        <div>
          <label htmlFor="receive-search" className="mb-1 block font-semibold">Add a product that was delivered</label>
          <input id="receive-search" className="input max-w-xl" placeholder="Type part of the product name" value={filter} autoComplete="off" onChange={(e) => setFilter(e.target.value)} />
          {matches.length > 0 && (
            <ul className="mt-2 grid max-w-xl gap-1">
              {matches.map((p) => (
                <li key={p.id}>
                  <button type="button" className="flex w-full justify-between rounded-lg border-2 border-slate-200 bg-white px-3 py-2 text-left hover:border-brand-600"
                    onClick={() => { setLines((ls) => [...ls, { product: p, quantity: "", cost: p.cost_price ? String(Number(p.cost_price)) : "" }]); setFilter(""); }}>
                    <span className="font-semibold">{p.name} {p.package_size}</span>
                    <span className="text-slate-600"><StockBadge status={p.stock_status} quantity={p.stock_on_hand} unit={`${p.base_unit} in stock`} /></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {filter.trim() !== "" && matches.length === 0 && <p className="mt-2 text-slate-600">No product found. New products are added on the Products page first.</p>}
        </div>

        {lines.length === 0 ? (
          <p className="rounded-lg border-2 border-dashed border-slate-300 p-6 text-center text-slate-600">No products added to this delivery yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>Product</th><th>Counted by</th><th className="w-36">Quantity received</th><th className="w-44">Cost for one (TZS)</th><th className="num">Line cost</th><th /></tr></thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.product.id}>
                    <td className="font-semibold">{l.product.name} {l.product.package_size}</td>
                    <td>{l.product.base_unit}</td>
                    <td><input aria-label={`Quantity received of ${l.product.name}`} className="input min-h-[2.5rem]" inputMode="numeric" value={l.quantity} onChange={(e) => setLine(l.product.id, { quantity: e.target.value.replace(/\D/g, "") })} /></td>
                    <td><input aria-label={`Cost for one ${l.product.name}`} className="input min-h-[2.5rem]" inputMode="numeric" placeholder="Leave empty if unknown" value={l.cost} onChange={(e) => setLine(l.product.id, { cost: e.target.value })} /></td>
                    <td className="num">{l.cost.trim() && Number(l.quantity) > 0 ? formatTZS(Number(l.quantity) * toCents(l.cost), true) : "—"}</td>
                    <td className="text-right"><button type="button" className="text-sm font-semibold text-red-800 underline" onClick={() => setLines((ls) => ls.filter((x) => x.product.id !== l.product.id))}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <label className="flex items-center gap-3">
          <input type="checkbox" className="h-6 w-6" checked={updateCost} onChange={(e) => setUpdateCost(e.target.checked)} />
          <span>Also update each product&apos;s purchase cost to the cost entered here</span>
        </label>
        <div className="flex flex-wrap items-center gap-4">
          <button className="btn-primary" disabled={busy || valid.length === 0} onClick={() => setConfirming(true)}>{busy ? "Saving…" : `Save delivery of ${valid.length} product(s)`}</button>
          {allCosted && <span className="font-semibold">Total cost: {formatTZS(totalCents, true)}</span>}
        </div>
        {confirming && (
          <ConfirmToast
            message={`Add this delivery of ${valid.length} product(s) to stock? It cannot be edited afterwards; a mistake is fixed with a stock adjustment.`}
            yes="Yes, add to stock" busy={busy} onNo={() => setConfirming(false)} onYes={save} />
        )}
      </section>
      )}

      <section className="card overflow-x-auto">
        <h2 className="mb-3 text-xl font-bold">Latest deliveries</h2>
        {history.loading && !history.data ? <Spinner /> : (history.data?.results.length ?? 0) === 0 ? <p className="text-slate-600">No deliveries recorded yet.</p> : (
          <table className="table">
            <thead><tr><th>Date</th><th>Supplier</th><th>Invoice no.</th><th>What came in</th><th className="num">Total cost</th><th>Received by</th></tr></thead>
            <tbody>
              {history.data!.results.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{formatDate(r.business_date)}</td>
                  <td>{r.supplier_name || "—"}</td>
                  <td>{r.reference || "—"}</td>
                  <td>{r.lines.map((l) => `${formatQty(l.quantity)} × ${l.product_name}`).join(", ")}</td>
                  <td className="num">{r.total_cost === null ? "Not recorded" : formatTZS(r.total_cost)}</td>
                  <td>{r.received_by_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
