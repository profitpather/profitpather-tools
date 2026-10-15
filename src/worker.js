// ShipRate AU - a remote MCP server that quotes Australian parcel shipping from
// two independent sources and says plainly which is which.
//
// WHY IT IS SHAPED LIKE THIS
//
// 1. UNAUTHENTICATED BY DESIGN, for discovery. Profitpather's /mcp returns 401
//    to everything, and the consequence is measurable: five directory crawlers
//    (mcpbeat, rokmcp, musedirectory, AgentRankProbe, agent-collector) have made
//    3,260 probes against it and every single one got a 401, so not one of them
//    can tell a catalogue what the server actually does. musedirectory even
//    states it lists services that BLOCK, so the end position is the worst one:
//    discoverable but unevaluable. Here initialize, tools/list AND tools/call all
//    work with no credentials, so a scout can connect, read the tools, call one,
//    and judge it. Protection comes from caching and a per-IP cap instead.
//
// 2. CACHE FIRST, because the upstream keys are the asset. Shipping rates for a
//    given route and weight do not move minute to minute, so identical requests
//    are served from the Cache API for 12 hours. Without this, an unauthenticated
//    endpoint would let anyone burn an AusPost or Easyship quota that cannot be
//    replaced by anyone but the account holder.
//
// 3. EVERY CAVEAT TRAVELS WITH THE NUMBER. The two sources are NOT like for like:
//    AusPost via PAC is RETAIL pricing, Easyship is PRE-NEGOTIATED COMMERCIAL
//    pricing off their courier panel. Quoting them in one sorted list without
//    saying so would make Easyship look like a miracle rather than a different
//    kind of price. Each rate carries pricing_basis, and the response carries a
//    comparison_note.
import { daysServer } from "./days/server.js";

const AP_BASE = "https://digitalapi.auspost.com.au";
const ES_BASE = "https://public-api.easyship.com/2024-09";
const CACHE_TTL_S = 12 * 60 * 60;
// Bump on any deploy that changes what a quote RETURNS, not just how it looks.
// Learned the hard way during build: a 12h cached answer survived the fix for
// Easyship's blank-city rejection, so one route kept returning AusPost-only
// results that looked like a live failure. Without this, every future fix ships
// with a silent 12-hour tail of pre-fix answers.
const CACHE_VERSION = "v3-actionable-easyship-notes";
const RATE_LIMIT_PER_MIN = 20;

// Verified live against the API, not guessed. "others", "general" and
// "accessories" are all REJECTED with "need to input either item_category_id or
// hs_code"; only these 20 slugs work, so an agent has to be told them.
const ES_CATEGORIES = [
  "accessory_no_battery", "accessory_with_battery", "audio_video", "bags_luggages",
  "books_collectibles", "cameras", "computers_laptops", "documents",
  "dry_food_supplements", "fashion", "health_beauty", "home_appliances",
  "home_decor", "jewelry", "mobile_phones", "pet_accessory", "sport_leisure",
  "tablets", "toys", "watches",
];
const DEFAULT_CATEGORY = "fashion";
const DEFAULT_DIMS = { length: 30, width: 22, height: 10 };

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type, authorization, mcp-protocol-version",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      ...extra,
    },
  });

const num = (v, dflt = null) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// ── upstream: Australia Post (retail / PAC) ──────────────────────────────────
async function apGet(env, path, params) {
  const key = (env.AUSPOST_KEY || "").trim();
  if (!key) throw new Error("AUSPOST_KEY is not configured on this deployment");
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const r = await fetch(`${AP_BASE}${path}?${qs}`, {
    headers: { "AUTH-KEY": key, accept: "application/json" },
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* fall through */ }
  if (!r.ok || body?.error) {
    const detail = body?.error?.errorMessage || body?.error?.message || text.slice(0, 200);
    throw new Error(`AusPost ${r.status}: ${detail}`);
  }
  return body;
}

const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);

// Easyship rejects an AU address with a blank city or state, and a caller only
// ever has a postcode, so resolve it. AusPost's own postcode lookup gives both
// and is authoritative. Memoised per isolate because the mapping effectively
// never changes and the same route gets quoted at many different weights.
const PC_CACHE = new Map();

// Free, deterministic fallback from the published AU postcode ranges, used when
// the lookup itself fails so a transient AusPost error cannot take the whole
// commercial-rates leg down with it.
function stateFromPostcode(pc) {
  const n = Number(pc);
  if (!Number.isFinite(n)) return null;
  if (n >= 800 && n <= 999) return "NT";
  if ((n >= 2600 && n <= 2618) || (n >= 2900 && n <= 2920)) return "ACT";
  if ((n >= 1000 && n <= 2599) || (n >= 2619 && n <= 2899) || (n >= 2921 && n <= 2999)) return "NSW";
  if ((n >= 3000 && n <= 3999) || (n >= 8000 && n <= 8999)) return "VIC";
  if ((n >= 4000 && n <= 4999) || (n >= 9000 && n <= 9999)) return "QLD";
  if (n >= 5000 && n <= 5999) return "SA";
  if (n >= 6000 && n <= 6999) return "WA";
  if (n >= 7000 && n <= 7999) return "TAS";
  return null;
}

