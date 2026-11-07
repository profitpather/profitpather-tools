/**
 * Usage counters for the hub.
 *
 * This exists because Cloudflare analytics could tell us how many requests
 * arrived but not what they asked for, and that distinction was the whole
 * question: 116k requests in a month looked like traction until the split
 * across four unrelated servers came back within 3% of even, which is the
 * signature of robots handshaking rather than anyone doing work.
 *
 * Aggregate-only by design. One upsert per request into a
 * day/server/method/tool/client bucket, with no IP, no arguments and no raw
 * user-agent, so the table cannot become a record of who asked what about
 * which store. The client label is deliberately lossy for the same reason.
 *
 * Telemetry never affects a response: every write runs in waitUntil and
 * swallows its own errors.
 */

const SCHEMA = `CREATE TABLE IF NOT EXISTS rpc_daily (
  day TEXT NOT NULL,
  server TEXT NOT NULL,
  method TEXT NOT NULL,
  tool TEXT NOT NULL DEFAULT '',
  client TEXT NOT NULL DEFAULT '',
  calls INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, server, method, tool, client)
)`;

let schemaReady = false;

/** A request that asks the server to do its actual job, as opposed to one that
 *  only inspects it. The whole point of the table is telling these apart. */
export const isWork = (method) => method === "tools/call";

/**
 * Coarse client family from the user-agent. Lossy on purpose: enough to answer
 * "is this a real client or a directory crawler", never enough to fingerprint
 * a caller.
 */
export function clientFamily(ua) {
  const s = String(ua || "").toLowerCase();
  if (!s) return "none";
  if (s.includes("claude")) return "claude";
  if (s.includes("codex")) return "codex";
  if (s.includes("cursor")) return "cursor";
  if (s.includes("windsurf")) return "windsurf";
  if (s.includes("glama")) return "glama";
  if (s.includes("smithery")) return "smithery";
  if (s.includes("pulsemcp") || s.includes("mcp.so")) return "directory";
  if (s.includes("openai") || s.includes("gptbot") || s.includes("chatgpt")) return "openai";
  if (s.includes("mcp")) return "other-mcp-client";
  if (s.includes("python") || s.includes("httpx") || s.includes("aiohttp") || s.includes("requests")) return "python";
  if (s.includes("undici") || s.includes("node")) return "node";
  if (s.includes("go-http")) return "go";
  if (s.includes("curl") || s.includes("wget")) return "curl";
  if (s.includes("mozilla") || s.includes("chrome") || s.includes("safari")) return "browser";
  return "other";
}

