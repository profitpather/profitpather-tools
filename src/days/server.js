/**
 * business-days: public holidays and working-day arithmetic for 200+ countries.
 *
 * A language model's failure mode on calendar questions is confident wrongness,
 * so a tool that is also confidently wrong adds nothing. Holiday data is read
 * from three independent providers and the disagreements are reported rather
 * than resolved. See ./sources.js.
 *
 * Lifted from the standalone businessdays-mcp Worker into the tools hub. The
 * tool definitions and handlers are unchanged; only the HTTP shell was dropped,
 * because the hub now owns transport, CORS, caching and rate limiting.
 */

import { fetchNager, gatherSources, compareNational, SOURCE_LABELS } from "./sources.js";

const SUPPORTED_PROTOCOLS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const DEFAULT_PROTOCOL = "2025-06-18";
const SERVER_INFO = { name: "business-days", version: "2.0.0" };

const MIN_YEAR = 1975;
const MAX_YEAR = 2075;
const MAX_SHIFT = 1000;


/** An error whose message is safe and useful to show the end user. */
class UserError extends Error {}

/* ---------------------------------------------------------------- dates -- */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parseDate(value, field) {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new UserError(`"${field}" must be a date in YYYY-MM-DD format (got ${JSON.stringify(value)}).`);
  }
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Rejects things like 2026-02-30, which Date.UTC would silently roll over.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new UserError(`"${field}" is not a real calendar date: ${value}.`);
  }
  if (y < MIN_YEAR || y > MAX_YEAR) throw new UserError(`"${field}" must fall between ${MIN_YEAR} and ${MAX_YEAR}.`);
  return dt;
}

const fmt = (dt) => dt.toISOString().slice(0, 10);
const shift = (dt, n) => new Date(dt.getTime() + n * 86400000);
const isWeekend = (dt) => dt.getUTCDay() === 0 || dt.getUTCDay() === 6;
const weekdayOf = (iso) => WEEKDAYS[new Date(iso + "T00:00:00Z").getUTCDay()];

function normaliseCountry(value) {
  if (typeof value !== "string" || !/^[A-Za-z]{2}$/.test(value.trim())) {
    throw new UserError(
      `"country" must be a 2-letter ISO 3166-1 alpha-2 code such as AU, US, GB or NZ (got ${JSON.stringify(value)}).`
    );
  }
  return value.trim().toUpperCase();
}

function normaliseRegion(value, country) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new UserError(`"region" must be a string such as AU-NSW or US-CA.`);
  const region = value.trim().toUpperCase();
  if (!/^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(region)) {
    throw new UserError(`"region" must be an ISO 3166-2 subdivision code such as AU-NSW or US-CA (got ${JSON.stringify(value)}).`);
  }
  if (!region.startsWith(country + "-")) throw new UserError(`"region" ${region} does not belong to country ${country}.`);
  return region;
}

function normaliseYear(value) {
  if (!Number.isInteger(value) || value < MIN_YEAR || value > MAX_YEAR) {
    throw new UserError(`"year" must be a whole number between ${MIN_YEAR} and ${MAX_YEAR} (got ${JSON.stringify(value)}).`);
  }
  return value;
}

/* ------------------------------------------------------------- calendar -- */

/**
 * The working calendar used for arithmetic. Deliberately single-source
 * (Nager, the only provider with ISO subdivision codes for every country) so
 * that a given question always yields one definite answer. Agreement across
 * providers is reported alongside, never blended into the result.
 */
function makeCalendar(country, region) {
  const byYear = new Map();

  async function load(year) {
    if (byYear.has(year)) return byYear.get(year);
    const source = await fetchNager(country, year);
    if (!source.available) {
      throw new UserError(
        `No public holiday calendar is available for country code "${country}" in ${year} (${source.reason}). ` +
          `Use a 2-letter ISO 3166-1 alpha-2 code such as AU, US, GB or NZ.`
      );
    }
    const applicable = new Map();
    let regionalSkipped = 0;
    for (const entry of source.entries) {
      const applies = entry.national || (region !== null && entry.counties.includes(region));
      if (applies) {
        if (!applicable.has(entry.date)) applicable.set(entry.date, entry);
      } else {
        regionalSkipped += 1;
      }
    }
    const loaded = { applicable, regionalSkipped, entries: source.entries };
    byYear.set(year, loaded);
    return loaded;
  }

  return {
    load,
    async holidayOn(dt) {
      const { applicable } = await load(dt.getUTCFullYear());
      return applicable.get(fmt(dt)) || null;
    },
  };
}

