"use client";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TemplatePreview } from "@/components/template-preview";
import { templateShape } from "@/lib/whatsapp/templates";
import { LEAD_FIELDS, resolveVar, validateMapping, type HeaderMedia, type VarSource, type VariableMapping } from "@/lib/whatsapp/send";
import { fmtInt, fmtMoney } from "@/lib/utils";
import type { Segment, Tag, WhatsAppTemplate } from "@/lib/types";
import { previewAudience, saveCampaign, type AudiencePreview } from "./actions";

export interface BuilderInitial {
  name: string;
  templateId: string;
  segmentIds: string[];
  tagIds: string[];
  tagMatch: "any" | "all";
  mapping: VariableMapping;
  media: HeaderMedia | null;
}

export function CampaignBuilder({
  id,
  initial,
  templates,
  segments,
  tags,
  customKeys,
  estRates,
  currency,
  live,
}: {
  id: string | null;
  initial?: BuilderInitial;
  templates: WhatsAppTemplate[];
  segments: Segment[];
  tags: Tag[];
  customKeys: string[];
  estRates: { MARKETING: number; UTILITY: number };
  currency: string;
  live: boolean;
}) {
  const router = useRouter();
  const [name, setName] = useState(initial?.name ?? "");
  const [templateId, setTemplateId] = useState(initial?.templateId ?? "");
  const [segmentIds, setSegmentIds] = useState<string[]>(initial?.segmentIds ?? []);
  const [tagIds, setTagIds] = useState<string[]>(initial?.tagIds ?? []);
  const [tagMatch, setTagMatch] = useState<"any" | "all">(initial?.tagMatch ?? "any");
  const [mapping, setMapping] = useState<VariableMapping>(initial?.mapping ?? {});
  const [media, setMedia] = useState<HeaderMedia | null>(initial?.media ?? null);
  const [audience, setAudience] = useState<AudiencePreview | null>(null);
  const [loadingAudience, setLoadingAudience] = useState(false);
  const [pending, start] = useTransition();

  const template = templates.find((t) => t.id === templateId);
  const shape = useMemo(() => (template ? templateShape(template.components) : null), [template]);

  // Refresh the audience preview whenever filters change.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoadingAudience(true);
      const r = await previewAudience({ segment_ids: segmentIds, tag_ids: tagIds, tag_match: tagMatch });
      if (cancelled) return;
      setLoadingAudience(false);
      if (r.ok) setAudience(r.data);
      else toast.error(r.error);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [segmentIds, tagIds, tagMatch]);

  function chooseTemplate(id: string) {
    setTemplateId(id);
    setMapping({});
    const t = templates.find((x) => x.id === id);
    const mh = t ? templateShape(t.components).mediaHeader : null;
    const type = mh ? (mh.toLowerCase() as HeaderMedia["type"]) : null;
    setMedia((m) => (type ? (m?.type === type ? m : { type, link: "" }) : null));
  }

  const fieldOptions = [...LEAD_FIELDS, ...customKeys.map((k) => ({ key: `custom.${k}`, label: `Imported: ${k}` }))];
  const sampleLead = audience?.sample[0];
  const previewValues = useMemo(() => {
    const v: Record<string, string> = {};
    for (const variable of shape?.variables ?? []) {
      const src = mapping[variable.key];
      const val = sampleLead ? resolveVar(src, sampleLead) : src?.source === "static" ? src.value : src?.fallback;
      if (val) v[variable.key] = val;
    }
    return v;
  }, [shape, mapping, sampleLead]);

  const mappingErrors = template ? validateMapping(template.components, mapping, shape?.mediaHeader ? media : null) : [];
  const eligible = audience?.counts.eligible ?? 0;
  const rate = template ? (estRates[template.category as "MARKETING" | "UTILITY"] ?? 0) : 0;
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const setVar = (key: string, patch: Partial<VarSource>) =>
    setMapping((m) => ({ ...m, [key]: { ...(m[key] ?? { source: "field", value: "" }), ...patch } as VarSource }));

  function save() {
    start(async () => {
      const r = await saveCampaign(id, {
        name,
        templateId,
        audience: { segment_ids: segmentIds, tag_ids: tagIds, tag_match: tagMatch },
        mapping,
        media: shape?.mediaHeader ? media : null,
      });
      if (!r.ok) return void toast.error(r.error);
      toast.success(r.message ?? "Saved");
      router.push(`/campaigns/${r.data.id}`);
      router.refresh();
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <div className="grid content-start gap-4 lg:col-span-3">
        <Card>
          <CardHeader><CardTitle>1. Campaign &amp; template</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="cname">Campaign name</Label>
              <Input id="cname" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ayushman hospitals — October follow-up" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tpl">Approved template</Label>
              <NativeSelect id="tpl" value={templateId} onChange={(e) => chooseTemplate(e.target.value)}>
                <option value="">Choose…</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name} ({t.language}, {t.category.toLowerCase()})</option>
                ))}
              </NativeSelect>
              {templates.length === 0 && <p className="text-xs text-muted-foreground">No approved templates yet. Create one and sync after Meta approves it.</p>}
              {shape?.unsupported && <p className="text-sm text-destructive">{shape.unsupported}</p>}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. Audience</CardTitle>
            <CardDescription>Only leads with recorded WhatsApp opt-in and not on the suppression list will receive messages.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label>Segments <span className="font-normal text-muted-foreground">(none selected = all)</span></Label>
              <div className="flex flex-wrap gap-1.5">
                {segments.map((s) => (
                  <label key={s.id} className="cursor-pointer rounded-md border px-2.5 py-1 text-sm has-checked:border-primary has-checked:bg-accent">
                    <input type="checkbox" className="sr-only" checked={segmentIds.includes(s.id)} onChange={() => toggle(segmentIds, setSegmentIds, s.id)} />
                    {s.name}
                  </label>
                ))}
              </div>
            </div>
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>Tags <span className="font-normal text-muted-foreground">(optional)</span></Label>
                {tagIds.length > 1 && (
                  <NativeSelect className="h-7 w-44 text-xs" value={tagMatch} onChange={(e) => setTagMatch(e.target.value as "any" | "all")}>
                    <option value="any">Has any selected tag</option>
                    <option value="all">Has all selected tags</option>
                  </NativeSelect>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {tags.length === 0 && <span className="text-xs text-muted-foreground">No tags yet.</span>}
                {tags.map((t) => (
                  <label key={t.id} className="cursor-pointer rounded-md border px-2 py-0.5 text-xs has-checked:border-primary has-checked:bg-accent">
                    <input type="checkbox" className="sr-only" checked={tagIds.includes(t.id)} onChange={() => toggle(tagIds, setTagIds, t.id)} />
                    {t.name}
                  </label>
                ))}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 rounded-md bg-muted/50 p-3 text-sm sm:grid-cols-5">
              <div className="col-span-2 flex items-center gap-2 sm:col-span-1">
                {loadingAudience ? <Loader2 className="size-4 animate-spin" /> : <Users className="size-4 text-primary" />}
                <div><div className="text-lg font-semibold tabular-nums">{fmtInt(eligible)}</div><div className="text-xs text-muted-foreground">eligible</div></div>
              </div>
              <div><div className="tabular-nums">{fmtInt(audience?.counts.matching)}</div><div className="text-xs text-muted-foreground">matching</div></div>
              <div><div className="tabular-nums">{fmtInt(audience?.counts.no_consent)}</div><div className="text-xs text-muted-foreground">no opt-in</div></div>
              <div><div className="tabular-nums">{fmtInt(audience?.counts.opted_out)}</div><div className="text-xs text-muted-foreground">opted out</div></div>
              <div><div className="tabular-nums">{fmtInt(audience?.counts.no_phone)}</div><div className="text-xs text-muted-foreground">no phone</div></div>
            </div>
          </CardContent>
        </Card>

        {template && shape && !shape.unsupported && (
          <Card>
            <CardHeader>
              <CardTitle>3. Personalise</CardTitle>
              <CardDescription>Map each template variable to a lead field (with a fallback for blanks) or fixed text.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              {shape.mediaHeader && media && (
                <div className="grid gap-2 rounded-md border p-3">
                  <Label>Header {shape.mediaHeader.toLowerCase()} — public HTTPS link</Label>
                  <Input placeholder={`https://…/file.${shape.mediaHeader === "IMAGE" ? "jpg" : shape.mediaHeader === "VIDEO" ? "mp4" : "pdf"}`} value={media.link} onChange={(e) => setMedia({ ...media, link: e.target.value })} />
                  {media.type === "document" && <Input placeholder="File name shown to recipients (e.g. Brochure.pdf)" value={media.filename ?? ""} onChange={(e) => setMedia({ ...media, filename: e.target.value })} />}
                  <p className="text-xs text-muted-foreground">Meta downloads the file from this link when sending, so it must be publicly reachable.</p>
                </div>
              )}
              {shape.variables.length === 0 && !shape.mediaHeader && <p className="text-sm text-muted-foreground">This template has no variables.</p>}
              {shape.variables.map((v) => {
                const m = mapping[v.key];
                return (
                  <div key={v.key} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[1fr_1fr_1fr]">
                    <div className="text-sm">
                      <div className="font-medium">{v.label}</div>
                      {v.example && <div className="text-xs text-muted-foreground">e.g. {v.example}</div>}
                    </div>
                    <NativeSelect value={m?.source === "static" ? "__static" : (m?.value ?? "")}
                      onChange={(e) => (e.target.value === "__static" ? setVar(v.key, { source: "static", value: "", fallback: undefined }) : setVar(v.key, { source: "field", value: e.target.value }))}>
                      <option value="">Choose value…</option>
                      {fieldOptions.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                      <option value="__static">Fixed text</option>
                    </NativeSelect>
                    {m?.source === "static" ? (
                      <Input placeholder="Text" value={m.value} onChange={(e) => setVar(v.key, { value: e.target.value })} />
                    ) : (
                      <Input placeholder="Fallback if empty" value={m?.fallback ?? ""} onChange={(e) => setVar(v.key, { fallback: e.target.value })} />
                    )}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}
      </div>

      <div className="grid content-start gap-4 lg:sticky lg:top-6 lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle>Preview</CardTitle>
            <CardDescription>{sampleLead ? `As ${sampleLead.full_name ?? sampleLead.organization ?? sampleLead.phone_e164} will see it` : "Select an audience to preview with a real lead"}</CardDescription>
          </CardHeader>
          <CardContent>
            {template ? <TemplatePreview components={template.components} values={previewValues} mediaUrl={media?.type === "image" ? media.link : undefined} /> : <p className="text-sm text-muted-foreground">Choose a template.</p>}
          </CardContent>
        </Card>
        <Card className="gap-2">
          <CardContent className="grid gap-1 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Eligible recipients</span><span className="tabular-nums">{fmtInt(eligible)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Estimated rate ({template?.category.toLowerCase() ?? "—"})</span><span className="tabular-nums">{fmtMoney(rate, currency)}</span></div>
            <div className="flex justify-between font-medium"><span>Estimated cost</span><span className="tabular-nums">{fmtMoney(eligible * rate, currency)}</span></div>
            <p className="pt-1 text-xs text-muted-foreground">
              Estimate from the rates in Settings. Meta bills per delivered message by category and country; actual charges can differ.
              {rate === 0 && " Set your rates in Settings for a meaningful estimate."}
            </p>
          </CardContent>
        </Card>
        {mappingErrors.length > 0 && template && (
          <div className="grid gap-1 text-sm text-destructive">{mappingErrors.map((e) => <p key={e}>• {e}</p>)}</div>
        )}
        <Button disabled={pending || !name.trim() || !template || mappingErrors.length > 0} onClick={save}>
          {pending && <Loader2 className="animate-spin" />} Save campaign &amp; review
        </Button>
        <p className="text-xs text-muted-foreground">Saving doesn&apos;t send anything. You&apos;ll confirm the exact recipient count on the next screen{live ? "" : " (mock mode: launch runs a dry run)"}.</p>
      </div>
    </div>
  );
}
