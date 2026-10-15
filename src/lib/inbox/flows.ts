/**
 * Button-driven conversation flows ("Free Growth Report", "Send Details").
 * Pure: takes the stored flow state + one inbound message and returns the
 * next state, the replies to queue and any details to save. No I/O.
 */
import type { TemplateSnapshot, SendComponent } from "@/lib/whatsapp/send";

export const FLOW_TTL_MS = 24 * 60 * 60 * 1000; // matches WhatsApp's customer service window
export const CTA_LABEL_MAX = 20; // interactive cta_url display_text limit

export type DetailsStep = "name" | "hospital" | "datetime" | "done" | "cancelled";

export interface FlowState {
  name: "send_details";
  step: DetailsStep;
  data: { representative?: string; hospital?: string; preferred_time?: string };
  started_at: string;
  updated_at: string;
  /** wamid of the last inbound message applied — guards against replays. */
  last_input?: string;
  completed_at?: string;
}

export interface InboundInput {
  wamid: string;
  /** WhatsApp message type: text, button, interactive, image, … */
  msgType: string;
  text: string;
  buttonPayload?: string;
}

export type ReplySpec =
  | { type: "text"; body: string }
  | { type: "cta_url"; body: string; displayText: string; url: string }
  | { type: "template"; body: string; template: TemplateSnapshot; components: SendComponent[] }
  /** Recorded in the inbox for staff, never sent. */
  | { type: "note"; body: string };

export interface FlowContext {
  now: Date;
  meetingUrl: string | null;
  /** Approved template with a URL button, if configured; else an interactive CTA is used. */
  growthTemplate: { snapshot: TemplateSnapshot; body: string } | null;
}

export interface Decision {
  /** undefined = leave state unchanged; null = clear. */
  flow?: FlowState | null;
  replies: ReplySpec[];
  details?: { representative: string; hospital: string; preferred_time: string };
  /** Machine-readable reason, for logs/tests. */
  action: string;
}

const norm = (s: string | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

export type ButtonIntent = "free_growth_report" | "send_details" | null;

/** Recognise our quick-reply buttons from a template button tap or interactive reply. */
export function buttonIntent(input: InboundInput): ButtonIntent {
  if (input.msgType !== "button" && input.msgType !== "interactive") return null;
  for (const v of [input.buttonPayload, input.text]) {
    const n = norm(v);
    if (n === "freegrowthreport") return "free_growth_report";
    if (n === "senddetails") return "send_details";
  }
  return null;
}

const CANCEL = new Set(["cancel", "exit", "quit", "stopform", "cancelform"]);
const RESTART = new Set(["restart", "startover", "startagain", "reset"]);

export const MESSAGES = {
  growthReport:
    "Thank you for requesting your *Free Growth Report*! 🙌\n\nOur team will prepare it for your hospital. Pick a convenient time for a short call so we can walk you through it.",
  growthReportNoUrl:
    "Automated reply held: the meeting link isn't configured (Settings → WhatsApp → Meeting URL). Please reply to this contact manually.",
  start: "Sure — let's get a few details to set up your meeting. Reply *CANCEL* at any time to stop.",
  restart: "No problem, let's start again.",
  askName: "1/3 — What is the *representative's full name*?",
  askHospital: (name: string) => `Thanks, ${name}. 2/3 — What is the *name of your hospital*?`,
  askDateTime: "3/3 — What is your *preferred date and time* for the meeting? (e.g. Monday 20 Oct, 11 AM)",
  invalid: "Sorry, I didn't catch that.",
  done: (d: { representative: string; hospital: string; preferred_time: string }) =>
    `Thank you! We've received your details:\n\n• Representative: ${d.representative}\n• Hospital: ${d.hospital}\n• Preferred time: ${d.preferred_time}\n\nOur team will confirm the meeting shortly. Reply *RESTART* if anything needs changing.`,
  cancelled: "Okay, I've cancelled this. Tap *Send Details* or reply *RESTART* whenever you'd like to continue.",
};

const ASK: Record<"name" | "hospital" | "datetime", (s: FlowState) => string> = {
  name: () => MESSAGES.askName,
  hospital: (s) => MESSAGES.askHospital(s.data.representative ?? "there"),
  datetime: () => MESSAGES.askDateTime,
};

/** Flow state that is still in play (not expired). */
export function liveFlow(flow: FlowState | null | undefined, now: Date): FlowState | null {
  if (!flow || flow.name !== "send_details") return null;
  return now.getTime() - new Date(flow.updated_at).getTime() > FLOW_TTL_MS ? null : flow;
}

const isActive = (f: FlowState | null): f is FlowState => !!f && ["name", "hospital", "datetime"].includes(f.step);

function clean(text: string, max: number): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 2 || t.length > max) return null;
  if (!/[\p{L}\p{N}]/u.test(t)) return null;
  return t;
}

