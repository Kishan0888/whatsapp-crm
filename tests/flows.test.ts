import { describe, expect, it } from "vitest";
import { buttonIntent, decide, FLOW_TTL_MS, MESSAGES, type FlowContext, type FlowState, type InboundInput } from "@/lib/inbox/flows";
import { buildCtaUrlMessage, buildTextMessage } from "@/lib/whatsapp/send";
import { parseWebhook } from "@/lib/whatsapp/webhook";

const now = new Date("2026-10-15T10:00:00Z");
const ctx: FlowContext = { now, meetingUrl: "https://calendly.com/medscale/30min", growthTemplate: null };
let n = 0;
const text = (t: string): InboundInput => ({ wamid: `w${++n}`, msgType: "text", text: t });
const button = (t: string, payload = t): InboundInput => ({ wamid: `w${++n}`, msgType: "button", text: t, buttonPayload: payload });

/** Run a sequence of inputs through decide(), carrying state like the handler does. */
function run(inputs: InboundInput[], start: FlowState | null = null, c: FlowContext = ctx) {
  let flow = start;
  const out = [];
  for (const i of inputs) {
    const d = decide(flow, i, c);
    if (d.flow !== undefined) flow = d.flow;
    out.push(d);
  }
  return { flow, out };
}

describe("buttonIntent", () => {
  it("matches template quick replies and interactive replies, case/spacing-insensitive", () => {
    expect(buttonIntent(button("Free Growth Report"))).toBe("free_growth_report");
    expect(buttonIntent({ wamid: "x", msgType: "interactive", text: "send details", buttonPayload: "send-details" })).toBe("send_details");
    expect(buttonIntent(button("Something else", "free_growth_report"))).toBe("free_growth_report");
    // Typed text is not a button tap.
    expect(buttonIntent(text("Free Growth Report"))).toBeNull();
  });
});

describe("Free Growth Report", () => {
  it("replies with a CTA URL button using the configured meeting link", () => {
    const d = decide(null, button("Free Growth Report"), ctx);
    expect(d.flow).toBeUndefined();
    expect(d.replies).toEqual([{ type: "cta_url", body: MESSAGES.growthReport, displayText: "Schedule Meeting", url: ctx.meetingUrl }]);
  });

  it("holds the reply (staff note) when no meeting link is configured", () => {
    const d = decide(null, button("Free Growth Report"), { ...ctx, meetingUrl: null });
    expect(d.replies).toEqual([{ type: "note", body: MESSAGES.growthReportNoUrl }]);
  });

  it("uses an approved template when configured", () => {
    const snapshot = { name: "growth_followup", language: "en", category: "UTILITY", components: [] };
    const d = decide(null, button("Free Growth Report"), { ...ctx, growthTemplate: { snapshot, body: "Thanks!" } });
    expect(d.replies[0]).toMatchObject({ type: "template", template: snapshot });
  });

  it("does not disturb an active Send Details flow", () => {
    const { flow } = run([button("Send Details")]);
    const d = decide(flow, button("Free Growth Report"), ctx);
    expect(d.flow).toBeUndefined();
  });
});

