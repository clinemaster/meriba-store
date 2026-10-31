/**
 * Column visibility rules, kept free of React so they can be tested on their own.
 * Hiding a column only changes what is drawn: the rows, the API responses and the CSV downloads are never touched.
 */
export type ColumnDef = {
  key: string;
  label: string;
  /** Always shown and never offered as a choice (for example the product name that identifies a row). */
  essential?: boolean;
  /** Hidden until the person turns it on, when the table's own configuration says so. */
  defaultHidden?: boolean;
};

const PREFIX = "meriba.columns.v1";

/** One preference per person per table, so two users on one computer never share a choice. */
export function storageKey(userId: number | string, tableId: string): string {
  return `${PREFIX}.${userId}.${tableId}`;
}

export function defaultHidden(defs: ColumnDef[]): string[] {
  return defs.filter((d) => d.defaultHidden && !d.essential).map((d) => d.key);
}

/**
 * Makes any stored list safe to use: unknown columns (the table changed since it was saved) are dropped,
 * essential columns can never be hidden, and at least one column always stays visible.
 */
export function sanitizeHidden(defs: ColumnDef[], hidden: unknown): string[] {
  if (!Array.isArray(hidden)) return defaultHidden(defs);
  const known = new Map(defs.map((d) => [d.key, d]));
  const keys = [...new Set(hidden.filter((k): k is string => typeof k === "string"))].filter((k) => known.has(k) && !known.get(k)!.essential);
  if (defs.length > 0 && keys.length >= defs.length) return keys.slice(1);
  return keys;
}

export function visibleKeys(defs: ColumnDef[], hidden: string[]): string[] {
  return defs.filter((d) => !hidden.includes(d.key)).map((d) => d.key);
}

/** A column can be switched off unless it is essential or it is the last one still showing. */
export function canToggle(defs: ColumnDef[], hidden: string[], key: string): boolean {
  const def = defs.find((d) => d.key === key);
  if (!def || def.essential) return false;
  if (hidden.includes(key)) return true;
  return visibleKeys(defs, hidden).length > 1;
}

export function toggleHidden(defs: ColumnDef[], hidden: string[], key: string): string[] {
  if (!canToggle(defs, hidden, key)) return hidden;
  return hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key];
}

export function isDefault(defs: ColumnDef[], hidden: string[]): boolean {
  const base = defaultHidden(defs);
  return base.length === hidden.length && base.every((k) => hidden.includes(k));
}

export function loadHidden(storage: Pick<Storage, "getItem"> | null, key: string): unknown {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveHidden(storage: Pick<Storage, "setItem" | "removeItem"> | null, key: string, hidden: string[] | null): void {
  if (!storage) return;
  try {
    if (hidden === null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(hidden));
  } catch {
    // Storage can be full or blocked (private browsing). The choice still applies until the page is closed.
  }
}

/* Column order. Stored apart from the hidden list (its own key), so preferences saved before ordering existed still load. */

const ORDER_PREFIX = "meriba.columnorder.v1";

export function orderStorageKey(userId: number | string, tableId: string): string {
  return `${ORDER_PREFIX}.${userId}.${tableId}`;
}

/** The table's own order. */
export function defaultOrder(defs: ColumnDef[]): string[] {
  return defs.map((d) => d.key);
}

/**
 * Makes a stored order safe: unknown keys are dropped, duplicates removed, and columns the table gained since the
 * order was saved go back to their own place among their neighbours (after the column that precedes them in the table).
 */
export function sanitizeOrder(defs: ColumnDef[], order: unknown): string[] {
  const base = defaultOrder(defs);
  if (!Array.isArray(order)) return base;
  const known = new Set(base);
  const result = [...new Set(order.filter((k): k is string => typeof k === "string" && known.has(k)))];
  base.forEach((key, i) => {
    if (result.includes(key)) return;
    const before = base.slice(0, i).reverse().find((k) => result.includes(k));
    result.splice(before === undefined ? 0 : result.indexOf(before) + 1, 0, key);
  });
  return result;
}

/** Moves one column one place left (-1) or right (+1). Moving past either end changes nothing. */
export function moveColumn(order: string[], key: string, delta: -1 | 1): string[] {
  const from = order.indexOf(key);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= order.length) return order;
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function isDefaultOrder(defs: ColumnDef[], order: string[]): boolean {
  return defaultOrder(defs).every((k, i) => order[i] === k);
}

/** The columns in the person's order. */
export function orderDefs<T extends ColumnDef>(defs: T[], order: string[]): T[] {
  const byKey = new Map(defs.map((d) => [d.key, d]));
  return order.map((k) => byKey.get(k)).filter((d): d is T => d !== undefined);
}
