"use client";

import Link from "next/link";

import { Alert, Spinner, Stat, StatusBadge } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { formatDate, formatTZS } from "@/lib/money";
import type { CurrentDay } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

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
            <Stat label="Your sales today" value={formatTZS(figures.sales_total)} note={`${figures.sale_count} sales`} strong />
            {figures.payments.map((p) => <Stat key={p.method} label={p.name} value={formatTZS(p.amount)} note={`${p.count} sales`} />)}
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
              <Stat label="Opening cumulative sales" value={formatTZS(data.day_figures.opening_cumulative_sales)} note="Carried from the last closed day" />
              <Stat label="Net sales today (so far)" value={formatTZS(data.day_figures.net_sales)} note={`${data.day_figures.sale_count} sales`} strong />
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
            <Link href="/products" className="btn-secondary">Products</Link>
            <Link href="/stock" className="btn-secondary">Stock</Link>
            {user.role === "OWNER" && <Link href="/users" className="btn-secondary">Users</Link>}
          </div>
        </section>
      )}
    </div>
  );
}