describe("Send Details", () => {
  it("asks one question at a time and completes with details", () => {
    const { flow, out } = run([button("Send Details"), text("  Ravi   Kumar "), text("City Care Hospital"), text("Mon 20 Oct, 11 AM")]);
    expect(out.map((d) => d.action)).toEqual(["start", "got_name", "got_hospital", "complete"]);
    expect(out[0].replies[0]).toMatchObject({ type: "text", body: expect.stringContaining(MESSAGES.askName) });
    expect(out[1].replies[0]).toMatchObject({ body: MESSAGES.askHospital("Ravi Kumar") });
    expect(out[2].replies[0]).toMatchObject({ body: MESSAGES.askDateTime });
    expect(out[3].details).toEqual({ representative: "Ravi Kumar", hospital: "City Care Hospital", preferred_time: "Mon 20 Oct, 11 AM" });
    expect(flow).toMatchObject({ step: "done", completed_at: now.toISOString() });
  });

  it("re-asks the same question for non-text or empty answers", () => {
    const { flow, out } = run([button("Send Details"), { wamid: "img1", msgType: "image", text: "" }, text("?")]);
    expect(out.slice(1).map((d) => d.action)).toEqual(["reask", "reask"]);
    expect(out[1].replies[0]).toMatchObject({ body: `${MESSAGES.invalid} ${MESSAGES.askName}` });
    expect(flow?.step).toBe("name");
  });

  it("supports cancel and restart", () => {
    const a = run([button("Send Details"), text("Ravi"), text("Cancel")]);
    expect(a.out[2].action).toBe("cancel");
    expect(a.flow?.step).toBe("cancelled");
    // After cancel, normal text is left for staff; RESTART starts again.
    expect(decide(a.flow, text("hello"), ctx).action).toBe("none");
    const r = decide(a.flow, text("restart"), ctx);
    expect(r.action).toBe("restart");
    expect(r.flow).toMatchObject({ step: "name", data: {} });
    // Tapping the button mid-flow restarts too.
    const b = run([button("Send Details"), text("Ravi"), button("Send Details")]);
    expect(b.out[2].action).toBe("restart");
    expect(b.flow?.data).toEqual({});
  });

  it("restart after completion is allowed; cancel/other text after completion is ignored", () => {
    const { flow } = run([button("Send Details"), text("Ravi"), text("City Care"), text("Tomorrow 5pm")]);
    expect(decide(flow, text("cancel"), ctx).action).toBe("none");
    expect(decide(flow, text("thanks!"), ctx).action).toBe("none");
    expect(decide(flow, text("Restart"), ctx).action).toBe("restart");
  });

  it("ignores replays of an already-applied message", () => {
    const first = decide(null, { wamid: "same", msgType: "button", text: "Send Details" }, ctx);
    const replay = decide(first.flow, { wamid: "same", msgType: "button", text: "Send Details" }, ctx);
    expect(replay).toEqual({ replies: [], action: "already_applied" });
  });

  it("expires after 24 hours of inactivity", () => {
    const { flow } = run([button("Send Details")]);
    const later = { ...ctx, now: new Date(now.getTime() + FLOW_TTL_MS + 1000) };
    expect(decide(flow, text("Ravi"), later).action).toBe("none");
  });

  it("does nothing for ordinary messages with no flow", () => {
    expect(decide(null, text("Hello, what are your prices?"), ctx)).toEqual({ replies: [], action: "none" });
  });
});

describe("message builders", () => {
  it("builds text and CTA URL payloads per the Cloud API", () => {
    expect(buildTextMessage("+919810000001", "Hi https://x.com")).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "919810000001",
      type: "text",
      text: { body: "Hi https://x.com", preview_url: true },
    });
    expect(buildCtaUrlMessage("+919810000001", "Body", "Schedule Your Meeting", "https://cal.com/x")).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "919810000001",
      type: "interactive",
      interactive: {
        type: "cta_url",
        body: { text: "Body" },
        action: { name: "cta_url", parameters: { display_text: "Schedule Your Meetin", url: "https://cal.com/x" } },
      },
    });
  });
});

describe("parseWebhook inbound fields", () => {
  it("captures type, context, profile name, button payload and interactive replies", () => {
    const ev = parseWebhook({
      object: "whatsapp_business_account",
      entry: [{
        id: "WABA",
        changes: [{
          field: "messages",
          value: {
            contacts: [{ wa_id: "919810000001", profile: { name: "Ravi" } }],
            messages: [
              { id: "w.b", from: "919810000001", timestamp: "1760000000", type: "button", context: { id: "w.tpl" }, button: { text: "Free Growth Report", payload: "Free Growth Report" } },
              { id: "w.i", from: "919810000001", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "send_details", title: "Send Details" } } },
              { id: "w.m", from: "919810000001", type: "image", image: { id: "media1", mime_type: "image/jpeg", caption: "Our OPD" } },
            ],
          },
        }],
      }],
    });
    expect(ev[0]).toMatchObject({ msgType: "button", text: "Free Growth Report", contextId: "w.tpl", profileName: "Ravi", timestamp: "1760000000" });
    expect(ev[1]).toMatchObject({ msgType: "interactive", text: "Send Details", buttonPayload: "send_details" });
    expect(ev[2]).toMatchObject({ msgType: "image", text: "Our OPD", media: { id: "media1", mime_type: "image/jpeg" } });
  });
});
