import type { Role } from "./types";

export const NAV_GROUPS = ["Selling", "Stock", "Money & Reports", "Admin"] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];
export type NavIcon =
  | "home"
  | "receipt"
  | "document"
  | "calendar"
  | "box"
  | "archive"
  | "receive"
  | "banknotes"
  | "expenses"
  | "chart"
  | "audit"
  | "users"
  | "settings"
  | "setup"
  | "help";
export type NavItem = { href: string; label: string; roles: Role[]; group?: NavGroup; icon: NavIcon };

const ALL: Role[] = ["OWNER", "ACCOUNTANT", "CASHIER"];
const OFFICE: Role[] = ["OWNER", "ACCOUNTANT"];

/** The sidebar menu, in its groups. Each role sees only its own entries; the server enforces the same rules again. */
export const NAV: NavItem[] = [
  { href: "/", label: "Home", roles: ALL, group: "Selling", icon: "home" },
  { href: "/sales", label: "Today's Sales", roles: ALL, group: "Selling", icon: "receipt" },
  { href: "/sheet", label: "Daily Sheet", roles: ALL, group: "Selling", icon: "document" },
  { href: "/day/close", label: "Close Day", roles: ALL, group: "Selling", icon: "calendar" },
  { href: "/products", label: "Products", roles: OFFICE, group: "Stock", icon: "box" },
  { href: "/stock", label: "Stock", roles: OFFICE, group: "Stock", icon: "archive" },
  { href: "/receive", label: "Receive Stock", roles: OFFICE, group: "Stock", icon: "receive" },
  { href: "/closing", label: "Daily Closing", roles: OFFICE, group: "Money & Reports", icon: "banknotes" },
  { href: "/expenses", label: "Expenses", roles: OFFICE, group: "Money & Reports", icon: "expenses" },
  { href: "/reports", label: "Reports", roles: OFFICE, group: "Money & Reports", icon: "chart" },
  { href: "/audit", label: "Audit History", roles: OFFICE, group: "Money & Reports", icon: "audit" },
  { href: "/users", label: "Users", roles: ["OWNER"], group: "Admin", icon: "users" },
  { href: "/settings", label: "Settings", roles: ["OWNER"], group: "Admin", icon: "settings" },
  { href: "/setup", label: "Setup", roles: OFFICE, group: "Admin", icon: "setup" },
];

/** Pages that exist but are not in the menu. */
const EXTRA: NavItem[] = [
  { href: "/day/start", label: "Start Day", roles: ALL, icon: "calendar" },
  { href: "/sale", label: "Daily Sheet", roles: ALL, icon: "document" },  // the old New Sale address; it now opens the Daily Sheet
  { href: "/change-password", label: "Change Password", roles: ALL, icon: "settings" },
  { href: "/help", label: "Help", roles: ALL, icon: "help" },
  // Taken off the menu at the owner's request (13 Oct 2026). The data is kept; Setup still links here for the open questions.
  { href: "/history", label: "Excel History", roles: OFFICE, icon: "document" },
];

export function navFor(role: Role): NavItem[] {
  return NAV.filter((item) => item.roles.includes(role));
}

/** The role's menu under its group headings. A group with nothing in it for this role is left out. */
export function navGroupsFor(role: Role): { group: NavGroup; items: NavItem[] }[] {
  const items = navFor(role);
  return NAV_GROUPS.map((group) => ({ group, items: items.filter((item) => item.group === group) })).filter((g) => g.items.length > 0);
}

/** The group whose entry is the page on screen, if that page is in the role's menu. */
export function groupOf(role: Role, path: string): NavGroup | undefined {
  return navFor(role).find((item) => isActive(item.href, path))?.group;
}

/** The menu entry for a page, so a sub-page such as /day/close lights up its own entry and not Home. */
export function isActive(href: string, path: string): boolean {
  return href === "/" ? path === "/" : path === href || path.startsWith(href + "/");
}

export function canOpen(role: Role, path: string): boolean {
  const match = [...NAV, ...EXTRA]
    .filter((item) => (item.href === "/" ? path === "/" : path === item.href || path.startsWith(item.href + "/")))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return match ? match.roles.includes(role) : false;
}
