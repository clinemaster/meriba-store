"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Receipt } from "@/components/Receipt";
import { ShareReceipt } from "@/components/ShareReceipt";
import { Alert, Modal, Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { centsToApi, formatQty, formatTZS, settle, toCents } from "@/lib/money";
import type { PaymentMethod, Product, Sale, ShopSettings } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

export type SheetSaleLine = { product: number | null; details: string; sales_price: string | null; closing_stock: string | null };

/**
 * A quantity typed on the Daily Sheet becomes a sale: a receipt, how it was paid, stock taken off.
 * This is the only place sales are entered, so everything the till needs is here: change for cash,
 * more than one payment method, a product's verified packages, and the receipt to print.
 */
export function SheetSale({ line, quantity: typed, onClose, onSaved }: {
  line: SheetSaleLine; quantity: number; onClose: () => void; onSaved: (sale: Sale) => void;
}) {
  const methods = useLoad<PaymentMethod[]>("/payment-methods/");
  const shop = useLoad<ShopSettings>("/settings/");
  const product = useLoad<Product>(line.product ? `/products/${line.product}/` : null);

  const [quantity, setQuantity] = useState(String(typed));
  const [unitId, setUnitId] = useState<number | null>(null);
  const [split, setSplit] = useState(false);
  const [methodId, setMethodId] = useState<number | null>(null);
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [references, setReferences] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<Sale | null>(null);
  // One key for this entry. It stays the same while it is retried, so it can only ever be saved once.
  const requestKey = useRef(crypto.randomUUID());

  const active = useMemo(() => (methods.data ?? []).filter((m) => m.is_active), [methods.data]);
  useEffect(() => {
    if (methodId === null && active.length) setMethodId((active.find((m) => m.is_cash) ?? active[0]).id);
  }, [active, methodId]);

  const packs = product.data?.units ?? [];
  const pack = packs.find((u) => u.id === unitId) ?? null;
  const baseUnit = product.data?.base_unit ?? "";
  const count = Number(quantity);
  const left = Number(line.closing_stock ?? 0);
  const needed = count * (pack ? Number(pack.factor) : 1);
  const priceCents = toCents(pack ? pack.selling_price : line.sales_price);
  const totalCents = count > 0 ? count * priceCents : 0;
  const stockProblem = count > 0 && needed > left ? `Only ${formatQty(left)} of ${line.details} left in stock.` : null;

  const shown = active.filter((m) => (split ? true : m.id === methodId));
  const tenders = shown.map((m) => {
    const value = amounts[m.id];
    // Paying by one method: an empty box means "the exact total".
    const cents = !split && (value === undefined || value === "") ? totalCents : toCents(value);
    return { methodId: m.id, isCash: m.is_cash, cents };
  });
  const settlement = settle(totalCents, tenders);
  const ready = count > 0 && !stockProblem && settlement.ok && !busy;

  async function save() {
    if (!ready) return;
    setBusy(true);
    setProblem(null);
    try {
      const sale = await api<Sale>("/sales/", {
        method: "POST",
        body: {
          request_key: requestKey.current,
          items: [{ product: line.product, quantity: count, ...(pack ? { unit: pack.id } : {}) }],
          payments: tenders.filter((t) => t.cents > 0).map((t) => ({ method: t.methodId, amount: centsToApi(t.cents), reference: references[t.methodId] ?? "" })),
        },
      });
      setDone(sale);
      onSaved(sale);
    } catch (err) {
      // Everything typed is kept as it was, so nothing has to be entered again.
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Modal title="Sale saved" onClose={onClose}>
        <div className="no-print mb-4 space-y-2">
          <Alert kind="success">Receipt <span className="font-bold">{done.receipt_number}</span> for {formatTZS(done.total)} has been saved and added to the sheet.</Alert>
          {Number(done.change_due) > 0 && <p className="text-xl font-bold">Give change: {formatTZS(done.change_due)}</p>}
        </div>
        <Receipt sale={done} shop={shop.data} />
        <div className="no-print mt-4 flex flex-wrap gap-3">
          <button className="btn-primary" autoFocus onClick={onClose}>Back to the sheet</button>
          <button className="btn-secondary" onClick={() => window.print()}>Print Receipt</button>
          <ShareReceipt sale={done} shop={shop.data} />
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Save this sale" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-lg font-semibold">{line.details}</p>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="sheet-sale-quantity" className="mb-1 block text-sm font-semibold">Quantity sold</label>
            <input id="sheet-sale-quantity" className="input w-28 text-center text-lg" inputMode="numeric" value={quantity}
              onChange={(e) => setQuantity(e.target.value.replace(/\D/g, ""))} onFocus={(e) => e.target.select()} />
          </div>
          {packs.length > 0 && (
            <div>
              <label htmlFor="sheet-sale-unit" className="mb-1 block text-sm font-semibold">Sold as</label>
              <select id="sheet-sale-unit" className="input" value={unitId ?? ""} onChange={(e) => setUnitId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">{baseUnit} · {formatTZS(line.sales_price ?? "0")}</option>
                {packs.map((u) => <option key={u.id} value={u.id}>{u.name} of {formatQty(u.factor)} · {formatTZS(u.selling_price)}</option>)}
              </select>
            </div>
          )}
        </div>

        <div className="flex items-baseline justify-between rounded-lg bg-brand-50 px-4 py-3">
          <span className="text-lg font-semibold">Total to pay</span>
          <span className="text-2xl font-bold tabular-nums" data-testid="sale-total">{formatTZS(totalCents, true)}</span>
        </div>
        {pack && <p className="text-sm text-slate-600">The sheet counts this as {formatQty(needed)} {baseUnit.toLowerCase()}(s) in the Sales column.</p>}

        <div>
          <p className="mb-2 font-semibold">How is the customer paying?</p>
          {methods.loading ? <Spinner /> : !split ? (
            <div role="radiogroup" aria-label="Payment method" className="grid grid-cols-3 gap-2">
              {active.map((m) => (
                <button key={m.id} type="button" role="radio" aria-checked={methodId === m.id} onClick={() => setMethodId(m.id)}
                  className={`btn min-h-[3.5rem] border-2 px-2 ${methodId === m.id ? "border-brand-700 bg-brand-600 text-white" : "border-slate-300 bg-white"}`}>
                  {methodId === m.id ? "✔ " : ""}{m.name}
                </button>
              ))}
            </div>
          ) : null}
          <div className="mt-3 space-y-3">
            {shown.map((m) => (
              <div key={m.id} className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor={`amount-${m.id}`} className="mb-1 block text-sm font-semibold">{m.is_cash ? "Cash received (TZS)" : `${m.name} amount (TZS)`}</label>
                  <input id={`amount-${m.id}`} className="input" inputMode="numeric" value={amounts[m.id] ?? ""}
                    placeholder={split ? "0" : formatTZS(totalCents, true).replace("TZS ", "")}
                    onChange={(e) => setAmounts((a) => ({ ...a, [m.id]: e.target.value }))} />
                </div>
                {!m.is_cash && (
                  <div>
                    <label htmlFor={`ref-${m.id}`} className="mb-1 block text-sm font-semibold">{m.reference_label || "Reference"} (optional)</label>
                    <input id={`ref-${m.id}`} className="input" value={references[m.id] ?? ""} maxLength={60} onChange={(e) => setReferences((r) => ({ ...r, [m.id]: e.target.value }))} />
                  </div>
                )}
              </div>
            ))}
          </div>
          {shop.data?.split_payments_enabled && active.length > 1 && (
            <button type="button" className="mt-2 text-sm font-semibold text-brand-700 underline" onClick={() => { setSplit((s) => !s); setAmounts({}); }}>
              {split ? "Pay with one method only" : "Customer is paying with more than one method"}
            </button>
          )}
        </div>

        {stockProblem ? <Alert kind="error">{stockProblem}</Alert> : count > 0 && (
          settlement.changeCents > 0 && settlement.ok ? (
            <div className="flex items-baseline justify-between rounded-lg border-2 border-amber-400 bg-amber-50 px-4 py-2">
              <span className="font-semibold">Change to give back</span>
              <span className="text-2xl font-bold tabular-nums">{formatTZS(settlement.changeCents, true)}</span>
            </div>
          ) : !settlement.ok ? (
            <p className="rounded-lg border-2 border-red-300 bg-red-50 px-4 py-2 font-semibold text-red-900">⚠ {settlement.problem}</p>
          ) : null
        )}
        {problem && <Alert kind="error">{problem}</Alert>}

        <div className="flex flex-wrap gap-3">
          <button className="btn-primary min-h-[3.5rem] text-lg" disabled={!ready} onClick={save}>{busy ? "Saving the sale…" : `Save sale · ${formatTZS(totalCents, true)}`}</button>
          <button className="btn-secondary" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </Modal>
  );
}
