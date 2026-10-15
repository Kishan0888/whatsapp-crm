import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { whatsappMode } from "@/lib/env";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Profile, Segment } from "@/lib/types";
import { isGrowthTemplateUsable } from "@/lib/inbox/deps";
import type { WhatsAppTemplate } from "@/lib/types";
import { AutomationForm, InviteForm, MetaSettingsForm, UsersTable } from "./settings-forms";

export const metadata = { title: "Settings" };

const secretStatus = (name: string) => (process.env[name] ? <Badge variant="success">Set</Badge> : <Badge variant="secondary">Missing</Badge>);

export default async function SettingsPage() {
  const { profile } = await requireUser();
  const isAdmin = profile.role === "admin";
  const supabase = await createClient();
  const [{ data: users }, { data: settings }, { data: segments }, { data: approved }] = await Promise.all([
    supabase.from("profiles").select("*").order("created_at"),
    supabase.from("app_settings").select("*").single(),
    supabase.from("segments").select("*").order("sort_order"),
    supabase.from("whatsapp_templates").select("id, name, language, status, components").eq("status", "APPROVED").order("name"),
  ]);
  const growthTemplates = ((approved ?? []) as Pick<WhatsAppTemplate, "id" | "name" | "language" | "status" | "components">[]).filter(isGrowthTemplateUsable);
  const mode = whatsappMode();

  return (
    <>
      <PageHeader title="Settings" description={isAdmin ? undefined : "Only admins can change settings."} />
      <div className="grid gap-4">
        <Card>
          <CardHeader>
            <CardTitle>WhatsApp Cloud API</CardTitle>
            <CardDescription>
              Mode: <Badge variant={mode === "live" ? "default" : "warning"}>{mode}</Badge>. Secrets are read from server environment variables only and are never stored in the database or sent to the browser.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            <div className="grid gap-2 text-sm sm:grid-cols-3">
              <div className="flex items-center justify-between rounded-md border p-2">WHATSAPP_ACCESS_TOKEN {secretStatus("WHATSAPP_ACCESS_TOKEN")}</div>
              <div className="flex items-center justify-between rounded-md border p-2">WHATSAPP_APP_SECRET {secretStatus("WHATSAPP_APP_SECRET")}</div>
              <div className="flex items-center justify-between rounded-md border p-2">WEBHOOK_VERIFY_TOKEN {secretStatus("WHATSAPP_WEBHOOK_VERIFY_TOKEN")}</div>
              <div className="flex items-center justify-between rounded-md border p-2">WHATSAPP_APP_ID {secretStatus("WHATSAPP_APP_ID")}</div>
              <div className="flex items-center justify-between rounded-md border p-2">WORKER_SECRET {secretStatus("WORKER_SECRET")}</div>
            </div>
            <div className="rounded-md bg-muted/50 p-3 text-sm">
              <div className="font-medium">Webhook callback URL</div>
              <code className="break-all text-xs">{(process.env.NEXT_PUBLIC_APP_URL ?? "https://your-domain") + "/api/webhooks/whatsapp"}</code>
              <p className="mt-1 text-xs text-muted-foreground">In your Meta app → WhatsApp → Configuration, use this URL and your verify token, then subscribe to the <strong>messages</strong> and <strong>message_template_status_update</strong> fields.</p>
            </div>
            {settings && <MetaSettingsForm settings={settings} disabled={!isAdmin} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Inbox automation</CardTitle>
            <CardDescription>
              Replies to the “Free Growth Report” and “Send Details” quick-reply buttons. Replies are sent directly (not through the campaign sender) and only inside WhatsApp&apos;s 24-hour service window.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AutomationForm
              meetingUrl={(settings?.meeting_url as string | null) ?? ""}
              templateId={(settings?.growth_report_template_id as string | null) ?? ""}
              templates={growthTemplates}
              disabled={!isAdmin}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Team &amp; roles</CardTitle>
            <CardDescription>
              Admin: everything · Manager: leads, templates, campaigns · Agent: leads and imports · Viewer: read-only.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {isAdmin && <InviteForm />}
            <UsersTable users={(users ?? []) as Profile[]} meId={profile.id} isAdmin={isAdmin} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Segments</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {(segments as Segment[] | null)?.map((s) => (
              <span key={s.id} className="inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
                <span className="size-2.5 rounded-full" style={{ background: s.color }} /> {s.name}
              </span>
            ))}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
