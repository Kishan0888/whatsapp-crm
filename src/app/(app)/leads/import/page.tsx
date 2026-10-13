import { requireUser, CAN_EDIT_LEADS } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/page-header";
import type { Segment, Tag } from "@/lib/types";
import { ImportWizard } from "./import-wizard";

export const metadata = { title: "Import leads" };

export default async function ImportPage() {
  await requireUser(CAN_EDIT_LEADS);
  const supabase = await createClient();
  const [{ data: segments }, { data: tags }] = await Promise.all([
    supabase.from("segments").select("*").order("sort_order"),
    supabase.from("tags").select("*").order("name"),
  ]);
  return (
    <>
      <PageHeader
        title="Import leads"
        description="Phone numbers are validated and normalised to international format. Duplicates are detected by phone number."
      />
      <ImportWizard segments={(segments ?? []) as Segment[]} tags={(tags ?? []) as Tag[]} />
    </>
  );
}
