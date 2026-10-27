import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { Modal } from "@/components/ui";

beforeAll(() => {
  // The test browser has no pointer events and lays nothing out; give it both, like a real 512 px window.
  if (!("PointerEvent" in window)) {
    class PointerEvent extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 0; }
    }
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: PointerEvent });
  }
  HTMLElement.prototype.getBoundingClientRect = function () {
    const dialog = this.closest('[role="dialog"]') as HTMLElement | null;
    const [x, y] = (dialog?.style.transform.match(/-?\d+/g) ?? ["0", "0"]).map(Number);
    return { left: 427 + x, top: 56 + y, width: 512, height: 300, right: 939 + x, bottom: 356 + y, x: 427 + x, y: 56 + y, toJSON: () => ({}) } as DOMRect;
  };
});

const handle = () => screen.getByRole("group", { name: /To move this window/ });
const position = () => screen.getByRole("dialog").style.transform;

function setWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
}

describe("moving a window", () => {
  afterEach(() => { cleanup(); setWidth(1024); });

  it("moves when its title bar is dragged, and Reset position puts it back", async () => {
    setWidth(1366);
    render(<Modal title="Approve a Profit figure" onClose={() => {}}>Body</Modal>);
    expect(position()).toBe("");
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 250, clientY: 160 });
    fireEvent.pointerUp(handle(), { pointerId: 1 });
    expect(position()).toBe("translate(150px, 60px)");
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 600, clientY: 600 }); // released: no longer follows the pointer
    expect(position()).toBe("translate(150px, 60px)");
    await userEvent.click(screen.getByRole("button", { name: "Reset position" }));
    expect(position()).toBe("");
    expect(screen.queryByRole("button", { name: "Reset position" })).toBeNull();
  });

  it("moves with the arrow keys", async () => {
    setWidth(1366);
    render(<Modal title="Edit product" onClose={() => {}}>Body</Modal>);
    handle().focus();
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{ArrowDown}");
    expect(position()).toBe("translate(40px, 20px)");
  });

  it("always leaves the title bar on screen", () => {
    setWidth(1366);
    render(<Modal title="Refund" onClose={() => {}}>Body</Modal>);
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 5000, clientY: -5000 });
    // its left edge stops 360 px before the right of the screen (1366 - 360 - 427); never above the top (-56)
    expect(position()).toBe("translate(579px, -56px)");
  });

  it("stays put on a phone", () => {
    setWidth(390);
    render(<Modal title="Refund" onClose={() => {}}>Body</Modal>);
    fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 300, clientY: 300 });
    expect(position()).toBe("");
  });
});
