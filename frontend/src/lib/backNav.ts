"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { canOpen } from "./nav";
import type { Role } from "./types";

/**
 * The Back button's memory: the in-app pages this tab has visited, oldest first, kept in sessionStorage so it
 * survives a refresh and starts empty in a new tab or when a page is opened straight from its address.
 * The browser keeps the real history; this trail only answers "is the page before this one ours, and allowed?"
 */
const TRAIL_KEY = "meriba.back.trail";
const STATE_KEY = "meriba.back.state:";
const MAX_TRAIL = 50;

/** Back never returns to these: signing in again, or the forced password change. */
const NEVER_BACK_TO = ["/login", "/change-password"];

/** Where Back goes when there is no earlier page, for pages whose natural parent is not Home. */
const PARENT: Record<string, string> = { "/history": "/setup" };

/** The page a router.replace is about to land on, so that arrival replaces the last trail entry like the browser does. */
let pendingReplace: string | null = null;
/** The page most recently arrived at by going back, so it can put its filters back the way they were. */
let arrivedBack: string | null = null;
/** Set by the browser's Back and Forward (and router.back), never by a link, so a link to the page before is not taken for Back. */
let popped = false;
/** Whether this page load has been looked at yet: an address typed or opened in a new tab starts a fresh trail. */
let loadChecked = false;

if (typeof window !== "undefined") window.addEventListener("popstate", () => { popped = true; });

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null; // storage switched off: Back simply always goes to the parent page
  }
}

export function readTrail(): string[] {
  try {
    const value = JSON.parse(storage()?.getItem(TRAIL_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function writeTrail(trail: string[]) {
  storage()?.setItem(TRAIL_KEY, JSON.stringify(trail));
}

/** The trail after arriving on `path` by a link (push), a redirect (replace) or the browser's Back/Forward (pop). */
export function stepTrail(trail: string[], path: string, how: "push" | "replace" | "pop" = "push"): { trail: string[]; back: boolean } {
  if (trail.at(-1) === path) return { trail, back: false }; // a refresh, or the same page again
  if (how === "replace") return { trail: [...trail.slice(0, -1), path], back: false };
  if (how === "pop" && trail.at(-2) === path) return { trail: trail.slice(0, -1), back: true };
  return { trail: [...trail, path].slice(-MAX_TRAIL), back: false }; // a link, or the browser's Forward
}

/** A page load from a typed address, a bookmark or a new tab, as opposed to a refresh or the browser's Back/Forward. */
function freshLoad(): boolean {
  try {
    const entry = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return entry?.type === "navigate";
  } catch {
    return false;
  }
}

/** Called by the app shell every time the page changes. Signing in starts a fresh trail. */
export function recordVisit(path: string) {
  if (!loadChecked) {
    loadChecked = true;
    if (freshLoad()) storage()?.removeItem(TRAIL_KEY); // whatever came before this load is not ours to go back to
  }
  if (path === "/login") {
    storage()?.removeItem(TRAIL_KEY);
    arrivedBack = pendingReplace = null;
    popped = false;
    return;
  }
  // A page that redirects in its own effect sets this before the shell records the page itself, so only clear it on use.
  const replace = pendingReplace === path;
  if (replace) pendingReplace = null;
  const step = stepTrail(readTrail(), path, replace ? "replace" : popped ? "pop" : "push");
  popped = false;
  writeTrail(step.trail);
  arrivedBack = step.back ? path : null;
}

/** Use instead of router.replace, so the trail drops the page being replaced just as the browser does. */
export function replaceTo(router: { replace: (href: string) => void }, href: string) {
  pendingReplace = href.split(/[?#]/)[0];
  router.replace(href);
}

/** The earlier in-app page Back can return to, or null when there is none this role may open. */
export function previousPage(role: Role, path: string): string | null {
  const trail = readTrail();
  if (trail.at(-1) !== path || trail.length < 2) return null;
  if (typeof window !== "undefined" && window.history.length < 2) return null; // a fresh tab: nothing to go back to
  const previous = trail[trail.length - 2];
  if (NEVER_BACK_TO.includes(previous) || previous === path || !canOpen(role, previous)) return null;
  return previous;
}

/** Where Back goes without an earlier page: the page's parent if this role may open it, otherwise Home. */
export function parentOf(path: string, role: Role): string {
  const named = PARENT[path];
  if (named && named !== path && canOpen(role, named)) return named;
  const parts = path.split("/").filter(Boolean);
  for (let i = parts.length - 1; i > 0; i--) {
    const up = "/" + parts.slice(0, i).join("/");
    if (canOpen(role, up)) return up;
  }
  return "/";
}

/** True while showing a page that was reached by going back (before or after the shell has noted the arrival). */
export function isReturning(path: string): boolean {
  if (arrivedBack === path) return true;
  const trail = readTrail();
  return popped && trail.at(-1) !== path && trail.at(-2) === path;
}

/**
 * useState for a page's filters, search, sorting and page number: going back to the page puts them back as they were.
 * Arriving any other way (the menu, a link, a refresh) starts from `initial` as before.
 */
export function useBackState<T>(key: string, initial: T) {
  const path = usePathname() ?? "/";
  const id = `${STATE_KEY}${path}:${key}`;
  const [value, setValue] = useState<T>(() => {
    if (!isReturning(path)) return initial;
    try {
      const saved = storage()?.getItem(id);
      return saved == null ? initial : (JSON.parse(saved) as T);
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      storage()?.setItem(id, JSON.stringify(value));
    } catch {
      // storage full or switched off: the page still works, it just will not remember
    }
  }, [id, value]);
  return [value, setValue] as const;
}

/** For tests only. */
export function resetBackNav() {
  pendingReplace = arrivedBack = null;
  popped = loadChecked = false;
}
