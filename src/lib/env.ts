import "server-only";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}. See .env.example.`);
  return v;
}

export const supabaseEnv = () => ({
  url: required("NEXT_PUBLIC_SUPABASE_URL"),
  anonKey: required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
});

export const serviceRoleKey = () => required("SUPABASE_SERVICE_ROLE_KEY");

export const whatsappMode = (): "mock" | "live" => (process.env.WHATSAPP_MODE === "live" ? "live" : "mock");