/** Fire-and-forget counter bump. */
export function recordRpc(env, ctx, { server, method, tool = "", client = "none", isError = false, cached = false }) {
  if (!env?.STATS || !method) return;
  const day = new Date().toISOString().slice(0, 10);
  const write = async () => {
    try {
      if (!schemaReady) {
        await env.STATS.prepare(SCHEMA).run();
        schemaReady = true;
      }
      await env.STATS.prepare(
        `INSERT INTO rpc_daily(day,server,method,tool,client,calls,errors,cached)
         VALUES(?,?,?,?,?,1,?,?)
         ON CONFLICT(day,server,method,tool,client) DO UPDATE SET
           calls = calls + 1,
           errors = errors + excluded.errors,
           cached = cached + excluded.cached`
      ).bind(day, server, String(method).slice(0, 40), String(tool || "").slice(0, 60), client, isError ? 1 : 0, cached ? 1 : 0).run();
    } catch {
      // A telemetry failure must never surface to the caller or retry.
    }
  };
  ctx.waitUntil(write());
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

/** Rolls the counters up into the answer to "is anyone actually using this". */
export async function statsPayload(env, days = 14) {
  const since = new Date(Date.now() - (Math.max(1, Math.min(90, days)) - 1) * 86400000)
    .toISOString().slice(0, 10);
  const { results = [] } = await env.STATS.prepare(
    `SELECT day,server,method,tool,client,calls,errors,cached FROM rpc_daily WHERE day >= ? ORDER BY day DESC`
  ).bind(since).all();

  const bump = (m, k, r) => {
    const o = m[k] || (m[k] = { calls: 0, errors: 0, cached: 0 });
    o.calls += r.calls; o.errors += r.errors; o.cached += r.cached;
  };
  const byDay = {}, byServer = {}, byMethod = {}, byClient = {}, byTool = {};
  let calls = 0, errors = 0, cached = 0, work = 0, inspect = 0;
  for (const r of results) {
    calls += r.calls; errors += r.errors; cached += r.cached;
    if (isWork(r.method)) work += r.calls; else inspect += r.calls;
    bump(byDay, r.day, r); bump(byServer, r.server, r);
    bump(byMethod, r.method, r); bump(byClient, r.client, r);
    if (r.tool) bump(byTool, `${r.server}/${r.tool}`, r);
  }
  const sorted = (m) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1].calls - a[1].calls));

  return {
    window: { since, days, generated_at: new Date().toISOString() },
    totals: {
      calls, errors, cache_hits: cached,
      real_work: work,
      inspection: inspect,
      real_work_pct: pct(work, calls),
      note: "real_work counts tools/call, the only method that asks a server to do its job. Everything else (initialize, tools/list, ping, notifications) is a client or a directory robot looking at the server rather than using it.",
    },
    by_method: sorted(byMethod),
    by_server: sorted(byServer),
    by_tool: sorted(byTool),
    by_client: sorted(byClient),
    by_day: Object.fromEntries(Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0]))),
    buckets: results.length,
    privacy: "Aggregate counters only. No IP addresses, no tool arguments and no raw user-agents are recorded, so this cannot show who asked what about which store.",
  };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** A table a human can read, because the person asking is a person. */
export function statsHTML(d, key) {
  const rows = (m, label) => `<h2>${esc(label)}</h2><table><tr><th>${esc(label)}</th><th>calls</th><th>errors</th><th>cache hits</th></tr>${
    Object.entries(m).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v.calls}</td><td>${v.errors}</td><td>${v.cached}</td></tr>`).join("") || "<tr><td colspan=4>no data yet</td></tr>"
  }</table>`;
  const t = d.totals;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Tools hub usage</title>
<style>
:root{--bg:#f3f4f7;--card:#fff;--line:#e8eaef;--ink:#0d0f14;--dim:#70757f;--accent:#6d4aff}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0d0f14;--card:#16181f;--line:#262a33;--ink:#eef0f4;--dim:#9aa0aa}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:40px 16px 72px}
h1{font-size:26px;margin:0 0 4px;letter-spacing:-.02em}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:28px 0 8px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);font-variant-numeric:tabular-nums}
th{font-size:12px;color:var(--dim);font-weight:600}tr:last-child td{border-bottom:none}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:16px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.kpi b{display:block;font-size:24px;letter-spacing:-.02em}.kpi span{font-size:12px;color:var(--dim)}
.note{color:var(--dim);font-size:13px;margin-top:10px}
</style></head><body><div class="wrap">
<h1>Tools hub usage</h1>
<div class="note">${esc(d.window.since)} to today, ${d.window.days} days. Generated ${esc(d.window.generated_at)}. <a href="/stats.json?key=${encodeURIComponent(key)}" style="color:var(--accent)">JSON</a></div>
<div class="kpis">
  <div class="kpi"><b>${t.calls}</b><span>JSON-RPC calls</span></div>
  <div class="kpi"><b>${t.real_work}</b><span>real work (tools/call)</span></div>
  <div class="kpi"><b>${t.real_work_pct}%</b><span>of calls are real work</span></div>
  <div class="kpi"><b>${t.cache_hits}</b><span>served from cache</span></div>
  <div class="kpi"><b>${t.errors}</b><span>errors</span></div>
</div>
<div class="note">${esc(t.note)}</div>
${rows(d.by_client, "client")}
${rows(d.by_method, "method")}
${rows(d.by_tool, "tool actually called")}
${rows(d.by_server, "server")}
${rows(d.by_day, "day")}
<div class="note">${esc(d.privacy)}</div>
</div></body></html>`;
}
