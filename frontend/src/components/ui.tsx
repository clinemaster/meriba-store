"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { formatQty } from "@/lib/money";
import { STOCK_LEVELS } from "@/lib/stockLevels";
import type { StockStatus } from "@/lib/types";

import { BackButton } from "./BackButton";

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

/** Every page's heading, with the Back button above it in the same place on every page. */
export function PageTitle({ title, help, action }: { title: string; help?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <BackButton />
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
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // How far the window has been moved from its usual place, by dragging its title bar.
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ pointer: number; startX: number; startY: number; from: { x: number; y: number }; rect: DOMRect } | null>(null);
  // Runs once, when the window opens. It must not run again on later re-draws: moving the focus
  // back to the window each time would pull the cursor out of whatever box the person is typing in.
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCloseRef.current();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** Keeps at least the title bar on screen, so the window can always be found and moved back. */
  function keepOnScreen(next: { x: number; y: number }, rect: DOMRect, from: { x: number; y: number }) {
    const left = rect.left - from.x, top = rect.top - from.y;  // where the window sits when not moved
    const visible = 360;  // enough for the title and Reset position
    return {
      x: Math.min(Math.max(next.x, visible - rect.width - left), window.innerWidth - visible - left),
      y: Math.min(Math.max(next.y, -top), window.innerHeight - 56 - top),
    };
  }
  const movable = () => window.innerWidth >= 640;  // on a phone the window stays where it is

  function startDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || !movable() || (e.target as HTMLElement).closest("button") || !ref.current) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { pointer: e.pointerId, startX: e.clientX, startY: e.clientY, from: offset, rect: ref.current.getBoundingClientRect() };
  }
  function moveDrag(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    setOffset(keepOnScreen({ x: d.from.x + e.clientX - d.startX, y: d.from.y + e.clientY - d.startY }, d.rect, d.from));
  }
  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointer === e.pointerId) drag.current = null;
  }
  function moveByKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = e.shiftKey ? 80 : 20;
    const by = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!by || !movable() || !ref.current) return;
    e.preventDefault();
    setOffset(keepOnScreen({ x: offset.x + by[0], y: offset.y + by[1] }, ref.current.getBoundingClientRect(), offset));
  }
  const moved = offset.x !== 0 || offset.y !== 0;

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/25 p-4 no-print-backdrop">
      <div
        ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
        style={moved ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined}
        className={`mt-10 w-full rounded-xl bg-white p-6 shadow-2xl ring-1 ring-slate-900/10 print:!transform-none ${wide ? "max-w-2xl" : "max-w-lg"}`}
      >
        <div className="no-print -mx-6 -mt-6 mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-t-xl border-b border-slate-200 bg-slate-50 px-6 py-3 sm:cursor-move sm:select-none sm:touch-none"
          role="group" tabIndex={0} aria-label={`${title}. To move this window, drag here or use the arrow keys.`}
          onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag} onKeyDown={moveByKey}>
          <h2 className="text-xl font-bold">{title}</h2>
          {moved && <button type="button" className="shrink-0 text-sm font-semibold text-brand-700 underline" onClick={() => setOffset({ x: 0, y: 0 })}>Reset position</button>}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Stat({ label, value, note, strong = false }: { label: string; value: string; note?: string; strong?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
      <div className="text-sm font-semibold text-slate-600">{label}</div>
      <div className={`mt-1 text-2xl tabular-nums ${strong ? "font-bold" : "font-semibold"}`}>{value}</div>
      {note && <div className="mt-1 text-sm text-slate-600">{note}</div>}
    </div>
  );
}

