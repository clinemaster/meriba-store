"use client";

import { useEffect, useState } from "react";

import { Alert, ConfirmToast, Field, Modal, PageTitle, Spinner, StatusBadge, StockBadge, useConfirm } from "@/components/ui";
import { ColumnPicker } from "@/components/ColumnPicker";
import { useBackState } from "@/lib/backNav";
import type { ColumnDef } from "@/lib/columns";
import { useColumnVisibility } from "@/lib/useColumnVisibility";
import { api, ApiError, errorMessage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatQty, formatTime, formatTZS } from "@/lib/money";
import { STOCK_LEVELS, STOCK_ORDER, useLiveReload } from "@/lib/stockLevels";
import type { Product, ProductDetails, ProductRow, ProductTable } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

const UNITS = ["Bottle", "Crate", "Carton", "Box", "Pack"];
const EMPTY = { name: "", base_unit: "Bottle", volume_ml: "", bottles_per_unit: "", selling_price: "", cost_price: "", reorder_point: "0", critical_point: "0", is_active: true };
type Form = typeof EMPTY;

/** S/No and the nine columns, in the agreed order (the Sales quantity column was removed at the owner's request, 13 Oct 2026). `key` is what the server sorts by. */
const COLUMNS: (ColumnDef & { numeric?: boolean; help: string })[] = [
  { key: "serial_number", label: "S/No", help: "The product's line number, as on the Excel sheet" },
  { key: "name", label: "Product", essential: true, help: "Name of the product" },
  { key: "sold_by", label: "Unit", help: "The unit this product is counted and sold in" },
  { key: "volume_ml", label: "Volume (ml)", numeric: true, help: "Volume of one bottle, in millilitres" },
  { key: "closing_stock", label: "Closing Stock", numeric: true, help: "Opening stock + stock in − sales − breakages and other stock out" },
  { key: "purchase_price", label: "Purchase Price", numeric: true, help: "What the shop pays for one unit now, as in the Excel sheet" },
  { key: "selling_price", label: "Selling Price", numeric: true, help: "Current approved selling price of one unit" },
  { key: "total_sales", label: "Total Sales", numeric: true, help: "Value of completed sales in the period, less refunds. Worked out from the sales themselves" },
  { key: "profit", label: "Profit", numeric: true, help: "Gross profit: Total Sales less the cost of the goods sold. Expenses are not taken off here" },
  { key: "stock", label: "Stock on Hand", numeric: true, help: "Physical stock right now, from the stock ledger, with its level: healthy, low, critical or out of stock" },
];

