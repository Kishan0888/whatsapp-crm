import { ExternalLink, FileText, Image as ImageIcon, Phone, Reply, Video, Copy } from "lucide-react";
import { renderPreview, type MetaComponent } from "@/lib/whatsapp/templates";

/** Minimal WhatsApp formatting: *bold*, _italic_, ~strike~. */
function Formatted({ text }: { text: string }) {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^\*.+\*$/.test(p) ? <strong key={i}>{p.slice(1, -1)}</strong>
        : /^_.+_$/.test(p) ? <em key={i}>{p.slice(1, -1)}</em>
        : /^~.+~$/.test(p) ? <s key={i}>{p.slice(1, -1)}</s>
        : <span key={i}>{p}</span>,
      )}
    </>
  );
}

const MEDIA_ICON = { IMAGE: ImageIcon, VIDEO: Video, DOCUMENT: FileText } as Record<string, typeof ImageIcon>;
const BTN_ICON = { URL: ExternalLink, PHONE_NUMBER: Phone, QUICK_REPLY: Reply, COPY_CODE: Copy } as Record<string, typeof Reply>;

export function TemplatePreview({ components, values, mediaUrl }: { components: MetaComponent[]; values?: Record<string, string>; mediaUrl?: string }) {
  const p = renderPreview(components, values);
  const MediaIcon = p.header?.type === "media" ? (MEDIA_ICON[p.header.format] ?? FileText) : null;
  return (
    <div className="rounded-xl bg-[#e5ddd5] p-4 dark:bg-[#0b141a]">
      <div className="max-w-sm rounded-lg rounded-tl-none bg-white text-sm text-[#111b21] shadow-sm dark:bg-[#202c33] dark:text-[#e9edef]">
        <div className="space-y-1.5 p-2.5">
          {p.header?.type === "text" && <div className="font-semibold"><Formatted text={p.header.text} /></div>}
          {p.header?.type === "media" && MediaIcon && (
            mediaUrl && p.header.format === "IMAGE"
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={mediaUrl} alt="" className="max-h-48 w-full rounded-md object-cover" />
              : <div className="flex h-32 items-center justify-center rounded-md bg-black/10 dark:bg-white/10"><MediaIcon className="size-8 opacity-60" /></div>
          )}
          <div className="whitespace-pre-wrap break-words">{p.body ? <Formatted text={p.body} /> : <span className="opacity-50">Message body…</span>}</div>
          {p.footer && <div className="text-xs opacity-60">{p.footer}</div>}
          <div className="text-right text-[10px] opacity-50">12:00</div>
        </div>
        {p.buttons.length > 0 && (
          <div className="divide-y border-t border-black/10 dark:divide-white/10 dark:border-white/10">
            {p.buttons.slice(0, p.buttons.length > 3 ? 2 : 3).map((b, i) => {
              const Icon = BTN_ICON[b.type] ?? Reply;
              return (
                <div key={i} className="flex items-center justify-center gap-1.5 py-2 text-[13px] font-medium text-[#00a5f4]">
                  <Icon className="size-3.5" /> {b.text || "Button"}
                </div>
              );
            })}
            {p.buttons.length > 3 && <div className="py-2 text-center text-[13px] font-medium text-[#00a5f4]">See all options</div>}
          </div>
        )}
      </div>
    </div>
  );
}