async function resolvePostcode(env, pc) {
  const key = String(pc);
  if (PC_CACHE.has(key)) return PC_CACHE.get(key);
  let out = { city: "", state: stateFromPostcode(key) || "", resolved: false };
  try {
    const d = await apGet(env, "/postcode/search.json", { q: key });
    const loc = asArray(d?.localities?.locality)[0];
    if (loc?.location) {
      out = { city: String(loc.location), state: String(loc.state || out.state || ""), resolved: true };
    }
  } catch (e) {
    // Keep the range-derived state; city stays blank and is filled below.
  }
  if (!out.city) out.city = `Postcode ${key}`;
  PC_CACHE.set(key, out);
  return out;
}

function apServices(data) {
  return asArray(data?.services?.service)
    .map((s) => ({
      source: "auspost",
      pricing_basis: "AusPost retail (PAC API). A business with an eParcel or contract account pays less than this.",
      service: String(s?.name || "unknown"),
      code: s?.code || null,
      price: round2(s?.price),
      currency: "AUD",
      // AusPost's PAC response does not carry transit days on every service, so
      // report it only when present rather than inventing a range.
      delivery_time: s?.delivery_time || null,
    }))
    .filter((s) => s.price > 0);
}

// ── upstream: Easyship (pre-negotiated commercial) ───────────────────────────
async function esRates(env, { origin, dest, weightKg, dims, category, valueAud, hsCode }) {
  const key = (env.EASYSHIP_KEY || "").trim();
  if (!key) throw new Error("EASYSHIP_KEY is not configured on this deployment");
  const item = {
    quantity: 1,
    actual_weight: Math.max(0.05, Math.min(weightKg, 30)),
    declared_currency: "AUD",
    declared_customs_value: valueAud ?? 100,
    dimensions: dims,
    description: "General goods",
  };
  // One of these is mandatory. hs_code wins when supplied because it is more
  // specific and matters for international duty.
  if (hsCode) item.hs_code = String(hsCode);
  else item.category = category;

  const r = await fetch(`${ES_BASE}/rates`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      origin_address: origin,
      destination_address: dest,
      incoterms: "DDU",
      insurance: { is_insured: false },
      parcels: [{ items: [item] }],
    }),
  });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* fall through */ }
  if (!r.ok || body?.error) {
    const e = body?.error || {};
    const detail = Array.isArray(e.details) && e.details.length ? e.details.join("; ") : e.message || text.slice(0, 200);
    throw new Error(`Easyship ${r.status}: ${detail}`);
  }
  return asArray(body?.rates).map((x) => ({
    source: "easyship",
    pricing_basis: "Easyship pre-negotiated commercial rate off their courier panel. Not a retail price, and not your own carrier contract.",
    service: String(x?.courier_service?.name || "unknown"),
    courier: x?.courier_service?.umbrella_name || null,
    price: round2(x?.total_charge),
    currency: String(x?.currency || "AUD"),
    delivery_time:
      x?.min_delivery_time && x?.max_delivery_time
        ? `${x.min_delivery_time}-${x.max_delivery_time} business days`
        : null,
  })).filter((x) => x.price > 0);
}

// ── merge + explain ─────────────────────────────────────────────────────────
function mergeRates(apRates, esRates_, notes) {
  const all = [...apRates, ...esRates_];
  // Never sort across currencies. Easyship can answer in a currency other than
  // AUD, and ranking mixed currencies by nominal amount is how you conclude that
  // 12,000,000 rupiah beats 300 dollars.
  const currencies = [...new Set(all.map((r) => r.currency))];
  const sortable = currencies.length <= 1;
  const sorted = sortable ? all.slice().sort((a, b) => a.price - b.price) : all;
  return {
    rates_returned: all.length,
    currencies_seen: currencies,
    sorted_by_price: sortable,
    ...(sortable
      ? {}
      : { currency_note: "More than one currency came back, so these are NOT sorted by price. Compare only within a currency; there is no exchange rate in this data." }),
    cheapest: sortable && sorted.length ? sorted[0] : null,
    rates: sorted,
    comparison_note:
      "The two sources are not like for like. AusPost prices are RETAIL (PAC); Easyship prices are PRE-NEGOTIATED COMMERCIAL rates off their panel. Easyship looking cheaper is usually a different class of pricing, not a better carrier. Compare within a source before comparing across them.",
    source_notes: notes,
  };
}

