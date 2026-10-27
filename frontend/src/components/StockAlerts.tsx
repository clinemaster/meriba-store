"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { api } from "@/lib/api";
import { formatQty } from "@/lib/money";
import { useLiveReload } from "@/lib/stockLevels";
import type { StockAlert } from "@/lib/types";

import { StockBadge } from "./ui";

type Feed = { latest_id: number; results: StockAlert[] };

const SHOWN = 4;

/**
 * Owner/Accountant: a quiet note in the corner when a product's stock gets worse (healthy to low, low to critical,
 * anything to out of stock). Alerts are created by the sale, count or other movement that caused them, and this
 * browser remembers the last one it showed, so reloading a page never repeats one.
 */
export function StockAlerts({ userId }: { userId: number }) {
  const key = `meriba.stockAlerts.seen.${userId}`;
  const [alerts, setAlerts] = useState<StockAlert[]>([]);

  const check = useCallback(async () => {
    let seen: string | null = null;
    try { seen = localStorage.getItem(key); } catch { /* storage switched off: start from now each time */ }
    try {
      const feed = await api<Feed>(`/stock/alerts/${seen === null ? "" : `?after=${Number(seen) || 0}`}`);
      localStorage.setItem(key, String(Math.max(feed.latest_id, Number(seen) || 0)));
      // The first visit in this browser starts from now rather than announcing everything that went before.
      if (seen === null) return;
      // One already put right (a delivery since) is not worth interrupting anyone for.
      const fresh = feed.results.filter((a) => a.current_status !== "IN_STOCK");
      if (fresh.length) {
        setAlerts((current) => {
          const known = new Set(current.map((a) => a.id));
          return [...fresh.filter((a) => !known.has(a.id)), ...current];
        });
      }
    } catch {
      // Not reachable just now: the next check will catch up.
    }
  }, [key]);

  useEffect(() => { void check(); }, [check]);
  useLiveReload(check);

  if (alerts.length === 0) return null;
  const more = alerts.length - SHOWN;
  return (
    <section role="status" aria-live="polite" aria-label="Stock warnings"
      className="no-print fixed bottom-4 right-4 z-40 w-[min(26rem,calc(100vw-2rem))] rounded-lg border-2 border-amber-400 bg-white p-4 shadow-2xl">
      <h2 className="font-bold"><span aria-hidden>⚠ </span>Stock is running low</h2>
      <ul className="mt-2 space-y-2">
        {alerts.slice(0, SHOWN).map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold">{a.product_name}</span>
            <span className="flex items-center gap-2 text-sm">
              <span className="tabular-nums">{formatQty(a.quantity)} left</span>
              <StockBadge status={a.status} />
            </span>
          </li>
        ))}
      </ul>
      {more > 0 && <p className="mt-2 text-sm text-slate-600">and {more} more.</p>}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button type="button" className="btn-secondary min-h-[2.5rem]" onClick={() => setAlerts([])}>Dismiss</button>
        <Link href="/products?stock=ATTENTION" className="btn-primary min-h-[2.5rem]" onClick={() => setAlerts([])}>See the products</Link>
      </div>
    </section>
  );
}
