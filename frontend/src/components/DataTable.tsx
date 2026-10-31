"use client";

import { useMemo, useState, type ButtonHTMLAttributes, type ReactNode } from "react";

import { Alert, Spinner } from "@/components/ui";
import { alignOf, cellContent, nextOrdering, parseOrdering, sortRows, type TableColumn } from "@/lib/table";
import type { ColumnVisibility } from "@/lib/useColumnVisibility";

/**
 * The one table used across MERIBA. Pages give it their columns and rows and keep their own business rules;
 * it draws the headings, cells, sorting, row actions, totals and the loading, problem and empty states the same way everywhere.
 *
 * Sorting: pass `sort` when the server sorts (the page sends `ordering` to the API and keeps paging right);
 * otherwise sortable columns are sorted here, which suits tables that load every row at once.
 */
export type DataTableProps<T> = {
  /** Names the table for screen readers, e.g. "Products". */
  label: string;
  columns: TableColumn<T>[];
  /** From useColumnVisibility: the person's chosen columns and order. Without it every column shows in the table's order. */
  visibility?: ColumnVisibility<TableColumn<T>>;
  rows: T[] | undefined;
  rowKey: (row: T) => string | number;
  loading?: boolean;
  error?: string | null;
  /** What to say when there are no rows. */
  empty?: ReactNode;
  sort?: { ordering: string; onSort: (ordering: string) => void };
  /** Starting order for sorting done here, e.g. "name" or "-date". */
  defaultOrdering?: string;
  /** The row's buttons. Use ActionButton; they are laid out side by side at the end of the row. */
  actions?: (row: T) => ReactNode;
  actionsLabel?: string;
  rowClassName?: (row: T) => string;
  /** A totals row. `values` are keyed by column; the label fills the columns before the first total. */
  totals?: { label: ReactNode; values: Partial<Record<string, ReactNode>> };
  className?: string;
};

const ALIGN = { left: "", center: "text-center", right: "num" } as const;

export function DataTable<T>({
  label, columns, visibility, rows, rowKey, loading = false, error = null, empty = "Nothing to show.",
  sort, defaultOrdering = "", actions, actionsLabel = "Actions", rowClassName, totals, className = "",
}: DataTableProps<T>) {
  const [localOrdering, setLocalOrdering] = useState(defaultOrdering);
  const ordering = sort ? sort.ordering : localOrdering;
  const onSort = (key: string) => (sort ? sort.onSort(nextOrdering(sort.ordering, key)) : setLocalOrdering((o) => nextOrdering(o, key)));

  // Hidden columns are left out entirely: no heading, no cell, nothing worked out for them.
  const shown = useMemo(
    () => (visibility ? visibility.ordered.filter((c) => visibility.show(c.key)) : columns),
    [visibility, columns],
  );
  const sorted = useMemo(
    () => (sort || !rows ? rows ?? [] : sortRows(rows, columns, localOrdering)),
    [sort, rows, columns, localOrdering],
  );

  if (loading) return <Spinner />;
  if (error) return <Alert kind="error">{error}</Alert>;
  if (sorted.length === 0) return <p className="p-4 text-slate-600">{empty}</p>;

  const active = parseOrdering(ordering);
  const width = actions ? shown.length + 1 : shown.length;

  return (
    // `relative` keeps the screen-reader-only heading text inside the scroll box; without it, it can widen the whole page on a phone.
    <div className="relative overflow-x-auto">
      <table className={`table ${className}`} aria-label={label}>
        <thead>
          <tr>
            {shown.map((c) => {
              const key = c.sortKey ?? c.key;
              const on = !!ordering && active.key === key;
              return (
                <th key={c.key} scope="col" className={`whitespace-nowrap ${ALIGN[alignOf(c)]}`.trim()} style={{ width: c.width, minWidth: c.minWidth, maxWidth: c.maxWidth }}
                  aria-sort={!c.sortable ? undefined : !on ? "none" : active.desc ? "descending" : "ascending"}>
                  {c.sortable ? (
                    <button type="button" className="th-sort" title={c.help ? `${c.help}. Press to sort.` : "Press to sort."} onClick={() => onSort(key)}>
                      {c.label}<span aria-hidden>{on ? (active.desc ? " ▼" : " ▲") : ""}</span>
                    </button>
                  ) : c.help ? <span title={c.help}>{c.label}</span> : c.label}
                </th>
              );
            })}
            {actions && <th scope="col" className="text-right"><span className="sr-only">{actionsLabel}</span></th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr key={rowKey(row)} className={rowClassName?.(row)}>
              {shown.map((c) => {
                const extra = typeof c.className === "function" ? c.className(row) : c.className ?? "";
                return <td key={c.key} className={`${ALIGN[alignOf(c)]} ${extra}`.trim() || undefined} style={c.maxWidth ? { maxWidth: c.maxWidth } : undefined}>{cellContent(c, row)}</td>;
              })}
              {actions && <td className="actions-cell"><div className="row-actions">{actions(row)}</div></td>}
            </tr>
          ))}
        </tbody>
        {totals && <TotalsFooter shown={shown} totals={totals} width={width} trailing={!!actions} />}
      </table>
    </div>
  );
}

function TotalsFooter<T>({ shown, totals, width, trailing }: {
  shown: TableColumn<T>[]; totals: NonNullable<DataTableProps<T>["totals"]>; width: number; trailing: boolean;
}) {
  const lead = shown.findIndex((c) => c.key in totals.values);
  const labelRow = <tr className="font-bold"><td colSpan={width}>{totals.label}</td></tr>;
  // No total column showing, or the first one is the first column: the label gets its own row.
  if (lead === -1) return <tfoot>{labelRow}</tfoot>;
  return (
    <tfoot>
      {lead === 0 && labelRow}
      <tr className="font-bold">
        {lead > 0 && <td colSpan={lead}>{totals.label}</td>}
        {shown.slice(lead).map((c) => <td key={c.key} className={ALIGN[alignOf(c)] || undefined}>{totals.values[c.key] ?? ""}</td>)}
        {trailing && <td />}
      </tr>
    </tfoot>
  );
}

/** Above a table: what is showing on the left; the column picker and downloads together on the right. */
export function TableToolbar({ summary, children }: { summary?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div className="text-slate-700">{summary}</div>
      {children && <div className="no-print ml-auto flex flex-wrap items-center gap-1">{children}</div>}
    </div>
  );
}

/** Download links for the server's exports. The server builds the file, so it always holds every row the filters cover. */
export function ExportLinks({ links }: { links: { label: string; href: string }[] }) {
  return <>{links.map((l) => <a key={l.href} className="btn-sm" href={l.href}>{l.label}</a>)}</>;
}

export function Pagination({ page, pages, onPage, label = "Pages" }: { page: number; pages: number; onPage: (page: number) => void; label?: string }) {
  if (pages <= 1) return null;
  return (
    <nav aria-label={label} className="no-print mt-2 flex items-center justify-end gap-2">
      <button type="button" className="btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
      <span className="text-sm">Page {page} of {pages}</span>
      <button type="button" className="btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    </nav>
  );
}

const TONE = { default: "btn-table", primary: "btn-table btn-table-primary", danger: "btn-table btn-table-danger" } as const;

/** A compact button for a table row. Give it a label that names the row when the text alone is vague (aria-label). */
export function ActionButton({ tone = "default", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: keyof typeof TONE }) {
  return <button type="button" className={`${TONE[tone]} ${className}`.trim()} {...props} />;
}
