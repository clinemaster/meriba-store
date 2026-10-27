import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Modal, useConfirm } from "@/components/ui";

function Demo({ run, withInput = false, onClose = () => {} }: { run: (answer: string) => void; withInput?: boolean; onClose?: () => void }) {
  const { confirm, confirmation, asking } = useConfirm();
  return (
    <Modal title="Window" onClose={onClose}>
      <button disabled={asking} onClick={() => confirm({
        message: "Cancel the expense?", yes: "Yes, cancel it", run,
        input: withInput ? { label: "Reason for cancelling" } : undefined,
      })}>Cancel…</button>
      {confirmation}
    </Modal>
  );
}

describe("useConfirm", () => {
  afterEach(cleanup);

  it("does nothing until Yes is pressed, and nothing at all on No", async () => {
    const run = vi.fn();
    render(<Demo run={run} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel…" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Cancel the expense?");
    expect(screen.getByRole("button", { name: "Cancel…" })).toBeDisabled(); // cannot be asked twice
    await userEvent.click(screen.getByRole("button", { name: "No, go back" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(run).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Cancel…" }));
    await userEvent.click(screen.getByRole("button", { name: "Yes, cancel it" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("asks for the typed answer in the same box and passes it on", async () => {
    const run = vi.fn();
    render(<Demo run={run} withInput />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel…" }));
    expect(screen.getByRole("button", { name: "Yes, cancel it" })).toBeDisabled(); // not without a reason
    await userEvent.type(screen.getByLabelText("Reason for cancelling"), "  Typed twice  ");
    await userEvent.click(screen.getByRole("button", { name: "Yes, cancel it" }));
    expect(run).toHaveBeenCalledWith("Typed twice");
  });

  it("Escape answers No without also closing the window underneath", async () => {
    const run = vi.fn();
    const onClose = vi.fn();
    render(<Demo run={run} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel…" }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}"); // with no question open, Escape closes the window as before
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
