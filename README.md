# Profitpather Tools

Open MCP servers for ecommerce operations, hosted on Cloudflare Workers at
**https://tools.profitpather.com**. No account, no API key, no sign-up.

Each server is namespaced by slug under one hostname, so adding a server is a
registry entry rather than a new domain.

| Server | Connect | Tools |
|---|---|---|
| **ShipRate AU** | `https://tools.profitpather.com/ship/mcp` | 5 |
| **Business Days** | `https://tools.profitpather.com/days/mcp` | 4 |

Published in the official MCP Registry as `com.profitpather.tools/shiprate-au`
and `com.profitpather.tools/business-days`.

## ShipRate AU

Australian parcel shipping, quoted from two independent sources in one call.

- `quote_domestic_au` - domestic rates from both sources
- `quote_international_from_au` - outbound international rates
- `lookup_au_postcode` - postcode to suburb and state, or the reverse
- `calculate_cubic_weight` - the weight you will actually be billed on
- `list_goods_categories` - the fixed category enum the commercial source accepts

**The two sources are not interchangeable, and the server never pretends they
are.** Australia Post prices come from the PAC API and are *retail*: a business
on an eParcel or contract account pays materially less. The commercial panel is
pre-negotiated pricing, a different class entirely. Every rate carries a
`pricing_basis` saying which it is, so a lower number is never mistaken for a
better carrier.

Two further rules the server holds to:

- **It will not rank across currencies.** The upstream data carries no exchange
  rate, so when more than one currency comes back the list is deliberately left
  unsorted and `sorted_by_price` is `false`. Nothing is summed either.
- **A source that quoted nothing is reported, not hidden.** `source_notes`
  always says what was missing and why, so an empty list is never silently
  presented as "no options exist".

`calculate_cubic_weight` exists because carriers bill on whichever is greater,
actual or volumetric weight. A 60x40x40cm parcel weighing 2kg is billed as 24kg
under the Australia Post domestic convention. It returns every common divisor
with the arithmetic shown, and states its assumptions rather than implying one
number is authoritative.

## Business Days

Public holidays and working-day arithmetic for 200+ countries, including state
and province subdivisions.

- `list_public_holidays` - holidays in a country or region for a year
- `check_business_day` - is this date a working day, and what blocks it
- `add_business_days` - move N working days, skipping weekends and holidays
- `cross_check_holidays` - compare the national list across all providers

A language model's failure mode on calendar questions is confident wrongness,
and a tool that is *also* confidently wrong adds nothing. So holiday data is
read from three independent providers and **disagreements are reported rather
than resolved**:

| Source | Coverage |
|---|---|
| Nager.Date | 204 countries, the only one with ISO 3166-2 codes everywhere |
| Google Calendar ICS | 36 countries, data from timeanddate.com |
| OpenHolidays | 36 countries, official government calendars |

Providers are compared **by date, never by name**, since the same day is named
differently by each. A disputed date arrives as a caveat attached to the answer,
not as a confident single date.

## Discovery

A directory can describe either server without connecting as a client:

```
GET https://tools.profitpather.com/.well-known/agent-skills/index.json
GET https://tools.profitpather.com/ship/.well-known/agent-skills/index.json
GET https://tools.profitpather.com/days/.well-known/agent-skills/index.json
```

The hub document inlines every skill on every server, so a crawler that reads
only the root still comes away with the full tool list rather than needing a
second fetch it may never make.

## Transport

Streamable HTTP, JSON-RPC 2.0 over `POST`. The servers answer with
`application/json` and offer no SSE stream, so `GET` on an endpoint returns
`405` with `Allow: POST, OPTIONS`. Notifications get `202` and no body.

Responses to `tools/call` are cached for 12 hours on a key covering the server,
tool name and every argument, so repeating a request costs the upstream APIs
nothing. There is also a crude per-IP, per-minute brake; the cache is what
really protects the upstream quotas.

## Running it

```bash
npm install
npx wrangler dev        # needs AUSPOST_KEY and EASYSHIP_KEY in .dev.vars
npx wrangler deploy
```

`node --check` is not a sufficient gate: it accepts code that esbuild rejects.
Use `npx wrangler deploy --dry-run --outdir /tmp/out` instead.

## Limits

Rates are indicative. International prices exclude destination duty and tax.
Holiday data is cached at the edge for 24 hours. Nothing here is advice, and for
anything that costs money the carrier's own contract and the official government
calendar govern.
