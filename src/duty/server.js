/**
 * US Tariff: find the right HTS line and the duty rate that actually governs it.
 *
 * Data comes live from the USITC Harmonized Tariff Schedule REST endpoints, so
 * the rates are the official published ones rather than a copy that silently
 * goes stale.
 *
 * Two things here exist because they are what people get wrong:
 *
 * 1. Rates sit on the 8-digit line. The 10-digit statistical lines underneath
 *    carry a blank rate and inherit from their parent, so reading the rate off
 *    the 10-digit line you were given returns nothing and looks like duty-free.
 *    resolveRate walks up the indent tree to the line that actually sets it.
 *
 * 2. The special column lists free-trade partners, and AU is in it for most
 *    apparel. That makes it tempting to read "Australian business, therefore
 *    Free". It is not: the rate follows the country of ORIGIN of the goods, not
 *    the address of the seller, and for apparel the rules of origin are
 *    yarn-forward. Australian wool spun and sewn in China is Chinese origin and
 *    pays the general rate. Every response says this.
 */

const HTS_BASE = "https://hts.usitc.gov/reststop";
const UA = "ProfitpatherTariffLookup/1.0 (+https://tools.profitpather.com/duty)";
const TIMEOUT_MS = 20000;

/* ------------------------------------------------------------------ util -- */

const stripHtml = (v) => String(v ?? "").replace(/<[^>]*>/g, "").trim();
const cleanUnits = (u) => (Array.isArray(u) ? u.map(stripHtml).filter(Boolean) : []);

async function htsGet(path) {
  const res = await fetch(`${HTS_BASE}${path}`, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cf: { cacheTtl: 86400, cacheEverything: true },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`The USITC tariff service answered HTTP ${res.status}. It is the official source and this tool has no cached copy, so try again shortly.`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("The USITC tariff service returned a non-JSON response. This happens on some chapters, notably Chapter 99, where the endpoint serves HTML instead.");
  }
}

/** Accepts 6212.10.90.10, 6212109010, or 6212.10.90 and normalises to digits. */
function normaliseHts(raw) {
  const digits = String(raw || "").replace(/[^\d]/g, "");
  if (digits.length < 4) {
    throw new Error(`hts_code must have at least the 4-digit heading, for example 6212 or 6212.10.90. Got ${JSON.stringify(String(raw || ""))}.`);
  }
  if (digits.length > 10) throw new Error("An HTS code has at most 10 digits.");
  return digits;
}

const dotted = (digits) => {
  const p = [digits.slice(0, 4), digits.slice(4, 6), digits.slice(6, 8), digits.slice(8, 10)].filter(Boolean);
  return p.join(".");
};

/** The chapter subtree a heading lives in. exportList needs a half-open range. */
function headingRange(digits) {
  const h = Number(digits.slice(0, 4));
  return { from: String(h).padStart(4, "0"), to: String(h + 1).padStart(4, "0") };
}

/**
 * The governing rate is on the nearest ancestor with a non-empty general rate.
 * Rows are returned in document order with an indent level, so walking
 * backwards for a shallower indent finds the parent.
 */
function resolveRate(rows, idx) {
  const start = rows[idx];
  const ind = (r) => Number(r.indent ?? 0);
  if (stripHtml(start.general)) return { row: start, inheritedFrom: null };
  for (let i = idx - 1; i >= 0; i--) {
    if (ind(rows[i]) < ind(rows[idx]) && stripHtml(rows[i].general)) {
      return { row: rows[i], inheritedFrom: rows[i].htsno || null };
    }
  }
  return { row: null, inheritedFrom: null };
}

/** Pulls the partner codes out of a special-rate string like "Free (AU,BH,CL)". */
function specialPartners(special) {
  const s = stripHtml(special);
  const out = [];
  for (const m of s.matchAll(/\(([^)]*)\)/g)) {
    for (const part of m[1].split(/[,\s]+/)) {
      const code = part.replace(/\*/g, "").trim().toUpperCase();
      if (/^[A-Z]{1,3}$/.test(code)) out.push({ code, conditional: part.includes("*") });
    }
  }
  const seen = new Set();
  return out.filter((p) => (seen.has(p.code) ? false : seen.add(p.code)));
}

