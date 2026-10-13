import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireUser, CAN_EDIT_LEADS } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fmtDate } from "@/lib/utils";
import type { Lead, Segment, Tag } from "@/lib/types";
import { LeadForm } from "../lead-form";
import { ConsentPanel, type ConsentEvent } from "../consent-panel";

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { profile } = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const supabase = await createClient();
  const [{ data: lead }, { data: segments }, { data: tags }, { data: leadTags }, { data: events }] = await Promise.all([
    supabase.from("leads").select("*").eq("id", id).maybeSingle(),
    supabase.from("segments").select("*").order("sort_order"),
    supabase.from("tags").select("*").order("name"),
    supabase.from("lead_tags").select("tag_id").eq("lead_id", id),
    supabase.from("consent_events").select("id, status, source, evidence, created_at").eq("lead_id", id).order("created_at", { ascending: false }),
  ]);
  if (!lead) notFound();
  const l = lead as Lead;
  const canEdit = CAN_EDIT_LEADS.includes(profile.role);
  const custom = Object.entries(l.custom_fields ?? {});

  return (
    <>
      <Link href="/leads" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Leads
      </Link>
      <PageHeader
        title={l.full_name || l.organization || "Unnamed lead"}
        description={`${l.phone_e164 ?? "No phone"} · added ${fmtDate(l.created_at)}`}
        actions={l.is_archived ? <Badge variant="warning">Archived</Badge> : undefined}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <LeadForm
            lead={l}
            tagIds={(leadTags ?? []).map((t) => t.tag_id)}
            segments={(segments ?? []) as Segment[]}
            tags={(tags ?? []) as Tag[]}
            canEdit={canEdit}
          />
        </div>
        <div className="grid content-start gap-4">
          <ConsentPanel
            leadId={l.id}
            status={l.marketing_consent}
            source={l.consent_source}
            events={(events ?? []) as ConsentEvent[]}
            canEdit={canEdit}
          />
          {custom.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Imported fields</CardTitle></CardHeader>
              <CardContent>
                <dl className="grid gap-2 text-sm">
                  {custom.map(([k, v]) => (
                    <div key={k} className="grid grid-cols-2 gap-2">
                      <dt className="truncate text-muted-foreground">{k}</dt>
                      <dd className="break-words">{String(v)}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          )}
          {l.import_id && (
            <Link href={`/imports/${l.import_id}`} className="text-sm text-primary hover:underline">View source import</Link>
          )}
        </div>
      </div>
    </>
  );
}
