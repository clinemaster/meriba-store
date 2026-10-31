"use client";

import { useEffect, useState } from "react";

import { Alert, Spinner } from "@/components/ui";
import { formatDate, formatTZS } from "@/lib/money";
import { useLoad } from "@/lib/useLoad";

type Report = {
  rows: Record<string, string | number | null>[];
};

const PROFIT_PREVIEW_COUNT = 5;

// Starts empty and grows to its width once painted, so bars animate in on every dashboard visit.
function AnimatedBar({ width, color, index, barColor }: { width: number; color: string; index: number; barColor?: string }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(width));
    return () => cancelAnimationFrame(frame);
  }, [width]);
  return (
    <div
      className={`h-full rounded transition-[width] duration-700 ease-out motion-reduce:transition-none ${color}`}
      style={{ width: `${shown}%`, transitionDelay: `${Math.min(index, 10) * 60}ms`, backgroundColor: barColor }}
    />
  );
}

function shiftDate(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function monthStart(value: string): string {
  return `${value.slice(0, 7)}-01`;
}

function chartBarColor(index: number): string {
  return `hsl(${(index * 137.508) % 360} 68% 38%)`;
}

function SalesTrend({ report }: { report: ReturnType<typeof useLoad<Report>> }) {
  if (report.loading && !report.data) return <Spinner />;
  if (report.error) return <Alert kind="error">{report.error}</Alert>;
  const rows = report.data?.rows ?? [];
  if (rows.length === 0) return <p className="text-ink-muted">No business-day sales recorded in the last seven days.</p>;

  const peak = Math.max(...rows.map((row) => Math.abs(Number(row.net_sales) || 0)), 1);
  return (
    <div className="space-y-3" aria-label="Net sales for the last seven days">
      {rows.map((row, index) => {
        const value = Number(row.net_sales) || 0;
        const width = Math.max(Math.abs(value) / peak * 100, value === 0 ? 0 : 2);
        return (
          <div key={String(row.date)} className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-3 text-sm">
            <span className="text-ink-muted">{new Date(`${row.date}T00:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit" })}</span>
            <div className="h-5 overflow-hidden rounded bg-neutral-soft" aria-hidden="true">
              <AnimatedBar width={width} color="" index={index} barColor={chartBarColor(index)} />
            </div>
            <span className={`text-right font-semibold tabular-nums ${value < 0 ? "text-danger" : ""}`}>{formatTZS(value)}</span>
          </div>
        );
      })}
    </div>
  );
}

function ProfitByProduct({ report }: { report: ReturnType<typeof useLoad<Report>> }) {
  const [showAll, setShowAll] = useState(false);
  if (report.loading && !report.data) return <Spinner />;
  if (report.error) return <Alert kind="error">{report.error}</Alert>;
  const rows = report.data?.rows ?? [];
  const unknownCostCount = rows.filter((row) => row.gross_profit === null || row.gross_profit === "").length;
  const known = rows
    .filter((row) => row.gross_profit !== null && row.gross_profit !== "")
    .sort((a, b) => Number(b.gross_profit) - Number(a.gross_profit));
  const peak = Math.max(...known.map((row) => Math.abs(Number(row.gross_profit) || 0)), 1);
  const visible = showAll ? known : known.slice(0, PROFIT_PREVIEW_COUNT);

  return (
    <div className="space-y-3">
      {unknownCostCount > 0 && (
        <Alert kind="warning">Profit is unavailable for {unknownCostCount} product(s) because cost data is incomplete; those products are not included below.</Alert>
      )}
      {known.length === 0 ? (
        <p className="text-ink-muted">No sales with complete cost data for this period.</p>
      ) : (
        <div className="space-y-3" aria-label="Gross profit by product, known costs only">
          {visible.map((row, index) => {
            const value = Number(row.gross_profit) || 0;
            const width = Math.max(Math.abs(value) / peak * 100, value === 0 ? 0 : 2);
            return (
              <div key={String(row.code)} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 text-sm">
                <span className="truncate font-medium" title={String(row.product ?? "")}>{String(row.product ?? row.code ?? "Product")}</span>
                <span className={`text-right font-semibold tabular-nums ${value < 0 ? "text-danger" : ""}`}>{formatTZS(value)}{value < 0 && " (loss)"}</span>
                <div className="col-span-2 h-3 overflow-hidden rounded bg-neutral-soft" aria-hidden="true">
                  <AnimatedBar width={width} color="" index={index} barColor={chartBarColor(index)} />
                </div>
              </div>
            );
          })}
        </div>
      )}
      {known.length > PROFIT_PREVIEW_COUNT && (
        <button type="button" className="text-sm font-semibold text-brand-700 underline" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
          {showAll ? "Show fewer" : `Show all ${known.length} products`}
        </button>
      )}
    </div>
  );
}

export function DashboardInsights({ today }: { today: string }) {
  const from = shiftDate(today, -6);
  const sales = useLoad<Report>(`/reports/daily-sales/?date_from=${from}&date_to=${today}`);
  const profit = useLoad<Report>(`/reports/sales-by-product/?date_from=${monthStart(today)}&date_to=${today}`);

  return (
    <section aria-label="Sales and profit insights" className="grid gap-4 lg:grid-cols-2">
      <div className="card space-y-4">
        <div>
          <h2 className="text-xl font-bold">Net sales trend</h2>
          <p className="text-sm text-ink-muted">Last seven days ending {formatDate(today)}</p>
        </div>
        <SalesTrend report={sales} />
      </div>
      <div className="card space-y-4">
        <div>
          <h2 className="text-xl font-bold">Gross profit by product</h2>
          <p className="text-sm text-ink-muted">Month to date, highest first, products with recorded costs only</p>
        </div>
        <ProfitByProduct report={profit} />
      </div>
    </section>
  );
}