const TRADE_REMEDY_CAVEAT =
  "Trade remedies are NOT included in any figure here. Section 301 (China), Section 232 (steel and aluminium), antidumping and countervailing duties, and any tariff imposed by executive action all sit in Chapter 99 and stack on top of the rate below. They can exceed the base rate several times over. Confirm the Chapter 99 position for this code and origin before pricing anything.";

const ORIGIN_CAVEAT =
  "Duty follows the country of ORIGIN of the goods, not where the seller is based. For apparel the rules of origin are yarn-forward, so Australian wool spun and sewn in China is Chinese origin and pays the general rate. Being an Australian business does not make a shipment AU-origin.";

/* --------------------------------------------------------------- search -- */

/**
 * The official search is an OR match returned in HTS numerical order, not by
 * relevance. "merino wool trousers" therefore opens with wool grease in chapter
 * 15, because that row contains "wool" and sorts lowest. Adding words makes it
 * worse, not better.
 *
 * So: query the API with the phrase and with the most distinctive single terms,
 * merge what comes back, and rank locally by how many of the caller's terms the
 * line actually matches. Term coverage is reported per candidate so the reader
 * can see why something ranked where it did.
 */
const STOP = new Set(["of", "the", "for", "and", "or", "with", "a", "an", "in", "to", "from", "other", "not", "made", "type"]);

