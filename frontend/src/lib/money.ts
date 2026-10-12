/** Money maths in whole cents (integers), so the screen never shows floating-point errors. */

export function toCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function centsToApi(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function formatTZS(value: string | number | null | undefined, fromCents = false): string {
  const cents = fromCents ? Number(value ?? 0) : toCents(value);
  const whole = cents % 100 === 0;
  const text = (Math.abs(cents) / 100).toLocaleString("en-US", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return `${cents < 0 ? "-" : ""}TZS ${text}`;
}

export function formatQty(value: string | number): string {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 3 });
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value.length === 10 ? value + "T00:00:00" : value);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return "";
  return new Date(value).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** `unitId` and `factor` are set when the line is a package (e.g. a crate of 12): one of it takes `factor` out of stock. */
export type CartLine = {
  productId: number; name: string; unit: string; priceCents: number; quantity: number; stock: number;
  unitId?: number | null; factor?: number;
};

export function lineTotalCents(line: Pick<CartLine, "priceCents" | "quantity">): number {
  return line.priceCents * line.quantity;
}

export function cartTotalCents(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + lineTotalCents(line), 0);
}

export type Tender = { methodId: number; isCash: boolean; cents: number };

/** What the cashier needs to see before confirming: still owed, or change to give back. */
export function settle(totalCents: number, tenders: Tender[]) {
  const used = tenders.filter((t) => t.cents > 0);
  const nonCash = used.filter((t) => !t.isCash).reduce((s, t) => s + t.cents, 0);
  const cash = used.filter((t) => t.isCash).reduce((s, t) => s + t.cents, 0);
  const paid = nonCash + cash;
  let problem: string | null = null;
  if (totalCents <= 0) problem = "Add at least one product to the sale.";
  else if (nonCash > totalCents) problem = "The mobile money or bank amount is more than the total.";
  else if (paid < totalCents) problem = `Still to pay: ${formatTZS(totalCents - paid, true)}`;
  else if (cash > 0 && cash - (paid - totalCents) <= 0) problem = "The other payments already cover the total. Remove the cash amount.";
  return {
    paidCents: paid,
    outstandingCents: Math.max(totalCents - paid, 0),
    changeCents: Math.max(paid - totalCents, 0),
    problem,
    ok: problem === null,
  };
}
