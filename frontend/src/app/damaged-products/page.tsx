"use client";

import { useMemo, useRef, useState } from "react";

import { Alert, Field, PageTitle, Spinner, StockBadge, useConfirm, StatusBadge } from "@/components/ui";
import { ActionButton, DataTable, ExportLinks, Pagination, TableToolbar } from "@/components/DataTable";
import { ColumnPicker } from "@/components/ColumnPicker";
import { api, errorMessage, type Page } from "@/lib/api";
import { formatDate, formatQty, formatTime, formatTZS, toCents } from "@/lib/money";
import type { TableColumn } from "@/lib/table";
import { useColumnVisibility } from "@/lib/useColumnVisibility";
import { useAuth } from "@/lib/auth";
import type { Product } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

type DamageEntry = {
  adjustment_id: number; line_id: number; business_date: string; created_at: string; reference: string; product: string;
  branch: string; stock_before: string; damaged_quantity: string; stock_after: string; selling_price: string | null;
  damage_value: string | null; average_cost: string | null; inventory_cost_value: string | null; reason: string;
  remarks: string; evidence_reference: string; recorded_by: string; confirmed_by: string; status: "Confirmed" | "Reversed";
  movement: number | null;
};
type DamageList = Page<DamageEntry> & {
  summary: { records: number; products: number; damaged_quantity: string; damage_value: string; inventory_cost_value: string | null };
};
type DamageProductRow = {
  product: Product; quantity: number; quantityText: string; remaining: number; valueCents: number;
  costValueCents: number | null; invalid: boolean; quantityInput: React.ReactNode;
};

const COLUMNS: TableColumn<DamageEntry>[] = [
  { key: "business_date", label: "Business day", type: "date", accessor: "business_date", sortable: true, sortKey: "business_date", essential: true },
  { key: "time", label: "Date and time", render: (row) => `${formatDate(row.created_at)} ${formatTime(row.created_at)}` },
  { key: "reference", label: "Reference", essential: true, sortable: true },
  { key: "product", label: "Product", essential: true, sortable: true },
  { key: "branch", label: "Branch", defaultHidden: true },
  { key: "stock_before", label: "Previous stock", type: "quantity" },
  { key: "damaged_quantity", label: "Damaged quantity", type: "quantity", essential: true },
  { key: "stock_after", label: "Remaining stock", type: "quantity" },
  { key: "selling_price", label: "Selling price", type: "currency", accessor: "selling_price" },
  { key: "damage_value", label: "Damage at selling price", type: "currency", essential: true,
    render: (row) => row.damage_value === null ? "Not available" : formatTZS(row.damage_value) },
  { key: "average_cost", label: "Average unit cost", type: "currency", defaultHidden: true },
  { key: "inventory_cost_value", label: "Inventory cost of damage", type: "currency", defaultHidden: true,
    render: (row) => row.inventory_cost_value === null ? "Not available" : formatTZS(row.inventory_cost_value) },
  { key: "reason", label: "Reason", essential: true },
  { key: "remarks", label: "Remarks", defaultHidden: true },
  { key: "evidence_reference", label: "Evidence", defaultHidden: true },
  { key: "recorded_by", label: "Recorded by" },
  { key: "confirmed_by", label: "Confirmed by", defaultHidden: true },
  { key: "status", label: "Status", render: (row) => <StatusBadge status={row.status === "Confirmed" ? "COMPLETED" : "VOIDED"} label={row.status} /> },
  { key: "movement", label: "Movement ID", type: "number", defaultHidden: true },
];

