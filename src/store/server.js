/**
 * Storefront Check: what an outsider can prove about an ecommerce storefront.
 *
 * Everything here is read from the public storefront. No credentials, no
 * account, no cooperation from the store. That is the point: an agent can audit
 * a store it has no access to, including a competitor or a prospect.
 *
 * The hard rule is that this server distinguishes three states and never
 * conflates them: present, absent, and not observable from outside. A Shopify
 * Custom Pixel loads inside a sandboxed iframe, so it cannot be seen in the
 * storefront HTML at all. Reporting "no pixel" in that case would be a lie, so
 * every tool carries a not_observable list saying what it could not see.
 */

const UA = "ProfitpatherStorefrontCheck/1.0 (+https://tools.profitpather.com/store)";
const FETCH_TIMEOUT_MS = 12000;
const MAX_HTML_BYTES = 800_000;
const MAX_JSON_BYTES = 2_000_000;

/* ----------------------------------------------------------------- fetch -- */

/**
 * Only public http(s) hosts. This server fetches caller-supplied URLs with no
 * authentication, so without this guard it would be an open proxy and a way to
 * probe anything that happens to be reachable from the edge.
 */
function safeUrl(raw, { field = "url" } = {}) {
  let u;
  const text = String(raw || "").trim();
  if (!text) throw new Error(`${field} is required, for example https://example.com.`);
  try {
    u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new Error(`${field} is not a valid URL: ${JSON.stringify(text)}.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`${field} must be http or https, not ${u.protocol.replace(":", "")}.`);
  }
  const host = u.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    !host.includes(".") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.includes(":");
  if (blocked) {
    throw new Error(
      `${field} must be a public domain name. Bare IP addresses and internal hostnames are refused, because this server fetches the URL for you and will not be used to reach private networks.`
    );
  }
  return u;
}

async function get(url, { accept = "text/html,*/*", cap = MAX_HTML_BYTES } = {}) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, accept },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    cf: { cacheTtl: 3600, cacheEverything: true },
  });
  const body = res.ok || res.status < 500 ? (await res.text()).slice(0, cap) : "";
  return { status: res.status, ok: res.ok, finalUrl: res.url || String(url), headers: res.headers, body };
}

/** A fetch that reports its own failure instead of throwing the whole tool over. */
async function tryGet(url, opts) {
  try {
    return await get(url, opts);
  } catch (e) {
    const why = /timeout|aborted/i.test(String(e?.message)) ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s` : String(e?.message || e);
    return { status: 0, ok: false, finalUrl: String(url), headers: new Headers(), body: "", error: why };
  }
}

const uniq = (a) => [...new Set(a.filter(Boolean))];
const all = (re, s) => uniq([...s.matchAll(re)].map((m) => m[1]));

/* ------------------------------------------------------------- platform -- */

function detectPlatform(html, headers, finalUrl) {
  const h = (n) => headers.get(n) || "";
  const signals = [];
  let platform = "unknown";
  if (h("x-shopid") || h("x-shopify-stage") || /cdn\.shopify\.com|\/cdn\/shop\/|Shopify\.shop/i.test(html)) {
    platform = "shopify";
    if (h("x-shopid")) signals.push(`x-shopid header: ${h("x-shopid")}`);
    if (/\/cdn\/shop\//i.test(html)) signals.push("Shopify CDN asset paths");
  } else if (/wp-content|wp-json/i.test(html)) {
    platform = /woocommerce/i.test(html) ? "woocommerce" : "wordpress";
  } else if (/cdn\d*\.bigcommerce\.com/i.test(html)) platform = "bigcommerce";
  else if (/static\.squarespace\.com/i.test(html)) platform = "squarespace";
  else if (/wixstatic\.com/i.test(html)) platform = "wix";

  const theme = (html.match(/Shopify\.theme\s*=\s*(\{[^}]*\})/) || [])[1] || null;
  let themeName = null;
  if (theme) {
    themeName = (theme.match(/"name"\s*:\s*"([^"]+)"/) || [])[1] || null;
  }
  return { platform, theme_name: themeName, signals, final_url: finalUrl };
}

/* ------------------------------------------------------- tracking tags --- */

const TAG_PATTERNS = [
  { id: "ga4", label: "Google Analytics 4", re: /\b(G-[A-Z0-9]{6,})\b/g, kind: "analytics" },
  { id: "google_ads", label: "Google Ads conversion tag", re: /\b(AW-\d{9,})\b/g, kind: "advertising" },
  { id: "gtm", label: "Google Tag Manager", re: /\b(GTM-[A-Z0-9]{4,})\b/g, kind: "tag manager" },
  { id: "google_legacy", label: "Universal Analytics (sunset)", re: /\b(UA-\d{4,}-\d+)\b/g, kind: "analytics" },
  { id: "meta_pixel", label: "Meta (Facebook) pixel", re: /fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d{14,17})['"]/g, kind: "advertising" },
  { id: "tiktok", label: "TikTok pixel", re: /ttq\.load\s*\(\s*['"]([A-Z0-9]{15,})['"]/g, kind: "advertising" },
  { id: "bing_uet", label: "Microsoft Advertising UET", re: /\bti\s*:\s*["'](\d{6,})["']/g, kind: "advertising" },
  { id: "klaviyo", label: "Klaviyo onsite", re: /klaviyo\.js\?company_id=([A-Za-z0-9]+)/g, kind: "email" },
  { id: "clarity", label: "Microsoft Clarity", re: /clarity\.ms\/tag\/([a-z0-9]+)/g, kind: "analytics" },
  { id: "hotjar", label: "Hotjar", re: /hjid\s*:\s*(\d+)/g, kind: "analytics" },
];

/** Script hosts worth reporting even when no id is extractable. */
const HOST_PATTERNS = [
  { id: "meta_pixel", label: "Meta (Facebook) pixel", re: /connect\.facebook\.net\/[^"']*fbevents\.js/i },
  { id: "pinterest", label: "Pinterest tag", re: /s\.pinimg\.com\/ct\/core\.js|pintrk\s*\(/i },
  { id: "snap", label: "Snap pixel", re: /sc-static\.net\/scevent/i },
  { id: "tiktok", label: "TikTok pixel", re: /analytics\.tiktok\.com/i },
  { id: "judgeme", label: "Judge.me reviews", re: /judge\.me|judgeme/i },
  { id: "yotpo", label: "Yotpo reviews", re: /yotpo\.com|yotpo\.js/i },
  { id: "shopify_analytics", label: "Shopify native analytics (trekkie)", re: /ShopifyAnalytics|trekkie/i },
  { id: "consentmo", label: "Consentmo GDPR app", re: /consentmo|isenselabs/i },
];

/**
 * Google Tag Manager answers 404 for a measurement id it does not know, and a
 * dead id means gtag never initialises, so every downstream conversion is lost
 * while the page still looks correctly tagged. This check exists because that
 * exact failure was found in production: a consent app injected an id that did
 * not resolve, and the store had been reporting zero conversions ever since.
 */
async function verifyGoogleIds(ids) {
  const out = [];
  for (const id of ids.slice(0, 8)) {
    const r = await tryGet(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`, { cap: 2000 });
    const dead = r.status === 404;
    out.push({
      id,
      gtag_status: r.status || null,
      resolves: r.ok,
      verdict: dead
        ? "DEAD. Google Tag Manager does not recognise this id, so gtag never initialises and nothing this tag was supposed to measure is being recorded."
        : r.ok
          ? "Resolves."
          : `Could not verify (${r.error || "status " + r.status}). Treat as unknown rather than broken.`,
    });
  }
  return out;
}

/* ------------------------------------------------------ structured data -- */

function jsonLdBlocks(html) {
  const blocks = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = m[1].trim();
    try {
      blocks.push({ ok: true, data: JSON.parse(raw) });
    } catch (e) {
      blocks.push({ ok: false, error: String(e.message).slice(0, 160), bytes: raw.length });
    }
  }
  return blocks;
}

/**
 * Collects every @type anywhere in the tree. It must walk all object values,
 * not just arrays and @graph: Shopify nests the Offer inside Product under an
 * "offers" key, so a shallow walk reports Product with no Offer, which is both
 * wrong and alarming.
 */
function typesOf(data, acc = [], depth = 0) {
  if (depth > 12 || data == null) return acc;
  if (Array.isArray(data)) { for (const d of data) typesOf(d, acc, depth + 1); return acc; }
  if (typeof data === "object") {
    const t = data["@type"];
    if (t) acc.push(...(Array.isArray(t) ? t : [t]));
    for (const [k, v] of Object.entries(data)) {
      if (k === "@type" || v == null || typeof v !== "object") continue;
      typesOf(v, acc, depth + 1);
    }
  }
  return acc;
}

/** Counts how many separate top-level blocks declare a given @type. */
function blocksDeclaring(blocks, type) {
  return blocks.filter((b) => b.ok && typesOf(b.data).includes(type)).length;
}

/* --------------------------------------------------------------- robots -- */

const AI_AGENTS = [
  "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot",
  "anthropic-ai", "PerplexityBot", "Perplexity-User", "Google-Extended", "Applebot-Extended",
  "CCBot", "meta-externalagent", "Bytespider",
];

/** Parses robots.txt into per-agent allow/disallow, which is what decides
 *  whether an AI crawler may read the store at all. */
function robotsVerdicts(txt) {
  const lines = txt.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
  const groups = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^(user-agent|allow|disallow)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val);
    } else if (cur) {
      cur.rules.push({ type: key, path: val });
    }
  }
  const forAgent = (agent) => {
    const exact = groups.find((g) => g.agents.some((a) => a.toLowerCase() === agent.toLowerCase()));
    const star = groups.find((g) => g.agents.includes("*"));
    const g = exact || star;
    if (!g) return { agent, matched: "none", blocked: false, note: "No rule, so crawling is permitted by default." };
    const blocksRoot = g.rules.some((r) => r.type === "disallow" && (r.path === "/" || r.path === ""));
    const blocked = g.rules.some((r) => r.type === "disallow" && r.path === "/");
    return {
      agent,
      matched: exact ? "named explicitly" : "wildcard (*)",
      blocked,
      note: blocked
        ? "Blocked from the whole site."
        : blocksRoot
          ? "Has rules but does not block the root."
          : "Permitted.",
    };
  };
  return AI_AGENTS.map(forAgent);
}

/* ---------------------------------------------------------------- tools -- */

const TOOLS = [
  {
    name: "detect_tracking_tags",
    title: "Find the advertising and analytics tags on a storefront",
    description:
      "Reads a public storefront and reports every advertising, analytics and marketing tag visible in its HTML, with the actual measurement ids. It then verifies each Google id against Google Tag Manager, because an id Google does not recognise returns 404 and silently stops gtag from initialising, which means a campaign can spend for months while recording zero conversions. Use this to explain why conversion tracking is wrong, or to see what a store you have no access to is running.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The storefront URL, for example example.com or https://example.com." },
        verify_google_ids: { type: "boolean", description: "Check each Google id against Google Tag Manager to catch dead ids. Default true." },
      },
      required: ["url"],
    },
  },
  {
    name: "check_agent_readiness",
    title: "Check whether AI shopping agents can find and read a store",
    description:
      "Determines whether an AI agent can actually discover and parse a store: whether robots.txt permits each major AI crawler by name, whether a sitemap, llms.txt, product feed or MCP endpoint exists, and whether the catalogue is machine readable. Use this when asked why a store never appears in AI assistants or agent shopping results.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "The store's domain, for example example.com." } },
      required: ["url"],
    },
  },
  {
    name: "check_structured_data",
    title: "Check a page's structured data",
    description:
      "Parses every JSON-LD block on a page and reports the schema.org types found, blocks that fail to parse, and whether the types a shopping agent looks for are present. Point it at a product page to check Product and Offer markup, or at a homepage to check Organization and WebSite.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "The exact page URL to inspect. Use a product URL to check Product markup." } },
      required: ["url"],
    },
  },
  {
    name: "audit_product_feed",
    title: "Audit a Shopify catalogue for feed readiness",
    description:
      "Reads a Shopify store's public products.json and reports what would break a Google Merchant Center or Meta catalogue feed: missing barcodes, absent weights, unpriced or unavailable variants, and thin descriptions. Shopify-only, because products.json is a Shopify endpoint.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The Shopify store domain, for example example.com." },
        limit: { type: "integer", description: "How many products to sample, 1 to 250. Default 250." },
      },
      required: ["url"],
    },
  },
];

const publicTool = (t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema });

/* ------------------------------------------------------------- handlers -- */

async function detectTrackingTags(a) {
  const u = safeUrl(a.url);
  const page = await tryGet(u.toString());
  if (!page.body) {
    throw new Error(
      `Could not read ${u.hostname}: ${page.error || "HTTP " + page.status}. If the store blocks unknown clients this tool cannot audit it from outside.`
    );
  }
  const html = page.body;
  const platform = detectPlatform(html, page.headers, page.finalUrl);

  const found = [];
  for (const p of TAG_PATTERNS) {
    for (const id of all(p.re, html)) found.push({ vendor: p.label, kind: p.kind, id, detected_via: "measurement id in HTML" });
  }
  for (const p of HOST_PATTERNS) {
    if (p.re.test(html) && !found.some((f) => f.vendor === p.label)) {
      found.push({ vendor: p.label, kind: "script", id: null, detected_via: "script or host reference in HTML" });
    }
  }

  const googleIds = found.filter((f) => /^(G-|AW-)/.test(f.id || "")).map((f) => f.id);
  const verify = a.verify_google_ids === false ? [] : await verifyGoogleIds(googleIds);
  const dead = verify.filter((v) => v.resolves === false && v.gtag_status === 404);

  const findings = [];
  if (dead.length) {
    findings.push({
      severity: "critical",
      finding: `${dead.length} Google tag id${dead.length === 1 ? " does" : "s do"} not resolve (${dead.map((d) => d.id).join(", ")}). gtag never initialises, so anything ${dead.length === 1 ? "it was" : "they were"} meant to measure is not being recorded.`,
      fix: "Find what injects the id. A consent or cookie app is a common culprit, because it rewrites the tag snippet and can carry a stale id from a previous property.",
    });
  }
  const ga4 = uniq(found.filter((f) => f.vendor.startsWith("Google Analytics")).map((f) => f.id));
  if (ga4.length > 1) {
    findings.push({
      severity: "warning",
      finding: `${ga4.length} different GA4 properties are tagged (${ga4.join(", ")}), so sessions are being counted into more than one place.`,
      fix: "Keep one. Duplicate GA4 tags also double-count events, which inflates every rate derived from them.",
    });
  }
  if (!found.some((f) => f.vendor.includes("Google Ads"))) {
    findings.push({
      severity: "info",
      finding: "No Google Ads conversion tag (AW-) is visible in the storefront HTML.",
      fix: "If Google Ads is spending, confirm the tag is installed. A campaign with no conversion tag optimises blind. Note a tag deployed through a Shopify Custom Pixel would not be visible here.",
    });
  }
  if (found.some((f) => f.vendor.includes("Universal Analytics"))) {
    findings.push({ severity: "warning", finding: "A Universal Analytics (UA-) id is still present. UA stopped processing data, so this tag does nothing.", fix: "Remove it to cut a request from every page load." });
  }

  const notObservable = ["Shopify Custom Pixels, which run in a sandboxed iframe and never appear in the storefront HTML. A store can be correctly tagged there while this report shows nothing."];
  if (found.some((f) => f.vendor.includes("Tag Manager"))) {
    notObservable.push("Tags fired from inside Google Tag Manager. Only the container id is visible from outside, not what it loads.");
  }
  if (found.some((f) => f.vendor.includes("Consentmo"))) {
    notObservable.push("What the consent app does at runtime. It can rewrite or suppress tag snippets after the page loads, so the HTML is not the final state.");
  }

  return {
    url: page.finalUrl,
    platform: platform.platform,
    theme_name: platform.theme_name,
    tag_count: found.length,
    tags: found,
    google_id_verification: verify,
    findings,
    not_observable: notObservable,
    method: "A single GET of the storefront HTML as an identified crawler, plus one request per Google id to Google Tag Manager. Nothing is executed, so anything injected by JavaScript after load is invisible here.",
  };
}

async function checkAgentReadiness(a) {
  const u = safeUrl(a.url);
  const origin = u.origin;
  const [home, robots, llms, sitemap, products, mcp] = await Promise.all([
    tryGet(origin),
    tryGet(`${origin}/robots.txt`, { accept: "text/plain", cap: 200_000 }),
    tryGet(`${origin}/llms.txt`, { accept: "text/plain", cap: 200_000 }),
    tryGet(`${origin}/sitemap.xml`, { accept: "application/xml", cap: 50_000 }),
    tryGet(`${origin}/products.json?limit=1`, { accept: "application/json", cap: 50_000 }),
    tryGet(`${origin}/.well-known/mcp.json`, { accept: "application/json", cap: 20_000 }),
  ]);

  const crawlers = robots.ok && robots.body ? robotsVerdicts(robots.body) : [];
  const blocked = crawlers.filter((c) => c.blocked);
  const named = crawlers.filter((c) => c.matched === "named explicitly");

  let catalogue = { readable: false, note: "No public products.json, so an agent cannot read the catalogue without scraping pages." };
  try {
    const j = JSON.parse(products.body);
    if (Array.isArray(j?.products)) {
      catalogue = { readable: true, note: "products.json is public, so an agent can read the catalogue directly rather than scraping." };
    }
  } catch { /* not Shopify, or endpoint disabled */ }

  const ld = home.body ? jsonLdBlocks(home.body) : [];
  const homeTypes = uniq(ld.flatMap((b) => (b.ok ? typesOf(b.data) : [])));

  const findings = [];
  if (blocked.length) {
    findings.push({
      severity: "critical",
      finding: `robots.txt blocks ${blocked.length} AI crawler${blocked.length === 1 ? "" : "s"} from the whole site: ${blocked.map((b) => b.agent).join(", ")}.`,
      fix: "Decide this deliberately. Blocking a training crawler is a reasonable choice, but blocking a retrieval or search crawler such as OAI-SearchBot or Claude-SearchBot removes the store from AI answers entirely.",
    });
  }
  if (!robots.ok) findings.push({ severity: "warning", finding: `No readable robots.txt (HTTP ${robots.status || robots.error}).`, fix: "Crawling is then permitted by default, but you also have no control over it." });
  if (!llms.ok) findings.push({ severity: "info", finding: "No llms.txt.", fix: "An emerging convention for telling an agent what the site is and where the useful pages are. Cheap to add and it costs nothing if ignored." });
  if (!catalogue.readable) findings.push({ severity: "warning", finding: catalogue.note, fix: "On Shopify, products.json is public unless deliberately blocked. Check robots.txt is not disallowing it." });
  if (!homeTypes.length) findings.push({ severity: "warning", finding: "No parseable JSON-LD on the homepage, so there is no Organization or WebSite markup for an agent to key on.", fix: "Add Organization markup with the brand name, logo and sameAs links." });
  if (!named.length && crawlers.length) findings.push({ severity: "info", finding: "No AI crawler is named explicitly in robots.txt; all of them fall through to the wildcard rule.", fix: "Naming them is how you treat retrieval and training crawlers differently." });

  return {
    url: u.origin,
    discoverable: {
      robots_txt: { present: robots.ok, status: robots.status || null },
      sitemap_xml: { present: sitemap.ok, status: sitemap.status || null },
      llms_txt: { present: llms.ok, status: llms.status || null },
      mcp_endpoint: { present: mcp.ok, status: mcp.status || null },
      products_json: catalogue,
      homepage_schema_types: homeTypes,
    },
    ai_crawlers: crawlers,
    findings,
    not_observable: [
      "Whether an AI assistant actually cites this store. That depends on each provider's index and ranking, which no external check can see. This tool reports only whether the door is open.",
    ],
  };
}

async function checkStructuredData(a) {
  const u = safeUrl(a.url);
  const page = await tryGet(u.toString());
  if (!page.body) throw new Error(`Could not read ${u.toString()}: ${page.error || "HTTP " + page.status}.`);
  const blocks = jsonLdBlocks(page.body);
  const good = blocks.filter((b) => b.ok);
  const broken = blocks.filter((b) => !b.ok);
  const types = uniq(good.flatMap((b) => typesOf(b.data)));

  const hasMicrodata = /itemtype=["']https?:\/\/schema\.org/i.test(page.body);
  const wanted = ["Product", "Offer", "Organization", "WebSite", "BreadcrumbList", "AggregateRating"];
  const findings = [];
  if (broken.length) {
    findings.push({
      severity: "critical",
      finding: `${broken.length} JSON-LD block${broken.length === 1 ? "" : "s"} failed to parse, so ${broken.length === 1 ? "it is" : "they are"} ignored entirely by every consumer.`,
      fix: `First parse error: ${broken[0].error}. Invalid JSON-LD is silently dropped, so this is invisible until you check.`,
    });
  }
  if (!types.length && !hasMicrodata) findings.push({ severity: "warning", finding: "No structured data of any kind was found on this page.", fix: "A shopping agent then has to infer price and availability from rendered text, which it will sometimes get wrong." });
  if (types.includes("Product") && !types.includes("Offer")) findings.push({ severity: "warning", finding: "Product markup is present but there is no Offer, so price and availability are not declared.", fix: "Add an Offer with price, priceCurrency and availability. Those three are what a shopping agent reads." });
  const productBlocks = blocksDeclaring(blocks, "Product");
  if (productBlocks > 1) {
    findings.push({
      severity: "warning",
      finding: `${productBlocks} separate JSON-LD blocks each declare a Product, so the page describes the same item more than once.`,
      fix: "Consumers pick one block without telling you which, so any disagreement between them in price, availability or rating becomes a coin toss. This usually means the theme and an app are both emitting Product markup; keep one.",
    });
  }

  return {
    url: page.finalUrl,
    json_ld_blocks: blocks.length,
    blocks_declaring_product: blocksDeclaring(blocks, "Product"),
    parsed_ok: good.length,
    failed_to_parse: broken.length,
    parse_errors: broken.map((b) => ({ error: b.error, bytes: b.bytes })),
    schema_types_found: types,
    microdata_present: hasMicrodata,
    commerce_types_checked: Object.fromEntries(wanted.map((w) => [w, types.includes(w)])),
    findings,
    not_observable: ["Markup injected by JavaScript after load. Nothing is executed here, so only server-rendered structured data is seen."],
  };
}

async function auditProductFeed(a) {
  const u = safeUrl(a.url);
  const limit = Math.max(1, Math.min(250, Number(a.limit) || 250));
  const r = await tryGet(`${u.origin}/products.json?limit=${limit}`, { accept: "application/json", cap: MAX_JSON_BYTES });
  let products;
  try {
    products = JSON.parse(r.body)?.products;
  } catch {
    throw new Error(
      `${u.hostname} did not return a readable products.json (HTTP ${r.status || r.error}). That endpoint is Shopify-only, so this tool does not apply to other platforms.`
    );
  }
  if (!Array.isArray(products)) throw new Error(`${u.hostname} returned no product array, so there is nothing to audit.`);

  const variants = products.flatMap((p) => (p.variants || []).map((v) => ({ p, v })));
  const count = (f) => variants.filter(f).length;
  const noBarcode = count(({ v }) => !v.barcode);
  const noWeight = count(({ v }) => !v.grams && !(v.weight > 0));
  const noPrice = count(({ v }) => !(Number(v.price) > 0));
  const unavailable = count(({ v }) => v.available === false);
  const thinDesc = products.filter((p) => String(p.body_html || "").replace(/<[^>]*>/g, "").trim().length < 100).length;
  const noImage = products.filter((p) => !(p.images || []).length).length;

  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
  const findings = [];
  if (noBarcode) findings.push({ severity: "warning", finding: `${noBarcode} of ${variants.length} variants (${pct(noBarcode, variants.length)}%) have no barcode.`, fix: "Merchant Center uses GTIN to match a product to the catalogue. Without it you lose price benchmarking and some ad formats entirely." });
  if (noWeight) findings.push({ severity: "warning", finding: `${noWeight} of ${variants.length} variants (${pct(noWeight, variants.length)}%) have no weight.`, fix: "Any carrier-calculated shipping rate and any landed-cost estimate is then guesswork." });
  if (noPrice) findings.push({ severity: "critical", finding: `${noPrice} variants have no usable price.`, fix: "These are rejected from every feed." });
  if (thinDesc) findings.push({ severity: "info", finding: `${thinDesc} of ${products.length} products have under 100 characters of description text.`, fix: "Thin descriptions hurt both feed quality review and the chance an AI assistant can answer a question about the product." });
  if (noImage) findings.push({ severity: "critical", finding: `${noImage} products have no image.`, fix: "A feed item with no image is disapproved." });

  return {
    url: u.origin,
    sampled: { products: products.length, variants: variants.length, limit_applied: limit },
    counts: {
      variants_without_barcode: noBarcode,
      variants_without_weight: noWeight,
      variants_without_price: noPrice,
      variants_unavailable: unavailable,
      products_with_thin_description: thinDesc,
      products_without_image: noImage,
    },
    findings,
    not_observable: [
      "Anything only the store owner can see: cost of goods, the live Merchant Center disapproval list, and the feed rules actually configured. This reads the public catalogue and reports what would break a feed built from it.",
      products.length === limit ? `Exactly ${limit} products came back, which is the page size, so the catalogue is probably larger than this sample.` : "The whole catalogue fitted in one page.",
    ],
  };
}

const HANDLERS = {
  detect_tracking_tags: detectTrackingTags,
  check_agent_readiness: checkAgentReadiness,
  check_structured_data: checkStructuredData,
  audit_product_feed: auditProductFeed,
};

export const storeServer = {
  slug: "store",
  name: "Storefront Check",
  version: "1.0.0",
  tagline:
    "Audit any ecommerce storefront from the outside: which ad and analytics tags are really firing, whether AI agents can read the store, and what would break a product feed.",
  description:
    "Audit a public ecommerce storefront with no credentials: advertising and analytics tags with dead-id verification, AI crawler access, structured data, and product feed readiness.",
  instructions: `Storefront Check audits a public storefront from the outside. No credentials and no cooperation from the store are needed, so it works on a competitor or a prospect as readily as your own site.

READ THE RESULTS CAREFULLY
- Every tool returns a not_observable list. Respect it. The most important entry is that Shopify Custom Pixels run in a sandboxed iframe and never appear in storefront HTML, so "no tag found" is NOT proof a store is untagged. Say so rather than telling someone their tracking is broken.
- findings carry a severity of critical, warning or info. A critical finding means something is measurably not working, not merely suboptimal.
- Nothing is executed. Only server-rendered HTML is read, so anything a script injects after load is invisible.

THE CHECK WORTH KNOWING ABOUT
detect_tracking_tags verifies each Google id against Google Tag Manager. Google answers 404 for an id it does not recognise, and a dead id means gtag never initialises, so the page looks correctly tagged while recording nothing. A consent or cookie app carrying a stale id from an old property is the usual cause. This is a silent, total loss of conversion data and it does not show up anywhere else.

No account or key is needed to use this server.`,
  caveat: {
    title: "Absent is not the same as not observable",
    body: "This server reads only what a storefront serves publicly, and it never executes JavaScript. A Shopify Custom Pixel runs in a sandboxed iframe and cannot be seen from outside at all, so an empty tag list is not evidence that a store is untagged. Every tool states what it could not see.",
  },
  footnote:
    "One identified GET per URL, cached for 12 hours. Findings are indicative: for anything that costs money, confirm against the store's own admin before acting.",
  tools: TOOLS.map(publicTool),
  async run(name, args) {
    const fn = HANDLERS[name];
    if (!fn) throw new Error(`Unknown tool "${name}".`);
    const out = await fn(args || {});
    return { text: JSON.stringify(out, null, 2), structured: out };
  },
};
