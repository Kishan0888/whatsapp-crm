import "server-only";

/** Error from the Graph API (or transport). `code` drives retry decisions. */
export class MetaApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public httpStatus: number,
    public details?: string,
    public fbtraceId?: string,
  ) {
    super(message);
    this.name = "MetaApiError";
  }
}

interface GraphOpts {
  token: string;
  version: string;
  query?: Record<string, string>;
  json?: unknown;
  body?: BodyInit;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export async function graphRequest<T>(method: "GET" | "POST" | "DELETE", path: string, o: GraphOpts): Promise<T> {
  const url = new URL(`https://graph.facebook.com/${o.version}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { Authorization: `Bearer ${o.token}`, ...o.headers };
  let body = o.body;
  if (o.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(o.json);
  }
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(o.timeoutMs ?? 20_000), cache: "no-store" });
  } catch (e) {
    throw new MetaApiError(`Could not reach Meta: ${e instanceof Error ? e.message : String(e)}`, "network", 0);
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const err = (data as { error?: { message?: string; code?: number; error_data?: { details?: string }; fbtrace_id?: string } })?.error;
    if (err?.code !== undefined)
      throw new MetaApiError(err.message ?? "Meta API error", String(err.code), res.status, err.error_data?.details, err.fbtrace_id);
    throw new MetaApiError(`Meta API HTTP ${res.status}`, res.status >= 500 ? "http_5xx" : `http_${res.status}`, res.status, text.slice(0, 300));
  }
  return data as T;
}