const ENTRY_COLUMNS: TableColumn<DamageProductRow>[] = [
  { key: "product", label: "Product", essential: true, sortable: true, accessor: (row) => `${row.product.name} ${row.product.package_size}`,
    render: (row) => <><span className="font-semibold">{row.product.name}</span> {row.product.package_size}</> },
  { key: "unit", label: "Counted by", accessor: (row) => row.product.base_unit },
  { key: "stock", label: "In stock", type: "quantity", accessor: (row) => row.product.stock_on_hand,
    render: (row) => <StockBadge status={row.product.stock_status} quantity={row.product.stock_on_hand} /> },
  { key: "selling_price", label: "Selling price", type: "currency", accessor: (row) => row.product.selling_price },
  { key: "quantity", label: "Quantity damaged", type: "quantity", accessor: (row) => row.quantity, render: (row) => <>{row.quantityInput}{row.invalid && <span className="block text-xs text-danger">Enter a positive quantity no greater than stock.</span>}</> },
  { key: "damage_value", label: "Damage at selling price", type: "currency", accessor: (row) => row.valueCents / 100,
    render: (row) => row.quantity > 0 ? formatTZS(row.valueCents, true) : "—" },
  { key: "inventory_cost_value", label: "Inventory cost of damage", type: "currency", accessor: (row) => row.costValueCents === null ? null : row.costValueCents / 100,
    render: (row) => row.quantity > 0 ? row.costValueCents === null ? "Not available" : formatTZS(row.costValueCents, true) : "—" },
  { key: "remaining", label: "Stock after", type: "quantity", accessor: (row) => Math.max(row.remaining, 0) },
];

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function firstOfMonth(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

function quantityInput(value: string): string {
  const [whole, fraction = ""] = value.replace(/[^\d.]/g, "").split(".");
  return fraction ? `${whole}.${fraction.slice(0, 3)}` : whole;
}

export default function DamagedProductsPage() {
  const { user } = useAuth();
  const products = useLoad<Page<Product>>("/products/?page_size=500&active=true");
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState(() => firstOfMonth(today()));
  const [to, setTo] = useState(today());
  const [productFilter, setProductFilter] = useState("");
  const [reasonFilter, setReasonFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("");
  const [filter, setFilter] = useState("");
  const [remarks, setRemarks] = useState("");
  const [evidenceReference, setEvidenceReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const requestKey = useRef(crypto.randomUUID());
  const cols = useColumnVisibility("damaged-products", COLUMNS);
  const { confirm, confirmation, asking } = useConfirm();

  const params = new URLSearchParams({ page: String(page), page_size: "25" });
  if (from) params.set("date_from", from);
  if (to) params.set("date_to", to);
  if (productFilter.trim()) params.set("product", productFilter.trim());
  if (reasonFilter.trim()) params.set("reason", reasonFilter.trim());
  if (statusFilter) params.set("status", statusFilter);
  const register = useLoad<DamageList>(`/stock/damaged/?${params.toString()}`);
  const exportParams = new URLSearchParams(params);
  exportParams.delete("page");
  exportParams.delete("page_size");
  const exportBase = `/api/v1/stock/damaged/?${exportParams.toString()}`;

  const rows = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return (products.data?.results ?? []).filter((product) =>
      `${product.name} ${product.package_size} ${product.sku}`.toLowerCase().includes(query),
    );
  }, [products.data, filter]);
  const entryRows: DamageProductRow[] = rows.map((product) => {
    const quantityText = quantities[product.id] ?? "";
    const quantity = Number(quantityText) || 0;
    const previous = Number(product.stock_on_hand);
    const remaining = previous - quantity;
    return {
      product, quantity, quantityText, remaining,
      valueCents: Math.round(toCents(product.selling_price) * Math.max(quantity, 0)),
      costValueCents: product.average_cost == null ? null : Math.round(Number(product.average_cost) * Math.max(quantity, 0) * 100),
      invalid: quantityText !== "" && (quantity <= 0 || quantity > previous),
      quantityInput: (
        <input
          aria-label={`Quantity damaged for ${product.name} ${product.package_size}`}
          className={`input min-h-[2.5rem] ${quantityText !== "" && (quantity <= 0 || quantity > previous) ? "border-danger text-danger" : ""}`}
          inputMode="decimal"
          value={quantityText}
          onChange={(e) => setQuantities((current) => ({ ...current, [product.id]: quantityInput(e.target.value) }))}
        />
      ),
    };
  });
  const damagedLines = (products.data?.results ?? []).flatMap((product) => {
    const text = quantities[product.id] ?? "";
    const quantity = Number(text);
    if (!text || !Number.isFinite(quantity) || quantity <= 0) return [];
    const previous = Number(product.stock_on_hand);
    const valueCents = Math.round(toCents(product.selling_price) * quantity);
    const costValueCents = product.average_cost == null
      ? null
      : Math.round(Number(product.average_cost) * quantity * 100);
    return [{ product, quantity, previous, remaining: previous - quantity, valueCents, costValueCents }];
  });
  const invalidQuantity = Object.entries(quantities).some(([id, text]) => {
    if (!text) return false;
    const quantity = Number(text);
    const product = products.data?.results.find((item) => item.id === Number(id));
    return !Number.isFinite(quantity) || quantity <= 0 || !product || quantity > Number(product.stock_on_hand);
  });
  const totalDamagedQuantity = damagedLines.reduce((sum, line) => sum + line.quantity, 0);
  const totalDamageCents = damagedLines.reduce((sum, line) => sum + line.valueCents, 0);
  const totalCostDamageCents = damagedLines.some((line) => line.costValueCents === null)
    ? null
    : damagedLines.reduce((sum, line) => sum + (line.costValueCents ?? 0), 0);

  async function save() {
    if (busy || damagedLines.length === 0 || invalidQuantity || reason.trim().length < 3) return;
    setBusy(true);
    setProblem(null);
    setSaved(null);
    try {
      const result = await api<{ reference: string; damaged_quantity: string; damage_value: string }>("/stock/damaged/", {
        method: "POST",
        body: {
          request_key: requestKey.current,
          reason: reason.trim(),
          remarks: remarks.trim(),
          evidence_reference: evidenceReference.trim(),
          lines: damagedLines.map(({ product, quantity }) => ({
            product: product.id,
            quantity: quantity.toFixed(3),
          })),
        },
      });
      requestKey.current = crypto.randomUUID();
      setQuantities({});
      setReason("");
      setRemarks("");
      setEvidenceReference("");
      setSaved(`${result.reference}: ${formatQty(result.damaged_quantity)} units damaged · ${formatTZS(result.damage_value)} at selling price.`);
      products.reload();
      register.reload();
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function askToSave() {
    if (busy || damagedLines.length === 0 || invalidQuantity || reason.trim().length < 3) return;
    confirm({
      message: `Deduct ${formatQty(totalDamagedQuantity)} damaged unit(s) from ${damagedLines.length} product(s)? Grand total at selling price: ${formatTZS(totalDamageCents, true)}.`,
      yes: "Confirm damaged products", danger: true, run: () => { void save(); },
    });
  }

  async function reverse(entry: DamageEntry, reversalReason: string) {
    try {
      await api(`/stock/damaged/${entry.adjustment_id}/reverse/`, {
        method: "POST", body: { request_key: crypto.randomUUID(), reason: reversalReason },
      });
      setSaved(`Damage record ${entry.reference} reversed; the original record remains in the register.`);
      register.reload();
      products.reload();
    } catch (err) {
      setProblem(errorMessage(err));
    }
  }

  const pages = Math.max(1, Math.ceil((register.data?.count ?? 0) / 25));
  const isOwner = user?.role === "OWNER";

  if (products.loading && !products.data) return <Spinner />;

  return (
    <div className="space-y-6">
      <PageTitle title="Damaged Product" help="Record damaged or expired stock. Damage is valued at the selling price and separately at weighted-average inventory cost when available." />
      {products.error && <Alert kind="error">{products.error}</Alert>}
      {saved && <Alert kind="success">{saved}</Alert>}
      {problem && <Alert kind="error">{problem}</Alert>}

      <section className="card space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Find a product">
            {(p) => <input {...p} className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Type part of the name" />}
          </Field>
          <Field label="Reason for damage" hint="For example: broken bottle or expired stock.">
            {(p) => <input {...p} className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}
          </Field>
          <Field label="Evidence reference (optional)">
            {(p) => <input {...p} className="input" value={evidenceReference} maxLength={300} onChange={(e) => setEvidenceReference(e.target.value)} />}
          </Field>
        </div>
        <Field label="Remarks (optional)">
          {(p) => <textarea {...p} className="input" rows={2} maxLength={500} value={remarks} onChange={(e) => setRemarks(e.target.value)} />}
        </Field>

        <div className="max-h-[55vh] overflow-auto">
          <DataTable
            label="Products available for damage recording"
            columns={ENTRY_COLUMNS}
            rows={entryRows}
            rowKey={(row) => row.product.id}
            loading={products.loading && !products.data}
            error={products.error}
            empty={(products.data?.results.length ?? 0) === 0 ? "No active products found." : "No products match this search."}
            className="min-w-[1050px]"
          />
        </div>

        <dl className="grid gap-3 border-t border-line pt-4 sm:grid-cols-4">
          <div><dt className="text-sm text-ink-muted">Distinct products</dt><dd className="text-lg font-bold">{damagedLines.length}</dd></div>
          <div><dt className="text-sm text-ink-muted">Total damaged quantity</dt><dd className="text-lg font-bold tabular-nums">{formatQty(totalDamagedQuantity)}</dd></div>
          <div><dt className="text-sm text-ink-muted">Grand Total Damage Value</dt><dd className="text-lg font-bold tabular-nums">{formatTZS(totalDamageCents, true)}</dd></div>
          <div><dt className="text-sm text-ink-muted">Inventory cost of damage</dt><dd className="text-lg font-bold tabular-nums">{totalCostDamageCents === null ? "Not available for every product" : formatTZS(totalCostDamageCents, true)}</dd></div>
        </dl>

        <div className="flex flex-wrap items-center gap-3">
          <button
            className="btn-danger"
            disabled={busy || asking || damagedLines.length === 0 || invalidQuantity || reason.trim().length < 3}
            onClick={askToSave}
          >
            {busy ? "Saving…" : "Review and record damaged stock"}
          </button>
        </div>
      </section>

      <section className="card space-y-4">
        <div className="grid gap-3 sm:grid-cols-5">
          <Field label="From">{(p) => <input {...p} className="input" type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />}</Field>
          <Field label="To">{(p) => <input {...p} className="input" type="date" value={to} min={from} onChange={(e) => { setTo(e.target.value); setPage(1); }} />}</Field>
          <Field label="Product">{(p) => <input {...p} className="input" value={productFilter} onChange={(e) => { setProductFilter(e.target.value); setPage(1); }} />}</Field>
          <Field label="Reason">{(p) => <input {...p} className="input" value={reasonFilter} onChange={(e) => { setReasonFilter(e.target.value); setPage(1); }} />}</Field>
          <Field label="Status">{(p) => (
            <select {...p} className="input" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}>
              <option value="">All</option><option value="CONFIRMED">Confirmed</option><option value="REVERSED">Reversed</option>
            </select>
          )}</Field>
        </div>
        {register.data?.summary && (
          <dl className="grid gap-3 sm:grid-cols-4">
            <div><dt className="text-sm text-ink-muted">Damage records</dt><dd className="font-bold">{register.data.summary.records}</dd></div>
            <div><dt className="text-sm text-ink-muted">Products damaged</dt><dd className="font-bold">{register.data.summary.products}</dd></div>
            <div><dt className="text-sm text-ink-muted">Damaged quantity</dt><dd className="font-bold tabular-nums">{formatQty(register.data.summary.damaged_quantity)}</dd></div>
            <div><dt className="text-sm text-ink-muted">Grand Total Damage Value</dt><dd className="font-bold tabular-nums">{formatTZS(register.data.summary.damage_value)}</dd></div>
          </dl>
        )}
        <TableToolbar summary={<h2 className="text-xl font-bold">Damaged products register</h2>}>
          <ColumnPicker visibility={cols} />
          <ExportLinks links={[{ label: "Download Excel", href: `${exportBase}&download=xlsx` }, { label: "Download CSV", href: `${exportBase}&download=csv` }]} />
        </TableToolbar>
        <DataTable
          label="Damaged products register"
          columns={COLUMNS}
          visibility={cols}
          rows={register.data?.results}
          rowKey={(row) => row.line_id}
          loading={register.loading && !register.data}
          error={register.error}
          empty="No damaged products match these filters."
          defaultOrdering="-business_date"
          actions={isOwner ? (row) => row.status === "Confirmed" ? (
            <ActionButton tone="danger" aria-label={`Reverse damage record ${row.reference}`} disabled={asking} onClick={() => confirm({
              message: `Restore the quantities from ${row.reference} to stock? The original damage record remains in the register.`,
              yes: "Reverse damage", danger: true, input: { label: "Reason for reversal", minLength: 3 },
              run: (reversalReason) => { void reverse(row, reversalReason); },
            })}>Reverse</ActionButton>
          ) : null : undefined}
        />
        <Pagination page={page} pages={pages} onPage={setPage} label="Damaged product register pages" />
      </section>
      {confirmation}
    </div>
  );
}