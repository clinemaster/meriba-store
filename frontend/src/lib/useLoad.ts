"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { api, errorMessage } from "./api";

const inFlight = new Map<string, Promise<unknown>>();

function load<T>(path: string): Promise<T> {
  const pending = inFlight.get(path);
  if (pending) return pending as Promise<T>;

  const request = api<T>(path);
  inFlight.set(path, request);
  void request.then(
    () => {
      if (inFlight.get(path) === request) inFlight.delete(path);
    },
    () => {
      if (inFlight.get(path) === request) inFlight.delete(path);
    },
  );
  return request;
}

/** Load something from the shop system, with loading and error states and a reload function. */
export function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);

  // Only the newest request may update state, so a slow earlier response can't overwrite a newer one.
  const latest = useRef(0);

  const request = useCallback(async (deduplicate: boolean) => {
    if (path === null) return;
    const id = ++latest.current;
    setLoading(true);
    try {
      const result = deduplicate ? await load<T>(path) : await api<T>(path);
      if (id !== latest.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (id !== latest.current) return;
      setError(errorMessage(err));
    } finally {
      if (id === latest.current) setLoading(false);
    }
  }, [path]);

  const reload = useCallback(() => request(false), [request]);

  useEffect(() => () => { latest.current++; }, []);

  useEffect(() => {
    request(true);
  }, [request]);

  return { data, error, loading, reload };
}
