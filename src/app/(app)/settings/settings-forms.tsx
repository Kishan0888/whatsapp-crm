"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Profile } from "@/lib/types";
import { createGrowthTemplateDraft, inviteUser, saveAutomationSettings, saveSettings, updateUser } from "./actions";

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        toast.success(r.message ?? "Saved");
        after?.();
        router.refresh();
      } else toast.error(r.error);
    });
  return { pending, run };
}

const ROLES = ["admin", "manager", "agent", "viewer"] as const;

export function UsersTable({ users, meId, isAdmin }: { users: Profile[]; meId: string; isAdmin: boolean }) {
  const { pending, run } = useRun();
  return (
    <Table>
      <TableHeader>
        <TableRow><TableHead>User</TableHead><TableHead>Role</TableHead><TableHead>Active</TableHead></TableRow>
      </TableHeader>
      <TableBody>
        {users.map((u) => (
          <TableRow key={u.id}>
            <TableCell>
              <div className="font-medium">{u.full_name ?? "—"}{u.id === meId && <span className="ml-1 text-xs text-muted-foreground">(you)</span>}</div>
              <div className="text-xs text-muted-foreground">{u.email}</div>
            </TableCell>
            <TableCell>
              <NativeSelect className="h-8 w-32" defaultValue={u.role} disabled={!isAdmin || pending || u.id === meId}
                onChange={(e) => run(() => updateUser({ id: u.id, role: e.target.value, is_active: u.is_active }))}>
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </NativeSelect>
            </TableCell>
            <TableCell>
              <input type="checkbox" aria-label="Active" defaultChecked={u.is_active} disabled={!isAdmin || pending || u.id === meId}
                onChange={(e) => run(() => updateUser({ id: u.id, role: u.role, is_active: e.target.checked }))} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function InviteForm() {
  const { pending, run } = useRun();
  return (
    <form
      className="grid gap-2 sm:grid-cols-4"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const fd = new FormData(form);
        run(() => inviteUser({ email: String(fd.get("email")), full_name: String(fd.get("full_name")), role: String(fd.get("role")) }), () => form.reset());
      }}
    >
      <Input name="email" type="email" placeholder="Email" required />
      <Input name="full_name" placeholder="Full name" />
      <NativeSelect name="role" defaultValue="agent">{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</NativeSelect>
      <Button disabled={pending}>Send invite</Button>
    </form>
  );
}

export function MetaSettingsForm({ settings, disabled }: { settings: Record<string, string | number | null>; disabled: boolean }) {
  const { pending, run } = useRun();
  const field = (name: string, label: string, hint?: string, type = "text") => (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} type={type} step="0.0001" defaultValue={String(settings[name] ?? "")} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        run(() => saveSettings(Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]))));
      }}
    >
      <fieldset disabled={disabled || pending} className="grid gap-4 sm:grid-cols-2">
        {field("waba_id", "WhatsApp Business Account ID")}
        {field("phone_number_id", "Phone number ID", "From WhatsApp Manager → API Setup")}
        {field("business_display_name", "Business display name")}
        {field("graph_api_version", "Graph API version", "e.g. v23.0 — check Meta's changelog before changing")}
        {field("currency", "Currency for estimates")}
        {field("send_rate_per_second", "Max sends per second", "Throttle for the background sender", "number")}
        {field("est_rate_marketing", "Estimated cost per marketing message", "Used only for estimates. Take it from Meta's current rate card for your recipients' country.", "number")}
        {field("est_rate_utility", "Estimated cost per utility message", undefined, "number")}
        <div className="sm:col-span-2"><Button disabled={disabled || pending}>Save WhatsApp settings</Button></div>
      </fieldset>
    </form>
  );
}

export function AutomationForm({
  meetingUrl,
  templateId,
  templates,
  disabled,
}: {
  meetingUrl: string;
  templateId: string;
  templates: { id: string; name: string; language: string }[];
  disabled: boolean;
}) {
  const router = useRouter();
  const { pending, run } = useRun();
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        run(() => saveAutomationSettings({ meeting_url: String(fd.get("meeting_url") ?? ""), growth_report_template_id: String(fd.get("growth_report_template_id") ?? "") }));
      }}
    >
      <fieldset disabled={disabled || pending} className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="meeting_url">Meeting / calendar URL</Label>
          <Input id="meeting_url" name="meeting_url" type="url" placeholder="https://calendly.com/your-team/30min" defaultValue={meetingUrl} />
          <p className="text-xs text-muted-foreground">Sent when someone taps “Free Growth Report”. While empty, the tap is logged in the inbox for a manual reply.</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="growth_report_template_id">Reply with</Label>
          <NativeSelect id="growth_report_template_id" name="growth_report_template_id" defaultValue={templateId}>
            <option value="">Interactive message — button “Schedule Meeting” (no approval needed)</option>
            {templates.map((t) => <option key={t.id} value={t.id}>Template: {t.name} ({t.language})</option>)}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">
            WhatsApp limits interactive button labels to 20 characters. For the exact label “Schedule Your Meeting”, use an approved template with a URL button.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 sm:col-span-2">
          <Button disabled={disabled || pending}>Save automation settings</Button>
          <Button type="button" variant="outline" disabled={disabled || pending || !meetingUrl}
            onClick={() => run(async () => {
              const r = await createGrowthTemplateDraft();
              if (r.ok && r.id) router.push(`/templates/${r.id}`);
              return r;
            })}>
            Create “Schedule Your Meeting” template draft
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
