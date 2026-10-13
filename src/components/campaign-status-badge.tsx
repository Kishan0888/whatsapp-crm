import { Badge } from "@/components/ui/badge";

export function CampaignStatusBadge({ status, dryRun }: { status: string; dryRun?: boolean }) {
  const v = status === "running" ? "default" : status === "completed" ? "success" : status === "paused" ? "warning" : status === "cancelled" || status === "failed" ? "destructive" : "secondary";
  return (
    <span className="inline-flex gap-1">
      <Badge variant={v}>{status}</Badge>
      {dryRun && <Badge variant="outline">dry run</Badge>}
    </span>
  );
}
