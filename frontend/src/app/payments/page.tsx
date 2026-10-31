"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { PaymentCategoryCards, PaymentMetricCards, PaymentTrendChart } from "@/components/PaymentSummary";
import { Alert, PageTitle, Spinner } from "@/components/ui";
import { useAuth } from "@/lib/auth";
import { formatDate } from "@/lib/money";
import { paymentQuery, periodPresets, readPaymentQuery, type TransactionQuery } from "@/lib/payments";
import type { CurrentDay, PaymentSummary } from "@/lib/types";
import { useLoad } from "@/lib/useLoad";

/**
 * Payments: what was collected by category and provider, beside the sales it should match. Every figure comes from
 * the server's totals of the recorded payments; each card opens the list of payments behind it with the same filters.
 */
export default function PaymentsPage() {
  const { user } = useAuth();
  const office = user?.role !== "CASHIER";
  const current = useLoad<CurrentDay>("/day/current/");
  const [q, setQ] = useState<TransactionQuery | null>(null);
  const [group, setGroup] = useState<"day" | "week" | "month">("day");

  // The filters live in the address, so a link, a refresh or Back shows the same figures.
  useEffect(() => {
    if (q || !current.data) return;
    const params = new URLSearchParams(window.location.search);
    const g = params.get("group");
    if (g === "week" || g === "month") setGroup(g);
    setQ(readPaymentQuery(params, current.data.day?.date ?? current.data.today));
  }, [current.data, q]);
  const query = q ? paymentQuery({ ...q, category: null, provider: null, kind: "payment", status: "collected", search: "", page: 1 }, group === "day" ? {} : { group }) : null;
  useEffect(() => {
    if (query !== null) window.history.replaceState(window.history.state, "", `/payments?${query}`);
  }, [query]);

  const summary = useLoad<PaymentSummary>(query !== null ? `/payment-summary/?${query}` : null);
  const palette = useMemo(() => (summary.data?.categories ?? []).map((c) => c.id!), [summary.data]);
  const presets = periodPresets(current.data?.today ?? "");
  const badDates = !!q && (!q.from || !q.to || q.from > q.to);
  const set = (change: Partial<TransactionQuery>) => setQ((was) => (was ? { ...was, ...change } : was));

  if (!q || (current.loading && !current.data)) return <Spinner />;
  const data = summary.data;

  return (
    <div className="space-y-6">
      <PageTitle title="Payments" help={office
        ? "Money collected by cash, each mobile money provider and each bank, beside the sales it must match. Click any figure to see the payments behind it."
        : "Your own payments: cash, mobile money and bank. Click any figure to see the payments behind it."}
        action={office ? <Link href="/settings/payment-methods" className="btn-secondary">Payment methods</Link> : undefined} />

      <section className="card no-print space-y-3" aria-label="Filters">
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <button key={p.key} type="button" aria-pressed={q.from === p.from && q.to === p.to} onClick={() => set({ from: p.from, to: p.to })}
              className={`btn min-h-[2.5rem] border-2 ${q.from === p.from && q.to === p.to ? "border-brand-700 bg-brand-600 text-white" : "border-slate-300 bg-white"}`}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="block"><span className="mb-1 block font-semibold">From</span>
            <input type="date" className="input" value={q.from} max={q.to} onChange={(e) => set({ from: e.target.value })} /></label>
          <label className="block"><span className="mb-1 block font-semibold">To</span>
            <input type="date" className="input" value={q.to} min={q.from} onChange={(e) => set({ to: e.target.value })} /></label>
          {office && data?.options.cashiers && (
            <label className="block"><span className="mb-1 block font-semibold">Cashier</span>
              <select className="input" value={q.cashier ?? ""} onChange={(e) => set({ cashier: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Everyone</option>
                {data.options.cashiers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></label>
          )}
          {(data?.options.branches.length ?? 0) > 1 && (
            <label className="block"><span className="mb-1 block font-semibold">Branch</span>
              <select className="input" value={q.branch ?? ""} onChange={(e) => set({ branch: e.target.value ? Number(e.target.value) : null })}>
                <option value="">All branches</option>
                {data!.options.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select></label>
          )}
          <label className="block"><span className="mb-1 block font-semibold">Chart by</span>
            <select className="input" value={group} onChange={(e) => setGroup(e.target.value as typeof group)}>
              <option value="day">Day</option><option value="week">Week</option><option value="month">Month</option>
            </select></label>
        </div>
      </section>

      {badDates ? <Alert kind="error">Choose a “From” date that is on or before the “To” date.</Alert>
        : summary.error ? <Alert kind="error">{summary.error}</Alert>
        : !data ? <SummarySkeleton /> : (
        <>
          <p className="text-slate-700" aria-live="polite">
            {q.from === q.to ? formatDate(q.from) : `${formatDate(q.from)} to ${formatDate(q.to)}`}
            {summary.loading && <span className="ml-2 text-sm text-slate-500">Updating…</span>}
          </p>
          {office && (data.unassigned_total ?? 0) > 0 && (
            <Alert kind="warning">
              {data.unassigned_total} earlier mobile money or bank payment{data.unassigned_total === 1 ? " was" : "s were"} recorded before providers existed and
              show as “Provider not recorded”. They were not guessed. Open that line under the category to record the provider from the phone or bank statement.
            </Alert>
          )}
          {(!data.checks.providers_match_categories || !data.checks.categories_match_total) && (
            <Alert kind="error">The category and provider totals do not add up. Please report this; nothing should be closed until it is checked.</Alert>
          )}
          <PaymentMetricCards metrics={data.metrics} categories={data.categories} query={q}
            reportsHref={office ? (key) => `/reports?key=${key}&date_from=${q.from}&date_to=${q.to}` : undefined} />

          <section aria-label="By category and provider">
            <h2 className="mb-3 text-xl font-bold">By category and provider</h2>
            <PaymentCategoryCards categories={data.categories} query={q} palette={palette} />
          </section>

          <section className="card" aria-label="Payment trend">
            <h2 className="mb-3 text-xl font-bold">Payments collected per {group}</h2>
            <PaymentTrendChart summary={data} palette={palette} />
          </section>

          {office && (
            <section className="card text-sm text-slate-700" aria-label="How the figures are worked out">
              <h2 className="mb-2 text-base font-bold">How these figures are worked out</h2>
              <ul className="list-disc space-y-1 pl-5">
                <li>Net sales = gross sales − cancelled sales − refunds + Owner corrections (the same rule as Daily Closing).</li>
                <li>Payments collected = money kept from sales of these days that were not cancelled. Each category equals the sum of its providers.</li>
                <li>Net collections = payments collected − refunds paid. Refunds count on the day they are paid, for sales of any day.</li>
                <li>Reconciliation difference = net collections − (net sales − corrections − outstanding credit). It should be 0.</li>
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function SummarySkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading the payment figures">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => <div key={i} className="h-24 animate-pulse rounded-lg bg-slate-200" />)}
      </div>
      <div className="grid gap-3 md:grid-cols-3">{Array.from({ length: 3 }, (_, i) => <div key={i} className="h-40 animate-pulse rounded-lg bg-slate-200" />)}</div>
    </div>
  );
}
