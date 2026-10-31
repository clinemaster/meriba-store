"use client";

import Link from "next/link";
import { useState } from "react";

import { formatTZS, toCents } from "@/lib/money";
import { iconFor, paymentQuery, seriesColour, type TransactionQuery } from "@/lib/payments";
import type { PaymentCategoryTotal, PaymentMetrics, PaymentSummary } from "@/lib/types";

const CARD = "block rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:border-brand-600 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-700";

function transactionsHref(base: TransactionQuery, change: Partial<TransactionQuery>): string {
  return `/payments/transactions?${paymentQuery({ ...base, category: null, provider: null, kind: "payment", status: "collected", search: "", page: 1, ...change })}`;
}

function Tile({ label, value, note, href, strong, tone }: {
  label: string; value: string; note?: string; href?: string; strong?: boolean; tone?: "ok" | "warn";
}) {
  const body = (
    <>
      <div className="text-sm font-semibold text-slate-600">{label}</div>
      <div className={`mt-1 text-2xl tabular-nums ${strong ? "font-bold" : "font-semibold"}`}>{value}</div>
      {note && (
        <div className={`mt-1 text-sm ${tone === "warn" ? "font-semibold text-amber-900" : tone === "ok" ? "text-green-900" : "text-slate-600"}`}>
          {tone === "warn" ? "⚠\uFE0E " : tone === "ok" ? "✔\uFE0E " : ""}{note}
        </div>
      )}
    </>
  );
  return href ? <Link href={href} className={CARD}>{body}</Link> : <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">{body}</div>;
}

/** The headline figures. Money cards open the matching list of payments; the sales and difference cards open reports. */
export function PaymentMetricCards({ metrics: m, categories, query, reportsHref }: {
  metrics: PaymentMetrics; categories: PaymentCategoryTotal[]; query: TransactionQuery; reportsHref?: (key: string) => string;
}) {
  const diff = toCents(m.reconciliation_difference);
  const of = (code: string) => categories.find((c) => c.code === code);
  const headline = ["cash", "mobile-money", "bank"].map(of).filter((c): c is PaymentCategoryTotal => !!c);
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Tile label="Total net sales" value={formatTZS(m.net_sales)} strong href={reportsHref?.("payment-daily")}
        note={`${m.sale_count} sale${m.sale_count === 1 ? "" : "s"}${toCents(m.cancellations) ? ` · ${formatTZS(m.cancellations)} cancelled` : ""}`} />
      <Tile label="Payments collected" value={formatTZS(m.payments_collected)} strong href={transactionsHref(query, {})}
        note={`${m.payment_count} payment${m.payment_count === 1 ? "" : "s"}`} />
      {headline.map((c) => (
        <Tile key={c.id} label={`${iconFor(c.icon)} ${c.name}`} value={formatTZS(c.amount)} href={transactionsHref(query, { category: c.id! })}
          note={`${c.count} payment${c.count === 1 ? "" : "s"}${toCents(c.refunds) ? ` · ${formatTZS(c.refunds)} refunded` : ""}`} />
      ))}
      <Tile label="Outstanding credit" value={formatTZS(m.outstanding_receivables)}
        note={toCents(m.outstanding_receivables) === 0 ? "Credit sales are not switched on; every sale is paid in full" : "Sales not yet fully paid"} />
      <Tile label="Refunds paid" value={formatTZS(m.refunds_issued)} href={transactionsHref(query, { kind: "refund" })}
        note={`${m.refund_count} refund${m.refund_count === 1 ? "" : "s"} · net collections ${formatTZS(m.net_collections)}`} />
      <Tile label="Reconciliation difference" value={formatTZS(m.reconciliation_difference)} href={reportsHref?.("payment-daily")}
        tone={diff === 0 ? "ok" : "warn"} note={diff === 0 ? "Payments match sales" : "Payments and sales do not match: check the daily reconciliation"} />
    </div>
  );
}