// ── tools ───────────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "quote_domestic_au",
    title: "Quote an Australian domestic parcel",
    description:
      "Live shipping prices for a parcel sent WITHIN Australia, from two independent sources at once: Australia Post retail (PAC) and Easyship's pre-negotiated commercial courier panel. Returns every service with price, currency and transit time where available, cheapest first, plus a note on why the two sources are not directly comparable. Use when asked what it costs to send a parcel between Australian postcodes, or which courier is cheapest for a given weight and route.",
    inputSchema: {
      type: "object",
      properties: {
        from_postcode: { type: "string", description: "Origin Australian postcode, e.g. '3000'." },
        to_postcode: { type: "string", description: "Destination Australian postcode, e.g. '2000'." },
        weight_kg: { type: "number", description: "Parcel weight in kilograms. AusPost caps domestic parcels at 22kg.", minimum: 0.01, maximum: 22 },
        length_cm: { type: "number", description: "Optional. Defaults to 30." },
        width_cm: { type: "number", description: "Optional. Defaults to 22." },
        height_cm: { type: "number", description: "Optional. Defaults to 10." },
        category: { type: "string", description: `Optional goods category, needed by Easyship. One of: ${ES_CATEGORIES.join(", ")}. Defaults to '${DEFAULT_CATEGORY}'. Call list_goods_categories if unsure.` },
        value_aud: { type: "number", description: "Optional declared value in AUD. Defaults to 100. Does not affect domestic price, only insurance options." },
      },
      required: ["from_postcode", "to_postcode", "weight_kg"],
    },
  },
  {
    name: "quote_international_from_au",
    title: "Quote a parcel sent from Australia overseas",
    description:
      "Live shipping prices for a parcel sent FROM Australia to another country, from Australia Post retail (PAC) and, where it can quote, Easyship's commercial panel. Returns each service with price and currency. Use when asked what it costs to post something overseas from Australia. Note that AusPost international prices are retail and exclude any destination duty or tax, which the recipient pays.",
    inputSchema: {
      type: "object",
      properties: {
        country_code: { type: "string", description: "ISO-2 destination country code, e.g. 'US', 'GB', 'NZ', 'SG'." },
        weight_kg: { type: "number", description: "Parcel weight in kilograms. AusPost caps international parcels at 20kg.", minimum: 0.01, maximum: 20 },
        from_postcode: { type: "string", description: "Optional origin Australian postcode, used for the Easyship leg. Defaults to '3000'." },
        to_postcode: { type: "string", description: "Optional destination postal code. Improves commercial-panel accuracy; ignored by AusPost." },
        to_city: { type: "string", description: "Optional destination city. Some couriers will not quote without it." },
        to_state: { type: "string", description: "Optional destination state or province code." },
        category: { type: "string", description: `Optional goods category for Easyship. One of: ${ES_CATEGORIES.join(", ")}. Defaults to '${DEFAULT_CATEGORY}'.` },
        hs_code: { type: "string", description: "Optional HS tariff code. More specific than category and matters for destination duty. Supplying this overrides category." },
        value_aud: { type: "number", description: "Optional declared customs value in AUD. Defaults to 100." },
      },
      required: ["country_code", "weight_kg"],
    },
  },
  {
    name: "list_goods_categories",
    title: "List the goods categories Easyship accepts",
    description:
      "Returns the exact goods categories the commercial rate source will accept. These are a fixed list, not free text: plausible-sounding values like 'general' or 'others' are rejected outright. Call this if a quote came back with a category error, or to pick the closest match before quoting.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "lookup_au_postcode",
    title: "Look up an Australian postcode or suburb",
    description:
      "Resolve an Australian postcode to its suburbs and state, or a suburb name to its postcode. Works in both directions. Use it to validate an address before quoting, or when a suburb name is ambiguous because the same name exists in several states.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "An Australian postcode such as 3000, or a suburb name such as Carlton." },
        state: { type: "string", description: "Optional state filter: NSW, VIC, QLD, SA, WA, TAS, NT or ACT. Supply it when a suburb name exists in more than one state." },
      },
      required: ["query"],
    },
  },
  {
    name: "calculate_cubic_weight",
    title: "Work out the chargeable weight of a parcel",
    description:
      "Carriers charge on whichever is greater, actual weight or cubic (volumetric) weight, so a light bulky parcel costs far more than its scale weight suggests. Give the dimensions and actual weight and this returns the cubic weight under each common convention and which weight you would be charged on. Use it before quoting so the weight you pass to a quote tool is the one that will actually be billed.",
    inputSchema: {
      type: "object",
      properties: {
        length_cm: { type: "number", description: "Longest side in centimetres." },
        width_cm: { type: "number", description: "Width in centimetres." },
        height_cm: { type: "number", description: "Height in centimetres." },
        weight_kg: { type: "number", description: "Actual weight on the scales, in kilograms." },
      },
      required: ["length_cm", "width_cm", "height_cm", "weight_kg"],
    },
  },
];

// Volumetric divisors, expressed in centimetres. A divisor of 4000 is the same
// rule as 250 kg per cubic metre, just arithmetic the other way round.
const CUBIC_CONVENTIONS = [
  { id: "auspost_domestic", label: "Australia Post domestic parcels", cm_divisor: 4000 },
  { id: "courier_road", label: "General domestic courier road freight", cm_divisor: 5000 },
  { id: "air_freight", label: "International air freight (IATA volumetric)", cm_divisor: 6000 },
];

