"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TemplatePreview } from "@/components/template-preview";
import { buildComponents, extractVars, LANGUAGES, validateDraft, type DraftButton, type HeaderFormat, type TemplateDraft } from "@/lib/whatsapp/templates";
import { saveTemplateDraft, submitTemplate } from "./actions";

export function TemplateEditor({
  id,
  initial,
  locked,
  status,
  live,
  canEdit,
}: {
  id: string | null;
  initial: TemplateDraft;
  /** Name/language/category locked once submitted to Meta. */
  locked: boolean;
  status: string;
  live: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [d, setD] = useState<TemplateDraft>(initial);
  const [pending, start] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [sampleUrl, setSampleUrl] = useState<string>();
  const bodyVars = extractVars(d.body.text);
  const components = useMemo(() => buildComponents(d), [d]);
  const validation = useMemo(() => validateDraft(d), [d]);
  const previewValues = useMemo(() => {
    const v: Record<string, string> = {};
    if (d.header.example) v["header.1"] = d.header.example;
    bodyVars.forEach((n, i) => d.body.examples[i] && (v[`body.${n}`] = d.body.examples[i]));
    return v;
  }, [d, bodyVars]);

  const set = <K extends keyof TemplateDraft>(k: K, v: TemplateDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const setBtn = (i: number, patch: Partial<DraftButton>) =>
    set("buttons", d.buttons.map((b, j) => (j === i ? ({ ...b, ...patch } as DraftButton) : b)));

  async function uploadSample(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      fd.set("format", d.header.format);
      const res = await fetch("/api/templates/media-handle", { method: "POST", body: fd });
      const json = (await res.json()) as { ok: boolean; handle?: string; error?: string };
      if (!json.ok || !json.handle) throw new Error(json.error ?? "Upload failed");
      set("header", { ...d.header, handle: json.handle });
      if (file.type.startsWith("image/")) setSampleUrl(URL.createObjectURL(file));
      toast.success("Sample uploaded to Meta");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  const save = (thenSubmit: boolean) =>
    start(async () => {
      const r = await saveTemplateDraft(id, d);
      if (!r.ok) return void toast.error(r.error);
      if (!thenSubmit) {
        toast.success(r.message ?? "Saved");
        if (!id) router.push(`/templates/${r.data.id}`);
        else router.refresh();
        return;
      }
      const s = await submitTemplate(r.data.id);
      if (!s.ok) {
        toast.error(s.error);
        if (!id) router.push(`/templates/${r.data.id}`);
        return;
      }
      toast.success(s.message ?? "Submitted");
      router.push(`/templates/${r.data.id}`);
      router.refresh();
    });

  const canSubmit = live && validation.errors.length === 0 && (!locked || ["APPROVED", "REJECTED", "PAUSED"].includes(status));

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <fieldset disabled={!canEdit || pending} className="grid content-start gap-4 lg:col-span-3">
        <Card>
          <CardHeader><CardTitle>Basics</CardTitle></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2 sm:col-span-3">
              <Label htmlFor="name">Template name</Label>
              <Input id="name" value={d.name} disabled={locked} placeholder="hospital_growth_offer"
                onChange={(e) => set("name", e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="category">Category</Label>
              <NativeSelect id="category" value={d.category} disabled={locked} onChange={(e) => set("category", e.target.value as TemplateDraft["category"])}>
                <option value="MARKETING">Marketing</option>
                <option value="UTILITY">Utility</option>
              </NativeSelect>
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="language">Language</Label>
              <NativeSelect id="language" value={d.language} disabled={locked} onChange={(e) => set("language", e.target.value)}>
                {LANGUAGES.map(([c, l]) => <option key={c} value={c}>{l} ({c})</option>)}
              </NativeSelect>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Content</CardTitle>
            <CardDescription>Use {"{{1}}"}, {"{{2}}"}… for variables. Formatting: *bold*, _italic_, ~strike~.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="hfmt">Header (optional)</Label>
              <NativeSelect id="hfmt" value={d.header.format} onChange={(e) => set("header", { format: e.target.value as HeaderFormat, text: "", example: "", handle: "" })}>
                <option value="NONE">None</option>
                <option value="TEXT">Text</option>
                <option value="IMAGE">Image</option>
                <option value="VIDEO">Video</option>
                <option value="DOCUMENT">Document</option>
              </NativeSelect>
              {d.header.format === "TEXT" && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input placeholder="Header text (max 60)" value={d.header.text} maxLength={60} onChange={(e) => set("header", { ...d.header, text: e.target.value })} />
                  {extractVars(d.header.text).length > 0 && (
                    <Input placeholder="Sample for {{1}}" value={d.header.example} onChange={(e) => set("header", { ...d.header, example: e.target.value })} />
                  )}
                </div>
              )}
              {["IMAGE", "VIDEO", "DOCUMENT"].includes(d.header.format) && (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 hover:bg-muted">
                    {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                    Upload sample {d.header.format.toLowerCase()}
                    <input type="file" className="sr-only" disabled={uploading || !live}
                      accept={d.header.format === "IMAGE" ? "image/jpeg,image/png" : d.header.format === "VIDEO" ? "video/mp4" : "application/pdf"}
                      onChange={(e) => uploadSample(e.target.files?.[0])} />
                  </label>
                  {d.header.handle ? <span className="text-primary">Sample uploaded ✓</span> : <span className="text-muted-foreground">{live ? "Required by Meta for review." : "Uploading needs live mode."}</span>}
                  <span className="w-full text-xs text-muted-foreground">The actual media is chosen per campaign.</span>
                </div>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="body">Body</Label>
              <Textarea id="body" rows={6} value={d.body.text} placeholder="Hello {{1}}, …" onChange={(e) => set("body", { ...d.body, text: e.target.value })} />
              <div className="text-right text-xs text-muted-foreground">{d.body.text.length}/1024</div>
              {bodyVars.length > 0 && (
                <div className="grid gap-2 sm:grid-cols-2">
                  {bodyVars.map((v, i) => (
                    <Input key={v} placeholder={`Sample for {{${v}}}`} value={d.body.examples[i] ?? ""}
                      onChange={(e) => {
                        const ex = [...d.body.examples];
                        ex[i] = e.target.value;
                        set("body", { ...d.body, examples: ex });
                      }} />
                  ))}
                </div>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="footer">Footer (optional)</Label>
              <Input id="footer" value={d.footer} maxLength={60} placeholder="Reply STOP to unsubscribe" onChange={(e) => set("footer", e.target.value)} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Buttons (optional)</CardTitle>
            <CardDescription>Up to 10: quick replies, 2 website links, 1 phone number. A &ldquo;Stop promotions&rdquo; quick reply opts people out automatically.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {d.buttons.map((b, i) => (
              <div key={i} className="grid gap-2 rounded-md border p-3 sm:grid-cols-[7rem_1fr_auto]">
                <span className="self-center text-xs font-medium uppercase text-muted-foreground">{b.type.replace("_", " ")}</span>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input placeholder="Label (max 25)" maxLength={25} value={b.text} onChange={(e) => setBtn(i, { text: e.target.value })} />
                  {b.type === "URL" && <Input placeholder="https://… (optional {{1}} at end)" value={b.url} onChange={(e) => setBtn(i, { url: e.target.value })} />}
                  {b.type === "URL" && extractVars(b.url).length > 0 && <Input placeholder="Sample for URL {{1}}" value={b.example} onChange={(e) => setBtn(i, { example: e.target.value })} />}
                  {b.type === "PHONE_NUMBER" && <Input placeholder="+919810000000" value={b.phone} onChange={(e) => setBtn(i, { phone: e.target.value })} />}
                </div>
                <Button type="button" variant="ghost" size="icon" aria-label="Remove button" onClick={() => set("buttons", d.buttons.filter((_, j) => j !== i))}>
                  <Trash2 />
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" disabled={d.buttons.length >= 10} onClick={() => set("buttons", [...d.buttons, { type: "QUICK_REPLY", text: "" }])}><Plus /> Quick reply</Button>
              <Button type="button" size="sm" variant="outline" disabled={d.buttons.length >= 10} onClick={() => set("buttons", [...d.buttons, { type: "URL", text: "", url: "", example: "" }])}><Plus /> Website</Button>
              <Button type="button" size="sm" variant="outline" disabled={d.buttons.length >= 10} onClick={() => set("buttons", [...d.buttons, { type: "PHONE_NUMBER", text: "", phone: "" }])}><Plus /> Phone</Button>
            </div>
          </CardContent>
        </Card>
      </fieldset>

      <div className="grid content-start gap-4 lg:col-span-2 lg:sticky lg:top-6">
        <Card>
          <CardHeader><CardTitle>Preview</CardTitle></CardHeader>
          <CardContent><TemplatePreview components={components} values={previewValues} mediaUrl={sampleUrl} /></CardContent>
        </Card>
        {(validation.errors.length > 0 || validation.warnings.length > 0) && (
          <Card className="gap-2">
            <CardContent className="grid gap-1 text-sm">
              {validation.errors.map((e) => <p key={e} className="text-destructive">• {e}</p>)}
              {validation.warnings.map((w) => <p key={w} className="text-amber-700 dark:text-amber-400">• {w}</p>)}
            </CardContent>
          </Card>
        )}
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={pending} onClick={() => save(false)}>Save draft</Button>
            <Button disabled={pending || !canSubmit} onClick={() => save(true)}>
              {pending && <Loader2 className="animate-spin" />} {locked ? "Submit changes to Meta" : "Submit to Meta for approval"}
            </Button>
          </div>
        )}
        {!live && <p className="text-xs text-muted-foreground">Mock mode: drafts can be saved but nothing is submitted to Meta.</p>}
      </div>
    </div>
  );
}