/** Every category with its providers. Each figure opens the list of exactly the payments behind it. */
export function PaymentCategoryCards({ categories, query, palette }: {
  categories: PaymentCategoryTotal[]; query: TransactionQuery; palette: number[];
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {categories.map((c) => (
        <div key={c.id} className="rounded-lg border border-slate-200 bg-white shadow-sm">
          <Link href={transactionsHref(query, { category: c.id! })} className={`${CARD} rounded-b-none border-0 shadow-none`}
            aria-label={`${c.name}: ${formatTZS(c.amount)} collected. Show these payments.`}>
            <div className="flex items-center gap-2">
              <span aria-hidden className="inline-block h-3 w-3 rounded-sm" style={{ background: seriesColour(palette.indexOf(c.id!)) }} />
              <span className="font-semibold"><span aria-hidden>{iconFor(c.icon)} </span>{c.name}</span>
              {!c.is_active && <span className="rounded-full border border-slate-300 px-2 text-xs text-slate-600">switched off</span>}
            </div>
            <div className="mt-1 text-2xl font-bold tabular-nums">{formatTZS(c.amount)}</div>
            <div className="text-sm text-slate-600">
              {c.count} payment{c.count === 1 ? "" : "s"}
              {toCents(c.refunds) !== 0 && <> · refunds {formatTZS(c.refunds)} · net {formatTZS(c.net)}</>}
            </div>
          </Link>
          {c.providers.length > 0 && (
            <ul className="border-t border-slate-200 px-2 py-1">
              {c.providers.map((p) => (
                <li key={p.id ?? "none"}>
                  <Link href={transactionsHref(query, { category: c.id!, provider: p.id ?? "none" })}
                    className="flex min-h-[2.5rem] items-center justify-between gap-3 rounded px-2 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2"
                    aria-label={`${c.name}, ${p.name}: ${formatTZS(p.amount)}. Show these payments.`}>
                    <span className={p.id === null ? "font-semibold text-amber-900" : ""}>
                      {p.id === null ? "⚠\uFE0E " : "— "}{p.name}{!p.is_active && p.id !== null ? " (switched off)" : ""}
                    </span>
                    <span className="tabular-nums">{formatTZS(p.amount)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {c.unassigned > 0 && (
            <p className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900">
              {c.unassigned} earlier payment{c.unassigned === 1 ? "" : "s"} have no provider recorded. Open the line above to review them.
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Payments collected per period, stacked by category. One axis; a 2px gap between segments; legend always shown;
 * hover or focus a bar for its figures; the same numbers are in the table view.
 */
export function PaymentTrendChart({ summary, palette }: { summary: PaymentSummary; palette: number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const points = summary.trend;
  const cats = summary.categories.filter((c) => points.some((p) => toCents(p.by_category[String(c.id)]) > 0));
  const max = Math.max(1, ...points.map((p) => toCents(p.total)));
  const W = 720, H = 220, left = 8, bottom = 24, top = 8;
  const slot = (W - left) / Math.max(points.length, 1);
  const bar = Math.max(4, Math.min(36, slot * 0.6));
  const y = (cents: number) => ((H - bottom - top) * cents) / max;
  const labelEvery = Math.ceil(points.length / 12);

  if (cats.length === 0) return <p className="text-slate-600">No payments in this period.</p>;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-label="Legend">
          {cats.map((c) => (
            <li key={c.id} className="flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-3 w-3 rounded-sm" style={{ background: seriesColour(palette.indexOf(c.id!)) }} />{c.name}
            </li>
          ))}
        </ul>
        <button type="button" className="text-sm font-semibold text-brand-700 underline" onClick={() => setAsTable((t) => !t)}>
          {asTable ? "Show as chart" : "Show as table"}
        </button>
      </div>
      {asTable ? (
        <div className="overflow-x-auto">
          <table className="table">
            <thead><tr><th>Period</th>{cats.map((c) => <th key={c.id} className="num">{c.name}</th>)}<th className="num">Total</th></tr></thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.period}><td>{p.label}</td>{cats.map((c) => <td key={c.id} className="num">{formatTZS(p.by_category[String(c.id)] ?? "0")}</td>)}<td className="num font-semibold">{formatTZS(p.total)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-56 w-full" role="img" aria-label={`Payments collected per ${summary.group}, by category`}>
            <line x1={left} x2={W} y1={H - bottom} y2={H - bottom} stroke="rgb(var(--line))" strokeWidth={1} />
            {points.map((p, i) => {
              const x = left + i * slot + (slot - bar) / 2;
              let base = H - bottom;
              const segments = cats.map((c) => ({ c, cents: toCents(p.by_category[String(c.id)]) })).filter((s) => s.cents > 0);
              return (
                <g key={p.period} tabIndex={0} role="button" aria-label={`${p.label}: ${formatTZS(p.total)}`}
                  onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
                  <rect x={left + i * slot} y={top} width={slot} height={H - bottom - top} fill="transparent" />
                  {segments.map((s, j) => {
                    const h = Math.max(y(s.cents) - (j < segments.length - 1 ? 2 : 0), 1);
                    base -= y(s.cents);
                    const last = j === segments.length - 1;
                    return (
                      <path key={s.c.id} fill={seriesColour(palette.indexOf(s.c.id!))} opacity={hover === null || hover === i ? 1 : 0.55}
                        d={last ? roundedTop(x, base, bar, h + (j > 0 ? 0 : 0)) : `M${x},${base + 2}h${bar}v${h}h${-bar}z`} />
                    );
                  })}
                  {i % labelEvery === 0 && (
                    <text x={left + i * slot + slot / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="rgb(var(--ink-muted))">{p.label}</text>
                  )}
                </g>
              );
            })}
          </svg>
          {hover !== null && points[hover] && (
            <div role="status" className="pointer-events-none absolute top-0 z-10 rounded-lg border border-slate-300 bg-white p-3 text-sm shadow-lg"
              style={{ left: `min(calc(${((left + hover * slot + slot) / W) * 100}% + 8px), calc(100% - 14rem))` }}>
              <div className="font-semibold">{points[hover].label}</div>
              {cats.map((c) => (
                <div key={c.id} className="flex justify-between gap-6">
                  <span className="flex items-center gap-1.5"><span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: seriesColour(palette.indexOf(c.id!)) }} />{c.name}</span>
                  <span className="tabular-nums">{formatTZS(points[hover].by_category[String(c.id)] ?? "0")}</span>
                </div>
              ))}
              <div className="mt-1 flex justify-between gap-6 border-t border-slate-200 pt-1 font-semibold"><span>Total</span><span className="tabular-nums">{formatTZS(points[hover].total)}</span></div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A bar segment with 4px rounded top corners (the free end); the baseline end stays square. */
function roundedTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}z`;
}
