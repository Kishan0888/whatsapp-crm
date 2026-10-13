import { Badge } from "@/components/ui/badge";
import type { ConsentStatus } from "@/lib/types";

export function ConsentBadge({ status }: { status: ConsentStatus }) {
  if (status === "opted_in") return <Badge variant="success">Opted in</Badge>;
  if (status === "opted_out") return <Badge variant="destructive">Opted out</Badge>;
  return <Badge variant="secondary">Unknown</Badge>;
}
