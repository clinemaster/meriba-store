"use client";

import { useRef, useState } from "react";

import { api, errorMessage } from "@/lib/api";
import { formatDate, formatQty, formatTZS, toCents } from "@/lib/money";
import { activeProviders, iconFor, paymentLabel, usableCategories } from "@/lib/payments";
import type { CurrentDay, PaymentMethod, Sale } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

import { Alert, Field, Spinner, useConfirm } from "./ui";

/** Owner/Accountant: give money back for some or all items of a completed sale. */
export function RefundForm({ sale, current, onDone, onCancel }: {
  sale: Sale; current: CurrentDay | null; onDone: (sale: Sale) => void; onCancel: () => void;
}) {
  const methods = useLoad<PaymentMethod[]>("/payment-methods/");
  const [drawer, setDrawer] = useState("");
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [damaged, setDamaged] = useState<Record<number, boolean>>({});
  const [methodId, setMethodId] = useState<number | null>(null);
  const [providerId, setProviderId] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const requestKey = useRef(crypto.randomUUID());
  const { confirm, confirmation, asking } = useConfirm();

  const lines = sale.items
    .map((item) => {
      const left = Number(item.quantity) - Number(item.refunded_quantity ?? 0);
      const quantity = Math.min(Math.max(Math.floor(Number(quantities[item.id] ?? 0)) || 0, 0), left);
      return { item, left, quantity, cents: quantity * toCents(item.unit_price) };
    });
  const chosen = lines.filter((l) => l.quantity > 0);
  const totalCents = chosen.reduce((sum, l) => sum + l.cents, 0);
  const active = usableCategories(methods.data);
  const method = active.find((m) => m.id === methodId) ?? null;
  const providers = activeProviders(method);
  const provider = providers.find((p) => p.id === providerId) ?? null;
  const openShifts = current?.open_shifts ?? [];
  const mustChooseDrawer = !!method?.is_cash && openShifts.length > 1;

  function askToRefund() {
    if (busy) return;
    if (chosen.length === 0) return setProblem("Type how many of each item are being refunded.");
    if (!method) return setProblem("Choose how the money is being given back.");
    if (method.requires_provider && !provider) return setProblem(`Choose which ${method.name} provider the money is sent through.`);
    if (reason.trim().length < 5) return setProblem("Write the reason for this refund.");
    if (mustChooseDrawer && !drawer) return setProblem("Choose which cashier's drawer the cash is taken from.");
    setProblem(null);
    const shelf = chosen.some((l) => !damaged[l.item.id]) ? " Items not marked damaged go back on the shelf." : "";
    confirm({ message: `Give back ${formatTZS(totalCents, true)} by ${paymentLabel(method.name, provider?.name)}?${shelf} This cannot be undone.`, yes: "Yes, refund", danger: true, run: submit });
  }

  async function submit() {
    if (busy || !method) return;
    setBusy(true);
    setProblem(null);
    try {
      const updated = await api<Sale>(`/sales/${sale.id}/refund/`, {
        method: "POST",
        body: {
          request_key: requestKey.current, reason, method: method.id, provider: provider?.id ?? null, shift: mustChooseDrawer ? Number(drawer) : null,
          lines: chosen.map((l) => ({ sale_item: l.item.id, quantity: l.quantity, restock: !damaged[l.item.id] })),
        },
      });
      onDone(updated);
    } catch (err) {
      setProblem(errorMessage(err));
      setBusy(false);
    }
  }

  if (methods.loading) return <Spinner />;

  return (
    <div className="no-print mt-4 space-y-3">
      <Alert kind="info">
        The refund is recorded on <strong>today&apos;s</strong> business day and linked to this sale of {formatDate(sale.business_date)}.
        The day the sale was made is not changed.
      </Alert>
      <table className="table">
        <thead><tr><th>Item</th><th className="num">Can refund</th><th className="w-24">Quantity</th><th>Back on the shelf?</th></tr></thead>
        <tbody>
          {lines.map(({ item, left }) => (
            <tr key={item.id}>
              <td>{item.product_name}<span className="block text-sm text-slate-600">{formatTZS(item.unit_price)} each</span></td>
              <td className="num">{formatQty(left)}</td>
              <td>
                <input aria-label={`Quantity of ${item.product_name} to refund`} className="input min-h-[2.5rem]" inputMode="numeric" disabled={left <= 0}
                  value={quantities[item.id] ?? ""} onChange={(e) => setQuantities((q) => ({ ...q, [item.id]: e.target.value.replace(/\D/g, "") }))} />
              </td>
              <td>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="h-5 w-5" checked={!!damaged[item.id]} onChange={(e) => setDamaged((d) => ({ ...d, [item.id]: e.target.checked }))} />
                  Damaged, do not return to stock
                </label>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <fieldset>
        <legend className="mb-1 font-semibold">How is the money given back?</legend>
        <div className="flex flex-wrap gap-2">
          {active.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={methodId === m.id} onClick={() => { setMethodId(m.id); setProviderId(null); }}
              className={`btn border-2 ${methodId === m.id ? "border-brand-700 bg-brand-600 text-white" : "border-slate-300 bg-white"}`}>
              <span aria-hidden className="mr-1">{methodId === m.id ? "✔" : iconFor(m.icon)}</span>{m.name}
            </button>
          ))}
        </div>
        {method?.requires_provider && (
          <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label={`${method.name} provider`}>
            {providers.map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={providerId === p.id} onClick={() => setProviderId(p.id)}
                className={`btn min-h-[2.75rem] border-2 ${providerId === p.id ? "border-brand-700 bg-brand-600 text-white" : "border-slate-300 bg-white"}`}>
                {providerId === p.id ? "✔ " : ""}{p.name}
              </button>
            ))}
          </div>
        )}
        {method?.is_cash && <p className="mt-1 text-sm text-slate-600">Cash is taken from the open cashier drawer and lowers the cash expected at closing.</p>}
        {mustChooseDrawer && (
          <div className="mt-2 max-w-sm">
            <label htmlFor="refund-drawer" className="mb-1 block font-semibold">Which drawer is the cash taken from?</label>
            <select id="refund-drawer" className="input" value={drawer} onChange={(e) => setDrawer(e.target.value)}>
              <option value="">— Choose —</option>
              {openShifts.map((s) => <option key={s.id} value={s.id}>{s.cashier_name}&apos;s drawer</option>)}
            </select>
          </div>
        )}
      </fieldset>
      <Field label="Reason for the refund" hint="For example: wrong item given, bottle was leaking.">
        {(p) => <input {...p} className="input" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
      <div className="flex items-baseline justify-between rounded-lg bg-brand-50 px-4 py-2">
        <span className="font-semibold">Amount to give back</span>
        <span className="text-2xl font-bold tabular-nums">{formatTZS(totalCents, true)}</span>
      </div>
      {problem && <Alert kind="error">{problem}</Alert>}
      <div className="flex gap-3">
        <button className="btn-danger" disabled={busy || asking || totalCents === 0} onClick={askToRefund}>{busy ? "Saving…" : `Refund ${formatTZS(totalCents, true)}`}</button>
        <button className="btn-secondary" disabled={busy} onClick={onCancel}>Go back</button>
      </div>
      {confirmation}
    </div>
  );
}