async function runTool(name, args, env) {
  const a = args || {};
  if (name === "list_goods_categories") {
    return {
      categories: ES_CATEGORIES,
      default: DEFAULT_CATEGORY,
      note: "This list is fixed by the upstream commercial rate provider and was verified against the live API. Values outside it are rejected. If nothing fits, supply an hs_code instead.",
    };
  }

  if (name === "lookup_au_postcode") {
    const q = String(a.query || "").trim();
    if (!q) throw new Error("query is required: an Australian postcode like 3000, or a suburb name like Carlton.");
    const st = a.state ? String(a.state).trim().toUpperCase() : null;
    const params = { q };
    if (st) params.state = st;
    const d = await apGet(env, "/postcode/search.json", params);
    const localities = asArray(d?.localities?.locality).map((l) => ({
      suburb: l.location ?? null,
      postcode: l.postcode != null ? String(l.postcode) : null,
      state: l.state ?? null,
      category: l.category ?? null,
      latitude: l.latitude ?? null,
      longitude: l.longitude ?? null,
    }));
    const notes = [];
    if (!localities.length) {
      notes.push(`Australia Post returned no match for "${q}"${st ? ` in ${st}` : ""}. Check the spelling, or drop the state filter and look at every match.`);
    }
    const states = [...new Set(localities.map((x) => x.state).filter(Boolean))];
    if (states.length > 1) {
      notes.push(`That name exists in ${states.length} states (${states.join(", ")}). Pick the right one before using a postcode for a quote, because the rate depends on it.`);
    }
    return { query: q, state_filter: st, match_count: localities.length, localities, notes };
  }

  if (name === "calculate_cubic_weight") {
    const dimsIn = { length_cm: num(a.length_cm), width_cm: num(a.width_cm), height_cm: num(a.height_cm), weight_kg: num(a.weight_kg) };
    for (const [field, v] of Object.entries(dimsIn)) {
      if (v === null || !(v > 0)) throw new Error(`${field} is required and must be a number greater than zero.`);
    }
    const cm3 = dimsIn.length_cm * dimsIn.width_cm * dimsIn.height_cm;
    const r2 = (n) => Math.round(n * 100) / 100;
    const conventions = CUBIC_CONVENTIONS.map((c) => {
      const cubic = r2(cm3 / c.cm_divisor);
      return {
        convention: c.id,
        label: c.label,
        cm_divisor: c.cm_divisor,
        kg_per_m3: r2(1e6 / c.cm_divisor),
        cubic_weight_kg: cubic,
        chargeable_weight_kg: r2(Math.max(cubic, dimsIn.weight_kg)),
        charged_on: cubic > dimsIn.weight_kg ? "cubic" : "actual",
      };
    });
    return {
      dimensions_cm: { length: dimsIn.length_cm, width: dimsIn.width_cm, height: dimsIn.height_cm },
      actual_weight_kg: dimsIn.weight_kg,
      volume_m3: Math.round((cm3 / 1e6) * 1e6) / 1e6,
      conventions,
      assumptions: [
        "Cubic weight is the volume divided by the convention's divisor. The carrier bills whichever is greater, cubic or actual, which is why a light bulky parcel costs more than its scale weight.",
        "Divisors vary by carrier and by service, and your own contract overrides every figure here. Treat the convention matching your carrier as the answer and the rest as context.",
        "Australia Post documents a volume threshold below which actual weight is used regardless of cubic weight. Confirm the current threshold against your own account terms before relying on the domestic figure for a small parcel.",
      ],
      next: "Pass the chargeable weight as weight_kg to quote_domestic_au or quote_international_from_au, along with these same dimensions.",
    };
  }

  if (name === "quote_domestic_au") {
    const from = String(a.from_postcode || "").trim();
    const to = String(a.to_postcode || "").trim();
    const w = num(a.weight_kg);
    if (!/^\d{4}$/.test(from) || !/^\d{4}$/.test(to)) {
      throw new Error("from_postcode and to_postcode must each be a 4-digit Australian postcode, e.g. '3000'.");
    }
    if (!w || w <= 0 || w > 22) throw new Error("weight_kg must be a number between 0.01 and 22 for a domestic parcel.");
    const category = ES_CATEGORIES.includes(a.category) ? a.category : DEFAULT_CATEGORY;
    const dims = {
      length: num(a.length_cm, DEFAULT_DIMS.length),
      width: num(a.width_cm, DEFAULT_DIMS.width),
      height: num(a.height_cm, DEFAULT_DIMS.height),
    };
    const notes = [];
    if (!ES_CATEGORIES.includes(a.category) && a.category) {
      notes.push(`category '${a.category}' is not accepted upstream, so '${DEFAULT_CATEGORY}' was used. Call list_goods_categories for the valid list.`);
    }
    // Both sources in parallel, and a failure in one must not lose the other:
    // a partial answer that says what is missing beats no answer.
    const [ap, es] = await Promise.allSettled([
      apGet(env, "/postage/parcel/domestic/service.json", {
        from_postcode: from, to_postcode: to,
        length: dims.length, width: dims.width, height: dims.height, weight: w,
      }).then(apServices),
      (async () => {
        const [o, d] = await Promise.all([resolvePostcode(env, from), resolvePostcode(env, to)]);
        return esRates(env, {
          origin: { country_alpha2: "AU", postal_code: from, city: o.city, state: o.state, line_1: "1 Sender St" },
          dest: { country_alpha2: "AU", postal_code: to, city: d.city, state: d.state, line_1: "1 Receiver St" },
          weightKg: w, dims, category, valueAud: num(a.value_aud, 100),
        });
      })(),
    ]);
    const apR = ap.status === "fulfilled" ? ap.value : [];
    const esR = es.status === "fulfilled" ? es.value : [];
    if (ap.status === "rejected") notes.push(`AusPost returned no prices: ${ap.reason?.message || ap.reason}`);
    if (es.status === "rejected") notes.push(`Easyship returned no prices: ${es.reason?.message || es.reason}`);
    if (ap.status === "fulfilled" && !apR.length) notes.push("AusPost answered but listed no eligible service for this parcel. Check the weight and dimensions are within its limits.");
    if (es.status === "fulfilled" && !esR.length) notes.push("Easyship answered but its panel quoted nothing for this route. That is normal for some origins rather than an error.");
    if (!apR.length && !esR.length) throw new Error(`Neither source could price this parcel. ${notes.join(" ")}`);
    return { route: { from, to, country: "AU" }, weight_kg: w, dimensions_cm: dims, category_used: category, ...mergeRates(apR, esR, notes) };
  }

  if (name === "quote_international_from_au") {
    const cc = String(a.country_code || "").trim().toUpperCase();
    const w = num(a.weight_kg);
    if (!/^[A-Z]{2}$/.test(cc)) throw new Error("country_code must be a 2-letter ISO country code, e.g. 'US'.");
    if (cc === "AU") throw new Error("country_code is AU. Use quote_domestic_au for parcels within Australia.");
    if (!w || w <= 0 || w > 20) throw new Error("weight_kg must be a number between 0.01 and 20 for an international parcel.");
    const from = /^\d{4}$/.test(String(a.from_postcode || "")) ? String(a.from_postcode) : "3000";
    const category = ES_CATEGORIES.includes(a.category) ? a.category : DEFAULT_CATEGORY;
    const dims = { ...DEFAULT_DIMS };
    const notes = [
      "AusPost international prices are retail and EXCLUDE destination duty and tax, which the recipient is billed for separately unless you prepay it.",
    ];
    const [ap, es] = await Promise.allSettled([
      apGet(env, "/postage/parcel/international/service.json", { country_code: cc, weight: w }).then(apServices),
      (async () => {
        const o = await resolvePostcode(env, from);
        return esRates(env, {
          origin: { country_alpha2: "AU", postal_code: from, city: o.city, state: o.state, line_1: "1 Sender St" },
          dest: { country_alpha2: cc, postal_code: String(a.to_postcode || ""), city: String(a.to_city || ""), state: String(a.to_state || ""), line_1: "1 Receiver St" },
          weightKg: w, dims, category, valueAud: num(a.value_aud, 100), hsCode: a.hs_code,
        });
      })(),
    ]);
    const apR = ap.status === "fulfilled" ? ap.value : [];
    const esR = es.status === "fulfilled" ? es.value : [];
    if (ap.status === "rejected") notes.push(`AusPost returned no prices: ${ap.reason?.message || ap.reason}`);
    if (es.status === "rejected") {
      const msg = String(es.reason?.message || es.reason);
      let note = `Easyship returned no prices: ${msg}`;
      // Easyship needs a destination city and state outside Australia, and this
      // server can only resolve those from an Australian postcode. Tell the
      // caller what to do about it instead of passing the raw 422 through.
      if (/(city|state) can't be blank/i.test(msg) && (!a.to_city || !a.to_state)) {
        note += " That is fixable from here: retry this same call with to_city and to_state filled in (for New York, to_city:'New York' and to_state:'NY') and the commercial panel will quote.";
      }
      notes.push(note);
    }
    if (es.status === "fulfilled" && !esR.length) notes.push("Easyship's panel quoted nothing for this destination. Its international coverage from Australia is patchy, so treat AusPost as the reliable source here.");
    if (!apR.length && !esR.length) throw new Error(`Neither source could price this parcel. ${notes.join(" ")}`);
    return { route: { from, to_country: cc, to_postcode: a.to_postcode || null }, weight_kg: w, dimensions_cm: dims, category_used: a.hs_code ? null : category, hs_code: a.hs_code || null, ...mergeRates(apR, esR, notes) };
  }

  throw new Error(`Unknown tool: ${name}`);
}

