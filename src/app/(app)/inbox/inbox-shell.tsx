import { cn } from "@/lib/utils";

/** Two-pane layout; on small screens only one pane shows at a time. */
export function InboxShell({ list, thread, hasThread }: { list: React.ReactNode; thread: React.ReactNode; hasThread: boolean }) {
  return (
    <div className="-m-4 flex h-[calc(100svh-3.5rem)] overflow-hidden border-y bg-card md:-m-8 md:h-svh md:border-y-0">
      <aside className={cn("w-full min-h-0 border-r md:block md:w-80 lg:w-96", hasThread ? "hidden" : "block")}>{list}</aside>
      <section className={cn("min-h-0 min-w-0 flex-1 md:block", hasThread ? "block" : "hidden")}>{thread}</section>
    </div>
  );
}
