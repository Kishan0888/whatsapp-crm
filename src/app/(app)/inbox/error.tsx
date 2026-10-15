"use client";
import { Button } from "@/components/ui/button";

export default function InboxError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border bg-card p-6 text-center">
      <h2 className="font-semibold">The inbox couldn&apos;t be loaded</h2>
      <p className="mt-1 text-sm text-muted-foreground">{error.digest ? `Reference: ${error.digest}` : "Please try again."}</p>
      <Button className="mt-4" onClick={reset}>Try again</Button>
    </div>
  );
}
