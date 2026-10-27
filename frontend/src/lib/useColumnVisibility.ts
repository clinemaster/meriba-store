"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useAuth } from "./auth";
import {
  canToggle, isDefault, loadHidden, sanitizeHidden, saveHidden, storageKey, toggleHidden, visibleKeys,
  type ColumnDef,
} from "./columns";

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export type ColumnVisibility = {
  columns: ColumnDef[];
  hidden: string[];
  show: (key: string) => boolean;
  visibleCount: number;
  canToggle: (key: string) => boolean;
  toggle: (key: string) => void;
  reset: () => void;
  isDefault: boolean;
};

/**
 * Which columns of one table are showing. The choice is remembered in this browser for the signed-in user and
 * this table only. Pass a stable `columns` array (a module constant or a memoised list).
 */
export function useColumnVisibility(tableId: string, columns: ColumnDef[]): ColumnVisibility {
  const { user } = useAuth();
  const key = user ? storageKey(user.id, tableId) : null;
  const [saved, setSaved] = useState<{ key: string; hidden: unknown } | null>(null);

  // Read after the first draw so the server and the browser draw the same thing at first.
  useEffect(() => {
    if (key) setSaved({ key, hidden: loadHidden(browserStorage(), key) });
  }, [key]);

  const hidden = useMemo(
    () => sanitizeHidden(columns, saved && saved.key === key ? saved.hidden : null),
    [columns, saved, key],
  );

  const store = useCallback((next: string[] | null) => {
    if (!key) return;
    saveHidden(browserStorage(), key, next);
    setSaved({ key, hidden: next });
  }, [key]);

  const toggle = useCallback((column: string) => {
    const next = toggleHidden(columns, hidden, column);
    if (next !== hidden) store(next);
  }, [columns, hidden, store]);

  const reset = useCallback(() => store(null), [store]);
  const show = useCallback((column: string) => !hidden.includes(column), [hidden]);
  const can = useCallback((column: string) => canToggle(columns, hidden, column), [columns, hidden]);

  return {
    columns, hidden, show, toggle, reset, canToggle: can,
    visibleCount: visibleKeys(columns, hidden).length,
    isDefault: isDefault(columns, hidden),
  };
}
