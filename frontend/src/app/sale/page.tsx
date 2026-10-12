"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Receipt } from "@/components/Receipt";
import { Alert, Modal, Spinner, StatusBadge } from "@/components/ui";
import { api, ApiError, errorMessage, type Page } from "@/lib/api";
import { cartTotalCents, centsToApi, formatQty, formatTZS, lineTotalCents, settle, toCents, type CartLine } from "@/lib/money";
import type { CurrentDay, PaymentMethod, Product, Sale, ShopSettings } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

const newKey = () => crypto.randomUUID();

export default function NewSalePage() {
  const current = useLoad<CurrentDay>("/day/current/");
  const methods = useLoad<PaymentMethod[]>("/payment-methods/");
  const shop = useLoad<ShopSettings>("/settings/");

  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Product[]>([]);
  const [searching, setSearching] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [split, setSplit] = useState(false);
  const [methodId, setMethodId] = useState<number | null>(null);
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [references, setReferences] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<Sale | null>(null);
  // One key per sale. It stays the same while this sale is retried, so it can only ever be saved once.
  const requestKey = useRef(newKey());
  const searchBox = useRef<HTMLInputElement>(null);

  const active = useMemo(() => (methods.data ?? []).filter((m) => m.is_active), [methods.data]);
  useEffect(() => {
    if (methodId === null && active.length) setMethodId((active.find((m) => m.is_cash) ?? active[0]).id);
  }, [active, methodId]);

  const loadProducts = useCallback(async (text: string) => {
    setSearching(true);
    try {
      const page = await api<Page<Product>>(`/products/?page_size=40&search=${encodeURIComponent(text)}`);
      setResults(page.results);
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => loadProducts(search.trim()), 200);
    return () => clearTimeout(timer);
  }, [search, loadProducts]);

  const totalCents = cartTotalCents(cart);
  const tenders = active
    .filter((m) => (split ? true : m.id === methodId))
    .map((m) => {
      const typed = amounts[m.id];
      // Paying by one method: an empty box means "the exact total".
      const cents = !split && (typed === undefined || typed === "") ? totalCents : toCents(typed);
      return { methodId: m.id, isCash: m.is_cash, cents };
    });
  const settlement = settle(totalCents, tenders);

  // A sale line is a product in one selling unit: its own unit, or a verified package such as a crate of 12.
  // Stock is always checked in the product's own unit, across all of its lines together.
  const keyOf = (l: Pick<CartLine, "productId" | "unitId">) => `${l.productId}:${l.unitId ?? 0}`;
  const usedElsewhere = (lines: CartLine[], line: Pick<CartLine, "productId" | "unitId">) =>
    lines.filter((l) => l.productId === line.productId && keyOf(l) !== keyOf(line)).reduce((sum, l) => sum + l.quantity * (l.factor ?? 1), 0);

  function addToCart(product: Product, pack?: Product["units"][number]) {
    setProblem(null);
    const stock = Number(product.stock_on_hand);
    const factor = pack ? Number(pack.factor) : 1;
    const id = { productId: product.id, unitId: pack?.id ?? null };
    setCart((lines) => {
      const existing = lines.find((l) => keyOf(l) === keyOf(id));
      const wanted = (existing?.quantity ?? 0) + 1;
      if (usedElsewhere(lines, id) + wanted * factor > stock) {
        setProblem(stock <= 0 ? `${product.name} is out of stock.` : `Only ${formatQty(stock)} of ${product.name} left in stock.`);
        return lines;
      }
      if (existing) return lines.map((l) => (keyOf(l) === keyOf(id) ? { ...l, quantity: wanted } : l));
      const base = [product.name, product.package_size].filter(Boolean).join(" ");
      return [...lines, {
        ...id, factor, stock, quantity: 1, unit: pack ? pack.name : product.base_unit,
        name: pack ? `${base} (${pack.name} of ${formatQty(pack.factor)})` : base,
        priceCents: toCents(pack ? pack.selling_price : product.selling_price),
      }];
    });
  }

  function setQuantity(line: CartLine, value: number) {
    setProblem(null);
    setCart((lines) =>
      lines.map((l) => {
        if (keyOf(l) !== keyOf(line)) return l;
        const quantity = Math.max(1, Math.floor(Number.isFinite(value) ? value : 1));
        const most = Math.floor((l.stock - usedElsewhere(lines, l)) / (l.factor ?? 1));
        if (quantity > most) {
          setProblem(`Only ${formatQty(l.stock)} of ${l.name.replace(/ \(.*\)$/, "")} left in stock.`);
          return { ...l, quantity: Math.max(1, most) };
        }
        return { ...l, quantity };
      }),
    );
  }

  function resetSale() {
    setCart([]);
    setAmounts({});
    setReferences({});
    setSplit(false);
    setProblem(null);
    setDone(null);
    setSearch("");
    requestKey.current = newKey();
    loadProducts("");
    searchBox.current?.focus();
  }

  async function complete() {
    if (busy || !settlement.ok) return;
    setBusy(true);
    setProblem(null);
    try {
      const sale = await api<Sale>("/sales/", {
        method: "POST",
        body: {
          request_key: requestKey.current,
          items: cart.map((l) => ({ product: l.productId, quantity: l.quantity, ...(l.unitId ? { unit: l.unitId } : {}) })),
          payments: tenders
            .filter((t) => t.cents > 0)
            .map((t) => ({ method: t.methodId, amount: centsToApi(t.cents), reference: references[t.methodId] ?? "" })),
        },
      });
      setDone(sale);
    } catch (err) {
      // The cart is kept exactly as it was, so nothing has to be typed again.
      setProblem(errorMessage(err));
      if (err instanceof ApiError && err.code === "insufficient_stock") loadProducts(search.trim());
    } finally {
      setBusy(false);
    }
  }

  function onSearchKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const text = search.trim();
    const exact = results.find((p) => p.barcode && p.barcode === text) ?? (results.length === 1 ? results[0] : null);
    if (exact) {
      addToCart(exact);
      setSearch("");
    }
  }

  if (current.loading && !current.data) return <Spinner />;
  if (current.error) return <Alert kind="error">{current.error}</Alert>;
  if (!current.data?.shift) {
    return (
      <div className="card max-w-xl space-y-4">
        <Alert kind="info">Start your day before making a sale.</Alert>
        <Link href="/day/start" className="btn-primary">Start Day</Link>
      </div>
    );
  }

  return (
    <div className="grid gap-5 lg:grid-cols-5">
      {/* 1. Find products */}
      <section aria-label="Find products" className="card lg:col-span-3">
        <h1 className="mb-3 text-2xl font-bold">New Sale</h1>
        <label htmlFor="product-search" className="mb-1 block font-semibold">1. Find the product</label>
        <input
          id="product-search" ref={searchBox} autoFocus className="input text-lg" value={search} autoComplete="off"
          placeholder="Type a product name, or scan the barcode" onChange={(e) => setSearch(e.target.value)} onKeyDown={onSearchKey}
        />
        <p className="mt-1 text-sm text-slate-600">Press a product to add it. Press it again to add one more.</p>
        <div className="mt-3 max-h-[60vh] overflow-y-auto" aria-live="polite">
          {searching && results.length === 0 ? (
            <Spinner label="Searching…" />
          ) : results.length === 0 ? (
            <p className="p-4 text-slate-600">No product found. Check the spelling, or ask the Owner to add the product.</p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {results.map((p) => {
                const out = p.stock_status === "OUT_OF_STOCK";
                return (
                  <li key={p.id}>
                    <button
                      type="button" disabled={out} onClick={() => addToCart(p)}
                      className="flex w-full items-center justify-between gap-3 rounded-lg border-2 border-slate-200 bg-white px-3 py-2 text-left hover:border-brand-600 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
                    >
                      <span>
                        <span className="block font-semibold">{p.name} {p.package_size}</span>
                        <span className="block text-sm text-slate-600">
                          {out ? "Out of stock" : `${formatQty(p.stock_on_hand)} ${p.base_unit} in stock`}
                          {p.stock_status === "LOW_STOCK" && " · running low"}
                        </span>
                      </span>
                      <span className="whitespace-nowrap font-bold tabular-nums">{formatTZS(p.selling_price)}</span>
                    </button>
                    {(p.units ?? []).map((pack) => (
                      <button
                        key={pack.id} type="button" disabled={Number(p.stock_on_hand) < Number(pack.factor)} onClick={() => addToCart(p, pack)}
                        className="mt-1 flex w-full items-center justify-between gap-3 rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 px-3 py-1.5 text-left text-sm hover:border-brand-600 disabled:cursor-not-allowed disabled:text-slate-500"
                      >
                        <span>Sell a whole <strong>{pack.name.toLowerCase()}</strong> of {p.name} ({formatQty(pack.factor)} {p.base_unit.toLowerCase()}s)</span>
                        <span className="whitespace-nowrap font-bold tabular-nums">{formatTZS(pack.selling_price)}</span>
                      </button>
                    ))}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* 2. The sale, 3. payment */}
      <section aria-label="This sale" className="card flex flex-col gap-4 lg:col-span-2">
        <h2 className="text-xl font-bold">2. This sale</h2>
        {cart.length === 0 ? (
          <p className="rounded-lg border-2 border-dashed border-slate-300 p-6 text-center text-slate-600">
            Nothing added yet. Find a product on the left and press it.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200">
            {cart.map((line) => (
              <li key={keyOf(line)} className="py-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-semibold">{line.name}</span>
                  <button type="button" className="text-sm font-semibold text-red-800 underline" onClick={() => setCart((c) => c.filter((l) => keyOf(l) !== keyOf(line)))}>
                    Remove<span className="sr-only"> {line.name}</span>
                  </button>
                </div>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1">
                    <button type="button" aria-label={`One less ${line.name}`} className="btn-secondary min-h-[2.5rem] px-3" onClick={() => setQuantity(line, line.quantity - 1)}>−</button>
                    <input
                      aria-label={`Quantity of ${line.name}`} className="input min-h-[2.5rem] w-20 text-center" inputMode="numeric" value={line.quantity}
                      onChange={(e) => setQuantity(line, Number(e.target.value.replace(/\D/g, "")) || 1)} onFocus={(e) => e.target.select()}
                    />
                    <button type="button" aria-label={`One more ${line.name}`} className="btn-secondary min-h-[2.5rem] px-3" onClick={() => setQuantity(line, line.quantity + 1)}>+</button>
                    <span className="ml-1 text-sm text-slate-600">× {formatTZS(line.priceCents, true)}</span>
                  </div>
                  <span className="font-bold tabular-nums">{formatTZS(lineTotalCents(line), true)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-baseline justify-between rounded-lg bg-brand-50 px-4 py-3">
          <span className="text-lg font-semibold">Total to pay</span>
          <span className="text-3xl font-bold tabular-nums" data-testid="sale-total">{formatTZS(totalCents, true)}</span>
        </div>

        <div>
          <h2 className="mb-2 text-xl font-bold">3. How is the customer paying?</h2>
          {methods.loading ? <Spinner /> : !split ? (
            <div role="radiogroup" aria-label="Payment method" className="grid grid-cols-3 gap-2">
              {active.map((m) => (
                <button
                  key={m.id} type="button" role="radio" aria-checked={methodId === m.id} onClick={() => setMethodId(m.id)}
                  className={`btn min-h-[3.5rem] border-2 px-2 ${methodId === m.id ? "border-brand-700 bg-brand-600 text-white" : "border-slate-300 bg-white"}`}
                >
                  {methodId === m.id ? "✔ " : ""}{m.name}
                </button>
              ))}
            </div>
          ) : null}

          <div className="mt-3 space-y-3">
            {active.filter((m) => (split ? true : m.id === methodId)).map((m) => (
              <div key={m.id} className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor={`amount-${m.id}`} className="mb-1 block text-sm font-semibold">
                    {m.is_cash ? "Cash received (TZS)" : `${m.name} amount (TZS)`}
                  </label>
                  <input
                    id={`amount-${m.id}`} className="input" inputMode="numeric" value={amounts[m.id] ?? ""}
                    placeholder={split ? "0" : formatTZS(totalCents, true).replace("TZS ", "")}
                    onChange={(e) => setAmounts((a) => ({ ...a, [m.id]: e.target.value }))}
                  />
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

        {cart.length > 0 && (
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

        <button type="button" className="btn-primary min-h-[4rem] text-xl" disabled={busy || !settlement.ok} onClick={complete}>
          {busy ? "Saving the sale…" : `Complete Sale · ${formatTZS(totalCents, true)}`}
        </button>
        {cart.length > 0 && <button type="button" className="btn-secondary" disabled={busy} onClick={resetSale}>Clear and start again</button>}
      </section>

      {done && (
        <Modal title="Sale saved" onClose={resetSale}>
          <div className="no-print mb-4 space-y-2">
            <Alert kind="success">
              Receipt <span className="font-bold">{done.receipt_number}</span> for {formatTZS(done.total)} has been saved.
            </Alert>
            {Number(done.change_due) > 0 && <p className="text-xl font-bold">Give change: {formatTZS(done.change_due)}</p>}
          </div>
          <Receipt sale={done} shop={shop.data} />
          <div className="no-print mt-4 flex flex-wrap gap-3">
            <button className="btn-primary" autoFocus onClick={resetSale}>Next Sale</button>
            <button className="btn-secondary" onClick={() => window.print()}>Print Receipt</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
