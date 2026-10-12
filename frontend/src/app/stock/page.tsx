"use client";

import { useMemo, useRef, useState } from "react";

import { Alert, Field, PageTitle, Spinner } from "@/components/ui";
import { api, errorMessage, type Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatQty, formatTime } from "@/lib/money";
import type { Product, SetupStatus, ShopSettings } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

type Movement = {
  id: number; created_at: string; business_date: string; product_name: string; type_label: string;
  quantity_delta: string; balance_after: string; user_name: string; reason: string;
};

export default function StockPage() {
  const { user } = useAuth();
  const shop = useLoad<ShopSettings>("/settings/");
  const products = useLoad<Page<Product>>("/products/?page_size=500&active=true");
  const movements = useLoad<Page<Movement>>("/stock/movements/?page_size=30");
  const setup = useLoad<SetupStatus>("/setup/status/");
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [reason, setReason] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const requestKey = useRef(crypto.randomUUID());

  const live = shop.data?.is_live ?? false;
  const opening = !live;
  const rows = useMemo(
    () => (products.data?.results ?? []).filter((p) => `${p.name} ${p.package_size} ${p.sku}`.toLowerCase().includes(filter.trim().toLowerCase())),
    [products.data, filter],
  );
  const changed = Object.entries(counts).filter(([, v]) => v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0);

  async function save() {
    if (busy || changed.length === 0) return;
    if (!opening && reason.trim().length < 3) return setProblem("Write the reason for this stock change.");
    const summary = opening ? `Save the counted opening stock for ${changed.length} product(s)?` : `Change the stock of ${changed.length} product(s) to the counted quantities? This is recorded under your name.`;
    if (!window.confirm(summary)) return;
    setBusy(true);
    setProblem(null);
    setSaved(null);
    try {
      await api(opening ? "/stock/opening/" : "/stock/adjustments/", {
        method: "POST",
        body: {
          request_key: requestKey.current,
          reason: opening ? reason.trim() || "Opening stock count" : reason.trim(),
          lines: changed.map(([id, quantity]) => ({ product: Number(id), quantity })),
        },
      });
      requestKey.current = crypto.randomUUID();
      setCounts({});
      setReason("");
      setSaved(`Saved the counted quantity for ${changed.length} product(s).`);
      products.reload();
      movements.reload();
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (shop.loading || (products.loading && !products.data)) return <Spinner />;
  const locked = opening && (setup.data?.opening_stock_confirmed ?? false);
  // Opening counts can be entered and corrected until the Owner approves them.

  return (
    <div className="space-y-6">
      <PageTitle
        title={opening ? "Opening Stock Count" : "Stock"}
        help={opening
          ? "Before the shop goes live, count every product on the shelves and in the store room and type the quantity here. Only type what was physically counted. You can correct a count until the Owner approves the opening stock on the Setup page."
          : "Stock goes down automatically with every sale. If a physical count is different, type the counted quantity and the reason. Every change is recorded with your name."}
      />
      {locked && <Alert kind="info">The Owner has approved the opening stock, so it is locked. {user?.role === "OWNER" ? "Unlock it on the Setup page if a count is wrong." : "Ask the Owner to unlock it if a count is wrong."}</Alert>}
      {saved && <Alert kind="success">{saved}</Alert>}
      {problem && <Alert kind="error">{problem}</Alert>}

      <section className="card">
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          <Field label="Find a product">{(p) => <input {...p} className="input" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Type part of the name" />}</Field>
          <Field label={opening ? "Note (optional)" : "Reason for the change"} hint={opening ? "e.g. Counted by Karoli on Sunday evening" : "e.g. Monthly count, 2 bottles broken"}>
            {(p) => <input {...p} className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}
          </Field>
        </div>
        <div className="max-h-[55vh] overflow-auto">
          {rows.length === 0 ? <p className="p-4 text-slate-600">No products to show. Add products first.</p> : (
            <table className="table">
              <thead className="sticky top-0 bg-white"><tr><th>Product</th><th>Counted by</th><th className="num">In the system now</th><th className="w-44">Quantity counted</th></tr></thead>
              <tbody>
                {rows.map((p) => {
                  const done = false;
                  return (
                    <tr key={p.id}>
                      <td><span className="font-semibold">{p.name}</span> {p.package_size}</td>
                      <td>{p.base_unit}</td>
                      <td className="num">{formatQty(p.stock_on_hand)}</td>
                      <td>
                        {done ? <span className="text-slate-600">✔ Entered</span> : (
                          <input aria-label={`Quantity counted for ${p.name} ${p.package_size}`} className="input min-h-[2.5rem]" inputMode="numeric" disabled={locked}
                            value={counts[p.id] ?? ""} onChange={(e) => setCounts((c) => ({ ...c, [p.id]: e.target.value.replace(/[^\d]/g, "") }))} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button className="btn-primary" disabled={busy || changed.length === 0 || locked} onClick={save}>
            {busy ? "Saving…" : changed.length === 0 ? "Type a counted quantity to save" : `Save ${changed.length} counted quantit${changed.length === 1 ? "y" : "ies"}`}
          </button>
          <span className="text-sm text-slate-600">Rows you leave empty are not changed.</span>
        </div>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="mb-3 text-xl font-bold">Latest stock movements</h2>
        {movements.loading && !movements.data ? <Spinner /> : movements.error ? <Alert kind="error">{movements.error}</Alert> : (movements.data?.results.length ?? 0) === 0 ? (
          <p className="text-slate-600">No stock movements yet.</p>
        ) : (
          <table className="table">
            <thead><tr><th>When</th><th>Product</th><th>What happened</th><th className="num">Change</th><th className="num">Stock after</th><th>By</th><th>Reason</th></tr></thead>
            <tbody>
              {movements.data!.results.map((m) => (
                <tr key={m.id}>
                  <td className="whitespace-nowrap">{formatDate(m.created_at)} {formatTime(m.created_at)}</td>
                  <td>{m.product_name}</td>
                  <td>{m.type_label}</td>
                  <td className="num font-semibold">{Number(m.quantity_delta) > 0 ? "+" : ""}{formatQty(m.quantity_delta)}</td>
                  <td className="num">{formatQty(m.balance_after)}</td>
                  <td>{m.user_name}</td>
                  <td>{m.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
