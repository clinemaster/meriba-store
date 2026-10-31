"use client";

import { useEffect, useRef } from "react";

import type { StockStatus } from "./types";

/**
 * How each stock level looks, everywhere it is shown. Every level has a word and an icon as well as a colour,
 * so it never rests on colour alone. The level itself is decided on the server (catalog/stock_levels.py).
 */
export const STOCK_LEVELS: Record<StockStatus, { label: string; icon: string; tone: string; tile: string }> = {
  IN_STOCK: { label: "Healthy", icon: "✔\uFE0E", tone: "border-success-line bg-success-soft text-success-ink", tile: "border-success-line border-l-success bg-success-soft" },
  LOW_STOCK: { label: "Low stock", icon: "!", tone: "border-warning-line bg-warning-soft text-warning-ink", tile: "border-warning-line border-l-warning bg-warning-soft" },
  CRITICAL: { label: "Critical stock", icon: "⚠\uFE0E", tone: "border-danger-line bg-danger-soft text-danger-ink", tile: "border-danger-line border-l-danger bg-danger-soft" },
  // Darker than Critical, and always worded, so it stands apart without relying on the shade.
  OUT_OF_STOCK: { label: "Out of stock", icon: "✕", tone: "border-danger bg-danger text-white", tile: "border-danger border-l-danger-ink bg-danger-soft" },
};

/** Best to worst. */
export const STOCK_ORDER: StockStatus[] = ["IN_STOCK", "LOW_STOCK", "CRITICAL", "OUT_OF_STOCK"];

const CHANGED = "meriba:data-changed";

/** Called after any change is saved, so stock figures on screen can refresh themselves straight away. */
export function announceDataChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGED));
}

/**
 * Keep a view's figures fresh without the person pressing reload: straight after anything is saved in this
 * window, when they come back to the window, and every `everyMs` (sales made at another till).
 */
export function useLiveReload(reload: () => unknown, everyMs = 30_000) {
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => {
    const run = () => { if (document.visibilityState !== "hidden") latest.current(); };
    const timer = window.setInterval(run, everyMs);
    window.addEventListener(CHANGED, run);
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", run);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(CHANGED, run);
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", run);
    };
  }, [everyMs]);
}
