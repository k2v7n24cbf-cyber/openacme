import { Link, linkOptions, useLocation } from "@tanstack/react-router";
import {
  Home,
  Bot,
  BookOpen,
  ListChecks,
  Settings,
  Users,
  Workflow,
} from "lucide-react";
import { cn } from "@/app/lib/utils";

const navItems = [
  { link: linkOptions({ to: "/" }), label: "Home", icon: Home },
  { link: linkOptions({ to: "/agents" }), label: "Agents", icon: Bot },
  { link: linkOptions({ to: "/teams" }), label: "Teams", icon: Users },
  { link: linkOptions({ to: "/tasks" }), label: "Tasks", icon: ListChecks },
  { link: linkOptions({ to: "/workflows" }), label: "Flows", icon: Workflow },
  { link: linkOptions({ to: "/skills" }), label: "Skills", icon: BookOpen },
  { link: linkOptions({ to: "/settings" }), label: "Settings", icon: Settings },
];

/**
 * Mobile bottom tab bar. Replaces the hamburger drawer pattern with a
 * fixed bar of icon+label entries at the bottom of the viewport — the
 * convention for native iOS/Android apps with 3-5 top-level sections.
 * Hidden on md+ where the persistent left sidebar takes over.
 *
 * Position: fixed bottom-0 so it sits above content regardless of scroll
 * position. Safe-area-inset-bottom padding for iPhone home-indicator
 * clearance. Page content needs `pb-mobile-tabbar` to keep its tail
 * scrollable above the bar — handled in the root layout wrapper.
 */
export function MobileTabBar() {
  const pathname = useLocation({ select: (l) => l.pathname });
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-paper-rule bg-paper-sunk pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid grid-cols-6">
        {navItems.map((item) => {
          const isActive =
            item.link.to === "/"
              ? pathname === "/"
              : pathname.startsWith(item.link.to);
          const Icon = item.icon;
          return (
            <li key={item.link.to}>
              <Link
                {...item.link}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex h-14 flex-col items-center justify-center gap-0.5 text-[10px] uppercase tracking-[0.08em] transition-colors",
                  isActive ? "text-plot-red" : "text-ink-soft hover:text-ink",
                )}
              >
                <Icon className="size-5" aria-hidden />
                <span className="font-mono">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
