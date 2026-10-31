/** Payment categories and providers on screen: labels, icons, colours, the filter address and the payment rows of a sale. */

import type { PaymentMethod, PaymentProvider } from "./types";

export const CATEGORY_ICONS: Record<string, { glyph: string; label: string }> = {
  cash: { glyph: "💵", label: "Cash" },
  phone: { glyph: "📱", label: "Phone" },
  bank: { glyph: "🏦", label: "Bank" },
  card: { glyph: "💳", label: "Card" },
  wallet: { glyph: "👛", label: "Wallet" },
  other: { glyph: "🔖", label: "Other" },
};

export function iconFor(icon: string | undefined): string {
  return (CATEGORY_ICONS[icon ?? "other"] ?? CATEGORY_ICONS.other).glyph;
}

/** "Mobile Money · M-PESA", or just "Cash". */
export function paymentLabel(method: string, provider?: string | null): string {
  return provider ? `${method} · ${provider}` : method;
}

/**
 * Chart colours, one per category in a fixed order (validated categorical palette; colour follows the category,
 * never its position in a filtered list). A ninth category and beyond share the last neutral.
 */
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
export function seriesColour(position: number): string {
  return position >= 0 && position < SERIES.length ? SERIES[position] : "#8a8984";
}

/** The categories a cashier can take money with now: switched on, and (when needed) with a provider switched on. */
export function usableCategories(methods: PaymentMethod[] | null | undefined): PaymentMethod[] {
  return (methods ?? []).filter((m) => m.is_active && (!m.requires_provider || activeProviders(m).length > 0));
}

export function activeProviders(method: PaymentMethod | null | undefined): PaymentProvider[] {
  return (method?.providers ?? []).filter((p) => p.is_active);
}

/** One payment line while a sale is being entered. */
export type Allocation = { key: string; methodId: number | null; providerId: number | null; amount: string; reference: string };

let counter = 0;
export function newAllocation(methodId: number | null = null): Allocation {
  counter += 1;
  return { key: `a${counter}`, methodId, providerId: null, amount: "", reference: "" };
}

/** What is wrong with one line, in plain words, or null when it can be sent. */
export function allocationProblem(line: Allocation, methods: PaymentMethod[]): string | null {
  const method = methods.find((m) => m.id === line.methodId);
  if (!method) return "Choose how the customer is paying.";
  if (method.requires_provider) {
    const provider = activeProviders(method).find((p) => p.id === line.providerId);
    if (!provider) return `Choose the ${method.name} provider (${activeProviders(method).map((p) => p.name).join(", ")}).`;
  }
  return null;
}

/** The same category and provider twice in one sale is refused by the server; say so before sending. */
export function duplicateAllocation(lines: Allocation[]): boolean {
  const seen = new Set<string>();
  for (const l of lines) {
    if (l.methodId === null) continue;
    const key = `${l.methodId}:${l.providerId ?? ""}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

export type TransactionQuery = {
  from: string; to: string; category?: number | "none" | null; provider?: number | "none" | null; cashier?: number | null;
  branch?: number | null; kind?: "payment" | "refund"; status?: string; search?: string; ordering?: string; page?: number;
};

/** The query string for the summary, the transaction list and the downloads, so all three use the same filters. */
export function paymentQuery(q: TransactionQuery, extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams({ date_from: q.from, date_to: q.to });
  const add = (key: string, value: unknown) => { if (value !== undefined && value !== null && value !== "") params.set(key, String(value)); };
  add("category", q.category);
  add("provider", q.provider);
  add("cashier", q.cashier);
  add("branch", q.branch);
  add("kind", q.kind && q.kind !== "payment" ? q.kind : undefined);
  add("status", q.status && q.status !== "collected" ? q.status : undefined);
  add("search", q.search);
  add("ordering", q.ordering && q.ordering !== "-date" ? q.ordering : undefined);
  add("page", q.page && q.page > 1 ? q.page : undefined);
  for (const [k, v] of Object.entries(extra)) add(k, v);
  return params.toString();
}

/** Reads the same filters back from a page address. */
export function readPaymentQuery(params: URLSearchParams, fallbackDay: string): TransactionQuery {
  const id = (key: string): number | "none" | null => {
    const v = params.get(key);
    if (!v) return null;
    if (v === "none") return "none";
    return /^\d+$/.test(v) ? Number(v) : null;
  };
  const date = (key: string) => (/^\d{4}-\d{2}-\d{2}$/.test(params.get(key) ?? "") ? params.get(key)! : "");
  const from = date("date_from") || fallbackDay;
  const page = Number(params.get("page") ?? 1);
  return {
    from, to: date("date_to") || from, category: id("category"), provider: id("provider"),
    cashier: id("cashier") === "none" ? null : (id("cashier") as number | null), branch: id("branch") === "none" ? null : (id("branch") as number | null),
    kind: params.get("kind") === "refund" ? "refund" : "payment", status: params.get("status") ?? "collected",
    search: params.get("search") ?? "", ordering: params.get("ordering") ?? "-date", page: Number.isFinite(page) && page > 0 ? page : 1,
  };
}

/** Common periods, worked out from the shop's date (never the computer's clock alone). */
export function periodPresets(today: string): { key: string; label: string; from: string; to: string }[] {
  const d = new Date(today + "T00:00:00");
  const iso = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const yesterday = new Date(d);
  yesterday.setDate(d.getDate() - 1);
  const lastMonthEnd = new Date(d.getFullYear(), d.getMonth(), 0);
  return [
    { key: "today", label: "Today", from: today, to: today },
    { key: "yesterday", label: "Yesterday", from: iso(yesterday), to: iso(yesterday) },
    { key: "week", label: "This week", from: iso(monday), to: today },
    { key: "month", label: "This month", from: iso(new Date(d.getFullYear(), d.getMonth(), 1)), to: today },
    { key: "last-month", label: "Last month", from: iso(new Date(d.getFullYear(), d.getMonth() - 1, 1)), to: iso(lastMonthEnd) },
  ];
}
