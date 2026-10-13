"use client";

import { useEffect, useState } from "react";

import { Alert, Field, Modal, PageTitle, Spinner, StatusBadge } from "@/components/ui";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatQty, formatTime, formatTZS } from "@/lib/money";
import type { Product, ProductDetails, ProductRow, ProductTable } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

const UNITS = ["Bottle", "Crate", "Carton", "Box", "Pack"];
const EMPTY = { name: "", base_unit: "Bottle", volume_ml: "", bottles_per_unit: "", barcode: "", selling_price: "", cost_price: "", reorder_point: "0", is_active: true };
type Form = typeof EMPTY;

/** The eleven columns, in the agreed order. `key` is what the server sorts by. */
const COLUMNS: { key: string; label: string; numeric?: boolean; help: string }[] = [
  { key: "name", label: "Product", help: "Name of the product" },
  { key: "sold_by", label: "Unit", help: "The unit this product is counted and sold in" },
  { key: "volume_ml", label: "Volume (ml)", numeric: true, help: "Volume of one bottle, in millilitres" },
  { key: "total_item_stock", label: "Total Stock", numeric: true, help: "Opening stock for the period plus stock received and other stock coming in" },
  { key: "sales", label: "Sales", numeric: true, help: "Quantity sold in the period, in the product's unit. Cancelled sales are not counted" },
  { key: "closing_stock", label: "Closing Stock", numeric: true, help: "Opening stock + stock in − sales − breakages and other stock out" },
  { key: "purchase_price", label: "Purchase Price", numeric: true, help: "What the shop pays for one unit now, as in the Excel sheet" },
  { key: "selling_price", label: "Selling Price", numeric: true, help: "Current approved selling price of one unit" },
  { key: "total_sales", label: "Total Sales", numeric: true, help: "Value of completed sales in the period, less refunds. Worked out from the sales themselves" },
  { key: "profit", label: "Profit", numeric: true, help: "Gross profit: Total Sales less the cost of the goods sold. Expenses are not taken off here" },
  { key: "stock", label: "Stock", numeric: true, help: "Physical stock right now, from the stock ledger" },
];

