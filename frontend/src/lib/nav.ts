import type { Role } from "./types";

export type NavItem = { href: string; label: string; roles: Role[] };

const ALL: Role[] = ["OWNER", "ACCOUNTANT", "CASHIER"];
const OFFICE: Role[] = ["OWNER", "ACCOUNTANT"];

/** The menu. Each role sees only its own entries; the server enforces the same rules again. */
export const NAV: NavItem[] = [
  { href: "/", label: "Home", roles: ALL },
  { href: "/sales", label: "Today's Sales", roles: ALL },
  { href: "/sheet", label: "Daily Sheet", roles: ALL },
  { href: "/day/close", label: "Close Day", roles: ALL },
  { href: "/closing", label: "Daily Closing", roles: OFFICE },
  { href: "/products", label: "Products", roles: OFFICE },
  { href: "/stock", label: "Stock", roles: OFFICE },
  { href: "/receive", label: "Receive Stock", roles: OFFICE },
  { href: "/expenses", label: "Expenses", roles: OFFICE },
  { href: "/reports", label: "Reports", roles: OFFICE },
  { href: "/audit", label: "Audit History", roles: OFFICE },
  { href: "/users", label: "Users", roles: ["OWNER"] },
  { href: "/settings", label: "Settings", roles: ["OWNER"] },
  { href: "/setup", label: "Setup", roles: OFFICE },
];

/** Pages that exist but are not in the menu. */
const EXTRA: NavItem[] = [
  { href: "/day/start", label: "Start Day", roles: ALL },
  { href: "/sale", label: "Daily Sheet", roles: ALL },  // the old New Sale address; it now opens the Daily Sheet
  { href: "/change-password", label: "Change Password", roles: ALL },
  { href: "/help", label: "Help", roles: ALL },
  // Taken off the menu at the owner's request (13 Oct 2026). The data is kept; Setup still links here for the open questions.
  { href: "/history", label: "Excel History", roles: OFFICE },
];

export function navFor(role: Role): NavItem[] {
  return NAV.filter((item) => item.roles.includes(role));
}

export function canOpen(role: Role, path: string): boolean {
  const match = [...NAV, ...EXTRA]
    .filter((item) => (item.href === "/" ? path === "/" : path === item.href || path.startsWith(item.href + "/")))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return match ? match.roles.includes(role) : false;
}
