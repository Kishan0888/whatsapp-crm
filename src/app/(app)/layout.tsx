import { Suspense } from "react";
import { connection } from "next/server";
import { LogOut, Menu, MessageCircle } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { signOut } from "@/app/login/actions";
import { SidebarNav } from "@/components/sidebar-nav";
import { whatsappMode } from "@/lib/env";

/** Signed-in user block. Also enforces auth for the whole (app) group. */
async function UserBlock() {
  const { profile } = await requireUser();
  return (
    <>
      <div className="truncate font-medium text-sidebar-foreground">{profile.full_name ?? profile.email}</div>
      <div className="capitalize">{profile.role}</div>
      <form action={signOut} className="mt-2">
        <button className="flex items-center gap-2 hover:text-white" type="submit">
          <LogOut className="size-3.5" /> Sign out
        </button>
      </form>
    </>
  );
}

async function ModeBanner() {
  await connection(); // read env at request time, not build time
  if (whatsappMode() !== "mock") return null;
  return (
    <div className="border-b bg-amber-500/10 px-6 py-1.5 text-xs text-amber-800 dark:text-amber-300">
      WhatsApp is in <strong>mock mode</strong>: nothing is submitted to or sent through Meta. Set WHATSAPP_MODE=live to enable real API calls.
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="animate-pulse space-y-4">
      <div className="h-8 w-48 rounded bg-muted" />
      <div className="grid gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 rounded-xl bg-muted" />)}
      </div>
      <div className="h-72 rounded-xl bg-muted" />
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh">
      <aside className="sticky top-0 hidden h-svh w-60 shrink-0 flex-col bg-sidebar p-3 md:flex">
        <div className="flex items-center gap-2 px-3 py-3 text-white">
          <div className="flex size-8 items-center justify-center rounded-md bg-primary">
            <MessageCircle className="size-4" />
          </div>
          <span className="font-semibold">WhatsApp CRM</span>
        </div>
        <div className="mt-4 flex-1">
          <SidebarNav />
        </div>
        <div className="min-h-16 border-t border-white/10 px-3 pt-3 text-xs text-sidebar-foreground/70">
          <Suspense fallback={null}>
            <UserBlock />
          </Suspense>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <Suspense fallback={null}>
          <ModeBanner />
        </Suspense>
        <details className="group border-b bg-sidebar text-sidebar-foreground md:hidden">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3">
            <span className="font-semibold text-white">WhatsApp CRM</span>
            <Menu className="size-5" />
          </summary>
          <div className="px-2 pb-3"><SidebarNav /></div>
        </details>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 md:p-8">
          <Suspense fallback={<PageSkeleton />}>{children}</Suspense>
        </main>
      </div>
    </div>
  );
}