function todayText(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function ProfitCell({ row }: { row: Pick<ProductRow, "profit" | "profit_status"> }) {
  if (row.profit === null) {
    return <span className="text-slate-600" title="Some of these sales have no reliable purchase cost, so profit is not shown rather than guessed.">Not available</span>;
  }
  return (
    <span title={row.profit_status === "PROVISIONAL" ? "Provisional: part of the cost was assumed (a delivery was recorded without a cost)." : undefined}>
      {formatTZS(row.profit)}{row.profit_status === "PROVISIONAL" && <span className="ml-1 text-sm font-normal text-amber-800">(provisional)</span>}
    </span>
  );
}

function Details({ id, from, to, isOwner, onClose, onChanged }: { id: number; from: string; to: string; isOwner: boolean; onClose: () => void; onChanged: () => void }) {
  const details = useLoad<ProductDetails>(`/products/${id}/details/?date_from=${from}&date_to=${to}`);
  const [pack, setPack] = useState({ name: "", factor: "", price: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await action();
      await details.reload();
      onChanged();
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const d = details.data;
  const p = d?.product;
  const f = d?.figures;
  const unit = p?.base_unit ?? "";
  const others = UNITS.filter((u) => u !== unit && !(p?.units ?? []).some((x) => x.name === u));

  return (
    <Modal title={p ? `${p.name} ${p.package_size}`.trim() : "Product"} onClose={onClose} wide>
      {details.loading && !d ? <Spinner /> : details.error || !d || !p || !f ? <Alert kind="error">{details.error}</Alert> : (
        <div className="space-y-5">
          <section>
            <h3 className="mb-2 font-bold">{d.date_from === d.date_to ? formatDate(d.date_from) : `${formatDate(d.date_from)} to ${formatDate(d.date_to)}`}</h3>
            <table className="table">
              <tbody>
                <tr><td>Opening stock</td><td className="num">{formatQty(f.opening_stock)} {unit}</td></tr>
                <tr><td>+ Stock in (deliveries, returns, counts)</td><td className="num">{formatQty(f.incoming)}</td></tr>
                <tr className="font-semibold"><td>= Total Stock</td><td className="num">{formatQty(f.total_item_stock)}</td></tr>
                <tr><td>− Sales</td><td className="num">{formatQty(f.sales)}</td></tr>
                <tr><td>− Breakages and other stock out</td><td className="num">{formatQty(f.other_out)}</td></tr>
                <tr className="font-semibold"><td>= Closing Stock</td><td className="num">{formatQty(f.closing_stock)}</td></tr>
                <tr><td>Stock right now</td><td className="num">{formatQty(f.stock)} {unit}</td></tr>
                <tr><td>Total Sales</td><td className="num">{formatTZS(f.total_sales)}</td></tr>
                <tr><td>Cost of goods sold</td><td className="num">{f.cost_of_goods_sold === null ? "Not available" : formatTZS(f.cost_of_goods_sold)}</td></tr>
                <tr className="font-semibold"><td>Gross profit</td><td className="num"><ProfitCell row={f} /></td></tr>
              </tbody>
            </table>
          </section>

          <section>
            <h3 className="mb-2 font-bold">Package configuration</h3>
            <p>
              Counted and sold by the <strong>{unit.toLowerCase()}</strong>
              {p.volume_ml ? <>; each bottle is <strong>{p.volume_ml.toLocaleString()} ml</strong></> : "; bottle volume not recorded"}
              {unit !== "Bottle" && (p.bottles_per_unit ? <>; one {unit.toLowerCase()} holds <strong>{p.bottles_per_unit} bottles</strong> (stock now is {formatQty(Number(f.stock) * p.bottles_per_unit)} bottles)</> : `; bottles in one ${unit.toLowerCase()} not recorded`)}.
            </p>
            <p className="mt-1 text-slate-700">
              Purchase Price: <strong>{p.cost_price ? formatTZS(p.cost_price) : "not entered yet"}</strong>. Profit is worked out as in the Excel sheet: quantity sold × (Sales price − Purchase price on the day of the sale).
              {p.average_cost ? ` For information only: the weighted average of deliveries is ${formatTZS(p.average_cost)}; it is not used in any figure.` : ""}
            </p>
            {p.units.length > 0 && (
              <table className="table mt-2">
                <thead><tr><th>Also sold by</th><th className="num">Holds</th><th className="num">Selling price</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {p.units.map((u) => (
                    <tr key={u.id}>
                      <td>{u.name}</td>
                      <td className="num">{formatQty(u.factor)} {unit.toLowerCase()}(s)</td>
                      <td className="num">{formatTZS(u.selling_price)}</td>
                      <td>{!u.is_active ? <StatusBadge status="OFF" label="Switched off" /> : u.is_verified ? <StatusBadge status="APPROVED" label="Verified" /> : <StatusBadge status="PENDING" label="Waiting for the Owner to verify" />}</td>
                      <td className="space-x-2 whitespace-nowrap text-right">
                        {isOwner && !u.is_verified && u.is_active && (
                          <button className="btn-primary min-h-[2.5rem]" disabled={busy}
                            onClick={() => window.confirm(`Confirm that one ${u.name.toLowerCase()} of ${p.name} holds exactly ${formatQty(u.factor)} ${unit.toLowerCase()}(s)? Selling one ${u.name.toLowerCase()} will take that many out of stock.`)
                              && run(() => api(`/products/${p.id}/units/${u.id}/verify/`, { method: "POST" }))}>Verify</button>
                        )}
                        <button className="btn-secondary min-h-[2.5rem]" disabled={busy}
                          onClick={() => {
                            const next = window.prompt(`How many ${unit.toLowerCase()}s are in one ${u.name.toLowerCase()}?\n\nPast sales keep the figure they were sold with. The new figure must be verified by the Owner before it can be sold.`, String(Number(u.factor)));
                            if (next && Number(next) >= 1 && Number(next) !== Number(u.factor)) run(() => api(`/products/${p.id}/units/${u.id}/`, { method: "PATCH", body: { factor: next } }));
                          }}>Change</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {others.length > 0 && (
              <form className="mt-3 grid gap-2 sm:grid-cols-4" noValidate onSubmit={(e) => {
                e.preventDefault();
                if (!pack.name || Number(pack.factor) < 1 || pack.price.trim() === "") return setProblem("Choose the package, how many it holds, and its selling price.");
                if (!window.confirm(`Add: one ${pack.name.toLowerCase()} = ${pack.factor} ${unit.toLowerCase()}(s), selling at ${formatTZS(pack.price)}? The Owner must verify it before it can be sold.`)) return;
                run(async () => { await api(`/products/${p.id}/units/`, { method: "POST", body: { name: pack.name, factor: pack.factor, selling_price: pack.price.replace(/,/g, "") } }); setPack({ name: "", factor: "", price: "" }); });
              }}>
                <select aria-label="Package to add" className="input" value={pack.name} onChange={(e) => setPack({ ...pack, name: e.target.value })}>
                  <option value="">Also sell by…</option>{others.map((u) => <option key={u}>{u}</option>)}
                </select>
                <input aria-label={`How many ${unit.toLowerCase()}s it holds`} className="input" inputMode="numeric" placeholder={`Holds how many ${unit.toLowerCase()}s?`} value={pack.factor} onChange={(e) => setPack({ ...pack, factor: e.target.value.replace(/\D/g, "") })} />
                <input aria-label="Selling price of the package" className="input" inputMode="numeric" placeholder="Selling price (TZS)" value={pack.price} onChange={(e) => setPack({ ...pack, price: e.target.value })} />
                <button className="btn-secondary" disabled={busy}>Add package</button>
              </form>
            )}
            {problem && <div className="mt-2"><Alert kind="error">{problem}</Alert></div>}
          </section>

          <section>
            <h3 className="mb-2 font-bold">Stock movement history</h3>
            {d.movements.length === 0 ? <p className="text-slate-600">No stock movements yet.</p> : (
              <div className="max-h-56 overflow-auto"><table className="table">
                <thead><tr><th>When</th><th>What happened</th><th className="num">Change</th><th className="num">Stock after</th><th>By</th><th>Reason</th></tr></thead>
                <tbody>{d.movements.map((m) => (
                  <tr key={m.id}><td className="whitespace-nowrap">{formatDate(m.date)} {formatTime(m.created_at)}</td><td>{m.type}</td>
                    <td className="num font-semibold">{Number(m.change) > 0 ? "+" : ""}{formatQty(m.change)}</td><td className="num">{formatQty(m.balance_after)}</td><td>{m.by}</td><td>{m.reason}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </section>

          <section>
            <h3 className="mb-2 font-bold">Purchase history</h3>
            {d.purchases.length === 0 ? <p className="text-slate-600">No deliveries recorded for this product.</p> : (
              <div className="max-h-48 overflow-auto"><table className="table">
                <thead><tr><th>Date</th><th>Supplier</th><th>Invoice</th><th className="num">Quantity</th><th className="num">Cost each</th><th className="num">Average before</th><th className="num">Average after</th></tr></thead>
                <tbody>{d.purchases.map((x, i) => (
                  <tr key={i}><td>{formatDate(x.date)}</td><td>{x.supplier || "—"}</td><td>{x.reference || "—"}</td><td className="num">{formatQty(x.quantity)}</td>
                    <td className="num">{x.unit_cost === null ? "Not recorded" : formatTZS(x.unit_cost)}</td>
                    <td className="num">{x.average_before === null ? "—" : formatTZS(x.average_before)}</td><td className="num">{x.average_after === null ? "—" : formatTZS(x.average_after)}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </section>

          {d.changes.length > 0 && (
            <section>
              <h3 className="mb-2 font-bold">Price and package changes</h3>
              <ul className="ml-5 list-disc text-sm">{d.changes.map((c, i) => <li key={i}>{formatDate(c.when)} · {c.by} · {c.what}</li>)}</ul>
            </section>
          )}
          <button className="btn-secondary" onClick={onClose}>Close</button>
        </div>
      )}
    </Modal>
  );
}

export default function ProductsPage() {
  const { user } = useAuth();
  const isOwner = user?.role === "OWNER";
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [soldBy, setSoldBy] = useState("");
  const [show, setShow] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [ordering, setOrdering] = useState("name");
  const [page, setPage] = useState(1);
  const badDates = !!from && !!to && from > to;
  const params = `page=${page}&page_size=25&ordering=${ordering}&search=${encodeURIComponent(query)}${soldBy ? `&sold_by=${soldBy}` : ""}${show ? `&active=${show}` : ""}${from ? `&date_from=${from}` : ""}${to ? `&date_to=${to}` : ""}`;
  const list = useLoad<ProductTable>(badDates ? null : `/products/table/?${params}`);
  const [detailsFor, setDetailsFor] = useState<number | null>(null);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search.trim()); setPage(1); }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  function sortBy(key: string) {
    setOrdering((current) => (current === key ? `-${key}` : key));
    setPage(1);
  }

  async function open(target: number | "new") {
    setErrors({});
    setProblem(null);
    if (target === "new") {
      setForm(EMPTY);
      setEditing("new");
      return;
    }
    try {
      const product = await api<Product>(`/products/${target}/`);
      setForm({
        name: product.name, base_unit: product.base_unit, volume_ml: product.volume_ml ? String(product.volume_ml) : "",
        bottles_per_unit: product.bottles_per_unit ? String(product.bottles_per_unit) : "", barcode: product.barcode,
        selling_price: String(Number(product.selling_price)), cost_price: product.cost_price ? String(Number(product.cost_price)) : "",
        reorder_point: String(Number(product.reorder_point ?? 0)), is_active: product.is_active,
      });
      setEditing(product);
    } catch (err) {
      setProblem(errorMessage(err));
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !editing) return;
    if (editing !== "new") {
      if (Number(editing.selling_price) !== Number(form.selling_price || 0)
        && !window.confirm(`Change the selling price from ${formatTZS(editing.selling_price)} to ${formatTZS(form.selling_price || 0)}? New sales use the new price straight away. Past sales and receipts are not changed.`)) return;
      if ((editing.bottles_per_unit ?? "") !== (form.bottles_per_unit === "" ? "" : Number(form.bottles_per_unit))
        && !window.confirm(`Change the number of bottles in one ${form.base_unit.toLowerCase()} from ${editing.bottles_per_unit ?? "not recorded"} to ${form.bottles_per_unit || "not recorded"}? Stock quantities, which are counted in ${form.base_unit.toLowerCase()}s, do not change.`)) return;
    }
    setBusy(true);
    setErrors({});
    setProblem(null);
    try {
      const body = {
        name: form.name, base_unit: form.base_unit, barcode: form.barcode, is_active: form.is_active,
        volume_ml: form.volume_ml === "" ? null : Number(form.volume_ml),
        bottles_per_unit: form.base_unit === "Bottle" || form.bottles_per_unit === "" ? null : Number(form.bottles_per_unit),
        selling_price: form.selling_price.replace(/,/g, "") || "0", cost_price: form.cost_price === "" ? null : form.cost_price.replace(/,/g, ""),
        reorder_point: form.reorder_point || "0",
      };
      if (editing === "new") await api("/products/", { method: "POST", body });
      else await api(`/products/${editing.id}/`, { method: "PATCH", body });
      await list.reload();
      setEditing(null);
    } catch (err) {
      if (err instanceof ApiError && err.errors) {
        setErrors(Object.fromEntries(Object.entries(err.errors).map(([k, v]) => [k, Array.isArray(v) ? String(v[0]) : String(v)])));
      }
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const set = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const whole = (key: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [key]: e.target.value.replace(/\D/g, "") }));
  const data = list.data;
  const rows = data?.results ?? [];
  const periodText = !data ? "" : data.date_from === data.date_to ? formatDate(data.date_from) : `${formatDate(data.date_from)} to ${formatDate(data.date_to)}`;

  return (
    <div>
      <PageTitle title="Products" help="Every product with its stock and sales for the day or dates you choose. Quantities are in each product's own unit. Products are never deleted; switch one off if you stop selling it."
        action={<button className="btn-primary" onClick={() => open("new")}>+ Add Product</button>} />

      <div className="card mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <div className="lg:col-span-2"><Field label="Search">{(p) => <input {...p} className="input" placeholder="Name, code or barcode" value={search} onChange={(e) => setSearch(e.target.value)} />}</Field></div>
        <Field label="Unit">{(p) => (
          <select {...p} className="input" value={soldBy} onChange={(e) => { setSoldBy(e.target.value); setPage(1); }}>
            <option value="">All units</option>{(data?.sold_by_options ?? UNITS).map((u) => <option key={u}>{u}</option>)}
          </select>)}</Field>
        <Field label="Show">{(p) => (
          <select {...p} className="input" value={show} onChange={(e) => { setShow(e.target.value); setPage(1); }}>
            <option value="">All products</option><option value="true">On sale</option><option value="false">Switched off</option>
          </select>)}</Field>
        <Field label="From" hint="Empty = the current business day">{(p) => <input {...p} type="date" className="input" max={todayText()} value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />}</Field>
        <Field label="To">{(p) => <input {...p} type="date" className="input" max={todayText()} value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} />}</Field>
      </div>
      {badDates && <Alert kind="error">Choose a “From” date that is on or before the “To” date.</Alert>}
      {problem && !editing && <div className="mb-3"><Alert kind="error">{problem}</Alert></div>}

      <div className="card">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-slate-700" aria-live="polite">
            {data ? <>Stock and sales for <strong>{periodText}</strong> · {data.count} product{data.count === 1 ? "" : "s"}</> : " "}
          </p>
          {data && data.count > 0 && <a className="btn-secondary" href={`/api/v1/products/table/?${params}&download=csv`}>Download for Excel (CSV)</a>}
        </div>
        <div className="overflow-x-auto">
          {list.loading && !data ? <Spinner /> : list.error ? <Alert kind="error">{list.error}</Alert> : rows.length === 0 ? (
            <p className="p-4 text-slate-600">{query || soldBy || show ? "No product matches your search and filters." : "No products yet. Press “Add Product” to create the first one."}</p>
          ) : (
            <table className="table min-w-[1150px]">
              <thead>
                <tr>
                  {COLUMNS.map((c) => {
                    const active = ordering === c.key || ordering === `-${c.key}`;
                    return (
                      <th key={c.key} className={c.numeric ? "num" : ""} aria-sort={!active ? "none" : ordering.startsWith("-") ? "descending" : "ascending"}>
                        <button type="button" title={`${c.help}. Press to sort.`} className="font-semibold underline-offset-2 hover:underline" onClick={() => sortBy(c.key)}>
                          {c.label}{active ? (ordering.startsWith("-") ? " ▼" : " ▲") : ""}
                        </button>
                      </th>
                    );
                  })}
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.is_active ? "" : "text-slate-500"}>
                    <td><span className="font-semibold">{r.name}</span>{!r.is_active && <span className="block text-sm">Switched off</span>}</td>
                    <td>{r.sold_by}{r.sold_by !== "Bottle" && r.bottles_per_unit ? <span className="block text-sm text-slate-600">{r.bottles_per_unit} bottles</span> : null}</td>
                    <td className="num">{r.volume_ml ? `${r.volume_ml.toLocaleString()} ml` : "—"}</td>
                    <td className="num">{formatQty(r.total_item_stock)}</td>
                    <td className="num">{formatQty(r.sales)}</td>
                    <td className="num">{formatQty(r.closing_stock)}</td>
                    <td className="num">{r.purchase_price === null ? <span className="text-slate-600" title="No purchase price has been entered for this product.">Not entered</span> : <>{formatTZS(r.purchase_price)}{r.purchase_price_provisional && <span className="block text-sm text-amber-800">provisional</span>}</>}</td>
                    <td className="num">{Number(r.selling_price) > 0 ? formatTZS(r.selling_price) : <span className="font-semibold text-red-800">⚠ No price</span>}</td>
                    <td className="num">{formatTZS(r.total_sales)}</td>
                    <td className="num font-semibold"><ProfitCell row={r} /></td>
                    <td className="num font-semibold">{formatQty(r.stock)}</td>
                    <td className="space-x-2 whitespace-nowrap text-right">
                      <button className="btn-secondary min-h-[2.5rem]" onClick={() => setDetailsFor(r.id)}>Details</button>
                      <button className="btn-secondary min-h-[2.5rem]" onClick={() => open(r.id)}>Edit</button>
                    </td>
                  </tr>
                ))}
              </tbody>
              {data && (
                <tfoot>
                  <tr className="font-bold">
                    <td colSpan={8}>Total for all {data.count} product{data.count === 1 ? "" : "s"} shown by these filters</td>
                    <td className="num">{formatTZS(data.totals.total_sales)}</td>
                    <td className="num">{formatTZS(data.totals.profit)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              )}
            </table>
          )}
        </div>
        {data && (data.totals.profit_unavailable_for > 0 || data.totals.profit_provisional_for > 0) && (
          <div className="mt-3"><Alert kind="warning">
            {data.totals.profit_unavailable_for > 0 && <>Profit is not available for {data.totals.profit_unavailable_for} product(s) because some sales have no reliable purchase cost; they are left out of the profit total. </>}
            {data.totals.profit_provisional_for > 0 && <>Profit is provisional for {data.totals.profit_provisional_for} product(s) because a delivery was recorded without a cost.</>}
          </Alert></div>
        )}
        {data && data.pages > 1 && (
          <div className="mt-3 flex items-center justify-end gap-3">
            <button className="btn-secondary min-h-[2.5rem]" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
            <span>Page {data.page} of {data.pages}</span>
            <button className="btn-secondary min-h-[2.5rem]" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>Next</button>
          </div>
        )}
        <details className="mt-4 text-sm text-slate-700">
          <summary className="cursor-pointer font-semibold">What do the columns mean?</summary>
          <ul className="ml-5 mt-2 list-disc space-y-1">{COLUMNS.slice(3).map((c) => <li key={c.key}><strong>{c.label}:</strong> {c.help}.</li>)}</ul>
        </details>
      </div>

      {detailsFor !== null && <Details id={detailsFor} from={data?.date_from ?? todayText()} to={data?.date_to ?? todayText()} isOwner={isOwner} onClose={() => setDetailsFor(null)} onChanged={list.reload} />}

      {editing && (
        <Modal title={editing === "new" ? "Add Product" : `Edit ${editing.name}`} onClose={() => setEditing(null)} wide>
          <form onSubmit={save} className="space-y-3" noValidate>
            {problem && <Alert kind="error">{problem}</Alert>}
            <Field label="Product Name" error={errors.name}>{(p) => <input {...p} className="input" value={form.name} onChange={set("name")} autoFocus />}</Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Unit" hint="What it is counted and sold in." error={errors.base_unit}>{(p) => (
                <select {...p} className="input" value={form.base_unit} onChange={set("base_unit")}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select>)}</Field>
              <Field label="Volume (ml)" hint="Of one bottle, e.g. 750. Leave empty if not applicable." error={errors.volume_ml}>{(p) => <input {...p} className="input" inputMode="numeric" value={form.volume_ml} onChange={whole("volume_ml")} />}</Field>
              {form.base_unit !== "Bottle" && (
                <Field label={`Bottles in one ${form.base_unit.toLowerCase()}`} hint="Optional. Each product has its own figure." error={errors.bottles_per_unit}>{(p) => <input {...p} className="input" inputMode="numeric" value={form.bottles_per_unit} onChange={whole("bottles_per_unit")} />}</Field>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Selling Price (TZS)" hint={`Price of one ${form.base_unit.toLowerCase()}`} error={errors.selling_price}>{(p) => <input {...p} className="input" inputMode="numeric" value={form.selling_price} onChange={set("selling_price")} />}</Field>
              <Field label="Purchase Price (TZS)" hint="What one costs from the supplier. Optional. Hidden from cashiers." error={errors.cost_price}>{(p) => <input {...p} className="input" inputMode="numeric" value={form.cost_price} onChange={set("cost_price")} />}</Field>
              <Field label="Low-stock warning at" hint="0 = no warning" error={errors.reorder_point}>{(p) => <input {...p} className="input" inputMode="numeric" value={form.reorder_point} onChange={set("reorder_point")} />}</Field>
            </div>
            <Field label="Barcode" hint="Optional. Scan or type it." error={errors.barcode}>{(p) => <input {...p} className="input" value={form.barcode} onChange={set("barcode")} />}</Field>
            <label className="flex items-center gap-3">
              <input type="checkbox" className="h-6 w-6" checked={form.is_active} onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))} />
              <span>On sale (untick to stop selling this product; its history is kept)</span>
            </label>
            <p className="text-sm text-slate-600">To also sell this product in another package (for example a crate of 12 bottles), save it, then open <strong>Details</strong>.</p>
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