function todayText(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Money in the table itself: the number only, with no "TZS" on every cell (owner's request, 13 Oct 2026). */
const plain = (value: string | number | null | undefined) => formatTZS(value).replace("TZS ", "");

function ProfitCell({ row, bare = false }: { row: Pick<ProductRow, "profit" | "profit_status">; bare?: boolean }) {
  if (row.profit === null) {
    return <span className="text-slate-600" title="Some of these sales have no reliable purchase cost, so profit is not shown rather than guessed.">Not available</span>;
  }
  return (
    <span title={row.profit_status === "PROVISIONAL" ? "Provisional: part of the cost was assumed (a delivery was recorded without a cost)." : undefined}>
      {bare ? plain(row.profit) : formatTZS(row.profit)}{row.profit_status === "PROVISIONAL" && <span className="ml-1 text-sm font-normal text-amber-800">(provisional)</span>}
    </span>
  );
}

function Details({ id, from, to, isOwner, onClose, onChanged }: { id: number; from: string; to: string; isOwner: boolean; onClose: () => void; onChanged: () => void }) {
  const details = useLoad<ProductDetails>(`/products/${id}/details/?date_from=${from}&date_to=${to}`);
  const [pack, setPack] = useState({ name: "", factor: "", price: "" });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm, confirmation, asking } = useConfirm();

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
                <tr><td>Stock right now</td><td className="num"><StockBadge status={f.stock_status} quantity={f.stock} unit={unit} /></td></tr>
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
                          <button className="btn-primary min-h-[2.5rem]" disabled={busy || asking}
                            onClick={() => confirm({
                              message: `Confirm that one ${u.name.toLowerCase()} of ${p.name} holds exactly ${formatQty(u.factor)} ${unit.toLowerCase()}(s)? Selling one ${u.name.toLowerCase()} will take that many out of stock.`,
                              yes: "Yes, verify", run: () => run(() => api(`/products/${p.id}/units/${u.id}/verify/`, { method: "POST" })),
                            })}>Verify</button>
                        )}
                        <button className="btn-secondary min-h-[2.5rem]" disabled={busy || asking}
                          onClick={() => confirm({
                            message: `Change how many ${unit.toLowerCase()}s are in one ${u.name.toLowerCase()}? Past sales keep the figure they were sold with. The new figure must be verified by the Owner before it can be sold.`,
                            yes: "Yes, change it", input: { label: `${unit}s in one ${u.name.toLowerCase()}`, initial: String(Number(u.factor)), numeric: true },
                            run: (next) => {
                              if (Number(next) < 1) return setProblem(`One ${u.name.toLowerCase()} must hold at least 1 ${unit.toLowerCase()}.`);
                              if (Number(next) !== Number(u.factor)) run(() => api(`/products/${p.id}/units/${u.id}/`, { method: "PATCH", body: { factor: next } }));
                            },
                          })}>Change</button>
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
                confirm({
                  message: `Add: one ${pack.name.toLowerCase()} = ${pack.factor} ${unit.toLowerCase()}(s), selling at ${formatTZS(pack.price)}? The Owner must verify it before it can be sold.`,
                  yes: "Yes, add it",
                  run: () => run(async () => { await api(`/products/${p.id}/units/`, { method: "POST", body: { name: pack.name, factor: pack.factor, selling_price: pack.price.replace(/,/g, "") } }); setPack({ name: "", factor: "", price: "" }); }),
                });
              }}>
                <select aria-label="Package to add" className="input" value={pack.name} onChange={(e) => setPack({ ...pack, name: e.target.value })}>
                  <option value="">Also sell by…</option>{others.map((u) => <option key={u}>{u}</option>)}
                </select>
                <input aria-label={`How many ${unit.toLowerCase()}s it holds`} className="input" inputMode="numeric" placeholder={`Holds how many ${unit.toLowerCase()}s?`} value={pack.factor} onChange={(e) => setPack({ ...pack, factor: e.target.value.replace(/\D/g, "") })} />
                <input aria-label="Selling price of the package" className="input" inputMode="numeric" placeholder="Selling price (TZS)" value={pack.price} onChange={(e) => setPack({ ...pack, price: e.target.value })} />
                <button className="btn-secondary" disabled={busy || asking}>Add package</button>
              </form>
            )}
            {problem && <div className="mt-2"><Alert kind="error">{problem}</Alert></div>}
            {confirmation}
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
  const cols = useColumnVisibility("products", COLUMNS);
  const isOwner = user?.role === "OWNER";
  const [search, setSearch] = useBackState("search", "");
  const [query, setQuery] = useBackState("query", "");
  const [soldBy, setSoldBy] = useBackState("soldBy", "");
  const [show, setShow] = useBackState("show", "");
  const [stockLevel, setStockLevel] = useBackState("stock", "");
  const [from, setFrom] = useBackState("from", "");
  const [to, setTo] = useBackState("to", "");
  const [ordering, setOrdering] = useBackState("ordering", "serial_number");
  const [page, setPage] = useBackState("page", 1);
  const badDates = !!from && !!to && from > to;
  const params = `page=${page}&page_size=25&ordering=${ordering}&search=${encodeURIComponent(query)}${soldBy ? `&sold_by=${soldBy}` : ""}${show ? `&active=${show}` : ""}${stockLevel ? `&stock_status=${stockLevel}` : ""}${from ? `&date_from=${from}` : ""}${to ? `&date_to=${to}` : ""}`;
  const list = useLoad<ProductTable>(badDates ? null : `/products/table/?${params}`);
  useLiveReload(list.reload);

  // Arriving from a dashboard tile or a stock warning (/products?stock=LOW_STOCK) shows just those products.
  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).get("stock");
    if (asked && (asked === "ATTENTION" || asked in STOCK_LEVELS)) { setStockLevel(asked); setShow(""); setPage(1); }
  }, []);
  const [detailsFor, setDetailsFor] = useState<number | null>(null);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmations, setConfirmations] = useState<string[]>([]);

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
        bottles_per_unit: product.bottles_per_unit ? String(product.bottles_per_unit) : "",
        selling_price: String(Number(product.selling_price)), cost_price: product.cost_price ? String(Number(product.cost_price)) : "",
        reorder_point: String(Number(product.reorder_point ?? 0)), critical_point: String(Number(product.critical_point ?? 0)), is_active: product.is_active,
      });
      setEditing(product);
    } catch (err) {
      setProblem(errorMessage(err));
    }
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !editing || confirmations.length > 0) return;
    const questions: string[] = [];
    if (editing !== "new") {
      if (Number(editing.selling_price) !== Number(form.selling_price || 0)) {
        questions.push(`Change the selling price from ${formatTZS(editing.selling_price)} to ${formatTZS(form.selling_price || 0)}? New sales use the new price straight away. Past sales and receipts are not changed.`);
      }
      if ((editing.bottles_per_unit ?? "") !== (form.bottles_per_unit === "" ? "" : Number(form.bottles_per_unit))) {
        questions.push(`Change the number of bottles in one ${form.base_unit.toLowerCase()} from ${editing.bottles_per_unit ?? "not recorded"} to ${form.bottles_per_unit || "not recorded"}? Stock quantities, which are counted in ${form.base_unit.toLowerCase()}s, do not change.`);
      }
    }
    if (questions.length > 0) setConfirmations(questions);
    else persist();
  }

  function answerYes() {
    const rest = confirmations.slice(1);
    setConfirmations(rest);
    if (rest.length === 0) persist();
  }

  async function persist() {
    if (busy || !editing) return;
    setBusy(true);
    setErrors({});
    setProblem(null);
    try {
      const body = {
        name: form.name, base_unit: form.base_unit, is_active: form.is_active,
        volume_ml: form.volume_ml === "" ? null : Number(form.volume_ml),
        bottles_per_unit: form.base_unit === "Bottle" || form.bottles_per_unit === "" ? null : Number(form.bottles_per_unit),
        selling_price: form.selling_price.replace(/,/g, "") || "0", cost_price: form.cost_price === "" ? null : form.cost_price.replace(/,/g, ""),
        reorder_point: form.reorder_point || "0", critical_point: form.critical_point || "0",
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

      <div className="card mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-7">
        <div className="lg:col-span-2"><Field label="Search">{(p) => <input {...p} className="input" placeholder="Name or code" value={search} onChange={(e) => setSearch(e.target.value)} />}</Field></div>
        <Field label="Unit">{(p) => (
          <select {...p} className="input" value={soldBy} onChange={(e) => { setSoldBy(e.target.value); setPage(1); }}>
            <option value="">All units</option>{(data?.sold_by_options ?? UNITS).map((u) => <option key={u}>{u}</option>)}
          </select>)}</Field>
        <Field label="Show">{(p) => (
          <select {...p} className="input" value={show} onChange={(e) => { setShow(e.target.value); setPage(1); }}>
            <option value="">All products</option><option value="true">On sale</option><option value="false">Switched off</option>
          </select>)}</Field>
        <Field label="Stock level">{(p) => (
          <select {...p} className="input" value={stockLevel} onChange={(e) => { setStockLevel(e.target.value); setPage(1); }}>
            <option value="">All levels</option><option value="ATTENTION">Needs attention (low, critical, out)</option>
            {STOCK_ORDER.map((s) => <option key={s} value={s}>{STOCK_LEVELS[s].label}</option>)}
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
          {data && data.count > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <ColumnPicker visibility={cols} />
              <a className="btn-secondary" href={`/api/v1/products/table/?${params}&download=csv`}>Download for Excel (CSV)</a>
            </div>
          )}
        </div>
        <div className="overflow-x-auto">
          {list.loading && !data ? <Spinner /> : list.error ? <Alert kind="error">{list.error}</Alert> : rows.length === 0 ? (
            <p className="p-4 text-slate-600">{query || soldBy || show || stockLevel ? "No product matches your search and filters." : "No products yet. Press “Add Product” to create the first one."}</p>
          ) : (
            <table className="table min-w-[960px]">
              <thead>
                <tr>
                  {COLUMNS.filter((c) => cols.show(c.key)).map((c) => {
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
                {rows.map((r) => {
                  const cell: Record<string, React.ReactNode> = {
                    serial_number: <td key="serial_number">{r.serial_number ?? ""}</td>,
                    name: <td key="name"><span className="font-semibold">{r.name}</span>{!r.is_active && <span className="block text-sm">Switched off</span>}</td>,
                    sold_by: <td key="sold_by">{r.sold_by}{r.sold_by !== "Bottle" && r.bottles_per_unit ? <span className="block text-sm text-slate-600">{r.bottles_per_unit} bottles</span> : null}</td>,
                    volume_ml: <td key="volume_ml" className="num">{r.volume_ml ? `${r.volume_ml.toLocaleString()} ml` : "—"}</td>,
                    closing_stock: <td key="closing_stock" className="num">{formatQty(r.closing_stock)}</td>,
                    purchase_price: <td key="purchase_price" className="num">{r.purchase_price === null ? <span className="text-slate-600" title="No purchase price has been entered for this product.">Not entered</span> : <>{plain(r.purchase_price)}{r.purchase_price_provisional && <span className="block text-sm text-amber-800">provisional</span>}</>}</td>,
                    selling_price: <td key="selling_price" className="num">{Number(r.selling_price) > 0 ? plain(r.selling_price) : <span className="font-semibold text-red-800">⚠ No price</span>}</td>,
                    total_sales: <td key="total_sales" className="num">{plain(r.total_sales)}</td>,
                    profit: <td key="profit" className="num font-semibold"><ProfitCell row={r} bare /></td>,
                    stock: <td key="stock" className="num font-semibold"><StockBadge status={r.stock_status} quantity={r.stock} /></td>,
                  };
                  return (
                  <tr key={r.id} className={r.is_active ? "" : "text-slate-500"}>
                    {COLUMNS.filter((c) => cols.show(c.key)).map((c) => cell[c.key])}
                    <td className="text-right">
                      {/* Stacked beside the sidebar so the table fits; side by side on a wide screen. */}
                      <div className="flex flex-col items-stretch gap-1 2xl:flex-row 2xl:justify-end">
                        <button className="btn-secondary min-h-[2.25rem] whitespace-nowrap" onClick={() => setDetailsFor(r.id)}>Details</button>
                        <button className="btn-secondary min-h-[2.25rem] whitespace-nowrap" onClick={() => open(r.id)}>Edit</button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
              {data && (
                <tfoot>
                  {(() => {
                    const shown = COLUMNS.filter((c) => cols.show(c.key));
                    const isTotal = (k: string) => k === "total_sales" || k === "profit";
                    const lead = shown.findIndex((c) => isTotal(c.key));
                    const label = `Total for all ${data.count} product${data.count === 1 ? "" : "s"} shown by these filters`;
                    if (lead === -1) return <tr className="font-bold"><td colSpan={shown.length + 1}>{label}</td></tr>;
                    return (
                      <>
                        {lead === 0 && <tr className="font-bold"><td colSpan={shown.length + 1}>{label}</td></tr>}
                        <tr className="font-bold">
                          {lead > 0 && <td colSpan={lead}>{label}</td>}
                          {shown.slice(lead).map((c) => <td key={c.key} className="num">{isTotal(c.key) ? plain(data.totals[c.key as "total_sales" | "profit"]) : ""}</td>)}
                          <td />
                        </tr>
                      </>
                    );
                  })()}
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
          <ul className="ml-5 mt-2 list-disc space-y-1">{COLUMNS.slice(4).map((c) => <li key={c.key}><strong>{c.label}:</strong> {c.help}.</li>)}</ul>
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
            </div>
            <fieldset className="grid gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-2">
              <legend className="px-1 font-semibold">Stock warnings, in {form.base_unit.toLowerCase()}s</legend>
              <Field label="Low stock at" hint="Shown amber at or below this. 0 = no warning." error={errors.reorder_point}>{(p) => <input {...p} className="input" inputMode="numeric" value={form.reorder_point} onChange={set("reorder_point")} />}</Field>
              <Field label="Critical at" hint="Shown red at or below this. Must be lower than Low stock. 0 = none." error={errors.critical_point}>{(p) => <input {...p} className="input" inputMode="numeric" value={form.critical_point} onChange={set("critical_point")} />}</Field>
              <p className="text-sm text-slate-600 sm:col-span-2">At 0 the product always shows red, Out of stock.</p>
            </fieldset>
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
          {confirmations.length > 0 && (
            <ConfirmToast message={confirmations[0]} yes="Yes, save" busy={busy} onNo={() => setConfirmations([])} onYes={answerYes} />
          )}
        </Modal>
      )}
    </div>
  );
}
