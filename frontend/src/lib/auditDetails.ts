/** Turns the before/after values of an Audit History entry into words for the Details view. */

import { formatDate, formatQty, formatTime, formatTZS } from "@/lib/money";

export type AuditEntry = {
  id: number; created_at: string; actor_username: string; action: string; entity_type: string; entity_id: string;
  summary: string; reason: string; before: unknown; after: unknown;
  // Sent by the server: names of the products the entry refers to by id, and the meaning of the record's status codes.
  product_names: Record<string, string>; status_labels: Record<string, string>;
};

const RECORDS: Record<string, string> = {
  Product: "Product", SourceProduct: "Excel product line", User: "User account", Sale: "Sale", OpeningCount: "Stock count",
  CashierShift: "Cashier shift", HistoricalRecord: "Excel sheet line", BusinessDay: "Business day", StockAdjustment: "Stock adjustment",
  GoodsReceipt: "Stock received", ReviewItem: "Excel History question", BusinessSettings: "Shop settings",
  ReceiptImport: "Received stock upload", Supplier: "Supplier", ImportBatch: "Excel import", Refund: "Refund", Expense: "Expense",
  PaymentMethod: "Payment method",
};

const LABELS: Record<string, string> = {
  status: "Status", cash_variance: "Cash difference", counted_cash: "Cash counted", expected_cash: "Cash expected",
  opening_float: "Opening float", selling_price: "Selling price", cost_price: "Purchase price", amount: "Amount", total: "Total",
  total_cost: "Total cost", net_sales: "Net sales", sales_total: "Sales total", profit: "Profit", approved_profit: "Approved profit",
  opening_cumulative_sales: "Opening cumulative sales", closing_cumulative_sales: "Closing cumulative sales",
  prepared_figure: "Figure prepared", prepared_by: "Prepared by", as_of: "As of", new_baseline: "Starts from zero",
  is_active: "On sale", base_unit: "Sold by", bottles_per_unit: "Bottles per unit", reorder_point: "Low-stock level",
  target_stock: "Target stock", sku: "SKU", items: "Number of items", payments: "Payments", quantities: "Quantities",
  lines: "Quantities", products: "Quantities added", restocked: "Put back in stock", not_restocked: "Lines not put back in stock",
  confirmed_package_size: "Confirmed package size", resolution: "Decision", resolution_label: "Decision",
  identities: "Products confirmed", approved_prices: "Prices approved", opening_stock_complete: "All opening counts approved",
  carried_from: "Carried over from", receipts: "Deliveries recorded", skipped_rows: "Excel rows skipped",
  excluded_rows: "Excel rows left out", corrections: "Corrections by Excel row", duplicates: "Duplicate decisions",
  earlier_import: "Replaces upload", method: "Payment method", price_type: "Price type", effective_date: "Applies from",
  source_name: "Name on the sheet", date_from: "From", date_to: "To", worksheets: "Sheets", product_rows: "Product lines",
  records_stored: "Lines stored", source_products: "Product names", exceptions: "Questions found",
  material_exceptions: "Questions for the Owner", workbook_total_sales: "Total sales in the workbook",
  workbook_units_sold: "Units sold in the workbook",
};

// Left to "Technical details".
const TECHNICAL = new Set(["file_hash", "batch"]);

const MONEY = new Set([
  "amount", "approved_profit", "cash_variance", "closing_cumulative_sales", "cost_price", "counted_cash", "expected_cash", "net_sales",
  "opening_cumulative_sales", "opening_float", "prepared_figure", "profit", "sales_total", "selling_price", "total", "total_cost",
  "workbook_total_sales",
]);
const CODES = new Set(["resolution", "price_type", "role", "confirmed_unit", "base_unit", "method"]);
// Maps of product id to quantity.
export const QUANTITY_MAPS = new Set(["quantities", "lines", "products", "restocked"]);
// Records whose whole before/after is a map of product id to quantity.
const PRODUCT_KEYED = new Set(["StockAdjustment", "OpeningCount"]);

export function words(code: string): string {
  const text = code.replace(/_/g, " ").trim().toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const fieldLabel = (key: string) => LABELS[key] ?? words(key);

export function recordLabel(entry: AuditEntry): string {
  if (!entry.entity_type) return "";
  return `${RECORDS[entry.entity_type] ?? words(entry.entity_type)}${entry.entity_id ? ` no. ${entry.entity_id}` : ""}`;
}

export function productName(entry: AuditEntry, id: string | number): string {
  return entry.product_names?.[String(id)] ?? `Product no. ${id}`;
}

/** A single value in words, or "" when it is a map or a list of records (shown as a list instead). */
export function plainValue(key: string, value: unknown, entry: AuditEntry): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (key === "cash_variance") {
    const cents = Math.round(Number(value) * 100);
    return cents === 0 ? "None: the cash matched" : `${formatTZS(Math.abs(cents), true)} ${cents > 0 ? "over" : "short"}`;
  }
  if (MONEY.has(key)) return formatTZS(value as string);
  if (key === "status") return entry.status_labels?.[String(value)] ?? words(String(value));
  if (key === "product") return productName(entry, value as number);
  if (CODES.has(key)) return words(String(value));
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return `${formatDate(value)} ${formatTime(value)}`;
  if (typeof value === "string" && /^-?\d+\.\d+$/.test(value)) return formatQty(value);
  if (Array.isArray(value) && value.every((v) => v === null || typeof v !== "object")) return value.length ? value.join(", ") : "None";
  return typeof value === "object" ? "" : String(value);
}

export type Row = { key: string; label: string; before?: unknown; after?: unknown; changed: boolean };

/** The rows of the Details table. `both` is false when the entry recorded only one side. */
export function changeRows(entry: AuditEntry): { rows: Row[]; both: boolean; side: "Before" | "Recorded" } {
  const asMap = (side: unknown) => (side && typeof side === "object" && !Array.isArray(side) ? (side as Record<string, unknown>) : null);
  const group = (side: Record<string, unknown> | null) => {
    if (!side || !PRODUCT_KEYED.has(entry.entity_type)) return side;
    const ids = Object.keys(side).filter((k) => /^\d+$/.test(k));
    if (!ids.length) return side;
    const rest = Object.fromEntries(Object.entries(side).filter(([k]) => !ids.includes(k)));
    return { ...rest, quantities: Object.fromEntries(ids.map((k) => [k, side[k]])) };
  };
  const before = group(asMap(entry.before)), after = group(asMap(entry.after));
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].filter((k) => !TECHNICAL.has(k));
  const rows = keys.map((key) => ({
    key, label: fieldLabel(key), before: before?.[key], after: after?.[key],
    changed: before !== null && after !== null && JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  }));
  return { rows, both: before !== null && after !== null, side: before && !after ? "Before" : "Recorded" };
}
