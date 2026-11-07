import {
  Bell,
  CalendarDays,
  Gift,
  LayoutDashboard,
  type LucideIcon,
  Map as MapIcon,
  Music,
  Package,
  Repeat,
  Zap,
} from "lucide-react";

export type NavItem = { title: string; href: string; icon: LucideIcon };
export type NavGroup = { label: string; items: NavItem[]; localOnly?: boolean };

export const NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [{ title: "Dashboard", href: "/admin", icon: LayoutDashboard }],
  },
  {
    label: "Live ops",
    items: [
      { title: "Events", href: "/admin/events", icon: CalendarDays },
      { title: "Series", href: "/admin/series", icon: Repeat },
      { title: "XP", href: "/admin/xp", icon: Zap },
      { title: "Song pool", href: "/admin/song-pool", icon: Music },
      { title: "Notifications", href: "/admin/notifications", icon: Bell },
    ],
  },
  {
    label: "Content",
    items: [
      { title: "Items", href: "/admin/items", icon: Package },
      { title: "Grant item", href: "/admin/players", icon: Gift },
    ],
  },
  {
    label: "Workshop",
    localOnly: true,
    items: [
      { title: "Map editor", href: "/admin/workshop/maps", icon: MapIcon },
    ],
  },
];

/** The nav entry a path belongs to (the longest matching href). */
export function activeNavItem(pathname: string): NavItem | undefined {
  let best: NavItem | undefined;
  for (const group of NAV) {
    for (const item of group.items) {
      const match =
        item.href === "/admin"
          ? pathname === "/admin"
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
      if (match && (!best || item.href.length > best.href.length)) best = item;
    }
  }
  return best;
}
