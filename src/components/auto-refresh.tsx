"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Re-render server data periodically while `active` (and the tab is visible). */
export function AutoRefresh({ active, intervalMs = 10_000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs, router]);
  return null;
}
