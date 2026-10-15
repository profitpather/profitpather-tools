/**
 * Holiday source adapters.
 *
 * Three independent providers. None is authoritative on its own, so every
 * adapter normalises to the same shape and the caller compares them rather
 * than picking a winner. A source that does not cover a country, or has no
 * data for a year, reports itself unavailable instead of looking like it
 * disagrees.
 */

const DAY_CACHE = { cacheTtl: 86400, cacheEverything: true };

/** Countries Google publishes an English holiday calendar for, ISO -> feed name. */
const GOOGLE_FEEDS = {
  AE: "ae", AT: "austrian", AU: "australian", BE: "be", BR: "brazilian",
  CA: "canadian", CH: "ch", CN: "china", CZ: "czech", DE: "german",
  DK: "danish", ES: "spain", FI: "finnish", FR: "french", GB: "uk",
  GR: "greek", HK: "hong_kong", ID: "indonesian", IE: "irish", IN: "indian",
  IT: "italian", JP: "japanese", KR: "south_korea", MX: "mexican",
  MY: "malaysia", NL: "dutch", NO: "norwegian", NZ: "new_zealand",
  PH: "philippines", PL: "polish", PT: "portuguese", SE: "swedish",
  SG: "singapore", TR: "turkish", US: "usa", ZA: "sa",
};

/** Countries OpenHolidays covers, sourced from official government calendars. */
const OPEN_HOLIDAYS = new Set([
  "AD", "AL", "AT", "BE", "BG", "BR", "BY", "CH", "CZ", "DE", "EE", "ES",
  "FR", "HR", "HU", "IE", "IT", "LI", "LT", "LU", "LV", "MC", "MD", "MT",
  "MX", "NL", "PL", "PT", "RO", "RS", "SE", "SI", "SK", "SM", "VA", "ZA",
]);

const unavailable = (id, label, reason) => ({ id, label, available: false, reason, entries: [] });

/** Returns null when the provider answers "nothing here" rather than an error. */
async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" }, cf: DAY_CACHE });
  if (res.status === 404 || res.status === 204) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // Nager answers 204 with an empty body for countries it does not cover, and
  // some edges strip the status, so an empty body is treated the same way.
  const body = (await res.text()).trim();
  if (body === "") return null;
  return JSON.parse(body);
}

/* ------------------------------------------------------------- Nager --- */

/**
 * Nager flags a holiday `global: false` whenever it enumerates subdivisions,
 * even when every subdivision is listed. UK New Year's Day lists all four home
 * nations, so it is national in practice. Full coverage therefore counts as
 * national; genuinely partial holidays stay regional.
 */
function coversEverywhere(counties, universe) {
  if (universe.size === 0 || counties.length < universe.size) return false;
  for (const code of universe) if (!counties.includes(code)) return false;
  return true;
}

// Nager labels 26 December "St. Stephen's Day" everywhere. Right for Ireland,
// wrong anywhere that calls it Boxing Day, where it reads as a data error.
const BOXING_DAY = new Set(["GB", "AU", "NZ", "CA", "ZA", "HK"]);

