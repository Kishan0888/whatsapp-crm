import { requireUser, CAN_EDIT_LEADS } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import type { Segment, Tag } from "@/lib/types";
import { LeadForm } from "../lead-form";

export const metadata = { title: "Add lead" };

export default async function NewLeadPage() {
  await requireUser(CAN_EDIT_LEADS);
  const supabase = await createClient();
  const [{ data: segments }, { data: tags }] = await Promise.all([
    supabase.from("segments").select("*").order("sort_order"),
    supabase.from("tags").select("*").order("name"),
  ]);
  return (
    <>
      <PageHeader title="Add lead" description="New leads start with unknown marketing consent." />
      <div className="max-w-3xl">
        <LeadForm segments={(segments ?? []) as Segment[]} tags={(tags ?? []) as Tag[]} canEdit />
      </div>
    </>
  );
}