const INSTRUCTIONS = `ShipRate AU quotes Australian parcel shipping from two independent sources in one call.

WHAT YOU GET
- Australia Post via the PAC API. These are RETAIL prices. A business on an eParcel or
  contract account pays materially less, so do not present these as the best available.
- Easyship's pre-negotiated COMMERCIAL panel. A different class of pricing entirely.

READ THE RESULTS CAREFULLY
- Every rate carries a pricing_basis. Quote it when you report a number.
- Easyship undercutting AusPost is usually the retail-versus-commercial gap, NOT evidence
  that one courier is better. Say so rather than declaring a winner.
- If more than one currency comes back, the list is deliberately NOT sorted by price and
  sorted_by_price is false. There is no exchange rate in this data, so never rank across
  currencies or add them together.
- source_notes explains anything missing. A source that quoted nothing is reported, not
  hidden, so an empty list is never silently treated as "no options exist".
- International prices exclude destination duty and tax.

No account or key is needed to use this server.`;

// ── Server registry ─────────────────────────────────────────────────────────
// Each entry is one logical MCP server with its own discovery document, landing
// page and /mcp endpoint, namespaced by slug under this single hostname. A new
// tool server is a new entry here, not a new domain and not a new Worker.
const shipServer = {
  slug: "ship",
  name: "ShipRate AU",
  version: "1.1.1",
  tagline:
    "Australian parcel shipping prices from two independent sources in one call: Australia Post retail, and a pre-negotiated commercial courier panel.",
  description:
    "Australian parcel shipping rates from Australia Post retail and a pre-negotiated commercial courier panel, in one call. No authentication required.",
  tools: TOOLS,
  instructions: INSTRUCTIONS,
  caveat: {
    title: "The two sources are not interchangeable",
    body: "Australia Post prices here are <strong>retail</strong>. A business with an eParcel or contract account pays less. The commercial panel is a different class of pricing, so a lower number is not automatically a better carrier. Every rate says which basis it came from.",
  },
  footnote: "Prices are fetched live and cached for 12 hours. Rates are indicative and exclude destination duty and tax on international parcels.",
  async run(name, args, env) {
    const out = await runTool(name, args, env);
    return { text: JSON.stringify(out, null, 2), structured: out };
  },
};

