"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { groupOf, isActive, navGroupsFor, type NavGroup, type NavIcon } from "@/lib/nav";
import type { Role } from "@/lib/types";

const GROUP_ICONS: Record<NavGroup, NavIcon> = {
  Selling: "receipt",
  Stock: "box",
  "Money & Reports": "chart",
  Admin: "settings",
};

/**
 * 3D icons from Microsoft's Fluent Emoji set (MIT licence, see public/icons/3d/LICENSE-fluentui-emoji.txt),
 * kept in public/icons/3d so the menu needs no internet. Each file is named after its NavIcon.
 */
function SidebarIcon({ name }: { name: NavIcon }) {
  return <img src={`/icons/3d/${name}.png`} alt="" aria-hidden="true" width={20} height={20} draggable={false} className="h-5 w-5 shrink-0 select-none" />;
}

/**
 * The sidebar menu: four groups that open and close on a click. Several can be open at once.
 * The group holding the page on screen opens by itself, so the current page is always shown highlighted.
 */
export function SidebarNav({ role, pathname }: { role: Role; pathname: string }) {
  const groups = navGroupsFor(role);
  const current = groupOf(role, pathname);
  const [open, setOpen] = useState<Set<NavGroup>>(() => new Set(current ? [current] : []));

  // Going to a page in a closed group opens that group; groups already open stay open.
  useEffect(() => {
    if (current) setOpen((was) => (was.has(current) ? was : new Set(was).add(current)));
  }, [current]);

  function toggle(group: NavGroup) {
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(group)) next.add(group);
      return next;
    });
  }

  return (
    <>
      {groups.map(({ group, items }) => {
        const expanded = open.has(group);
        const id = `menu-group-${group.toLowerCase().replace(/[^a-z]+/g, "-")}`;
        const holdsCurrent = group === current;
        return (
          <div key={group} className="border-b border-slate-200 shadow-[0_2px_4px_rgba(15,23,42,0.08)]">
            <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => toggle(group)}
              className={`flex min-h-11 w-full items-center justify-between px-3 py-2 text-left text-base font-medium transition-colors ${
                holdsCurrent && !expanded
                  ? "bg-slate-100 text-slate-900 hover:bg-slate-100 active:bg-slate-200"
                  : "text-slate-600 hover:bg-slate-50 hover:text-slate-900 active:bg-slate-100"
              }`}>
              <span className="flex items-center gap-2"><SidebarIcon name={GROUP_ICONS[group]} />{group}</span>
              <svg aria-hidden viewBox="0 0 24 24" className={`h-5 w-5 text-slate-500 transition-transform ${expanded ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
            <ul id={id} hidden={!expanded}>
              {items.map((item) => {
                const active = isActive(item.href, pathname);
                return (
                  <li key={item.href}>
                    <Link href={item.href} aria-current={active ? "page" : undefined}
                      className={`flex min-h-11 items-center gap-2 border-t border-slate-100 py-2 pl-7 pr-3 text-base font-medium ${
                        active ? "bg-slate-100 text-slate-900" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                      }`}>
                      <SidebarIcon name={item.icon} />
                      <span>{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {/* Help is for everyone, so it sits on its own below the groups and is always showing. */}
      <div className="mt-2 border-y border-slate-200 shadow-[0_2px_4px_rgba(15,23,42,0.08)]">
        <Link href="/help" aria-current={isActive("/help", pathname) ? "page" : undefined}
          className={`flex min-h-11 items-center gap-2 px-3 py-2 text-base font-medium ${
            isActive("/help", pathname) ? "bg-slate-100 text-slate-900" : "text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 active:bg-slate-100"
          }`}>
          <SidebarIcon name="help" />
          Help
        </Link>
      </div>
    </>
  );
}