/** National-level agreement report for one country and year, memoised per request. */
async function agreementFor(country, year, memo) {
  const key = `${country}:${year}`;
  if (memo.has(key)) return memo.get(key);
  const report = compareNational(await gatherSources(country, year));
  memo.set(key, report);
  return report;
}

const sourceList = (ids) => ids.map((id) => SOURCE_LABELS[id] || id).join(", ");

/* ---------------------------------------------------------------- tools -- */

const TOOLS = [
  {
    name: "list_public_holidays",
    title: "List public holidays",
    description:
      "Use this when the user asks what the public holidays are in a country or region for a given year, when a particular holiday falls, or how many holidays a year has. Covers 200+ countries with state and province detail. Do not use it for working-day arithmetic; use add_business_days for that.",
    inputSchema: {
      type: "object",
      properties: {
        country: { type: "string", description: "ISO 3166-1 alpha-2 country code, for example AU, US, GB, NZ, DE." },
        year: { type: "integer", description: `Calendar year between ${MIN_YEAR} and ${MAX_YEAR}.` },
        region: {
          type: "string",
          description:
            "Optional ISO 3166-2 subdivision code such as AU-NSW or US-CA. Supply it whenever the user names a state or province, otherwise only nationwide holidays are returned.",
        },
      },
      required: ["country", "year"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        country: { type: "string" },
        year: { type: "integer" },
        region: { type: ["string", "null"] },
        holiday_count: { type: "integer" },
        regional_holidays_excluded: { type: "integer" },
        holidays: { type: "array", items: { type: "object" } },
      },
      required: ["country", "year", "holiday_count", "holidays"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: async (args) => {
      const country = normaliseCountry(args.country);
      const region = normaliseRegion(args.region, country);
      const year = normaliseYear(args.year);

      const { applicable, regionalSkipped } = await makeCalendar(country, region).load(year);
      const holidays = [...applicable.values()]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((h) => ({ date: h.date, name: h.name, local_name: h.local_name, nationwide: h.national, regions: h.counties }));

      const where = region ? `${country} (${region})` : country;
      const lines = holidays.map(
        (h) => `${h.date} (${weekdayOf(h.date)}) - ${h.name}${h.nationwide ? "" : ` [${h.regions.join(", ")}]`}`
      );
      let text = `${holidays.length} public holiday${holidays.length === 1 ? "" : "s"} in ${where} during ${year}:\n${lines.join("\n")}`;
      if (!region && regionalSkipped > 0) {
        text += `\n\nNationwide holidays only. ${regionalSkipped} state or province specific holiday${
          regionalSkipped === 1 ? " was" : "s were"
        } excluded; pass a "region" code to include them.`;
      }
      text += `\n\nSingle source. Call cross_check_holidays to compare this against independent providers.`;

      return {
        structured: {
          country,
          year,
          region,
          holiday_count: holidays.length,
          regional_holidays_excluded: region ? 0 : regionalSkipped,
          holidays,
        },
        text,
      };
    },
  },
  {
    name: "check_business_day",
    title: "Check whether a date is a business day",
    description:
      "Use this when the user asks whether one specific date is a working day, a public holiday, or whether businesses and banks are open. Names the holiday if there is one, and reports whether independent holiday sources agree on that date.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "The date to check, in YYYY-MM-DD format." },
        country: { type: "string", description: "ISO 3166-1 alpha-2 country code, for example AU, US, GB." },
        region: { type: "string", description: "Optional ISO 3166-2 subdivision code such as AU-NSW or US-CA." },
      },
      required: ["date", "country"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        date: { type: "string" },
        weekday: { type: "string" },
        country: { type: "string" },
        region: { type: ["string", "null"] },
        is_weekend: { type: "boolean" },
        is_public_holiday: { type: "boolean" },
        holiday_name: { type: ["string", "null"] },
        is_business_day: { type: "boolean" },
        agreement: { type: "object" },
      },
      required: ["date", "weekday", "country", "is_weekend", "is_public_holiday", "is_business_day", "agreement"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: async (args, memo) => {
      const country = normaliseCountry(args.country);
      const region = normaliseRegion(args.region, country);
      const date = parseDate(args.date, "date");
      const iso = fmt(date);

      const holiday = await makeCalendar(country, region).holidayOn(date);
      const weekend = isWeekend(date);
      const weekday = WEEKDAYS[date.getUTCDay()];
      const businessDay = !weekend && holiday === null;

      const report = await agreementFor(country, date.getUTCFullYear(), memo);
      const row = report.dates.find((d) => d.date === iso) || null;
      const agreement = {
        sources_compared: report.sources_compared,
        confirmed_by: row ? row.confirmed_by : [],
        missing_from: row ? row.missing_from : report.sources_compared,
        status: row ? row.status : "not_a_national_holiday_in_any_source",
        names_by_source: row ? row.names : {},
        note: "Source comparison is national-level only; regional holidays are not cross-checked.",
      };

      const where = region ? `${country} (${region})` : country;
      let text;
      if (businessDay) text = `${iso} is a ${weekday} and a normal business day in ${where}.`;
      else if (holiday && weekend) text = `${iso} falls on a ${weekday} in ${where} and is also the public holiday ${holiday.name}. Not a business day.`;
      else if (holiday) text = `${iso} is a ${weekday} but a public holiday in ${where}: ${holiday.name}. Not a business day.`;
      else text = `${iso} falls on a ${weekday} in ${where}, so it is not a business day.`;

      if (row && row.status === "agreed") {
        text += `\n\nConfirmed as a national holiday by all ${row.confirmed_by.length} sources checked (${sourceList(row.confirmed_by)}).`;
      } else if (row && row.status === "disputed") {
        text += `\n\nSOURCES DISAGREE. ${sourceList(row.confirmed_by)} list this as a national holiday; ${sourceList(
          row.missing_from
        )} do not. Verify against the official government calendar before relying on this.`;
      } else if (holiday) {
        text += `\n\nThis is a regional holiday, which is not cross-checked. Compared sources: ${sourceList(report.sources_compared)}.`;
      }

      return {
        structured: {
          date: iso,
          weekday,
          country,
          region,
          is_weekend: weekend,
          is_public_holiday: holiday !== null,
          holiday_name: holiday ? holiday.name : null,
          is_business_day: businessDay,
          agreement,
        },
        text,
      };
    },
  },
  {
    name: "add_business_days",
    title: "Add or subtract business days from a date",
    description:
      "Use this when the user needs a date N working days from another date: delivery and shipping estimates, payment or settlement terms, notice periods, SLA and deadline questions. Skips weekends and the public holidays of the country or region, reports exactly which days were skipped, and flags any date in the range that independent sources disagree about.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "The starting date in YYYY-MM-DD format. It is not counted itself." },
        days: {
          type: "integer",
          description: `Business days to move. Positive counts forward, negative counts backward. Maximum magnitude ${MAX_SHIFT}.`,
        },
        country: { type: "string", description: "ISO 3166-1 alpha-2 country code, for example AU, US, GB." },
        region: { type: "string", description: "Optional ISO 3166-2 subdivision code such as AU-NSW or US-CA." },
      },
      required: ["start_date", "days", "country"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string" },
        business_days_moved: { type: "integer" },
        result_date: { type: "string" },
        result_weekday: { type: "string" },
        country: { type: "string" },
        region: { type: ["string", "null"] },
        calendar_days_elapsed: { type: "integer" },
        skipped: { type: "array", items: { type: "object" } },
        disputed_dates_in_range: { type: "array", items: { type: "object" } },
      },
      required: ["start_date", "business_days_moved", "result_date", "result_weekday", "country", "calendar_days_elapsed", "skipped", "disputed_dates_in_range"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: async (args, memo) => {
      const country = normaliseCountry(args.country);
      const region = normaliseRegion(args.region, country);
      const start = parseDate(args.start_date, "start_date");
      const days = args.days;
      if (!Number.isInteger(days)) throw new UserError(`"days" must be a whole number (got ${JSON.stringify(args.days)}).`);
      if (Math.abs(days) > MAX_SHIFT) throw new UserError(`"days" must be between -${MAX_SHIFT} and ${MAX_SHIFT} (got ${days}).`);

      const calendar = makeCalendar(country, region);
      const step = days >= 0 ? 1 : -1;
      const skipped = [];
      let cursor = start;
      let remaining = Math.abs(days);

      while (remaining > 0) {
        cursor = shift(cursor, step);
        if (cursor.getUTCFullYear() < MIN_YEAR || cursor.getUTCFullYear() > MAX_YEAR) {
          throw new UserError(`The result falls outside the supported range ${MIN_YEAR}-${MAX_YEAR}.`);
        }
        const holiday = await calendar.holidayOn(cursor);
        if (isWeekend(cursor)) skipped.push({ date: fmt(cursor), reason: "weekend", name: WEEKDAYS[cursor.getUTCDay()] });
        else if (holiday) skipped.push({ date: fmt(cursor), reason: "public_holiday", name: holiday.name });
        else remaining -= 1;
      }

      // Flag any national-level disagreement that lands inside the traversed window.
      const lo = days >= 0 ? fmt(start) : fmt(cursor);
      const hi = days >= 0 ? fmt(cursor) : fmt(start);
      const years = new Set([start.getUTCFullYear(), cursor.getUTCFullYear()]);
      const disputed = [];
      for (const year of years) {
        const report = await agreementFor(country, year, memo);
        for (const row of report.disputed) {
          if (row.date >= lo && row.date <= hi) {
            disputed.push({ date: row.date, confirmed_by: row.confirmed_by, missing_from: row.missing_from, names: row.names });
          }
        }
      }
      disputed.sort((a, b) => a.date.localeCompare(b.date));

      const where = region ? `${country} (${region})` : country;
      const elapsed = Math.round(Math.abs(cursor.getTime() - start.getTime()) / 86400000);
      const holidaysSkipped = skipped.filter((s) => s.reason === "public_holiday");

      let text = `${Math.abs(days)} business day${Math.abs(days) === 1 ? "" : "s"} ${days >= 0 ? "after" : "before"} ${fmt(
        start
      )} in ${where} is ${fmt(cursor)} (${WEEKDAYS[cursor.getUTCDay()]}), ${elapsed} calendar day${elapsed === 1 ? "" : "s"} away.`;
      if (holidaysSkipped.length > 0) {
        text += ` Public holidays skipped: ${holidaysSkipped.map((h) => `${h.date} ${h.name}`).join("; ")}.`;
      }
      if (disputed.length > 0) {
        text += `\n\nCAUTION: ${disputed.length} date${disputed.length === 1 ? "" : "s"} in this range ${
          disputed.length === 1 ? "is" : "are"
        } disputed between sources, so the result may be off by a day: ${disputed
          .map((d) => `${d.date} (listed by ${sourceList(d.confirmed_by)}, absent from ${sourceList(d.missing_from)})`)
          .join("; ")}.`;
      }

      return {
        structured: {
          start_date: fmt(start),
          business_days_moved: days,
          result_date: fmt(cursor),
          result_weekday: WEEKDAYS[cursor.getUTCDay()],
          country,
          region,
          calendar_days_elapsed: elapsed,
          skipped,
          disputed_dates_in_range: disputed,
        },
        text,
      };
    },
  },
  {
    name: "cross_check_holidays",
    title: "Cross-check holidays across independent sources",
    description:
      "Use this when accuracy matters more than speed, or when the user questions whether a holiday date is right: contracts, payroll, settlement, compliance deadlines. Compares the national holiday list for a country and year across three independent providers and reports exactly where they agree and disagree, rather than picking one.",
    inputSchema: {
      type: "object",
      properties: {
        country: { type: "string", description: "ISO 3166-1 alpha-2 country code, for example AU, US, GB." },
        year: { type: "integer", description: `Calendar year between ${MIN_YEAR} and ${MAX_YEAR}.` },
      },
      required: ["country", "year"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        country: { type: "string" },
        year: { type: "integer" },
        sources_compared: { type: "array", items: { type: "string" } },
        sources_unavailable: { type: "array", items: { type: "object" } },
        agreed_count: { type: "integer" },
        disputed_count: { type: "integer" },
        agreed: { type: "array", items: { type: "object" } },
        disputed: { type: "array", items: { type: "object" } },
      },
      required: ["country", "year", "sources_compared", "sources_unavailable", "agreed_count", "disputed_count", "agreed", "disputed"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: async (args, memo) => {
      const country = normaliseCountry(args.country);
      const year = normaliseYear(args.year);
      const report = await agreementFor(country, year, memo);

      if (report.sources_compared.length === 0) {
        const why = report.sources_unavailable.map((s) => `${SOURCE_LABELS[s.id] || s.id}: ${s.reason}`).join("; ");
        return {
          structured: { country, year, sources_compared: [], sources_unavailable: report.sources_unavailable, agreed_count: 0, disputed_count: 0, agreed: [], disputed: [] },
          text: `No holiday source covers ${country} for ${year}. ${why}`,
        };
      }

      const lines = [
        `Cross-check for ${country} ${year}, national holidays only.`,
        `Sources compared (${report.sources_compared.length}): ${sourceList(report.sources_compared)}.`,
      ];
      if (report.sources_unavailable.length > 0) {
        lines.push(`Not compared: ${report.sources_unavailable.map((s) => `${SOURCE_LABELS[s.id] || s.id} (${s.reason})`).join("; ")}.`);
      }
      lines.push("");

      if (report.sources_compared.length === 1) {
        lines.push(`Only one source covers this country and year, so nothing could be corroborated. Treat all ${report.agreed.length} dates as unverified.`);
      } else {
        lines.push(`${report.agreed.length} date${report.agreed.length === 1 ? "" : "s"} confirmed by every source:`);
        for (const d of report.agreed) lines.push(`  ${d.date} (${weekdayOf(d.date)}) - ${Object.values(d.names)[0]}`);
        lines.push("");
        if (report.disputed.length === 0) {
          lines.push("No disagreements. Every source agrees on the full national list.");
        } else {
          lines.push(`${report.disputed.length} date${report.disputed.length === 1 ? "" : "s"} DISPUTED:`);
          for (const d of report.disputed) {
            lines.push(
              `  ${d.date} (${weekdayOf(d.date)}) - "${Object.values(d.names)[0]}" listed by ${sourceList(
                d.confirmed_by
              )}, absent from ${sourceList(d.missing_from)}`
            );
          }
          lines.push("");
          lines.push("A disputed date usually means a substitute-day rule, a regional holiday one source treats as national, or a recently declared holiday. Verify against the official government calendar.");
        }
      }

      return {
        structured: {
          country,
          year,
          sources_compared: report.sources_compared,
          sources_unavailable: report.sources_unavailable,
          agreed_count: report.agreed.length,
          disputed_count: report.disputed.length,
          agreed: report.agreed,
          disputed: report.disputed,
        },
        text: lines.join("\n"),
      };
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const publicTool = (t) => ({
  name: t.name,
  title: t.title,
  description: t.description,
  inputSchema: t.inputSchema,
  outputSchema: t.outputSchema,
  annotations: t.annotations,
});

/* ------------------------------------------------------------ jsonrpc --- */

/* ------------------------------------------------------ server export --- */

export const daysServer = {
  slug: "days",
  name: SERVER_INFO.name,
  version: SERVER_INFO.version,
  tagline:
    "Public holidays and working-day arithmetic for 200+ countries, read from three independent providers so disagreements are reported rather than hidden.",
  description:
    "Public-holiday and business-day tools for 200+ countries with state and province detail. Three independent providers are compared and their disagreements reported rather than resolved. No authentication required.",
  instructions:
    "Use these tools for any question about public holidays or working-day arithmetic. Always call a tool rather than answering from memory, because holiday dates move between years and differ by state or province. Supply the region code whenever the user names a state or province. When a result reports that sources disagree, pass that caveat on to the user rather than presenting a single confident date.",
  protocols: SUPPORTED_PROTOCOLS,
  defaultProtocol: DEFAULT_PROTOCOL,
  caveat: {
    title: "Three providers, disagreements reported not resolved",
    body: "Holiday dates move between years and differ by state or province, and no single provider is authoritative. These tools read three independent sources and tell you where they disagree instead of picking a winner, so a disputed date arrives as a caveat rather than a confident answer.",
  },
  footnote: "Holiday data is cached at the edge for 24 hours. Providers are compared by date and never by name, since the same day is named differently by each.",
  tools: TOOLS.map(publicTool),
  async run(name, args) {
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) throw new Error(`Unknown tool "${name}".`);
    // The memo is per call, so one request never reuses another's provider reads.
    const memo = new Map();
    try {
      return await tool.handler(args ?? {}, memo);
    } catch (err) {
      // Preserve the original distinction: a UserError is actionable prose, any
      // other failure means a provider could not be reached.
      throw new Error(
        err instanceof UserError
          ? err.message
          : `The holiday calendar could not be reached right now. ${err.message}`
      );
    }
  },
};