const normText = (v) =>
  String(v ?? "").toLowerCase().replace(/[\u2018\u2019']/g, "").replace(/[^a-z0-9]+/g, " ").trim();

const termsOf = (v) => [...new Set(normText(v).split(" ").filter((t) => t.length > 2 && !STOP.has(t)))];

/**
 * Singular/plural folding. The "es" plural matters as much as the "s" one:
 * only trying t+"s" meant "toothbrush" never matched the schedule's
 * "Toothbrushes", so the single most informative term in the query scored zero
 * and bamboo shoots won.
 */
function termVariants(t) {
  const v = new Set([t]);
  if (t.endsWith("ies")) v.add(t.slice(0, -3) + "y");
  if (t.endsWith("es")) v.add(t.slice(0, -2));
  if (t.endsWith("s")) v.add(t.slice(0, -1));
  if (t.endsWith("y")) v.add(t.slice(0, -1) + "ies");
  v.add(t + "s");
  v.add(t + "es");
  return [...v];
}

/**
 * Whole-word matching, not substring. A plain includes() made "bra" match
 * "brace overalls", which pushed heading 6104 above the actual brassieres
 * heading on a search for a sports bra.
 */
const wordRe = (words) => new RegExp(`\\b(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`);

function termMatches(haystack, t) {
  if (wordRe(termVariants(t)).test(haystack)) return true;
  for (const syn of synonymsFor(t)) {
    if (wordRe(termVariants(normText(syn))).test(haystack)) return true;
  }
  return false;
}

/**
 * The schedule speaks trade English, and the official search matches whole
 * words only. "bra" returns zero rows while "brassiere" finds heading 6212;
 * "leggings" returns frog legs because no garment line uses the word. So a
 * consumer word has to be translated before it is sent, and the translation is
 * reported in the response rather than applied invisibly.
 */
const TRADE_SYNONYMS = {
  bra: ["brassiere"], bras: ["brassiere"], bralette: ["brassiere"], bralettes: ["brassiere"],
  leggings: ["trousers"], legging: ["trousers"], jeggings: ["trousers"],
  joggers: ["trousers"], sweatpants: ["trousers"], trackpants: ["trousers"], tracksuit: ["track suits"],
  tights: ["pantyhose", "hosiery"], pantyhose: ["pantyhose"],
  jumper: ["pullover"], jumpers: ["pullover"], sweater: ["pullover"], sweaters: ["pullover"],
  hoodie: ["sweatshirts"], hoodies: ["sweatshirts"], hoody: ["sweatshirts"],
  singlet: ["singlets"], singlets: ["singlets"], camisole: ["singlets"],
  undies: ["briefs"], knickers: ["briefs"], panties: ["briefs"], underwear: ["briefs"],
  swimsuit: ["swimwear"], swimsuits: ["swimwear"], bathers: ["swimwear"], togs: ["swimwear"], bikini: ["swimwear"],
  beanie: ["headgear"], beanies: ["headgear"],
  thongs: ["sandals"], flipflops: ["sandals"],
  sneakers: ["footwear"], runners: ["footwear"], trainers: ["footwear"],
};

/** Words that are marketing categories, not goods. They match nothing, ever. */
const NON_TARIFF_WORDS = new Set(["activewear", "athleisure", "loungewear", "sportswear", "apparel", "clothing", "merino", "organic", "sustainable", "premium", "unisex"]);

const synonymsFor = (t) => TRADE_SYNONYMS[t] || [];

/**
 * Chapters 98 and 99 are not where you classify goods. Chapter 99 holds
 * temporary duty suspensions and the trade-remedy provisions, so a "Free" rate
 * there is conditional and sits alongside, not instead of, the real chapter 61
 * or 62 classification. Presenting one as the answer would be badly misleading,
 * so they are labelled and ranked below ordinary lines.
 */
function lineType(htsno) {
  const ch = String(htsno || "").replace(/[^\d]/g, "").slice(0, 2);
  if (ch === "99") return { chapter: 99, kind: "special_provision", note: "Chapter 99: a temporary suspension or a trade-remedy provision, used in addition to the primary classification and only when its own conditions are met. Not a classification in its own right." };
  if (ch === "98") return { chapter: 98, kind: "special_provision", note: "Chapter 98: a special classification provision such as returned goods, not an ordinary classification." };
  return { chapter: Number(ch) || null, kind: "normal", note: null };
}

/* ----------------------------------------------------------------- tools -- */

const TOOLS = [
  {
    name: "find_hts_code",
    title: "Find candidate US tariff codes for a product",
    description:
      "Search the official US Harmonized Tariff Schedule by plain-language product description and get back candidate HTS lines with their duty rates. Classification is the hard part of importing and the usual place a costly mistake is made, so this returns several candidates with their descriptions rather than pretending there is one obvious answer.",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", description: "What the product is, in plain words. For example 'women's merino wool leggings' or 'brassieres'." },
        limit: { type: "integer", description: "How many candidates to return, 1 to 40. Default 15." },
      },
      required: ["description"],
    },
  },
  {
    name: "lookup_us_duty_rate",
    title: "Look up the US duty rate that governs an HTS code",
    description:
      "Given a US HTS code, returns the duty rate that actually applies, resolving the common trap that rates sit on the 8-digit line while the 10-digit statistical lines underneath are blank and inherit. Optionally pass the country of origin to see whether a free-trade rate is available. Always reports what is excluded, because trade remedies such as Section 301 are not in this data and can dwarf the base rate.",
    inputSchema: {
      type: "object",
      properties: {
        hts_code: { type: "string", description: "A US HTS code, with or without dots: 6212.10.90, 6212109010 or 6212." },
        origin_country: { type: "string", description: "Optional ISO 3166-1 alpha-2 country of origin of the GOODS, for example CN or AU. Used to check free-trade eligibility." },
      },
      required: ["hts_code"],
    },
  },
  {
    name: "estimate_us_duty",
    title: "Estimate the US duty payable on a shipment",
    description:
      "Applies the governing ad valorem rate for an HTS code to a customs value and returns the indicative duty, with the free-trade rate shown separately when the origin qualifies. It states plainly what is excluded rather than presenting a total that looks complete. Use it for a directional landed-cost figure, never as a customs declaration.",
    inputSchema: {
      type: "object",
      properties: {
        hts_code: { type: "string", description: "A US HTS code." },
        customs_value_usd: { type: "number", description: "Declared customs value in USD. For most imports this is the transaction value of the goods, excluding international freight and insurance." },
        origin_country: { type: "string", description: "ISO 3166-1 alpha-2 country of origin of the goods, for example CN or AU." },
      },
      required: ["hts_code", "customs_value_usd"],
    },
  },
];

