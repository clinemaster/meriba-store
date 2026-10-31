"use client";

import Link from "next/link";

import { DashboardInsights } from "./DashboardInsights";

import { StockValue, type StockValueStatement } from "@/components/StockValue";

import { Alert, Spinner, Stat, StatusBadge, StockBadge } from "@/components/ui";
import type { Page } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { formatDate, formatQty, formatTZS } from "@/lib/money";
import { STOCK_LEVELS, STOCK_ORDER, useLiveReload } from "@/lib/stockLevels";
import type { CurrentDay, Product, StockLevelCounts } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

/** Owner/Accountant: the money value of the stock after the day's sales, kept up to date as sales are made. */
function StockValueCard() {
  const { data, reload } = useLoad<{ stock_value: StockValueStatement | null }>("/daily-sheet/stock-value/");
  useLiveReload(reload);
  const value = data?.stock_value;
  if (!value) return null;
  return (
    <section aria-label="Stock value" className="card border-l-4 border-l-secondary">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold">Stock value {value.source === "LIVE" ? "after today's sales" : `on ${formatDate(value.date)}`}</h2>
        <Link href="/sheet" className="btn-secondary">Daily Sheet</Link>
      </div>
      <StockValue value={value} compact />
    </section>
  );
}

/** Owner/Accountant: how many products are at each stock level, and the ones that need attention, worst first. */
function StockLevels() {
  const levels = useLoad<StockLevelCounts>("/products/stock-levels/");
  const list = useLoad<Page<Product>>("/products/?stock_status=ATTENTION&page_size=8");
  useLiveReload(() => { levels.reload(); list.reload(); });
  if (!levels.data) return null;
  const counts = levels.data.counts;
  return (
    <section aria-label="Stock levels" className="card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold">Stock levels</h2>
        <Link href="/receive" className="btn-secondary">Receive Stock</Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {STOCK_ORDER.map((s) => (
          <Link key={s} href={`/products?stock=${s}`} className={`rounded-lg border border-l-4 p-4 hover:shadow-md ${STOCK_LEVELS[s].tile}`}
            aria-label={`${STOCK_LEVELS[s].label}: ${counts[s]} product${counts[s] === 1 ? "" : "s"}. Show them.`}>
            <div className="flex items-center gap-2 text-sm font-semibold"><span aria-hidden>{STOCK_LEVELS[s].icon}</span>{STOCK_LEVELS[s].label}</div>
            <div className="mt-1 text-2xl font-bold tabular-nums">{counts[s]}</div>
            <div className="text-sm text-slate-700">product{counts[s] === 1 ? "" : "s"} on sale</div>
          </Link>
        ))}
      </div>
      {list.data && list.data.count > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 font-bold">Needs attention <span className="font-semibold text-warning">({list.data.count})</span></h3>
          <div className="overflow-x-auto"><table className="table">
            <thead><tr><th>Product</th><th className="num">In stock</th><th className="num">Low at</th><th className="num">Critical at</th><th className="num">Suggested order</th></tr></thead>
            <tbody>
              {list.data.results.map((p) => {
                const onHand = Number(p.stock_on_hand);
                const target = Number(p.target_stock ?? 0);
                const level = (v?: string) => (Number(v ?? 0) > 0 ? formatQty(v!) : "—");
                return (
                  <tr key={p.id}>
                    <td className="font-semibold">{p.name} {p.package_size}</td>
                    <td className="num"><StockBadge status={p.stock_status} quantity={p.stock_on_hand} /></td>
                    <td className="num">{level(p.reorder_point)}</td>
                    <td className="num">{level(p.critical_point)}</td>
                    <td className="num">{target > onHand ? formatQty(String(target - onHand)) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
          {list.data.count > list.data.results.length && (
            <p className="mt-2 text-sm text-slate-600">Showing the {list.data.results.length} most urgent of {list.data.count}. <Link className="font-semibold underline" href="/products?stock=ATTENTION">See them all</Link></p>
          )}
        </div>
      )}
    </section>
  );
}

export default function HomePage() {
  const { user } = useAuth();
  const { data, error, loading } = useLoad<CurrentDay>("/day/current/");
  if (!user) return null;
  if (loading && !data) return <Spinner />;
  if (error || !data) return <Alert kind="error">{error}</Alert>;

  const office = user.role !== "CASHIER";
  const { shift, shift_figures: figures, day } = data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold">Hello, {user.display_name}</h1>
        <p className="text-lg text-slate-700">{formatDate(data.today)}</p>
      </div>

      {!data.is_live && (
        <Alert kind="warning">
          The shop is not ready for selling yet.{" "}
          {user.role === "OWNER" ? <Link href="/setup" className="font-semibold underline">Finish the setup steps</Link> : "Ask the Owner to finish the setup."}
        </Alert>
      )}
      {data.day_needs_closing && day && (
        <Alert kind="warning">The day of {formatDate(day.date)} was not closed. It must be closed before a new day can start.</Alert>
      )}

      <section aria-label="Your shift" className="card">
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <h2 className="text-xl font-bold">Your shift</h2>
          {shift ? (
            <StatusBadge status="OPEN" label={`Open since ${new Date(shift.opened_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`} />
          ) : data.closed_shift_today ? (
            <StatusBadge status="CLOSED" label="Closed for today" />
          ) : (
            <StatusBadge status="NOT_STARTED" label="Not started" />
          )}
        </div>
        {shift && figures && (
          <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Your sales today" value={formatTZS(figures.sales_total)} note={`${figures.sale_count} sales`} strong tone="sales" />
            {figures.payments.map((p) => <Stat key={p.method} label={p.name} value={formatTZS(p.amount)}
              note={(p.providers ?? []).length ? (p.providers ?? []).map((x) => `${x.name} ${formatTZS(x.amount)}`).join(" · ") : `${p.count} sales`} />)}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {shift ? (
            <>
              <Link href="/sheet" className="btn-primary btn-big">Daily Sheet</Link>
              <Link href="/sales" className="btn-secondary btn-big">Today&apos;s Sales</Link>
              <Link href="/day/close" className="btn-secondary btn-big">Close Day</Link>
            </>
          ) : data.closed_shift_today ? (
            <>
              <Link href="/sales" className="btn-secondary btn-big">Today&apos;s Sales</Link>
              <p className="self-center text-slate-600 sm:col-span-2">Your day is closed. You can start again tomorrow.</p>
            </>
          ) : (
            <Link href="/day/start" className={`btn-primary btn-big ${data.is_live ? "" : "pointer-events-none opacity-50"}`} aria-disabled={!data.is_live}>
              Start Day
            </Link>
          )}
        </div>
      </section>

      {office && (
        <section aria-label="Shop today" className="card">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <h2 className="text-xl font-bold">Shop today</h2>
            {day ? <StatusBadge status={day.status} label={`Day ${day.status_label.toLowerCase()} · ${formatDate(day.date)}`} /> : <StatusBadge status="NONE" label="No day open" />}
          </div>
          {data.day_figures ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label="Opening cumulative sales" value={formatTZS(data.day_figures.opening_cumulative_sales)} note={day?.opening_changes.length ? "Changed by the Owner" : "Carried from the last closed day"} />
              <Stat label="Net sales today (so far)" value={formatTZS(data.day_figures.net_sales)} note={`${data.day_figures.sale_count} sales`} strong tone="sales" />
              <Stat label="Cumulative sales (so far)" value={formatTZS(data.day_figures.closing_cumulative_sales)} note="Opening + today's net sales. Not cash." />
            </div>
          ) : (
            <p className="text-slate-600">
              No business day is open. The next day will open with a cumulative sales balance of{" "}
              <span className="font-semibold">{formatTZS(data.next_opening_cumulative_sales)}</span>.
            </p>
          )}
          <div className="mt-5 flex flex-wrap gap-3">
            <Link href="/closing" className="btn-secondary">Daily Closing</Link>
            <Link href="/payments" className="btn-secondary">Payments</Link>
            <Link href="/products" className="btn-secondary">Products</Link>
            <Link href="/stock" className="btn-secondary">Stock</Link>
            {user.role === "OWNER" && <Link href="/users" className="btn-secondary">Users</Link>}
          </div>
        </section>
      )}
      {office && <StockValueCard />}
      {office && <DashboardInsights today={data.today} />}
      {office && <StockLevels />}
    </div>
  );
}
