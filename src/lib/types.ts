// Row types mirroring supabase/migrations. Replace with `supabase gen types`
// output once the project is linked (see PROJECT_STATUS.md).
export type AppRole = "admin" | "manager" | "agent" | "viewer";
export type ConsentStatus = "unknown" | "opted_in" | "opted_out";
export type LeadStatus = "new" | "contacted" | "interested" | "not_interested" | "converted";

export interface Profile {
  id: string;
  email: string | null;
  full_name: string | null;
  role: AppRole;
  is_active: boolean;
  created_at: string;
}

export interface Segment {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  color: string;
  sort_order: number;
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface Lead {
  id: string;
  full_name: string | null;
  organization: string | null;
  phone_raw: string | null;
  phone_e164: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  segment_id: string | null;
  status: LeadStatus;
  source: string | null;
  notes: string | null;
  custom_fields: Record<string, unknown>;
  marketing_consent: ConsentStatus;
  consent_source: string | null;
  consent_at: string | null;
  is_archived: boolean;
  archived_at: string | null;
  import_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImportRecord {
  id: string;
  file_name: string;
  file_type: "csv" | "xlsx";
  segment_id: string | null;
  tag_ids: string[];
  duplicate_strategy: "skip" | "update";
  default_country: string;
  column_mapping: Record<string, string>;
  consent_basis: string | null;
  status: "processing" | "completed" | "failed";
  total_rows: number;
  inserted_count: number;
  updated_count: number;
  duplicate_count: number;
  error_count: number;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface DashboardMetrics {
  total_leads: number;
  archived_leads: number;
  opted_in: number;
  opted_out: number;
  imports: number;
  campaigns: number;
  segments: { id: string; name: string; color: string; count: number }[];
  messages: { sent: number; delivered: number; read: number; failed: number; pending: number; dry_run: number };
  est_cost: number;
}

export interface WhatsAppTemplate {
  id: string;
  meta_template_id: string | null;
  name: string;
  language: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  status: string;
  rejected_reason: string | null;
  quality_score: string | null;
  components: import("@/lib/whatsapp/templates").MetaComponent[];
  example_data: { draft?: import("@/lib/whatsapp/templates").TemplateDraft; dirty?: boolean };
  last_synced_at: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Campaign {
  id: string;
  name: string;
  template_id: string | null;
  status: "draft" | "queued" | "running" | "paused" | "completed" | "cancelled" | "failed";
  audience_filter: { segment_ids?: string[]; tag_ids?: string[]; tag_match?: "any" | "all" };
  variable_mapping: import("@/lib/whatsapp/send").VariableMapping;
  header_media: import("@/lib/whatsapp/send").HeaderMedia | null;
  is_dry_run: boolean;
  total_recipients: number;
  est_rate: number;
  est_cost: number;
  est_unpriced: number;
  est_country: string | null;
  currency: string;
  last_error: string | null;
  template_snapshot: import("@/lib/whatsapp/send").TemplateSnapshot | null;
  confirmed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface CampaignStats {
  campaign_id: string;
  total: number;
  queued: number;
  sending: number;
  submitted: number;
  sent_confirmed: number;
  delivered: number;
  read: number;
  failed: number;
  cancelled: number;
  skipped: number;
  dry_run: number;
  paid: number;
  free: number;
}
