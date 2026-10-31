/**
 * The shared column definition used by every DataTable, kept free of React drawing so the rules can be tested alone.
 * It builds on ColumnDef (key, label, essential, defaultHidden), so the column picker and saved preferences work unchanged.
 * Business rules stay in each page: a column only says where its value comes from and how it is shown.
 */
import type { ReactNode } from "react";

import type { ColumnDef } from "./columns";
import { formatDate, formatQty, formatTime, formatTZS } from "./money";

/**
 * - `currency`: "TZS 1,500"; `amount`: money as a bare number "1,500" (for tables that say TZS once, in the heading)
 * - `quantity`: up to 3 decimals; `number`: as given, right-aligned
 */
export type ColumnType = "text" | "number" | "currency" | "amount" | "quantity" | "date" | "time" | "status";

export type Align = "left" | "center" | "right";

export type TableColumn<T> = ColumnDef & {
  type?: ColumnType;
  /** A field of the row, or a function that reads the value. Defaults to the field named by `key`. Used for sorting and formatting. */
  accessor?: keyof T | ((row: T) => unknown);
  /** Draws the cell. When missing, the value is formatted by `format` or by `type`. */
  render?: (row: T) => ReactNode;
  format?: (value: unknown, row: T) => ReactNode;
  align?: Align;
  /** Offers sorting on this column. With server sorting, `sortKey` is what the server sorts by (defaults to `key`). */
  sortable?: boolean;
  sortKey?: string;
  /** Shown as the heading's tooltip and in "What do the columns mean?" lists. */
  help?: string;
  /** Extra classes for this column's cells, fixed or per row (e.g. strike-through on a cancelled amount). */
  className?: string | ((row: T) => string);
  /** Widths in CSS units. Leave them out to let the content decide, which avoids empty space. */
  width?: string;
  minWidth?: string;
  maxWidth?: string;
};

const NUMERIC: ColumnType[] = ["number", "currency", "amount", "quantity"];

export function isNumeric<T>(column: TableColumn<T>): boolean {
  return NUMERIC.includes(column.type ?? "text");
}

/** Numbers right, everything else left, unless the column says otherwise. */
export function alignOf<T>(column: TableColumn<T>): Align {
  return column.align ?? (isNumeric(column) ? "right" : "left");
}

export function valueOf<T>(column: TableColumn<T>, row: T): unknown {
  const accessor = column.accessor ?? (column.key as keyof T);
  return typeof accessor === "function" ? accessor(row) : row[accessor];
}

/** Money with no "TZS" in front: the number only. */
export function formatAmount(value: string | number | null | undefined): string {
  return formatTZS(value).replace("TZS ", "");
}

export function formatValue(type: ColumnType | undefined, value: unknown): string {
  if (value === null || value === undefined || value === "") return type && NUMERIC.includes(type) ? "—" : "";
  switch (type) {
    case "currency": return formatTZS(value as string | number);
    case "amount": return formatAmount(value as string | number);
    case "quantity": return formatQty(value as string | number);
    case "number": return typeof value === "number" ? value.toLocaleString("en-US") : String(value);
    case "date": return formatDate(String(value));
    case "time": return formatTime(String(value));
    default: return String(value);
  }
}

export function cellContent<T>(column: TableColumn<T>, row: T): ReactNode {
  if (column.render) return column.render(row);
  const value = valueOf(column, row);
  return column.format ? column.format(value, row) : formatValue(column.type, value);
}

/* Sorting. The server's `ordering` parameter is "name" for A→Z and "-name" for Z→A; client sorting uses the same form. */

export type Ordering = { key: string; desc: boolean };

export function parseOrdering(ordering: string): Ordering {
  return ordering.startsWith("-") ? { key: ordering.slice(1), desc: true } : { key: ordering, desc: false };
}

/** Pressing a heading sorts by it; pressing it again reverses the order. */
export function nextOrdering(current: string, key: string): string {
  return current === key ? `-${key}` : key;
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === "";

function compare(a: unknown, b: unknown, numeric: boolean): number {
  if (numeric) return Number(a) - Number(b);
  return String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
}

/** Sorts a copy of the rows; ties keep their original order. Empty values always go last. */
export function sortRows<T>(rows: T[], columns: TableColumn<T>[], ordering: string): T[] {
  if (!ordering) return rows;
  const { key, desc } = parseOrdering(ordering);
  const column = columns.find((c) => (c.sortKey ?? c.key) === key);
  if (!column) return rows;
  const numeric = isNumeric(column);
  return rows
    .map((row, i) => ({ row, i, v: valueOf(column, row) }))
    .sort((x, y) => {
      if (isEmpty(x.v) !== isEmpty(y.v)) return isEmpty(x.v) ? 1 : -1;
      if (isEmpty(x.v)) return x.i - y.i;
      const c = compare(x.v, y.v, numeric);
      return (desc ? -c : c) || x.i - y.i;
    })
    .map((x) => x.row);
}
