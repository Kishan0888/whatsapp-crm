/**
 * "Send test message": one approved template to one explicitly chosen
 * number. Never touches campaign_recipients or the campaign worker; it is
 * sent through the same direct Cloud API sender the inbox uses, and recorded
 * as an outbound message (source "campaign_test").
 */
import { normalizePhone } from "@/lib/phone";
import { deliverOutboundDetailed, type InboxDeps } from "@/lib/inbox/handler";
import { renderPreview } from "@/lib/whatsapp/templates";
import {
  buildSendComponents, validateMapping, type HeaderMedia, type LeadForRender, type SendComponent, type TemplateSnapshot, type VariableMapping,
} from "@/lib/whatsapp/send";

export interface TestSendPlan {
  to: string;
  components: SendComponent[];
  values: Record<string, string>;
  header: string | null;
  body: string;
  /** Name of the lead whose data personalised the test, or null (fallback values used). */
  personalizedWith: string | null;
}

const blankLead = (phone: string): LeadForRender => ({
  full_name: null, organization: null, city: null, state: null, country: null, email: null, phone_e164: phone, custom_fields: {},
});

/** Validate the number and template variables and render exactly what will be sent. Pure. */
export function planTestSend(input: {
  phone: string;
  defaultCountry: string;
  template: TemplateSnapshot;
  mapping: VariableMapping;
  media: HeaderMedia | null;
  lead: (LeadForRender & { full_name: string | null }) | null;
}): { ok: true; plan: TestSendPlan } | { ok: false; errors: string[] } {
  const phone = normalizePhone(input.phone, input.defaultCountry);
  if (!phone.ok) return { ok: false, errors: [`Test number: ${phone.error}`] };
  const errors = validateMapping(input.template.components, input.mapping, input.media);
  if (errors.length) return { ok: false, errors };
  const lead = input.lead ?? blankLead(phone.e164);
  const built = buildSendComponents(input.template.components, input.mapping, lead, input.media);
  if (!built.ok) return { ok: false, errors: [built.error] };
  const p = renderPreview(input.template.components, built.values);
  return {
    ok: true,
    plan: {
      to: phone.e164,
      components: built.components,
      values: built.values,
      header: p.header?.type === "text" ? p.header.text : p.header ? `[${p.header.format.toLowerCase()}]` : null,
      body: p.body,
      personalizedWith: input.lead ? (input.lead.full_name || input.lead.organization || input.lead.phone_e164) : null,
    },
  };
}

export interface TestSendResult {
  messageId: number;
  duplicate: boolean;
  result: "sent" | "failed" | "mock" | "not_claimed";
  wamid?: string;
  errorCode?: string;
  error?: string;
}

/** Record and send the planned test message to its single recipient. */
export async function executeTestSend(
  deps: InboxDeps,
  input: { plan: TestSendPlan; template: TemplateSnapshot; clientKey: string; userId: string | null },
): Promise<TestSendResult> {
  if (deps.cfg.mode !== "live") throw new Error("Test sends need WHATSAPP_MODE=live — mock mode never contacts WhatsApp.");
  const conversationId = await deps.rpc<string>("inbox_ensure_conversation", { p_phone: input.plan.to });
  const q = await deps.rpc<{ id: number; duplicate: boolean }>("inbox_queue_outbound", {
    p_conversation_id: conversationId,
    p_idempotency_key: `test:${input.clientKey}`,
    p_type: "template",
    p_body: [input.plan.header, input.plan.body].filter(Boolean).join("\n\n"),
    p_payload: { template: input.template, components: input.plan.components, test: true },
    p_source: "campaign_test",
    p_sent_by: input.userId,
  });
  if (q.duplicate) return { messageId: q.id, duplicate: true, result: "not_claimed" };
  const d = await deliverOutboundDetailed(deps, q.id);
  return { messageId: q.id, duplicate: false, ...d };
}