// Order matters: the first entry is what the legacy root /mcp endpoint aliases.
const SERVERS = [shipServer, daysServer];

const serverBySlug = (slug) => SERVERS.find((s) => s.slug === slug) || null;
const mcpUrl = (origin, server) => `${origin}/${server.slug}/mcp`;
const originOf = (env, url) => env.PUBLIC_ORIGIN || url.origin;
const isWellKnown = (p) =>
  p === "/.well-known/agent-skills/index.json" || p === "/.well-known/mcp.json";

const skillEntry = (origin, server, t, withServer) => ({
  name: t.name,
  type: "mcp-tool",
  title: t.title,
  description: t.description,
  url: mcpUrl(origin, server),
  mcp_tool: t.name,
  ...(withServer ? { server: server.name } : {}),
});

// Public discovery for one server. This is the endpoint that lets a directory
// describe the server without connecting as a client, which is exactly what the
// crawlers hitting Profitpather could never do.
function discoveryForServer(origin, server) {
  return {
    $schema: "https://agentskills.io/schemas/discovery-v0.2.json",
    version: "0.2.0",
    server: {
      name: server.name,
      description: server.description,
      mcp_url: mcpUrl(origin, server),
      auth: "none",
    },
    skills: server.tools.map((t) => skillEntry(origin, server, t, false)),
  };
}

// The hub document. A crawler that reads only the root still comes away with
// every tool on every server, because the skills are inlined here rather than
// hidden behind a second fetch it may never make.
function hubDiscovery(origin) {
  return {
    $schema: "https://agentskills.io/schemas/discovery-v0.2.json",
    version: "0.2.0",
    server: {
      name: "Profitpather Tools",
      description:
        "Open MCP servers for ecommerce operations. No authentication required.",
      mcp_url: `${origin}/mcp`,
      auth: "none",
    },
    servers: SERVERS.map((s) => ({
      name: s.name,
      description: s.description,
      mcp_url: mcpUrl(origin, s),
      discovery_url: `${origin}/${s.slug}/.well-known/agent-skills/index.json`,
      auth: "none",
      tool_count: s.tools.length,
    })),
    skills: SERVERS.flatMap((s) =>
      s.tools.map((t) => skillEntry(origin, s, t, true))),
  };
}

const SHELL_OPEN = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">`;
const BODY_OPEN = `</head><body style="margin:0;background:#f3f4f7;font:16px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0d0f14">
<div style="max-width:720px;margin:0 auto;padding:48px 20px 72px">`;
const CARD = "background:#fff;border:1px solid #e8eaef;border-radius:12px;padding:18px 20px";
const EYEBROW = "font:700 11px/1.4 inherit;color:#6d4aff;text-transform:uppercase;letter-spacing:.1em";
const LABEL = "font:600 12px/1.4 inherit;color:#70757f;text-transform:uppercase;letter-spacing:.06em";

function hubLanding(env, url) {
  const o = originOf(env, url);
  return `${SHELL_OPEN}
<title>Profitpather Tools - open MCP servers for ecommerce</title>
<meta name="description" content="Open, unauthenticated MCP servers for ecommerce operations. Connect any MCP client; nothing to sign up for.">
<link rel="canonical" href="${o}/">
${BODY_OPEN}
  <div style="${EYEBROW}">Remote MCP servers</div>
  <h1 style="font-size:32px;line-height:1.2;margin:10px 0 8px;letter-spacing:-.02em">Profitpather Tools</h1>
  <p style="color:#70757f;margin:0 0 28px;font-size:17px">Open MCP servers for ecommerce operations. Each one works without an account or an API key. Add the URL to any client that supports remote MCP servers.</p>
  <div style="${LABEL};padding-bottom:10px">Servers</div>
  ${SERVERS.map((s) => `<div style="${CARD};margin-bottom:12px">
    <div style="font-weight:700;font-size:18px">${s.name}</div>
    <div style="color:#70757f;font-size:14px;margin:6px 0 12px">${s.tagline}</div>
    <code style="display:block;background:#f3f4f7;border-radius:8px;padding:11px 13px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all">${mcpUrl(o, s)}</code>
    <div style="margin-top:10px;font-size:14px"><a href="/${s.slug}" style="color:#6d4aff;text-decoration:none;font-weight:600">${s.tools.length} tools &rarr;</a></div>
  </div>`).join("")}
  <p style="color:#9aa0aa;font-size:13px;margin-top:28px">Machine-readable index: <a href="/.well-known/agent-skills/index.json" style="color:#9aa0aa">/.well-known/agent-skills/index.json</a></p>
</div></body></html>`;
}