function fresh(now: Date, wamid: string): FlowState {
  const ts = now.toISOString();
  return { name: "send_details", step: "name", data: {}, started_at: ts, updated_at: ts, last_input: wamid };
}

function growthReportReplies(ctx: FlowContext): ReplySpec[] {
  if (!ctx.meetingUrl) return [{ type: "note", body: MESSAGES.growthReportNoUrl }];
  if (ctx.growthTemplate) {
    return [{ type: "template", body: ctx.growthTemplate.body, template: ctx.growthTemplate.snapshot, components: [] }];
  }
  return [{ type: "cta_url", body: MESSAGES.growthReport, displayText: "Schedule Meeting", url: ctx.meetingUrl }];
}

/** Decide what to do with one inbound message. */
export function decide(stored: FlowState | null | undefined, input: InboundInput, ctx: FlowContext): Decision {
  const now = ctx.now;
  const flow = liveFlow(stored, now);
  const intent = buttonIntent(input);

  // Replay of a message whose state change was already applied.
  if (stored?.last_input === input.wamid) return { replies: [], action: "already_applied" };

  if (intent === "free_growth_report") return { replies: growthReportReplies(ctx), action: "growth_report" };

  if (intent === "send_details") {
    const next = fresh(now, input.wamid);
    return {
      flow: next,
      replies: [{ type: "text", body: `${isActive(flow) ? MESSAGES.restart : MESSAGES.start}\n\n${MESSAGES.askName}` }],
      action: isActive(flow) ? "restart" : "start",
    };
  }

  const cmd = input.msgType === "text" ? norm(input.text) : "";
  if (flow && RESTART.has(cmd)) {
    return { flow: fresh(now, input.wamid), replies: [{ type: "text", body: `${MESSAGES.restart}\n\n${MESSAGES.askName}` }], action: "restart" };
  }
  if (!isActive(flow)) return { replies: [], action: "none" };

  const touch = (patch: Partial<FlowState>): FlowState => ({ ...flow, ...patch, updated_at: now.toISOString(), last_input: input.wamid });

  if (CANCEL.has(cmd)) {
    return { flow: touch({ step: "cancelled" }), replies: [{ type: "text", body: MESSAGES.cancelled }], action: "cancel" };
  }

  const step = flow.step as "name" | "hospital" | "datetime";
  const answer = input.msgType === "text" ? clean(input.text, step === "datetime" ? 120 : 100) : null;
  if (!answer) {
    return { flow: touch({}), replies: [{ type: "text", body: `${MESSAGES.invalid} ${ASK[step](flow)}` }], action: "reask" };
  }

  if (step === "name") {
    const next = touch({ step: "hospital", data: { ...flow.data, representative: answer } });
    return { flow: next, replies: [{ type: "text", body: ASK.hospital(next) }], action: "got_name" };
  }
  if (step === "hospital") {
    const next = touch({ step: "datetime", data: { ...flow.data, hospital: answer } });
    return { flow: next, replies: [{ type: "text", body: ASK.datetime(next) }], action: "got_hospital" };
  }
  const details = {
    representative: flow.data.representative ?? "",
    hospital: flow.data.hospital ?? "",
    preferred_time: answer,
  };
  return {
    flow: touch({ step: "done", data: details, completed_at: now.toISOString() }),
    replies: [{ type: "text", body: MESSAGES.done(details) }],
    details,
    action: "complete",
  };
}