const publicTool = (t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema });

/* -------------------------------------------------------------- handlers -- */

async function findHtsCode(a) {
  const q = String(a.description || "").trim();
  if (!q) throw new Error("description is required: say what the product is, for example \"women's merino wool leggings\".");
  const limit = Math.max(1, Math.min(40, Number(a.limit) || 15));
  const terms = termsOf(q);
  if (!terms.length) throw new Error(`No searchable words in ${JSON.stringify(q)}. Use the product noun, for example "brassieres" or "trousers".`);

  // The phrase, plus each term on its own. A single distinctive noun gives a
  // tight set the API would otherwise bury under every chapter sharing one
  // word, and short terms matter as much as long ones: querying only the
  // longest words missed "bra" entirely, and with it the whole brassieres
  // heading. The requests run in parallel and the edge caches them for a day.
  const translated = [...new Set(terms.flatMap(synonymsFor))];
  const queries = [...new Set([q, ...terms.slice(0, 5), ...translated])].filter(Boolean);
  const settled = await Promise.allSettled(queries.map((k) => htsGet(`/search?keyword=${encodeURIComponent(k)}`)));
  const byCode = new Map();
  let upstreamTotal = 0;
  for (const r of settled) {
    if (r.status !== "fulfilled" || !Array.isArray(r.value)) continue;
    upstreamTotal += r.value.length;
    for (const row of r.value) {
      const k = String(row.htsno || "") + "|" + stripHtml(row.description).slice(0, 40);
      if (!byCode.has(k)) byCode.set(k, row);
    }
  }
  if (!byCode.size) {
    return {
      query: q,
      search_terms: terms,
      match_count: 0,
      candidates: [],
      notes: [`The official tariff search returned nothing usable for ${JSON.stringify(q)}. Use the trade term rather than a brand or marketing word: "brassiere" not "bralette", "trousers" not "leggings", "pullover" not "jumper".`],
    };
  }

  const rows = [...byCode.values()];
  const descs = rows.map((r) => normText(r.description));
  // A term matching nothing at all is not a tariff word. Keeping it in the
  // denominator would reward lines that match the generic words instead.
  const marketing = terms.filter((t) => NON_TARIFF_WORDS.has(t));
  const dead = terms.filter((t) => !descs.some((d) => termMatches(d, t)));
  const live = terms.filter((t) => !dead.includes(t));
  const scoring = live.length ? live : terms;

  // Counting matched terms equally is wrong: "womens" matches hundreds of lines
  // and tells you almost nothing, while "brassiere" matches four and tells you
  // everything. So weight each term by how rare it is in the rows actually
  // fetched, which needs no extra requests.
  const N = rows.length || 1;
  const weights = new Map(
    scoring.map((t) => {
      const df = descs.reduce((n, d) => n + (termMatches(d, t) ? 1 : 0), 0);
      // +1 keeps a term that matches every row at a weight of zero rather than
      // negative, and an unmatched term never contributes anyway.
      return [t, df ? Math.log(1 + N / df) : 0];
    })
  );

  const scored = rows.map((row, i) => {
    const matched = scoring.filter((t) => termMatches(descs[i], t));
    const score = matched.reduce((sum, t) => sum + (weights.get(t) || 0), 0);
    const hasRate = Boolean(stripHtml(row.general));
    const code = String(row.htsno || "");
    const lt = lineType(code);
    return { row, matched, score, hasRate, lt, depth: code.replace(/[^\d]/g, "").length, code };
  });
  const byRelevance = (x, y) =>
    y.score - x.score ||
    Number(y.hasRate) - Number(x.hasRate) ||
    y.depth - x.depth ||
    x.code.localeCompare(y.code);

  // Goods are classified in chapters 1 to 97. Chapter 98 and 99 lines are kept,
  // because one can describe the product more precisely than any ordinary line,
  // but they go in their own list so they cannot be read as the classification.
  const normal = scored.filter((c) => c.lt.kind === "normal").sort(byRelevance);
  const special = scored.filter((c) => c.lt.kind === "special_provision").sort(byRelevance);

  const shape = (c) => ({
    hts_code: c.row.htsno || null,
    description: stripHtml(c.row.description),
    general_rate: stripHtml(c.row.general) || null,
    special_rate: stripHtml(c.row.special) || null,
    rate_on_this_line: c.hasRate,
    line_type: c.lt.kind,
    chapter: c.lt.chapter,
    line_type_note: c.lt.note,
    terms_matched: c.matched,
    terms_matched_count: `${c.matched.length} of ${scoring.length}`,
    relevance: Math.round(c.score * 100) / 100,
    units: cleanUnits(c.row.units),
    indent: c.row.indent ?? null,
  });

  const top = normal.slice(0, limit);
  const candidates = top.map(shape);
  const relatedSpecial = special.slice(0, Math.min(5, limit)).map(shape);
  const best = top[0]?.matched.length ?? 0;
  const termWeights = Object.fromEntries([...weights].map(([t, w]) => [t, Math.round(w * 100) / 100]));
  const notes = [];
  if (translated.length) {
    const pairs = terms.filter((t) => synonymsFor(t).length).map((t) => `${t} -> ${synonymsFor(t).join("/")}`);
    notes.push(`Consumer words were translated into tariff terms before searching: ${pairs.join("; ")}. The schedule matches whole words only, so an untranslated consumer word returns nothing: "bra" finds no rows at all while "brassiere" finds heading 6212.`);
  }
  if (marketing.length) {
    notes.push(`${marketing.map((t) => JSON.stringify(t)).join(", ")} ${marketing.length === 1 ? "is a marketing category" : "are marketing categories"} rather than ${marketing.length === 1 ? "a type of goods" : "types of goods"}, so ${marketing.length === 1 ? "it carries" : "they carry"} no classification meaning.`);
  }
  if (dead.length) {
    notes.push(`${dead.map((t) => JSON.stringify(t)).join(", ")} ${dead.length === 1 ? "does" : "do"} not appear anywhere in the tariff schedule, so ${dead.length === 1 ? "it was" : "they were"} excluded from ranking. Fibre brand names and marketing words are not tariff terms; the schedule speaks of wool, cotton and man-made fibres.`);
  }
  if (relatedSpecial.length) {
    notes.push(`${relatedSpecial.length} Chapter 98 or 99 line${relatedSpecial.length === 1 ? "" : "s"} also matched and ${relatedSpecial.length === 1 ? "is" : "are"} listed separately under related_special_provisions. Those often describe a product more exactly than any ordinary line, which makes them useful for confirming what the product is, but goods are classified in chapters 1 to 97 and a "Free" rate there is conditional and additional. Never read one as the duty answer.`);
  }
  notes.push(
    `Ranked locally. The official search is an OR match returned in tariff-number order rather than by relevance, so its raw ordering opens with whichever low-numbered chapter happens to share a single word. Terms are weighted by how rare they are in the rows returned, because a word like "womens" matches hundreds of lines and carries almost no information while the product noun carries nearly all of it. Weights used: ${JSON.stringify(termWeights)}.`,
    `${candidates.filter((c) => c.rate_on_this_line).length} of ${candidates.length} candidates carry a rate on their own line. The rest are headings or statistical lines that inherit; call lookup_us_duty_rate to resolve one.`
  );
  if (best < scoring.length) {
    notes.push(`No line matched all ${scoring.length} usable search terms; the best matched ${best}. Narrow to the trade term for the garment or article itself.`);
  }
  // Stated every time rather than behind a confidence heuristic. Coverage ratio
  // and term rarity both turned out to flag correct answers as weak and miss
  // wrong ones, so a verdict here would be worse than this standing caveat.
  notes.push(
    "Many everyday articles have no name of their own in the schedule and are classified by MATERIAL and construction instead, so no keyword can reach them by their consumer name. A reusable metal drinking straw falls under table, kitchen or other household articles of the relevant metal, not under anything called a straw. If nothing here looks like the product, search the material instead of the product name."
  );
  notes.push("A description is a starting point, not a classification. The legal classification turns on material composition, construction, knit versus woven and gender, and only the importer of record can settle it.");
  notes.push(ORIGIN_CAVEAT);

  return {
    query: q,
    search_terms: terms,
    terms_used_for_ranking: scoring,
    trade_terms_substituted: translated,
    terms_not_in_schedule: dead,
    marketing_words_ignored: marketing,
    queries_issued: queries,
    match_count: byCode.size,
    upstream_rows_considered: upstreamTotal,
    returned: candidates.length,
    candidates,
    related_special_provisions: relatedSpecial,
    notes,
  };
}

