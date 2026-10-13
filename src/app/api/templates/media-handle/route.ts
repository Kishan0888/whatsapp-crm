import { NextResponse, type NextRequest } from "next/server";
import { assertRole, CAN_MANAGE_CAMPAIGNS } from "@/lib/auth";
import { loadWaConfig } from "@/lib/whatsapp/config";
import { uploadHeaderSample } from "@/lib/whatsapp/api";
import { toFail } from "@/lib/action-result";


const ALLOWED: Record<string, { format: string; max: number }> = {
  "image/jpeg": { format: "IMAGE", max: 5 * 1024 * 1024 },
  "image/png": { format: "IMAGE", max: 5 * 1024 * 1024 },
  "video/mp4": { format: "VIDEO", max: 16 * 1024 * 1024 },
  "application/pdf": { format: "DOCUMENT", max: 16 * 1024 * 1024 },
};

/** Upload a header sample to Meta's Resumable Upload API and return its handle. */
export async function POST(req: NextRequest) {
  try {
    await assertRole(CAN_MANAGE_CAMPAIGNS);
    const form = await req.formData();
    const file = form.get("file");
    const format = String(form.get("format") ?? "");
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "No file" }, { status: 400 });
    const rule = ALLOWED[file.type];
    if (!rule || rule.format !== format)
      return NextResponse.json({ ok: false, error: `For a ${format.toLowerCase()} header upload ${format === "IMAGE" ? "JPEG/PNG" : format === "VIDEO" ? "MP4" : "PDF"}.` }, { status: 400 });
    if (file.size > rule.max) return NextResponse.json({ ok: false, error: `File too large (max ${rule.max / 1024 / 1024} MB).` }, { status: 400 });
    const handle = await uploadHeaderSample(await loadWaConfig(), { bytes: await file.arrayBuffer(), name: file.name, type: file.type });
    return NextResponse.json({ ok: true, handle });
  } catch (e) {
    return NextResponse.json(toFail(e), { status: 400 });
  }
}
