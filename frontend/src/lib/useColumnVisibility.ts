"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useAuth } from "./auth";
import {
  canToggle, isDefault, isDefaultOrder, loadHidden, moveColumn, orderDefs, orderStorageKey, sanitizeHidden, sanitizeOrder,
  saveHidden, storageKey, toggleHidden, visibleKeys,
  type ColumnDef,
} from "./columns";

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export type ColumnVisibility<T extends ColumnDef = ColumnDef> = {
  /** The table's columns in the table's own order. */
  columns: T[];
  /** The columns in the order this person chose. */
  ordered: T[];
  hidden: string[];
  show: (key: string) => boolean;
  visibleCount: number;
  canToggle: (key: string) => boolean;
  toggle: (key: string) => void;
  /** Moves a column one place left (-1) or right (+1). */
  move: (key: string, delta: -1 | 1) => void;
  /** Shows every column, keeping the chosen order. */
  showAll: () => void;
  /** Back to the table's own columns and order. */
  reset: () => void;
  /** Showing the table's own columns in its own order. */
  isDefault: boolean;
  allShown: boolean;
};

type Saved = { key: string; value: unknown } | null;

/** One remembered value for the signed-in user, read after the first draw so the server and browser draw the same. */
function useStored(key: string | null): [unknown, (next: string[] | null) => void] {
  const [saved, setSaved] = useState<Saved>(null);
  useEffect(() => {
    if (key) setSaved({ key, value: loadHidden(browserStorage(), key) });
  }, [key]);
  const store = useCallback((next: string[] | null) => {
    if (!key) return;
    saveHidden(browserStorage(), key, next);
    setSaved({ key, value: next });
  }, [key]);
  return [saved && saved.key === key ? saved.value : null, store];
}

/**
 * Which columns of one table are showing, and in what order. The choice is remembered in this browser for the
 * signed-in user and this table only. Pass a stable `columns` array (a module constant or a memoised list).
 */
export function useColumnVisibility<T extends ColumnDef>(tableId: string, columns: T[]): ColumnVisibility<T> {
  const { user } = useAuth();
  const [storedHidden, storeHidden] = useStored(user ? storageKey(user.id, tableId) : null);
  const [storedOrder, storeOrder] = useStored(user ? orderStorageKey(user.id, tableId) : null);

  const hidden = useMemo(() => sanitizeHidden(columns, storedHidden), [columns, storedHidden]);
  const order = useMemo(() => sanitizeOrder(columns, storedOrder), [columns, storedOrder]);
  const ordered = useMemo(() => orderDefs(columns, order), [columns, order]);

  const toggle = useCallback((column: string) => {
    const next = toggleHidden(columns, hidden, column);
    if (next !== hidden) storeHidden(next);
  }, [columns, hidden, storeHidden]);

  const move = useCallback((column: string, delta: -1 | 1) => {
    const next = moveColumn(order, column, delta);
    if (next !== order) storeOrder(next);
  }, [order, storeOrder]);

  const showAll = useCallback(() => storeHidden([]), [storeHidden]);
  const reset = useCallback(() => { storeHidden(null); storeOrder(null); }, [storeHidden, storeOrder]);
  const show = useCallback((column: string) => !hidden.includes(column), [hidden]);
  const can = useCallback((column: string) => canToggle(columns, hidden, column), [columns, hidden]);

  return {
    columns, ordered, hidden, show, toggle, move, showAll, reset, canToggle: can,
    visibleCount: visibleKeys(columns, hidden).length,
    isDefault: isDefault(columns, hidden) && isDefaultOrder(columns, order),
    allShown: hidden.length === 0,
  };
}
