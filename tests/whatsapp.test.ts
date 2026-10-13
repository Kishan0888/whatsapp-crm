import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyError } from "@/lib/whatsapp/errors";
import {
  buildComponents, draftFromTemplate, emptyDraft, extractVars, renderPreview, templateShape, validateDraft,
  type MetaComponent, type TemplateDraft,
} from "@/lib/whatsapp/templates";
import { buildSendComponents, buildTemplateMessage, cleanParam, validateMapping, type LeadForRender } from "@/lib/whatsapp/send";
import { isOptOutMessage, parseWebhook, verifySignature } from "@/lib/whatsapp/webhook";

const draft = (over: Partial<TemplateDraft> = {}): TemplateDraft => ({
  ...emptyDraft(),
  name: "hospital_promo",
  header: { format: "TEXT", text: "Hello {{1}}", example: "Dr. Rao", handle: "" },
  body: { text: "We help {{1}} hospitals in {{2}} grow.", examples: ["multi-speciality", "Jaipur"] },
  footer: "Reply STOP to opt out",
  buttons: [
    { type: "QUICK_REPLY", text: "Interested" },
    { type: "QUICK_REPLY", text: "Stop promotions" },
    { type: "URL", text: "Book a call", url: "https://example.com/book/{{1}}", example: "abc" },
  ],
  ...over,
});

describe("extractVars", () => {
  it("orders positional variables numerically and keeps named order", () => {
    expect(extractVars("{{2}} and {{1}} and {{2}}")).toEqual(["1", "2"]);
    expect(extractVars("Hi {{first_name}}, {{ city }}")).toEqual(["first_name", "city"]);
  });
});

describe("validateDraft", () => {
  it("accepts a valid draft", () => {
    expect(validateDraft(draft()).errors).toEqual([]);
  });

  it("enforces Meta limits", () => {
    const bad = draft({
      name: "Bad Name",
      body: { text: "Hi {{1}} {{3}}", examples: ["a"] },
      footer: "x".repeat(61),
      buttons: [
        { type: "QUICK_REPLY", text: "A" },
        { type: "URL", text: "Go", url: "https://x.com/{{1}}/path", example: "" },
        { type: "QUICK_REPLY", text: "B".repeat(26) },
      ],
    });
    const { errors } = validateDraft(bad);
    expect(errors.join("\n")).toMatch(/lowercase/);
    expect(errors.join("\n")).toMatch(/without gaps/);
    expect(errors.join("\n")).toMatch(/Footer is limited/);
    expect(errors.join("\n")).toMatch(/grouped together/);
    expect(errors.join("\n")).toMatch(/25 characters/);
    expect(errors.join("\n")).toMatch(/end of the URL/);
  });

  it("requires a sample for media headers", () => {
    expect(validateDraft(draft({ header: { format: "IMAGE", text: "", example: "", handle: "" } })).errors.join()).toMatch(/sample image/);
  });
});

describe("buildComponents / draftFromTemplate", () => {
  it("produces Meta's component format with examples and round-trips", () => {
    const c = buildComponents(draft());
    expect(c).toEqual([
      { type: "HEADER", format: "TEXT", text: "Hello {{1}}", example: { header_text: ["Dr. Rao"] } },
      { type: "BODY", text: "We help {{1}} hospitals in {{2}} grow.", example: { body_text: [["multi-speciality", "Jaipur"]] } },
      { type: "FOOTER", text: "Reply STOP to opt out" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Interested" },
          { type: "QUICK_REPLY", text: "Stop promotions" },
          { type: "URL", text: "Book a call", url: "https://example.com/book/{{1}}", example: ["abc"] },
        ],
      },
    ]);
    expect(draftFromTemplate({ name: "hospital_promo", language: "en", category: "MARKETING", components: c })).toEqual(draft());
  });
});

const lead: LeadForRender = {
  full_name: "Anil  Kumar",
  organization: "City\nHospital",
  city: null,
  state: "Rajasthan",
  country: null,
  email: null,
  phone_e164: "+919810000001",
  custom_fields: { Beds: "120" },
};

