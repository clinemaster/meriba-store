"use client";

import { useEffect, useId, useRef } from "react";

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-3 p-6 text-slate-600">
      <span className="h-6 w-6 animate-spin rounded-full border-4 border-slate-300 border-t-brand-600" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

const ALERT = {
  error: { box: "border-red-300 bg-red-50 text-red-900", icon: "⚠", word: "Problem" },
  success: { box: "border-green-300 bg-green-50 text-green-900", icon: "✔", word: "Done" },
  info: { box: "border-sky-300 bg-sky-50 text-sky-900", icon: "ℹ", word: "Note" },
  warning: { box: "border-amber-300 bg-amber-50 text-amber-900", icon: "!", word: "Attention" },
} as const;

/** Messages always carry an icon and a word, never colour alone. */
export function Alert({ kind = "info", children }: { kind?: keyof typeof ALERT; children: React.ReactNode }) {
  const style = ALERT[kind];
  return (
    <div role={kind === "error" ? "alert" : "status"} className={`flex gap-3 rounded-lg border-2 px-4 py-3 ${style.box}`}>
      <span aria-hidden className="font-bold">{style.icon}</span>
      <div>
        <span className="font-semibold">{style.word}: </span>
        {children}
      </div>
    </div>
  );
}

export function Field({
  label, hint, error, children,
}: { label: string; hint?: string; error?: string; children: (props: { id: string; "aria-describedby"?: string }) => React.ReactNode }) {
  const id = useId();
  const describedBy = hint || error ? `${id}-help` : undefined;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block font-semibold">{label}</label>
      {children({ id, "aria-describedby": describedBy })}
      {(hint || error) && (
        <p id={`${id}-help`} className={`mt-1 text-sm ${error ? "font-semibold text-red-800" : "text-slate-600"}`}>
          {error ? `⚠ ${error}` : hint}
        </p>
      )}
    </div>
  );
}

export function PageTitle({ title, help, action }: { title: string; help?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        {help && <p className="mt-1 max-w-3xl text-slate-600">{help}</p>}
      </div>
      {action}
    </div>
  );
}

export function Modal({
  title, onClose, children, wide = false,
}: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/60 p-4 no-print-backdrop">
      <div
        ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
        className={`mt-10 w-full rounded-xl bg-white p-6 shadow-xl ${wide ? "max-w-2xl" : "max-w-lg"}`}
      >
        <h2 className="no-print mb-4 text-xl font-bold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function Stat({ label, value, note, strong = false }: { label: string; value: string; note?: string; strong?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="text-sm font-semibold text-slate-600">{label}</div>
      <div className={`mt-1 tabular-nums ${strong ? "text-3xl font-bold" : "text-xl font-semibold"}`}>{value}</div>
      {note && <div className="mt-1 text-sm text-slate-600">{note}</div>}
    </div>
  );
}

export function StatusBadge({ status, label }: { status: string; label: string }) {
  const tone =
    status === "OPEN" || status === "IN_STOCK" || status === "BALANCED" || status === "APPROVED" || status === "COMPLETED"
      ? "bg-green-100 text-green-900 border-green-300"
      : status === "DISCREPANCY" || status === "OUT_OF_STOCK" || status === "VOIDED"
        ? "bg-red-100 text-red-900 border-red-300"
        : "bg-amber-100 text-amber-900 border-amber-300";
  return <span className={`inline-block whitespace-nowrap rounded-full border px-3 py-0.5 text-sm font-semibold ${tone}`}>{label}</span>;
}