export function StatusBadge({ status, label }: { status: string; label: string }) {
  const tone =
    status === "OPEN" || status === "IN_STOCK" || status === "BALANCED" || status === "APPROVED" || status === "COMPLETED"
      ? "bg-green-100 text-green-900 border-green-300"
      : status === "DISCREPANCY" || status === "OUT_OF_STOCK" || status === "CRITICAL" || status === "VOIDED"
        ? "bg-red-100 text-red-900 border-red-300"
        : "bg-amber-100 text-amber-900 border-amber-300";
  return <span className={`inline-block whitespace-nowrap rounded-full border px-3 py-0.5 text-sm font-semibold ${tone}`}>{label}</span>;
}

/** A product's stock level: icon and word on its colour, with the quantity beside it when given. */
export function StockBadge({ status, quantity, unit }: { status: StockStatus; quantity?: string; unit?: string }) {
  const level = STOCK_LEVELS[status];
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
      {quantity !== undefined && <span className="tabular-nums">{formatQty(quantity)}{unit ? ` ${unit}` : ""}</span>}
      <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${level.tone}`}>
        <span aria-hidden>{level.icon}</span>{level.label}
      </span>
    </span>
  );
}

/**
 * A toast that asks a question: it slides in at the top right, stays until answered, and does not block the page
 * the way the browser's own pop-up does. Escape or "No" dismisses it.
 */
export function ConfirmToast({ message, yes, no = "No, go back", busy = false, ready = true, onYes, onNo, children }: {
  message: string; yes: string; no?: string; busy?: boolean; ready?: boolean; onYes: () => void; onNo: () => void; children?: React.ReactNode;
}) {
  const yesButton = useRef<HTMLButtonElement>(null);
  const onNoRef = useRef(onNo);
  onNoRef.current = onNo;
  const hasInput = Boolean(children);
  useEffect(() => {
    if (!hasInput) yesButton.current?.focus();
    // Caught first, so Escape answers this question and does not also close a window underneath it.
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopImmediatePropagation(); onNoRef.current(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [hasInput]);
  return (
    <div role="alertdialog" aria-label="Please confirm" aria-describedby="confirm-toast-message"
      className="no-print fixed right-4 top-4 z-50 w-[min(26rem,calc(100vw-2rem))] rounded-lg border-2 border-brand-700 bg-white p-4 shadow-2xl">
      <p id="confirm-toast-message" className="font-semibold text-slate-900">{message}</p>
      {children && <div className="mt-3">{children}</div>}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button type="button" className="btn-secondary min-h-[2.5rem]" disabled={busy} onClick={onNo}>{no}</button>
        <button type="button" ref={yesButton} className="btn-primary min-h-[2.5rem]" disabled={busy || !ready} onClick={onYes}>{yes}</button>
      </div>
    </div>
  );
}

type Question = {
  message: string; yes: string;
  // Asks for one typed answer in the same box (a reason, a number) instead of the browser's prompt.
  input?: { label: string; hint?: string; initial?: string; numeric?: boolean; minLength?: number };
  run: (answer: string) => void;
};

/** Ask before an important action, in the app's own confirmation box.
 *  `confirm({ message, yes, run })` shows it; render `confirmation` once on the screen. */
export function useConfirm() {
  const [question, setQuestion] = useState<Question | null>(null);
  const [answer, setAnswer] = useState("");
  const confirm = useCallback((q: Question) => { setAnswer(q.input?.initial ?? ""); setQuestion(q); }, []);
  const input = question?.input;
  const ready = !input || answer.trim().length >= (input.minLength ?? 1);
  const confirmation = question && (
    <ConfirmToast message={question.message} yes={question.yes} ready={ready} onNo={() => setQuestion(null)}
      onYes={() => { if (!ready) return; setQuestion(null); question.run(answer.trim()); }}>
      {input && (
        <Field label={input.label} hint={input.hint}>
          {(p) => <input {...p} className="input" autoFocus maxLength={500} inputMode={input.numeric ? "numeric" : undefined} value={answer}
            onChange={(e) => setAnswer(input.numeric ? e.target.value.replace(/[^\d]/g, "") : e.target.value)} />}
        </Field>
      )}
    </ConfirmToast>
  );
  return { confirm, confirmation, asking: question !== null };
}