async function resolveCode(code) {
  const digits = normaliseHts(code);
  const { from, to } = headingRange(digits);
  const rows = await htsGet(`/exportList?from=${from}&to=${to}&format=JSON&styles=true`);
  if (!Array.isArray(rows) || !rows.length) throw new Error(`No tariff lines came back for heading ${from}. Check the code.`);

  const key = (r) => String(r.htsno || "").replace(/[^\d]/g, "");
  let idx = rows.findIndex((r) => key(r) === digits);
  let matchedAs = "exact";
  if (idx < 0) {
    // Fall back to the longest line that is a prefix of what was asked for, so
    // a 10-digit code with no own row still resolves through its 8-digit parent.
    let best = -1, bestLen = -1;
    rows.forEach((r, i) => {
      const k = key(r);
      if (k && digits.startsWith(k) && k.length > bestLen) { best = i; bestLen = k.length; }
    });
    if (best < 0) throw new Error(`${dotted(digits)} is not a line in the current tariff schedule, and no parent of it is either.`);
    idx = best;
    matchedAs = `nearest parent (${rows[best].htsno})`;
  }
  const { row: rateRow, inheritedFrom } = resolveRate(rows, idx);
  return { digits, rows, idx, matchedAs, rateRow, inheritedFrom, path: descriptionPath(rows, idx) };
}

