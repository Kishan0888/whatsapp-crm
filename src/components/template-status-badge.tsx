import { Badge } from "@/components/ui/badge";

export function TemplateStatusBadge({ status }: { status: string }) {
  const v =
    status === "APPROVED" ? "success" :
    ["REJECTED", "DISABLED", "DELETED"].includes(status) ? "destructive" :
    ["PENDING", "IN_APPEAL", "PAUSED", "FLAGGED", "LIMIT_EXCEEDED"].includes(status) ? "warning" : "secondary";
  return <Badge variant={v}>{status.replace(/_/g, " ").toLowerCase()}</Badge>;
}
