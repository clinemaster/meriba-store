import { describe, expect, it } from "vitest";

import { cartTotalCents, centsToApi, formatTZS, lineTotalCents, settle, toCents, type CartLine } from "./money";

const line = (priceCents: number, quantity: number): CartLine => ({ productId: priceCents, name: "x", unit: "Bottle", priceCents, quantity, stock: 99 });

describe("money", () => {
  it("converts and formats shillings", () => {
    expect(toCents("4500.00")).toBe(450000);
    expect(toCents("1,250,000")).toBe(125000000);
    expect(toCents("")).toBe(0);
    expect(centsToApi(450000)).toBe("4500.00");
    expect(formatTZS("1250000.00")).toBe("TZS 1,250,000");
    expect(formatTZS("-10000")).toBe("-TZS 10,000");
    expect(formatTZS(450050, true)).toBe("TZS 4,500.50");
  });

  it("adds line totals and the grand total exactly", () => {
    expect(lineTotalCents(line(450000, 5))).toBe(2250000);
    expect(cartTotalCents([line(100000, 2), line(250000, 3)])).toBe(950000);
    // 0.1 + 0.2 style errors cannot happen with integer cents
    expect(cartTotalCents([line(toCents("0.10"), 1), line(toCents("0.20"), 1)])).toBe(30);
  });
});

describe("settle", () => {
  const cash = (cents: number) => ({ methodId: 1, isCash: true, cents });
  const momo = (cents: number) => ({ methodId: 2, isCash: false, cents });

  it("exact cash is fine with no change", () => {
    expect(settle(450000, [cash(450000)])).toMatchObject({ ok: true, changeCents: 0, outstandingCents: 0 });
  });
  it("cash over the total gives change", () => {
    expect(settle(450000, [cash(1000000)])).toMatchObject({ ok: true, changeCents: 550000 });
  });
  it("underpayment shows what is still owed", () => {
    const result = settle(450000, [cash(400000)]);
    expect(result.ok).toBe(false);
    expect(result.problem).toBe("Still to pay: TZS 500");
  });
  it("split payment adds up (AT-14)", () => {
    expect(settle(10000000, [cash(4000000), momo(6000000)])).toMatchObject({ ok: true, changeCents: 0 });
  });
  it("non-cash can never exceed the total", () => {
    expect(settle(450000, [momo(500000)]).ok).toBe(false);
  });
  it("cash is refused when other payments already cover the total", () => {
    expect(settle(450000, [momo(450000), cash(100000)]).ok).toBe(false);
  });
  it("an empty sale cannot be completed", () => {
    expect(settle(0, [cash(0)]).ok).toBe(false);
  });
});
