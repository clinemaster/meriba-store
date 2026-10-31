"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { formatQty } from "@/lib/money";
import { STOCK_LEVELS } from "@/lib/stockLevels";
import type { StockStatus } from "@/lib/types";

import { BackButton } from "./BackButton";

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-3 p-6 text-ink-muted">
      <span className="h-6 w-6 animate-spin rounded-full border-4 border-line border-t-brand-600 motion-reduce:animate-none" aria-hidden />
      <span>{label}</span>
    </div>
  );
}

const ALERT = {
  error: { box: "border-danger-line border-l-danger bg-danger-soft text-danger-ink", icon: "⚠\uFE0E", word: "Problem" },
  success: { box: "border-success-line border-l-success bg-success-soft text-success-ink", icon: "✔\uFE0E", word: "Done" },
  info: { box: "border-info-line border-l-info bg-info-soft text-info-ink", icon: "ℹ\uFE0E", word: "Note" },
  warning: { box: "border-warning-line border-l-warning bg-warning-soft text-warning-ink", icon: "!", word: "Attention" },
} as const;

/** Messages always carry an icon and a word, never colour alone. */
export function Alert({ kind = "info", children }: { kind?: keyof typeof ALERT; children: React.ReactNode }) {
  const style = ALERT[kind];
  return (
    <div role={kind === "error" ? "alert" : "status"} className={`flex gap-3 rounded-lg border border-l-4 px-4 py-3 ${style.box}`}>
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

/**
 * Each kind of figure keeps one colour on every screen, shown as a coloured edge and a light tint; the number itself
 * stays in the main text colour so it is always easy to read:
 * sales = action blue, profit = success green (danger when it is a loss), stock value = teal, expenses = amber.
 */
const STAT_TONE = {
  neutral: "border-line bg-neutral-soft",
  sales: "border-brand-200 border-l-brand-600 bg-brand-50",
  profit: "border-success-line border-l-success bg-success-soft",
  loss: "border-danger-line border-l-danger bg-danger-soft",
  stock: "border-secondary-line border-l-secondary bg-secondary-soft",
  expenses: "border-warning-line border-l-warning bg-warning-soft",
} as const;
export type StatTone = keyof typeof STAT_TONE;

export function Stat({ label, value, note, strong = false, tone = "neutral" }: { label: string; value: string; note?: string; strong?: boolean; tone?: StatTone }) {
  return (
    <div className={`rounded-lg border p-4 ${tone === "neutral" ? "" : "border-l-4"} ${STAT_TONE[tone]}`}>
      <div className="text-sm font-semibold text-ink-muted">{label}</div>
      <div className={`mt-1 text-2xl tabular-nums text-ink ${strong ? "font-bold" : "font-semibold"}`}>{value}</div>
      {note && <div className="mt-1 text-sm text-ink-muted">{note}</div>}
    </div>
  );
}

/**
 * What each state looks like, everywhere. Green = done or fine, amber = waiting for someone, red = cancelled or wrong,
 * violet = money given back, blue = for information, grey = closed, switched off or history.
 * Every badge shows an icon and its word as well as its colour.
 */
const BADGE = {
  success: { tone: "border-success-line bg-success-soft text-success-ink", icon: "✔\uFE0E" },
  warning: { tone: "border-warning-line bg-warning-soft text-warning-ink", icon: "!" },
  danger: { tone: "border-danger-line bg-danger-soft text-danger-ink", icon: "✕" },
  refund: { tone: "border-refund-line bg-refund-soft text-refund-ink", icon: "↩" },
  info: { tone: "border-info-line bg-info-soft text-info-ink", icon: "ℹ\uFE0E" },
  neutral: { tone: "border-neutral-line bg-neutral-soft text-neutral-ink", icon: "–" },
} as const;

const STATUS_KIND: Record<string, keyof typeof BADGE> = {
  OPEN: "success", IN_STOCK: "success", BALANCED: "success", APPROVED: "success", COMPLETED: "success",
  VERIFIED: "success", CONFIRMED: "success", ACTIVE: "success",
  PENDING: "warning", PENDING_REVIEW: "warning", NOT_STARTED: "warning", LOW_STOCK: "warning", FLAGGED: "warning",
  DISCREPANCY: "danger", OUT_OF_STOCK: "danger", CRITICAL: "danger", VOIDED: "danger", REJECTED: "danger", REVERSED: "danger",
  REFUNDED: "refund", PARTIALLY_REFUNDED: "refund",
  PREVIEW: "info", INFO: "info",
  CLOSED: "neutral", OFF: "neutral", NONE: "neutral", INACTIVE: "neutral",
};

/** The kind of badge a status code gets. Unknown codes are shown as waiting, so they are never missed. */
export function statusKind(status: string): keyof typeof BADGE {
  return STATUS_KIND[status] ?? "warning";
}

export function StatusBadge({ status, label }: { status: string; label: string }) {
  const badge = BADGE[statusKind(status)];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[12px] font-semibold ${badge.tone}`}>
      <span aria-hidden>{badge.icon}</span>{label}
    </span>
  );
}

/** A product's stock level: icon and word on its colour, with the quantity beside it when given. */
export function StockBadge({ status, quantity, unit }: { status: StockStatus; quantity?: string; unit?: string }) {
  const level = STOCK_LEVELS[status];
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
      {quantity !== undefined && <span className="tabular-nums">{formatQty(quantity)}{unit ? ` ${unit}` : ""}</span>}
      <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[12px] font-semibold ${level.tone}`}>
        <span aria-hidden>{level.icon}</span>{level.label}
      </span>
    </span>
  );
}

/**
 * A toast that asks a question: it slides in at the top right, stays until answered, and does not block the page
 * the way the browser's own pop-up does. Escape or "No" dismisses it.
 */
export function ConfirmToast({ message, yes, no = "No, go back", busy = false, ready = true, danger = false, onYes, onNo, children }: {
  message: string; yes: string; no?: string; busy?: boolean; ready?: boolean;
  /** The action cannot be undone (cancelling a sale): "Yes" is red instead of the usual blue. */
  danger?: boolean;
  onYes: () => void; onNo: () => void; children?: React.ReactNode;
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
      className="no-print fixed right-4 top-4 z-50 w-[min(26rem,calc(100vw-2rem))] rounded-lg border-2 border-l-8 border-warning bg-surface p-4 shadow-2xl">
      <p id="confirm-toast-message" className="font-semibold text-ink">{message}</p>
      {children && <div className="mt-3">{children}</div>}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button type="button" className="btn-secondary min-h-[2.5rem]" disabled={busy} onClick={onNo}>{no}</button>
        <button type="button" ref={yesButton} className={`${danger ? "btn-danger" : "btn-primary"} min-h-[2.5rem]`} disabled={busy || !ready} onClick={onYes}>{yes}</button>
      </div>
    </div>
  );
}

type Question = {
  message: string; yes: string; danger?: boolean;
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
    <ConfirmToast message={question.message} yes={question.yes} danger={question.danger} ready={ready} onNo={() => setQuestion(null)}
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
