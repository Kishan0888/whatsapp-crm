"use client";
import Link from "next/link";
import { Suspense } from "react";
import { usePathname } from "next/navigation";
import { BarChart3, FileText, LayoutDashboard, Megaphone, MessagesSquare, Settings, Upload, Users, History, ScrollText } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/inbox", label: "Inbox", icon: MessagesSquare },
  { href: "/leads", label: "Leads", icon: Users, exact: true },
  { href: "/leads/import", label: "Import leads", icon: Upload },
  { href: "/imports", label: "Import history", icon: History },
  { href: "/templates", label: "Templates", icon: FileText },
  { href: "/campaigns", label: "Campaigns", icon: Megaphone },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/audit", label: "Audit log", icon: ScrollText },
  { href: "/settings", label: "Settings", icon: Settings },
];

function NavLinks({ pathname }: { pathname: string }) {
  return (
    <nav className="grid gap-0.5">
      {NAV.map(({ href, label, icon: Icon, exact }) => {
        const active = exact ? pathname === href || (href === "/leads" && /^\/leads\/[0-9a-f-]{36}/.test(pathname)) : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-white",
              active && "bg-sidebar-accent font-medium text-white",
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

function ActiveNav() {
  return <NavLinks pathname={usePathname()} />;
}

/** Static links render in the prerendered shell; active state streams in. */
export function SidebarNav() {
  return (
    <Suspense fallback={<NavLinks pathname="" />}>
      <ActiveNav />
    </Suspense>
  );
}
