export default function InboxLoading() {
  return (
    <div className="-m-4 flex h-[calc(100svh-3.5rem)] animate-pulse border-y bg-card md:-m-8 md:h-svh md:border-y-0" aria-busy="true" aria-label="Loading inbox">
      <div className="w-full space-y-3 border-r p-3 md:w-80 lg:w-96">
        <div className="h-9 rounded-md bg-muted" />
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="flex gap-3">
            <div className="size-9 rounded-full bg-muted" />
            <div className="flex-1 space-y-1.5"><div className="h-3 w-2/3 rounded bg-muted" /><div className="h-3 w-full rounded bg-muted" /></div>
          </div>
        ))}
      </div>
      <div className="hidden flex-1 flex-col gap-3 p-6 md:flex">
        <div className="h-6 w-48 rounded bg-muted" />
        <div className="h-14 w-1/2 rounded-lg bg-muted" />
        <div className="ml-auto h-14 w-1/2 rounded-lg bg-muted" />
        <div className="h-10 w-1/3 rounded-lg bg-muted" />
      </div>
    </div>
  );
}
