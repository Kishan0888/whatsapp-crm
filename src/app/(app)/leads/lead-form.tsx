"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Lead, Segment, Tag } from "@/lib/types";
import { createTag, saveLead, setArchived } from "./actions";

const FIELDS: { name: keyof Lead; label: string; type?: string }[] = [
  { name: "full_name", label: "Contact name" },
  { name: "organization", label: "Organization" },
  { name: "email", label: "Email", type: "email" },
  { name: "city", label: "City" },
  { name: "state", label: "State" },
  { name: "country", label: "Country" },
  { name: "source", label: "Source" },
];

export function LeadForm({
  lead,
  tagIds: initialTagIds = [],
  segments,
  tags: initialTags,
  canEdit,
}: {
  lead?: Lead;
  tagIds?: string[];
  segments: Segment[];
  tags: Tag[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [tags, setTags] = useState(initialTags);
  const [tagIds, setTagIds] = useState<string[]>(initialTagIds);
  const [newTag, setNewTag] = useState("");

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const str = (k: string) => String(fd.get(k) ?? "");
    start(async () => {
      const r = await saveLead({
        id: lead?.id,
        full_name: str("full_name"),
        organization: str("organization"),
        phone: str("phone"),
        email: str("email"),
        city: str("city"),
        state: str("state"),
        country: str("country"),
        source: str("source"),
        notes: str("notes"),
        segment_id: str("segment_id"),
        status: str("status") as Lead["status"],
        tag_ids: tagIds,
      });
      if (!r.ok) return void toast.error(r.error);
      toast.success(lead ? "Lead saved" : "Lead created");
      if (!lead && r.data) router.push(`/leads/${r.data.id}`);
      else router.refresh();
    });
  }

  function addTag() {
    if (!newTag.trim()) return;
    start(async () => {
      const r = await createTag(newTag);
      if (!r.ok || !r.data) return void toast.error(r.ok ? "Failed" : r.error);
      const created = r.data;
      setTags((t) => (t.some((x) => x.id === created.id) ? t : [...t, { id: created.id, name: created.name, color: "#64748b" }]));
      setTagIds((ids) => (ids.includes(created.id) ? ids : [...ids, created.id]));
      setNewTag("");
    });
  }

  return (
    <form onSubmit={onSubmit}>
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <fieldset disabled={!canEdit || pending} className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="phone">Phone (WhatsApp) *</Label>
              <Input id="phone" name="phone" required defaultValue={lead?.phone_e164 ?? ""} placeholder="+91 98100 00000" />
              <p className="text-xs text-muted-foreground">Numbers without a country code are treated as Indian (+91).</p>
            </div>
            {FIELDS.map((f) => (
              <div key={f.name} className="grid gap-2">
                <Label htmlFor={f.name}>{f.label}</Label>
                <Input id={f.name} name={f.name} type={f.type} defaultValue={(lead?.[f.name] as string | null) ?? ""} />
              </div>
            ))}
            <div className="grid gap-2">
              <Label htmlFor="segment_id">Segment</Label>
              <NativeSelect id="segment_id" name="segment_id" defaultValue={lead?.segment_id ?? ""}>
                <option value="">No segment</option>
                {segments.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="status">Lead status</Label>
              <NativeSelect id="status" name="status" defaultValue={lead?.status ?? "new"}>
                {["new", "contacted", "interested", "not_interested", "converted"].map((s) => (
                  <option key={s} value={s}>{s.replace("_", " ")}</option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label>Tags</Label>
              <div className="flex flex-wrap gap-2">
                {tags.map((t) => (
                  <label key={t.id} className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-sm has-checked:border-primary has-checked:bg-accent">
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={tagIds.includes(t.id)}
                      onChange={(e) => setTagIds((ids) => (e.target.checked ? [...ids, t.id] : ids.filter((x) => x !== t.id)))}
                    />
                    {t.name}
                  </label>
                ))}
                <div className="flex gap-1">
                  <Input className="h-8 w-36" placeholder="New tag" value={newTag} onChange={(e) => setNewTag(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(); } }} />
                  <Button type="button" size="sm" variant="outline" onClick={addTag}>Add</Button>
                </div>
              </div>
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="notes">Notes</Label>
              <Textarea id="notes" name="notes" rows={4} defaultValue={lead?.notes ?? ""} />
            </div>
          </fieldset>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={pending}>{pending ? "Saving…" : lead ? "Save changes" : "Create lead"}</Button>
              {lead && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      const r = await setArchived([lead.id], !lead.is_archived);
                      if (r.ok) { toast.success(r.message ?? "Done"); router.refresh(); } else toast.error(r.error);
                    })
                  }
                >
                  {lead.is_archived ? "Restore lead" : "Archive lead"}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </form>
  );
}
