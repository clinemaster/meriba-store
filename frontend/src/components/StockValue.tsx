"use client";

import { formatDate, formatTZS } from "@/lib/money";

/** The money value of the stock for one day, at selling prices, as worked out on the server (trading/sheet.py). */
export type StockValueStatement = {
  date: string; source: "LIVE" | "CLOSED";
  previous_date: string | null; previous_value: string | null; price_changes: string | null;
  opening_value: string; deliveries: string; sales: string; other: string; closing_value: string;
};

const signed = (value: string) => `${Number(value) < 0 ? "−" : "+"} ${formatTZS(String(Math.abs(Number(value))))}`;

/**
 * Yesterday's stock value, less the day's sales, = the stock value now. Deliveries, returns and counts, and price
 * changes are shown on their own lines only when they happened, so the sum can always be followed.
 */
export function StockValue({ value, compact = false }: { value: StockValueStatement; compact?: boolean }) {
  const live = value.source === "LIVE";
  const rows: [string, string, boolean?][] = [];
  if (value.previous_value !== null) {
    rows.push([`Stock value at the close of ${formatDate(value.previous_date!)}`, formatTZS(value.previous_value)]);
    if (Number(value.price_changes)) rows.push(["Selling prices changed since then", signed(value.price_changes!)]);
  } else {
    rows.push(["Stock value at the start of the day", formatTZS(value.opening_value)]);
  }
  if (Number(value.deliveries)) rows.push(["Deliveries received", signed(value.deliveries)]);
  rows.push([live ? "Sales today so far" : "Sales of the day", `− ${formatTZS(value.sales)}`, true]);
  if (Number(value.other)) rows.push(["Returns, stock counts and breakages", signed(value.other)]);

  return (
    <div>
      <table className={`table ${compact ? "" : "max-w-2xl"}`}>
        <caption className="sr-only">Stock value for {formatDate(value.date)}, at selling prices</caption>
        <tbody>
          {rows.map(([label, amount, strong]) => (
            <tr key={label}><td>{label}</td><td className={`num ${strong ? "font-semibold" : ""}`}>{amount}</td></tr>
          ))}
          <tr className="border-t-2 border-slate-400 text-lg font-bold">
            <td>{live ? "Stock value now" : `Stock value at the close of ${formatDate(value.date)}`}</td>
            <td className="num">{formatTZS(value.closing_value)}</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-sm text-slate-600">
        Valued at selling prices, as the Stock column of the Excel sheet: Closing stock × Sales price, added up. Quantities of
        bottles and crates are counted separately and are not changed by this.
      </p>
    </div>
  );
}

//