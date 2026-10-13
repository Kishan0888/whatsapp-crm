#!/usr/bin/env node
// Long-running worker for VPS/Docker deployments: calls the send endpoint
// in a loop. Usage: APP_URL=https://crm.example.com WORKER_SECRET=... node scripts/worker.mjs
const url = `${process.env.APP_URL ?? "http://localhost:3000"}/api/worker/send`;
const secret = process.env.WORKER_SECRET;
if (!secret) {
  console.error("WORKER_SECRET is required");
  process.exit(1);
}
const idleMs = Number(process.env.WORKER_IDLE_MS ?? 15000);

for (;;) {
  try {
    const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
    const body = await res.json().catch(() => ({}));
    console.log(new Date().toISOString(), res.status, JSON.stringify(body));
    if (!res.ok || !body.claimed) await new Promise((r) => setTimeout(r, idleMs));
  } catch (e) {
    console.error(new Date().toISOString(), "worker request failed:", e.message);
    await new Promise((r) => setTimeout(r, idleMs));
  }
}
