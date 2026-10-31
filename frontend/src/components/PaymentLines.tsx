"use client";

import { useState } from "react";

import { formatTZS } from "@/lib/money";
import { activeProviders, iconFor, paymentLabel, type Allocation } from "@/lib/payments";
import type { PaymentMethod } from "@/lib/types";

/** Shown as buttons up to this many providers; beyond it a search box appears above them. */
const SEARCH_FROM = 7;

/**
 * How the customer is paying: one line per category (and provider), each with its amount and reference.
 * A category that needs a provider shows only its providers that are switched on, read fresh from the server
 * each time the sale window opens, so an Owner's change applies without anything being reinstalled.
 */
export function PaymentLines({ methods, lines, onChange, totalCents, split }: {
  methods: PaymentMethod[]; lines: Allocation[]; onChange: (lines: Allocation[]) => void; totalCents: number; split: boolean;
}) {
  const update = (key: string, change: Partial<Allocation>) => onChange(lines.map((l) => (l.key === key ? { ...l, ...change } : l)));
  return (
    <div className="space-y-3">
      {lines.map((line, i) => (
        <PaymentLine key={line.key} line={line} methods={methods} split={split} totalCents={totalCents} position={i + 1}
          onChange={(change) => update(line.key, change)}
          onRemove={split && lines.length > 1 ? () => onChange(lines.filter((l) => l.key !== line.key)) : undefined} />
      ))}
    </div>
  );
}

function PaymentLine({ line, methods, split, totalCents, position, onChange, onRemove }: {
  line: Allocation; methods: PaymentMethod[]; split: boolean; totalCents: number; position: number;
  onChange: (change: Partial<Allocation>) => void; onRemove?: () => void;
}) {
  const [search, setSearch] = useState("");
  const method = methods.find((m) => m.id === line.methodId) ?? null;
  const providers = activeProviders(method);
  const provider = providers.find((p) => p.id === line.providerId) ?? null;
  const shown = providers.length >= SEARCH_FROM && search.trim()
    ? providers.filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase()) || p.id === line.providerId)
    : providers;
  const label = method ? paymentLabel(method.name, provider?.name) : "";
  const id = `pay-${line.key}`;

  return (
    <div className={split ? "rounded-lg border border-slate-300 p-3" : ""} data-testid="payment-line">
      {split && (
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-600">Payment {position}</span>
          {onRemove && <button type="button" className="text-sm font-semibold text-red-800 underline" onClick={onRemove}>Remove</button>}
        </div>
      )}
      <div role="radiogroup" aria-label={split ? `Payment ${position} method` : "Payment method"} className="grid grid-cols-3 gap-2">
        {methods.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={line.methodId === m.id}
            onClick={() => onChange({ methodId: m.id, providerId: null, reference: m.id === line.methodId ? line.reference : "" })}
            className={`btn min-h-[3.5rem] border-2 px-2 ${line.methodId === m.id ? "border-brand-700 bg-brand-600 text-white" : "border-slate-300 bg-white"}`}>
            <span aria-hidden className="mr-1">{line.methodId === m.id ? "✔" : iconFor(m.icon)}</span>{m.name}
          </button>
        ))}
      </div>

      {method?.requires_provider && (
        <div className="mt-3">
          <p className="mb-1 text-sm font-semibold" id={`${id}-providers`}>Which {method.name}? <span className="font-normal text-slate-600">(required)</span></p>
          {providers.length >= SEARCH_FROM && (
            <input className="input mb-2" placeholder={`Search ${method.name} providers`} aria-label={`Search ${method.name} providers`}
              value={search} onChange={(e) => setSearch(e.target.value)} />
          )}
          <div role="radiogroup" aria-labelledby={`${id}-providers`} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {shown.map((p) => (
              <button key={p.id} type="button" role="radio" aria-checked={line.providerId === p.id} onClick={() => onChange({ providerId: p.id })}
                className={`btn min-h-[3rem] border-2 px-2 ${line.providerId === p.id ? "border-brand-700 bg-brand-600 text-white" : "border-slate-300 bg-white"}`}>
                {line.providerId === p.id ? "✔ " : ""}{p.name}
              </button>
            ))}
            {shown.length === 0 && <p className="col-span-full text-sm text-slate-600">No provider matches “{search}”.</p>}
          </div>
        </div>
      )}

      {method && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div>
            <label htmlFor={`${id}-amount`} className="mb-1 block text-sm font-semibold">{method.is_cash ? "Cash received (TZS)" : `${label} amount (TZS)`}</label>
            <input id={`${id}-amount`} className="input" inputMode="numeric" value={line.amount}
              placeholder={split ? "0" : formatTZS(totalCents, true).replace("TZS ", "")}
              onChange={(e) => onChange({ amount: e.target.value })} />
          </div>
          {!method.is_cash && (
            <div>
              <label htmlFor={`${id}-ref`} className="mb-1 block text-sm font-semibold">{method.reference_label || "Reference"} (optional)</label>
              <input id={`${id}-ref`} className="input" value={line.reference} maxLength={60} onChange={(e) => onChange({ reference: e.target.value })} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
