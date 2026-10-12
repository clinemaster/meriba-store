/** One place for every call to the shop system. Turns failures into plain-language messages. */

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public errors?: Record<string, unknown>,
    public details?: unknown,
  ) {
    super(message);
  }
}

const BASE = "/api/v1";
const SAFE = new Set(["GET", "HEAD"]);

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const hit = document.cookie.split("; ").find((c) => c.startsWith(name + "="));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

async function csrfToken(): Promise<string> {
  const existing = readCookie("csrftoken");
  if (existing) return existing;
  const res = await fetch(`${BASE}/auth/csrf/`, { credentials: "same-origin" });
  const data = await res.json();
  return readCookie("csrftoken") ?? data.csrfToken;
}

export async function api<T = unknown>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { Accept: "application/json" };
  let response: Response;
  try {
    if (!SAFE.has(method)) {
      headers["X-CSRFToken"] = await csrfToken();
      headers["Content-Type"] = "application/json";
    }
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      credentials: "same-origin",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError("We could not reach the shop system. Check the connection and try again.", 0, "network");
  }
  if (response.status === 204) return undefined as T;
  let data: any = null;
  try {
    data = await response.json();
  } catch {
    /* not JSON: handled below */
  }
  if (!response.ok) {
    throw new ApiError(
      data?.message ?? "Something went wrong. Please try again.",
      response.status,
      data?.code ?? "error",
      data?.errors,
      data?.details,
    );
  }
  return data as T;
}

export type Page<T> = { count: number; next: string | null; previous: string | null; results: T[] };

export function errorMessage(err: unknown): string {
  return err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
}