/**
 * The description on a deep line is frequently just "Other", which tells the
 * reader nothing. The meaning only exists as the chain of parents, so return
 * that chain rather than the leaf on its own.
 */
function descriptionPath(rows, idx) {
  const ind = (r) => Number(r.indent ?? 0);
  const path = [];
  let want = ind(rows[idx]);
  for (let i = idx; i >= 0 && want >= 0; i--) {
    if (ind(rows[i]) === want) {
      const d = stripHtml(rows[i].description);
      if (d) path.unshift({ hts_code: rows[i].htsno || null, description: d });
      want -= 1;
    }
  }
  return path;
}

/** Parses "16.9%" into a fraction. Specific and compound rates are not ad valorem. */
function adValorem(rateText) {
  const t = stripHtml(rateText);
  if (/^free$/i.test(t)) return { kind: "free", fraction: 0 };
  const frac = (n) => Math.round((Number(n) / 100) * 1e6) / 1e6;
  const pct = t.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pct) return { kind: "ad_valorem", percent: Number(pct[1]), fraction: frac(pct[1]) };
  const anyPct = t.match(/(\d+(?:\.\d+)?)\s*%/);
  if (anyPct) return { kind: "compound", percent: Number(anyPct[1]), fraction: frac(anyPct[1]) };
  return { kind: "not_ad_valorem", fraction: null };
}

