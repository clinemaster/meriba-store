import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./api";
import { useLoad } from "./useLoad";

vi.mock("./api", () => ({ api: vi.fn(), errorMessage: (e: unknown) => String(e) }));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("useLoad", () => {
  beforeEach(() => vi.mocked(api).mockReset());

  it("ignores a slow earlier response that arrives after a newer one", async () => {
    const slow = deferred<string>();
    vi.mocked(api).mockImplementation((path: string) => (path === "/a" ? slow.promise : Promise.resolve("B")) as never);

    const { result, rerender } = renderHook(({ path }) => useLoad<string>(path), { initialProps: { path: "/a" } });
    rerender({ path: "/b" });
    await waitFor(() => expect(result.current.data).toBe("B"));

    await act(async () => { slow.resolve("A"); await slow.promise; });
    expect(result.current.data).toBe("B");
    expect(result.current.loading).toBe(false);
  });

  it("shares an in-flight request when Strict Mode replays the loading effect", async () => {
    const response = deferred<string>();
    vi.mocked(api).mockReturnValue(response.promise as never);

    const { result } = renderHook(() => useLoad<string>("/same"), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });

    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    await act(async () => { response.resolve("loaded"); await response.promise; });
    await waitFor(() => expect(result.current.data).toBe("loaded"));
  });

  it("starts a fresh request for an explicit reload while the initial request is pending", async () => {
    const initial = deferred<string>();
    vi.mocked(api)
      .mockReturnValueOnce(initial.promise as never)
      .mockResolvedValueOnce("fresh" as never);

    const { result } = renderHook(() => useLoad<string>("/same"));
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));

    await act(async () => { await result.current.reload(); });
    expect(api).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe("fresh");

    await act(async () => { initial.resolve("stale"); await initial.promise; });
    expect(result.current.data).toBe("fresh");
  });
});
