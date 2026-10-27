import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";

import LoginPage from "./page";

vi.mock("@/lib/auth", () => ({ useAuth: vi.fn() }));

const signIn = vi.fn();

beforeEach(() => {
  signIn.mockReset();
  vi.mocked(useAuth).mockReturnValue({ user: null, loading: false, signIn, signOut: vi.fn(), refresh: vi.fn() });
});

describe("login page", () => {
  it("keeps username and password validation before calling sign in", async () => {
    render(<LoginPage />);
    expect(screen.getByRole("heading", { name: "Meriba Liquor Store" })).toBeInTheDocument();
    expect(screen.queryByText("The United Republic of Tanzania")).not.toBeInTheDocument();
    expect(screen.queryByText("National Audit Office")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "LOGIN" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter your username and your password.");
    expect(signIn).not.toHaveBeenCalled();
  });

  it("trims username, allows password visibility, and prevents duplicate submissions", async () => {
    let finishSignIn!: (value: { id: number }) => void;
    signIn.mockReturnValue(new Promise((resolve) => { finishSignIn = resolve; }));
    render(<LoginPage />);

    await userEvent.type(screen.getByLabelText("Username"), "  audit.user  ");
    await userEvent.type(screen.getByLabelText("Password"), "not-a-real-password");
    await userEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");
    await userEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");

    fireEvent.submit(screen.getByRole("button", { name: "LOGIN" }).closest("form")!);
    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
    expect(signIn).toHaveBeenCalledWith("audit.user", "not-a-real-password");
    expect(screen.getByRole("button", { name: "Signing in…" })).toBeDisabled();

    fireEvent.submit(screen.getByRole("button", { name: "Signing in…" }).closest("form")!);
    expect(signIn).toHaveBeenCalledTimes(1);
    finishSignIn({ id: 1 });
  });

  it("shows authentication errors and supports manually selecting a placeholder slide", async () => {
    signIn.mockRejectedValue(new ApiError("The username or password is not correct.", 400, "bad_credentials"));
    render(<LoginPage />);

    await userEvent.type(screen.getByLabelText("Username"), "auditor");
    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "LOGIN" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The username or password is not correct.");

    await userEvent.click(screen.getByRole("button", { name: "Show image 2: Meriba Liquor Store" }));
    expect(screen.getByRole("button", { name: "Show image 2: Meriba Liquor Store" })).toHaveAttribute("aria-current", "true");
  });
});