describe("buildSendComponents", () => {
  const comps = buildComponents(draft());
  const mapping = {
    "header.1": { source: "field" as const, value: "first_name", fallback: "there" },
    "body.1": { source: "field" as const, value: "custom.Beds", fallback: "your" },
    "body.2": { source: "field" as const, value: "city", fallback: "your city" },
    "button.2.1": { source: "static" as const, value: "promo-oct" },
  };

  it("renders params in order with fallbacks and URL button index", () => {
    const r = buildSendComponents(comps, mapping, lead, null);
    expect(r).toEqual({
      ok: true,
      values: { "header.1": "Anil", "body.1": "120", "body.2": "your city", "button.2.1": "promo-oct" },
      components: [
        { type: "header", parameters: [{ type: "text", text: "Anil" }] },
        { type: "body", parameters: [{ type: "text", text: "120" }, { type: "text", text: "your city" }] },
        { type: "button", sub_type: "url", index: 2, parameters: [{ type: "text", text: "promo-oct" }] },
      ],
    });
  });

  it("uses parameter_name for named templates and media links", () => {
    const named: MetaComponent[] = [
      { type: "HEADER", format: "IMAGE" },
      { type: "BODY", text: "Hi {{first_name}}" },
    ];
    const r = buildSendComponents(named, { "body.first_name": { source: "field", value: "first_name", fallback: "there" } }, lead, {
      type: "image",
      link: "https://cdn.example.com/a.jpg",
    });
    expect(r.ok && r.components).toEqual([
      { type: "header", parameters: [{ type: "image", image: { link: "https://cdn.example.com/a.jpg" } }] },
      { type: "body", parameters: [{ type: "text", parameter_name: "first_name", text: "Anil" }] },
    ]);
  });

  it("fails when a value is missing", () => {
    const r = buildSendComponents(comps, { ...mapping, "body.2": { source: "field", value: "city" } }, lead, null);
    expect(r).toMatchObject({ ok: false });
  });

  it("validates mapping completeness", () => {
    expect(validateMapping(comps, {}, null).length).toBe(4);
    expect(validateMapping(comps, mapping, null)).toEqual([]);
  });

  it("builds the message envelope", () => {
    const m = buildTemplateMessage("+919810000001", { name: "t", language: "en", category: "MARKETING", components: [] }, []);
    expect(m).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "919810000001",
      type: "template",
      template: { name: "t", language: { code: "en" } },
    });
  });

  it("cleans params", () => {
    expect(cleanParam(" a\n\tb     c ")).toBe("a b c");
  });
});

describe("templateShape / renderPreview", () => {
  it("flags unsupported components", () => {
    expect(templateShape([{ type: "HEADER", format: "LOCATION" }, { type: "BODY", text: "x" }]).unsupported).toMatch(/LOCATION/);
    expect(templateShape([{ type: "BODY", text: "x" }, { type: "BUTTONS", buttons: [{ type: "FLOW", text: "f" }] }]).unsupported).toMatch(/FLOW/);
  });
  it("substitutes values", () => {
    const p = renderPreview(buildComponents(draft()), { "body.1": "big" });
    expect(p.body).toBe("We help big hospitals in {{2}} grow.");
    expect(p.header).toEqual({ type: "text", text: "Hello {{1}}" });
  });
});

describe("classifyError", () => {
  it("follows Meta's retry guidance", () => {
    expect(classifyError("130429", 1)).toEqual({ action: "retry", retryInSec: 15 });
    expect(classifyError("130429", 5).action).toBe("permanent");
    expect(classifyError("131000", 1).action).toBe("retry");
    expect(classifyError("131000", 2).action).toBe("permanent");
    expect(classifyError("131050", 1).action).toBe("opt_out");
    expect(classifyError("190", 1).action).toBe("systemic");
    expect(classifyError("132015", 1).action).toBe("systemic");
    expect(classifyError("131026", 1).action).toBe("permanent");
    expect(classifyError(undefined, 1).action).toBe("retry");
  });
});

describe("webhook", () => {
  const secret = "s3cret";
  const raw = JSON.stringify({ a: 1 });
  const sig = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");

  it("verifies signatures in constant time", () => {
    expect(verifySignature(raw, sig, secret)).toBe(true);
    expect(verifySignature(raw + " ", sig, secret)).toBe(false);
    expect(verifySignature(raw, "sha256=00", secret)).toBe(false);
    expect(verifySignature(raw, null, secret)).toBe(false);
    expect(verifySignature(raw, sig, "")).toBe(false);
  });

  it("parses statuses, inbound messages and template updates", () => {
    const events = parseWebhook({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA",
          time: 1700000000,
          changes: [
            {
              field: "messages",
              value: {
                statuses: [
                  { id: "wamid.1", status: "delivered", timestamp: "1700000001", recipient_id: "919810000001", pricing: { type: "regular", category: "marketing" } },
                  { id: "wamid.2", status: "failed", timestamp: "1700000002", recipient_id: "919810000002", errors: [{ code: 131026, title: "Message undeliverable", message: "Message undeliverable", error_data: { details: "not on WhatsApp" } }] },
                ],
                messages: [{ id: "wamid.in", from: "919810000003", type: "button", button: { text: "Stop promotions", payload: "Stop promotions" } }],
              },
            },
            {
              field: "message_template_status_update",
              value: { event: "REJECTED", message_template_id: 123, message_template_name: "promo", message_template_language: "en", reason: "INVALID_FORMAT", rejection_info: { reason: "Bad var", recommendation: "Fix it" } },
            },
          ],
        },
      ],
    });
    expect(events.map((e) => e.key)).toEqual([
      "status:wamid.1:delivered:1700000001",
      "status:wamid.2:failed:1700000002",
      "in:wamid.in",
      "tpl:123:REJECTED:1700000000",
    ]);
    expect(events[1]).toMatchObject({ errorCode: "131026", errorMessage: "Message undeliverable — not on WhatsApp" });
    expect(events[3]).toMatchObject({ reason: "INVALID_FORMAT", detail: "Bad var — Fix it" });
    expect(parseWebhook({ object: "page" })).toEqual([]);
  });

  it("detects opt-out keywords exactly", () => {
    expect(isOptOutMessage("STOP")).toBe(true);
    expect(isOptOutMessage("Stop promotions")).toBe(true);
    expect(isOptOutMessage("please don't stop")).toBe(false);
  });
});