function serverLanding(env, url, server) {
  const o = originOf(env, url);
  return `${SHELL_OPEN}
<title>${server.name} - remote MCP server</title>
<meta name="description" content="${server.description}">
<link rel="canonical" href="${o}/${server.slug}">
${BODY_OPEN}
  <div style="${EYEBROW}"><a href="/" style="color:#6d4aff;text-decoration:none">Profitpather Tools</a> / Remote MCP server</div>
  <h1 style="font-size:32px;line-height:1.2;margin:10px 0 8px;letter-spacing:-.02em">${server.name}</h1>
  <p style="color:#70757f;margin:0 0 28px;font-size:17px">${server.tagline} No account, no API key.</p>
  <div style="${CARD};margin-bottom:22px">
    <div style="${LABEL};padding-bottom:8px">Connect</div>
    <code style="display:block;background:#f3f4f7;border-radius:8px;padding:11px 13px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all">${mcpUrl(o, server)}</code>
    <p style="color:#70757f;font-size:14px;margin:12px 0 0">Add that as a remote MCP server in any client that supports them. Nothing to sign up for.</p>
  </div>
  <div style="${LABEL};padding-bottom:10px">Tools</div>
  ${server.tools.map((t) => `<div style="background:#fff;border:1px solid #e8eaef;border-radius:10px;padding:14px 16px;margin-bottom:10px">
    <div style="font-weight:700">${t.title || t.name}</div>
    <code style="font:12px/1.5 ui-monospace,monospace;color:#6d4aff">${t.name}</code>
    <div style="color:#70757f;font-size:14px;margin-top:6px">${t.description.split(". ")[0]}.</div>
  </div>`).join("")}
  ${server.caveat ? `<div style="background:#fff;border:1px solid #e8eaef;border-left:3px solid #c2410c;border-radius:10px;padding:14px 16px;margin-top:22px">
    <div style="font-weight:700;margin-bottom:4px">${server.caveat.title}</div>
    <div style="color:#70757f;font-size:14px">${server.caveat.body}</div>
  </div>` : ""}
  ${server.footnote ? `<p style="color:#9aa0aa;font-size:13px;margin-top:28px">${server.footnote}</p>` : ""}
</div></body></html>`;
}

// ── MCP transport ───────────────────────────────────────────────────────────
const rpc = (id, payload) => json({ jsonrpc: "2.0", id: id ?? null, ...payload });

// Each server declares which protocol revisions it supports. One that declares
// none echoes whatever the client asked for, which is the lenient behaviour the
// ship server shipped with.
const negotiate = (server, asked) =>
  server.protocols?.has(asked) ? asked : server.defaultProtocol || asked || "2025-06-18";

async function handleRpc(req, env, server) {
  if (!req || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return rpc(req?.id ?? null, { error: { code: -32600, message: "Invalid Request" } });
  }
  const { id, method, params } = req;
  // Streamable HTTP: an accepted notification gets 202 and no body. It must
  // never receive a JSON-RPC response, not even a method-not-found error.
  if (method.startsWith("notifications/")) return new Response(null, { status: 202 });
  if (method === "initialize") {
    return rpc(id, {
      result: {
        protocolVersion: negotiate(server, params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: server.name, version: server.version },
        instructions: server.instructions,
      },
    });
  }
  if (method === "ping") return rpc(id, { result: {} });
  if (method === "tools/list") {
    return rpc(id, { result: { tools: server.tools } });
  }
  if (method === "tools/call") {
    const name = params?.name;
    if (!name) return rpc(id, { error: { code: -32602, message: "Missing tool name" } });
    // Each server exposes only its own tools, so a slug cannot be used to reach
    // another server's surface.
    if (!server.tools.some((t) => t.name === name)) {
      return rpc(id, {
        error: {
          code: -32601,
          message: `Unknown tool: ${name}. ${server.name} exposes ${server.tools.map((t) => t.name).join(", ")}.`,
        },
      });
    }
    try {
      const out = await server.run(name, params?.arguments, env);
      const result = { content: [{ type: "text", text: out.text }], isError: false };
      // A client that validates will reject structuredContent on a tool with no
      // declared outputSchema, so only send it where the schema exists.
      const tool = server.tools.find((t) => t.name === name);
      if (tool?.outputSchema && out.structured !== undefined) result.structuredContent = out.structured;
      return rpc(id, { result });
    } catch (e) {
      // The caller is a model, so the error has to be actionable prose, not a
      // stack trace. Upstream messages are already written that way above.
      return rpc(id, {
        result: { content: [{ type: "text", text: String(e?.message || e) }], isError: true },
      });
    }
  }
  return rpc(id, { error: { code: -32601, message: `Method not found: ${method}` } });
}