async function lookupUsDutyRate(a) {
  const { digits, matchedAs, rateRow, inheritedFrom, path } = await resolveCode(a.hts_code);
  const origin = a.origin_country ? String(a.origin_country).trim().toUpperCase() : null;
  if (origin && !/^[A-Z]{2}$/.test(origin)) {
    throw new Error(`origin_country must be a 2-letter ISO country code such as CN or AU. Got ${JSON.stringify(a.origin_country)}.`);
  }

  if (!rateRow) {
    return {
      hts_code: dotted(digits),
      matched_as: matchedAs,
      rate_found: false,
      notes: [`No line at or above ${dotted(digits)} carries a general rate. That usually means the code is a heading only and you need a more specific subheading.`, TRADE_REMEDY_CAVEAT],
    };
  }

  const general = stripHtml(rateRow.general) || null;
  const special = stripHtml(rateRow.special) || null;
  const partners = specialPartners(rateRow.special);
  const match = origin ? partners.find((p) => p.code === origin) : null;

  const notes = [TRADE_REMEDY_CAVEAT, ORIGIN_CAVEAT];
  if (inheritedFrom) {
    notes.unshift(`The rate is set on ${inheritedFrom}, not on ${dotted(digits)} itself. The 10-digit statistical lines are blank and inherit, which is why reading the rate straight off the code you were given shows nothing.`);
  }
  if (match?.conditional) {
    notes.push(`${origin} is listed with an asterisk, which means the free rate is conditional. Check the chapter notes for the carve-out before relying on it.`);
  }
  const addl = stripHtml(rateRow.additionalDuties || rateRow.addiitionalDuties);
  if (addl) notes.push(`The schedule records additional duties on this line: ${addl}`);

  return {
    hts_code: dotted(digits),
    matched_as: matchedAs,
    description: stripHtml(rateRow.description) || null,
    description_path: path,
    full_description: path.map((p) => p.description).join(" > ") || null,
    rate_found: true,
    rate_set_on: rateRow.htsno || null,
    general_rate: general,
    general_rate_parsed: adValorem(general),
    special_rate: special,
    free_trade_partners: partners.map((p) => p.code),
    origin_country: origin,
    origin_qualifies_for_special: origin ? Boolean(match) : null,
    origin_verdict: origin
      ? match
        ? `${origin} appears in the special column, so goods of ${origin} ORIGIN may enter at the special rate, subject to meeting the rules of origin and holding the documentation.`
        : `${origin} is not in the special column, so goods of ${origin} origin pay the general rate of ${general}.`
      : "No origin supplied, so only the general rate is resolved. Pass origin_country to check free-trade eligibility.",
    units: cleanUnits(rateRow.units),
    footnotes: rateRow.footnotes || null,
    source: "Official USITC Harmonized Tariff Schedule, fetched live.",
    notes,
  };
}

async function estimateUsDuty(a) {
  const value = Number(a.customs_value_usd);
  if (!Number.isFinite(value) || value <= 0) throw new Error("customs_value_usd is required and must be greater than zero.");
  const r = await lookupUsDutyRate({ hts_code: a.hts_code, origin_country: a.origin_country });
  if (!r.rate_found) return { ...r, estimate: null };

  const r2 = (n) => Math.round(n * 100) / 100;
  const gen = r.general_rate_parsed;
  const qualifies = r.origin_qualifies_for_special === true;
  const rows = [];

  if (gen.fraction !== null) {
    rows.push({ basis: "general (MFN) rate", rate: r.general_rate, duty_usd: r2(value * gen.fraction), applies: !qualifies });
  }
  if (qualifies) {
    const spec = adValorem(r.special_rate);
    rows.push({
      basis: `free-trade rate for ${r.origin_country}`,
      rate: /free/i.test(String(r.special_rate)) ? "Free" : r.special_rate,
      duty_usd: /free/i.test(String(r.special_rate)) ? 0 : spec.fraction !== null ? r2(value * spec.fraction) : null,
      applies: true,
      conditional: "Only with qualifying origin and the documentation to prove it.",
    });
  }
  const applied = rows.find((x) => x.applies) || rows[0] || null;

  return {
    hts_code: r.hts_code,
    description: r.full_description || r.description,
    customs_value_usd: r2(value),
    origin_country: r.origin_country,
    rate_options: rows,
    indicative_duty_usd: applied ? applied.duty_usd : null,
    indicative_basis: applied ? applied.basis : null,
    excluded_from_this_figure: [
      "Section 301, Section 232, antidumping and countervailing duties, and any tariff imposed by executive action. These sit in Chapter 99, stack on top, and can be several times the base rate.",
      "Merchandise Processing Fee and Harbor Maintenance Fee.",
      "International freight, insurance and customs brokerage.",
      "State and local taxes at the destination.",
    ],
    rate_detail: {
      general_rate: r.general_rate,
      special_rate: r.special_rate,
      rate_set_on: r.rate_set_on,
      rate_kind: gen.kind,
    },
    notes: gen.kind === "not_ad_valorem"
      ? ["This line is not a simple percentage rate, so no value-based figure can be produced. Specific and compound rates are charged per unit or per kilogram and need the quantity, not just the value.", ...r.notes]
      : gen.kind === "compound"
        ? ["This line is a compound rate. Only the percentage component is applied here, so the real duty is higher than this figure.", ...r.notes]
        : r.notes,
    disclaimer: "Indicative only, not a customs declaration and not customs advice. The importer of record is responsible for classification and for the duty actually payable.",
  };
}