export async function fetchNager(country, year) {
  const id = "nager";
  const label = "Nager.Date";
  let raw;
  try {
    raw = await getJson(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`);
  } catch (err) {
    return unavailable(id, label, `fetch failed (${err.message})`);
  }
  if (raw === null) return unavailable(id, label, `country not covered (204 countries only)`);
  if (!Array.isArray(raw) || raw.length === 0) return unavailable(id, label, `no data for ${year}`);

  const universe = new Set();
  for (const h of raw) if (Array.isArray(h.counties)) for (const c of h.counties) universe.add(c);

  const entries = raw.map((h) => {
    const counties = Array.isArray(h.counties) ? h.counties : [];
    const name = h.name === "St. Stephen's Day" && BOXING_DAY.has(country) ? "Boxing Day" : h.name;
    return {
      date: h.date,
      name,
      local_name: h.localName,
      national: Boolean(h.global) || counties.length === 0 || coversEverywhere(counties, universe),
      counties,
    };
  });
  return { id, label, available: true, entries, universe };
}

/* ------------------------------------------------------------ Google --- */

/** Minimal iCalendar reader: unfold continuation lines, then split events. */
function parseIcs(text) {
  const unfolded = text.replace(/\r\n[ \t]/g, "").replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  const events = [];
  for (const chunk of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const body = chunk.split("END:VEVENT")[0];
    const start = /DTSTART;VALUE=DATE:(\d{4})(\d{2})(\d{2})/.exec(body);
    const summary = /\nSUMMARY:(.*)/.exec("\n" + body);
    const description = /\nDESCRIPTION:(.*)/.exec("\n" + body);
    if (!start || !summary) continue;
    events.push({
      date: `${start[1]}-${start[2]}-${start[3]}`,
      name: summary[1].trim(),
      description: (description ? description[1] : "").trim(),
    });
  }
  return events;
}

export async function fetchGoogle(country, year) {
  const id = "google";
  const label = "Google Calendar (data from timeanddate.com)";
  const feed = GOOGLE_FEEDS[country];
  if (!feed) return unavailable(id, label, `no English holiday calendar published for ${country}`);

  let text;
  try {
    const url = `https://calendar.google.com/calendar/ical/en.${feed}%23holiday%40group.v.calendar.google.com/public/basic.ics`;
    const res = await fetch(url, { cf: DAY_CACHE });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    return unavailable(id, label, `fetch failed (${err.message})`);
  }

  // Two passes, mirroring the Nager fix. Google also enumerates subdivisions
  // for holidays that every subdivision observes: Australian Good Friday is
  // listed as "regional" while naming all eight states plus the external
  // territories. Full coverage of the subdivision universe means national.
  const raw = [];
  for (const ev of parseIcs(text)) {
    if (!ev.date.startsWith(String(year))) continue;
    const description = ev.description
      .replace(/\\,/g, ",")
      .replace(/\\;/g, ";")
      .replace(/\\n/g, "\n")
      .replace(/\\\\/g, "\\");
    // The feed mixes real holidays with observances such as Mother's Day.
    // Only DESCRIPTION tells them apart, and "Public holiday in X" means regional.
    if (!description.startsWith("Public holiday")) continue;
    const scopeText = description.slice("Public holiday".length).split("\n")[0].replace(/^\s*in\s*/, "").trim();
    raw.push({
      date: ev.date,
      name: ev.name.replace(/\s*\(regional holiday\)\s*$/, "").trim(),
      scopes: scopeText ? scopeText.split(",").map((x) => x.trim()).filter(Boolean) : [],
    });
  }

  const universe = new Set();
  for (const r of raw) for (const scope of r.scopes) universe.add(scope);

  const entries = raw.map((r) => ({
    date: r.date,
    name: r.name,
    national: r.scopes.length === 0 || coversEverywhere(r.scopes, universe),
    scope: r.scopes.length > 0 ? r.scopes.join(", ") : null,
  }));

  // The feed only spans a few years either side of today.
  if (entries.length === 0) return unavailable(id, label, `feed carries no ${year} data`);
  return { id, label, available: true, entries };
}

/* ------------------------------------------------------ OpenHolidays --- */

export async function fetchOpenHolidays(country, year) {
  const id = "openholidays";
  const label = "OpenHolidays (official government sources)";
  if (!OPEN_HOLIDAYS.has(country)) return unavailable(id, label, `country not covered (36 countries only)`);

  let raw;
  try {
    raw = await getJson(
      `https://openholidaysapi.org/PublicHolidays?countryIsoCode=${country}&languageIsoCode=EN` +
        `&validFrom=${year}-01-01&validTo=${year}-12-31`
    );
  } catch (err) {
    return unavailable(id, label, `fetch failed (${err.message})`);
  }
  if (raw === null || !Array.isArray(raw) || raw.length === 0) return unavailable(id, label, `no data for ${year}`);

  const entries = raw
    .filter((h) => h.type === "Public")
    .map((h) => ({
      date: h.startDate,
      name: (h.name?.find((n) => n.language === "EN") || h.name?.[0])?.text || "Public holiday",
      national: Boolean(h.nationwide),
      counties: (h.subdivisions || []).map((s) => s.code),
    }));
  return { id, label, available: true, entries };
}

/* -------------------------------------------------------- comparison --- */

export async function gatherSources(country, year) {
  return Promise.all([fetchNager(country, year), fetchGoogle(country, year), fetchOpenHolidays(country, year)]);
}

/**
 * Compare the NATIONAL holiday set across every source that actually covers
 * this country and year. Matching is by date, never by name, because the same
 * day is called different things by different providers.
 */
export function compareNational(sources) {
  const covering = sources.filter((s) => s.available);
  const byDate = new Map();

  for (const source of covering) {
    for (const entry of source.entries) {
      if (!entry.national) continue;
      if (!byDate.has(entry.date)) byDate.set(entry.date, { date: entry.date, names: {}, present: new Set() });
      const row = byDate.get(entry.date);
      row.names[source.id] = entry.name;
      row.present.add(source.id);
    }
  }

  const dates = [...byDate.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((row) => {
      const missing = covering.filter((s) => !row.present.has(s.id)).map((s) => s.id);
      return {
        date: row.date,
        names: row.names,
        confirmed_by: [...row.present],
        missing_from: missing,
        status: missing.length === 0 ? "agreed" : "disputed",
      };
    });

  return {
    sources_compared: covering.map((s) => s.id),
    sources_unavailable: sources.filter((s) => !s.available).map((s) => ({ id: s.id, reason: s.reason })),
    agreed: dates.filter((d) => d.status === "agreed"),
    disputed: dates.filter((d) => d.status === "disputed"),
    dates,
  };
}

export const SOURCE_LABELS = {
  nager: "Nager.Date",
  google: "Google Calendar (timeanddate.com)",
  openholidays: "OpenHolidays (official government sources)",
};
