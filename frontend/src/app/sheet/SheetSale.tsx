"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { PaymentLines } from "@/components/PaymentLines";
import { Receipt } from "@/components/Receipt";
import { ShareReceipt } from "@/components/ShareReceipt";
import { Alert, Modal, Spinner } from "@/components/ui";
import { api, errorMessage } from "@/lib/api";
import { centsToApi, formatQty, formatTZS, settle, toCents } from "@/lib/money";
import { allocationProblem, duplicateAllocation, newAllocation, usableCategories, type Allocation } from "@/lib/payments";
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
  const [lines, setLines] = useState<Allocation[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<Sale | null>(null);
  // One key for this entry. It stays the same while it is retried, so it can only ever be saved once.
  const requestKey = useRef(crypto.randomUUID());

  const active = useMemo(() => usableCategories(methods.data), [methods.data]);
  useEffect(() => {
    if (lines.length === 0 && active.length) setLines([newAllocation((active.find((m) => m.is_cash) ?? active[0]).id)]);
  }, [active, lines.length]);

  const packs = product.data?.units ?? [];
  const pack = packs.find((u) => u.id === unitId) ?? null;
  const baseUnit = product.data?.base_unit ?? "";
  const count = Number(quantity);
  const left = Number(line.closing_stock ?? 0);
  const needed = count * (pack ? Number(pack.factor) : 1);
  const priceCents = toCents(pack ? pack.selling_price : line.sales_price);
  const totalCents = count > 0 ? count * priceCents : 0;
  const stockProblem = count > 0 && needed > left ? `Only ${formatQty(left)} of ${line.details} left in stock.` : null;

  const tenders = lines.map((line) => {
    const method = active.find((m) => m.id === line.methodId);
    // Paying by one method: an empty box means "the exact total".
    const cents = !split && line.amount === "" ? totalCents : toCents(line.amount);
    return { line, methodId: line.methodId ?? 0, isCash: !!method?.is_cash, cents };
  });
  const settlement = settle(totalCents, tenders);
  const lineProblem = lines.map((l) => allocationProblem(l, active)).find((p) => p !== null)
    ?? (duplicateAllocation(lines) ? "The same payment method and provider appears twice. Put the whole amount on one line." : null);
  // Both are shown: what is still owed, and what a payment line is missing.
  const paymentProblems = [settlement.ok ? null : settlement.problem, lineProblem].filter((p): p is string => !!p);
  const paymentProblem = paymentProblems[0] ?? null;
  const ready = count > 0 && !stockProblem && paymentProblem === null && !busy;

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
          payments: tenders.filter((t) => t.cents > 0).map((t) => ({
            method: t.methodId, amount: centsToApi(t.cents), reference: t.line.reference,
            ...(t.line.providerId ? { provider: t.line.providerId } : {}),
          })),
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
          {methods.loading && !methods.data ? <Spinner /> : active.length === 0 ? (
            <Alert kind="error">No payment method is switched on. Ask the Owner to check Settings → Payment methods.</Alert>
          ) : (
            <PaymentLines methods={active} lines={lines} onChange={setLines} totalCents={totalCents} split={split} />
          )}
          {split && (
            <button type="button" className="btn-secondary mt-2 min-h-[2.5rem]" onClick={() => setLines((l) => [...l, newAllocation()])}>+ Add another payment</button>
          )}
          {shop.data?.split_payments_enabled && active.length > 1 && (
            <button type="button" className="mt-2 block text-sm font-semibold text-brand-700 underline" onClick={() => {
              // One method: keep the first line. More than one: keep it and add an empty second line to fill in.
              setLines((l) => (split ? l.slice(0, 1).map((x) => ({ ...x, amount: "" })) : [{ ...l[0], amount: "" }, newAllocation()]));
              setSplit((s) => !s);
            }}>
              {split ? "Pay with one method only" : "Customer is paying with more than one method"}
            </button>
          )}
        </div>

        {stockProblem ? <Alert kind="error">{stockProblem}</Alert> : count > 0 && (
          settlement.changeCents > 0 && paymentProblem === null ? (
            <div className="flex items-baseline justify-between rounded-lg border-2 border-amber-400 bg-amber-50 px-4 py-2">
              <span className="font-semibold">Change to give back</span>
              <span className="text-2xl font-bold tabular-nums">{formatTZS(settlement.changeCents, true)}</span>
            </div>
          ) : paymentProblem ? (
            <div className="space-y-1 rounded-lg border-2 border-red-300 bg-red-50 px-4 py-2 font-semibold text-red-900">
              {paymentProblems.map((p) => <p key={p}>⚠ {p}</p>)}
            </div>
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