const HANDLERS = { find_hts_code: findHtsCode, lookup_us_duty_rate: lookupUsDutyRate, estimate_us_duty: estimateUsDuty };

export const dutyServer = {
  slug: "duty",
  name: "US Tariff Lookup",
  version: "1.0.0",
  tagline:
    "Find the right US tariff code for a product and the duty rate that actually governs it, read live from the official schedule.",
  description:
    "Search the official US Harmonized Tariff Schedule, resolve the duty rate that governs an HTS code, and estimate indicative duty. No authentication required.",
  instructions: `US Tariff Lookup reads the official USITC Harmonized Tariff Schedule live. No account or key is needed.

TWO TRAPS THIS SERVER EXISTS TO HANDLE
- Rates sit on the 8-digit line. The 10-digit statistical lines underneath are blank and inherit, so reading the rate off the code you were handed shows nothing and looks duty-free. Every response says which line actually sets the rate.
- Duty follows the country of ORIGIN of the goods, not the seller's address. AU appears in the special column for most apparel, which makes "Australian business, therefore free" a tempting and expensive mistake. For apparel the rules of origin are yarn-forward, so Australian wool spun and sewn in China is Chinese origin and pays the general rate.

WHAT IS NOT IN THESE NUMBERS
Trade remedies. Section 301 on China, Section 232, antidumping and countervailing duties, and anything imposed by executive action all live in Chapter 99 and stack on top of the rate returned here. They routinely exceed the base rate. Never present a figure from this server as a landed cost without saying so.

HOW TO USE IT
Start with find_hts_code when you only have a product description, and treat the result as candidates rather than an answer. Then lookup_us_duty_rate with an origin_country. Use estimate_us_duty only for a directional figure, and pass on its excluded_from_this_figure list to whoever is going to act on it.

This is not customs advice. The importer of record owns the classification.`,
  caveat: {
    title: "The base rate is not the landed cost",
    body: "These are the official published duty rates. Section 301, Section 232, antidumping and countervailing duties, and tariffs imposed by executive action all sit in Chapter 99, stack on top, and can be several times the base rate. Duty also follows the country of origin of the goods, not the seller's address, and for apparel the rules of origin are yarn-forward.",
  },
  footnote:
    "Rates are fetched live from the USITC schedule and cached for 12 hours. Indicative only, not customs advice; the importer of record owns the classification and the duty payable.",
  tools: TOOLS.map(publicTool),
  async run(name, args) {
    const fn = HANDLERS[name];
    if (!fn) throw new Error(`Unknown tool "${name}".`);
    const out = await fn(args || {});
    return { text: JSON.stringify(out, null, 2), structured: out };
  },
};
