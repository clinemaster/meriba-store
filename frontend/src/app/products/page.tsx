"use client";

import { useEffect, useState } from "react";

import { Alert, Field, Modal, PageTitle, Spinner, StatusBadge } from "@/components/ui";
import { api, ApiError, errorMessage, type Page } from "@/lib/api";
import { formatQty, formatTZS } from "@/lib/money";
import type { Product } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

const STOCK_LABEL = { IN_STOCK: "In stock", LOW_STOCK: "Low stock", OUT_OF_STOCK: "Out of stock" } as const;
const EMPTY = { name: "", package_size: "", pack_description: "", base_unit: "Bottle", barcode: "", selling_price: "", cost_price: "", reorder_point: "0", is_active: true };
type Form = typeof EMPTY;

export default function ProductsPage() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const list = useLoad<Page<Product>>(`/products/?page=${page}&search=${encodeURIComponent(query)}`);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search.trim()); setPage(1); }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  function open(product: Product | "new") {
    setEditing(product);
    setErrors({});
    setProblem(null);
    setForm(product === "new" ? EMPTY : {
      name: product.name, package_size: product.package_size, pack_description: product.pack_description, base_unit: product.base_unit,
      barcode: product.barcode, selling_price: String(Number(product.selling_price)), cost_price: product.cost_price ? String(Number(product.cost_price)) : "",
      reorder_point: String(Number(product.reorder_point ?? 0)), is_active: product.is_active,
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !editing) return;
    const priceChanged = editing !== "new" && Number(editing.selling_price) !== Number(form.selling_price);
    if (priceChanged && !window.confirm(`Change the selling price from ${formatTZS(editing.selling_price)} to ${formatTZS(form.selling_price)}? New sales will use the new price straight away.`)) return;
    setBusy(true);
    setErrors({});
    setProblem(null);
    try {
      const body = { ...form, selling_price: form.selling_price || "0", cost_price: form.cost_price === "" ? null : form.cost_price, reorder_point: form.reorder_point || "0" };
      if (editing === "new") await api("/products/", { method: "POST", body });
      else await api(`/products/${editing.id}/`, { method: "PATCH", body });
      setEditing(null);
      list.reload();
    } catch (err) {
      if (err instanceof ApiError && err.errors) {
        setErrors(Object.fromEntries(Object.entries(err.errors).map(([k, v]) => [k, Array.isArray(v) ? String(v[0]) : String(v)])));
      }
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const rows = list.data?.results ?? [];
  const pages = Math.max(1, Math.ceil((list.data?.count ?? 0) / 25));

  return (
    <div>
      <PageTitle title="Products" help="The items you sell, with their selling prices. Products are never deleted; switch one off if you stop selling it."
        action={<button className="btn-primary" onClick={() => open("new")}>+ Add Product</button>} />
      <div className="card">
        <label htmlFor="product-filter" className="mb-1 block font-semibold">Search</label>
        <input id="product-filter" className="input mb-4 max-w-md" placeholder="Name, code or barcode" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="overflow-x-auto">
          {list.loading && !list.data ? <Spinner /> : list.error ? <Alert kind="error">{list.error}</Alert> : rows.length === 0 ? (
            <p className="p-4 text-slate-600">{query ? "No product matches your search." : "No products yet. Press “Add Product” to create the first one."}</p>
          ) : (
            <table className="table">
              <thead><tr><th>Code</th><th>Product</th><th>Sold by</th><th className="num">Selling price</th><th className="num">Cost</th><th className="num">In stock</th><th>Status</th><th /></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id} className={p.is_active ? "" : "text-slate-500"}>
                    <td className="font-mono">{p.sku}</td>
                    <td><span className="font-semibold">{p.name}</span> {p.package_size}{p.pack_description && <span className="block text-sm text-slate-600">{p.pack_description}</span>}</td>
                    <td>{p.base_unit}</td>
                    <td className="num">{Number(p.selling_price) > 0 ? formatTZS(p.selling_price) : <span className="font-semibold text-red-800">⚠ No price</span>}</td>
                    <td className="num">{p.cost_price ? formatTZS(p.cost_price) : "—"}</td>
                    <td className="num">{formatQty(p.stock_on_hand)}</td>
                    <td>{p.is_active ? <StatusBadge status={p.stock_status} label={STOCK_LABEL[p.stock_status]} /> : <StatusBadge status="OFF" label="Switched off" />}</td>
                    <td className="text-right"><button className="btn-secondary min-h-[2.5rem]" onClick={() => open(p)}>Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {pages > 1 && (
          <div className="mt-3 flex items-center justify-end gap-3">
            <button className="btn-secondary min-h-[2.5rem]" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <span>Page {page} of {pages}</span>
            <button className="btn-secondary min-h-[2.5rem]" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        )}
      </div>

      {editing && (
        <Modal title={editing === "new" ? "Add Product" : `Edit ${editing.name}`} onClose={() => setEditing(null)} wide>
          <form onSubmit={save} className="space-y-3" noValidate>
            {problem && <Alert kind="error">{problem}</Alert>}
            <Field label="Product name" error={errors.name}>{(p) => <input {...p} className="input" value={form.name} onChange={set("name")} autoFocus />}</Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Size" hint="e.g. 750ml">{(p) => <input {...p} className="input" value={form.package_size} onChange={set("package_size")} />}</Field>
              <Field label="Sold and counted by" hint="Bottle, Crate, Carton…" error={errors.base_unit}>{(p) => <input {...p} className="input" value={form.base_unit} onChange={set("base_unit")} />}</Field>
              <Field label="Supplier pack" hint="e.g. Box (24)">{(p) => <input {...p} className="input" value={form.pack_description} onChange={set("pack_description")} />}</Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Selling price (TZS)" hint="Price for one unit" error={errors.selling_price}>{(p) => <input {...p} className="input" inputMode="numeric" value={form.selling_price} onChange={set("selling_price")} />}</Field>
              <Field label="Purchase cost (TZS)" hint="Optional. Hidden from cashiers." error={errors.cost_price}>{(p) => <input {...p} className="input" inputMode="numeric" value={form.cost_price} onChange={set("cost_price")} />}</Field>
              <Field label="Low-stock warning at" hint="0 = no warning" error={errors.reorder_point}>{(p) => <input {...p} className="input" inputMode="numeric" value={form.reorder_point} onChange={set("reorder_point")} />}</Field>
            </div>
            <Field label="Barcode" hint="Optional. Scan or type it." error={errors.barcode}>{(p) => <input {...p} className="input" value={form.barcode} onChange={set("barcode")} />}</Field>
            <label className="flex items-center gap-3">
              <input type="checkbox" className="h-6 w-6" checked={form.is_active} onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))} />
              <span>On sale (untick to stop selling this product; its history is kept)</span>
            </label>
            <div className="flex gap-3 pt-2">
              <button className="btn-primary" disabled={busy}>{busy ? "Saving…" : "Save Product"}</button>
              <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