// Per-IP cap. Crude and in-isolate, so it is a brake on accidental hammering
// rather than a security control; the 12h cache is what really protects the
// upstream quotas.
const hits = new Map();
function overLimit(ip) {
  const now = Date.now();
  const bucket = Math.floor(now / 60000);
  const key = `${ip}:${bucket}`;
  for (const k of hits.keys()) if (!k.endsWith(`:${bucket}`)) hits.delete(k);
  const n = (hits.get(key) || 0) + 1;
  hits.set(key, n);
  return n > RATE_LIMIT_PER_MIN;
}

// Shared POST handling for every server: per-IP brake, then the 12h response
// cache, then the RPC itself.
async function handleMcpPost(request, env, ctx, url, server) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (overLimit(ip)) {
    return json({
      jsonrpc: "2.0", id: null,
      error: { code: -32029, message: `Rate limit: at most ${RATE_LIMIT_PER_MIN} calls a minute from one address. Identical quotes are cached for 12 hours, so repeating a request costs you nothing.` },
    }, 429);
  }
  let body = null;
  try { body = await request.json(); } catch { /* handled below */ }
  if (!body) return rpc(null, { error: { code: -32700, message: "Parse error: body must be JSON-RPC 2.0" } });

  // Cache only tools/call, keyed on the whole request, so repeated identical
  // quotes never touch the upstream APIs again.
  const isCall = body?.method === "tools/call";
  let cacheKey = null;
  if (isCall) {
    const sig = JSON.stringify({ v: CACHE_VERSION, s: server.slug, n: body?.params?.name, a: body?.params?.arguments || {} });
    cacheKey = new Request(`${url.origin}/__cache/${encodeURIComponent(sig)}`, { method: "GET" });
    const hit = await caches.default.match(cacheKey);
    if (hit) {
      const cached = await hit.json();
      return rpc(body?.id ?? null, { result: cached.result });
    }
  }

  const res = await handleRpc(body, env, server);
  if (isCall && res.status === 200) {
    try {
      const clone = await res.clone().json();
      if (clone?.result && clone.result.isError !== true) {
        ctx.waitUntil(caches.default.put(cacheKey, json({ result: clone.result }, 200, { "cache-control": `max-age=${CACHE_TTL_S}` })));
      }
    } catch { /* caching is best effort and must never fail the call */ }
  }
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const origin = originOf(env, url);
    const html = (markup) => new Response(markup, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
    });

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id",
          "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-max-age": "86400",
        },
      });
    }

    // ship.profitpather.com predates the tools hub. GETs move to the canonical
    // URL so directories and search engines settle on one address; POSTs are
    // served in place so any client already pointed there keeps working.
    if (request.method === "GET" && url.host.startsWith("ship.") && url.host !== new URL(origin).host) {
      const target = path === "/" ? `${origin}/ship`
        : isWellKnown(path) ? `${origin}/ship${path}`
        : `${origin}${path}`;
      return Response.redirect(target, 301);
    }

    // ── Hub ────────────────────────────────────────────────────────────────
    if (request.method === "GET" && (path === "/" || path === "/index.html")) {
      return html(hubLanding(env, url));
    }
    if (request.method === "GET" && path === "/health") {
      return json({
        ok: true,
        servers: SERVERS.map((s) => ({ slug: s.slug, name: s.name, tools: s.tools.length, mcp_url: mcpUrl(origin, s) })),
      });
    }
    if (request.method === "GET" && isWellKnown(path)) {
      return json(hubDiscovery(origin), 200, { "cache-control": "public, max-age=3600" });
    }
    // Domain-ownership proof for the official MCP Registry.
    if (request.method === "GET" && path === "/.well-known/mcp-registry-auth") {
      return new Response((env.MCP_REGISTRY_AUTH || "") + "\n", {
        status: env.MCP_REGISTRY_AUTH ? 200 : 404,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" },
      });
    }

    // ── Per-server, namespaced by slug ─────────────────────────────────────
    const seg = path.split("/").filter(Boolean);
    const server = seg.length ? serverBySlug(seg[0]) : null;
    if (server) {
      const rest = "/" + seg.slice(1).join("/");
      if (request.method === "GET" && rest === "/") return html(serverLanding(env, url, server));
      if (request.method === "GET" && rest === "/health") {
        return json({ ok: true, service: server.name, tools: server.tools.length });
      }
      if (request.method === "GET" && isWellKnown(rest)) {
        return json(discoveryForServer(origin, server), 200, { "cache-control": "public, max-age=3600" });
      }
      if (request.method === "POST" && (rest === "/mcp" || rest === "/")) {
        return handleMcpPost(request, env, ctx, url, server);
      }
      // No SSE stream is offered, so the spec calls for 405 here, not 404.
      if (rest === "/mcp") {
        return json({ error: "This endpoint accepts POST only. It answers JSON-RPC over Streamable HTTP and offers no SSE stream." },
          405, { allow: "POST, OPTIONS" });
      }
    }

    // Root MCP endpoint, kept working as an alias for the default server so the
    // original ship.profitpather.com/mcp address never breaks.
    if (request.method === "POST" && (path === "/mcp" || path === "/")) {
      return handleMcpPost(request, env, ctx, url, SERVERS[0]);
    }

    return json({
      error: "Not found",
      servers: SERVERS.map((s) => ({ name: s.name, mcp_url: mcpUrl(origin, s) })),
      discovery: `${origin}/.well-known/agent-skills/index.json`,
    }, 404);
  },
};
