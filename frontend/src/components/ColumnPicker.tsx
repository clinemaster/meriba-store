"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { ColumnVisibility } from "@/lib/useColumnVisibility";

/** "Columns (5 of 10)" button with a checklist and move buttons. Place it beside the table's other controls. */
export function ColumnPicker({ visibility, className = "" }: { visibility: ColumnVisibility; className?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const { columns, ordered, hidden, visibleCount } = visibility;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  return (
    <div ref={box} className={`relative no-print ${className}`}>
      <button type="button" className="btn-sm" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
        Columns ({visibleCount} of {columns.length})
      </button>
      {open && (
        <div id={panelId} role="group" aria-label="Choose columns to show"
          className="absolute right-0 z-30 mt-2 w-80 max-w-[85vw] rounded-lg border border-slate-300 bg-white p-3 text-left shadow-lg">
          <p className="mb-2 text-sm text-slate-600">Tick the columns to show; use the arrows to change the order (top of the list = left of the table). This only changes what you see here; downloads always include every column.</p>
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {ordered.map((c, i) => {
              const checked = !hidden.includes(c.key);
              const locked = !!c.essential || !visibility.canToggle(c.key);
              return (
                <li key={c.key} className="flex items-center gap-1">
                  <label className={`flex min-h-[2.5rem] flex-1 items-center gap-2 rounded px-1 ${locked ? "text-slate-500" : "cursor-pointer hover:bg-slate-50"}`}>
                    <input type="checkbox" className="h-5 w-5" checked={checked} disabled={locked} onChange={() => visibility.toggle(c.key)} />
                    <span>{c.label}</span>
                    {c.essential ? <span className="ml-auto text-xs">always shown</span> : locked && checked ? <span className="ml-auto text-xs">keep one</span> : null}
                  </label>
                  <button type="button" className="btn-icon" aria-label={`Move ${c.label} up`} disabled={i === 0} onClick={() => visibility.move(c.key, -1)}>
                    <span aria-hidden>↑</span>
                  </button>
                  <button type="button" className="btn-icon" aria-label={`Move ${c.label} down`} disabled={i === ordered.length - 1} onClick={() => visibility.move(c.key, 1)}>
                    <span aria-hidden>↓</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <button type="button" className="btn-sm" disabled={visibility.isDefault} onClick={visibility.reset}>Restore default</button>
            <button type="button" className="btn-sm" disabled={visibility.allShown} onClick={visibility.showAll}>Show all columns</button>
          </div>
        </div>
      )}
    </div>
  );
}
