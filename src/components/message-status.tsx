import { AlertCircle, Check, CheckCheck, Clock, FlaskConical, MinusCircle } from "lucide-react";

const LABEL: Record<string, string> = {
  pending: "Queued", queued: "Queued", sending: "Sending", sent: "Sent", delivered: "Delivered", read: "Read",
  failed: "Failed", mock: "Not sent (mock mode)", dry_run: "Dry run (not sent)", skipped: "Not sent", cancelled: "Cancelled",
};

/** WhatsApp-style ticks; statuses come only from the Cloud API response and webhooks. */
export function MessageStatus({ status }: { status: string }) {
  const label = LABEL[status] ?? status;
  const icon =
    status === "read" ? <CheckCheck className="size-3.5 text-sky-500" /> :
    status === "delivered" ? <CheckCheck className="size-3.5" /> :
    status === "sent" ? <Check className="size-3.5" /> :
    status === "failed" ? <AlertCircle className="size-3.5 text-destructive" /> :
    status === "mock" || status === "dry_run" ? <FlaskConical className="size-3.5" /> :
    status === "skipped" || status === "cancelled" ? <MinusCircle className="size-3.5" /> :
    <Clock className="size-3.5" />;
  return <span className="inline-flex items-center gap-1" title={label} aria-label={label}>{icon}</span>;
}
