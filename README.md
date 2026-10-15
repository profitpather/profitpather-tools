# Profitpather Tools

Open MCP servers for ecommerce operations, hosted on Cloudflare Workers at
**https://tools.profitpather.com**. No account, no API key, no sign-up.

Each server is namespaced by slug under one hostname, so adding a server is a
registry entry rather than a new domain.

| Server | Connect | Tools |
|---|---|---|
| **ShipRate AU** | `https://tools.profitpather.com/ship/mcp` | 5 |
| **Business Days** | `https://tools.profitpather.com/days/mcp` | 4 |
| **Storefront Check** | `https://tools.profitpather.com/store/mcp` | 4 |
| **US Tariff Lookup** | `https://tools.profitpather.com/duty/mcp` | 3 |

All four are published in the official MCP Registry under
`com.profitpather.tools/`.

A theme runs through all of them: each one distinguishes what it knows from what
it cannot see, and says so in the response. ShipRate refuses to rank across
currencies because the data has no exchange rate. Business Days reports provider
disagreement instead of resolving it. Storefront Check carries a
`not_observable` list on every tool. US Tariff Lookup states what its figures
exclude. A confidently wrong tool is worse than no tool.

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

## Storefront Check

Audit a public ecommerce storefront from the outside. No credentials and no
cooperation from the store, so it works on a competitor or a prospect.

- `detect_tracking_tags` - every ad and analytics tag visible in the HTML, with ids
- `check_agent_readiness` - whether AI crawlers may read the store, and whether the catalogue is machine readable
- `check_structured_data` - JSON-LD types, parse failures and commerce markup
- `audit_product_feed` - Shopify catalogue health for Merchant Center and Meta feeds

It distinguishes **present, absent and not observable** and never conflates
them. A Shopify Custom Pixel runs in a sandboxed iframe and cannot be seen from
outside, so an empty tag list is not evidence a store is untagged.

The check worth knowing about: each Google measurement id is verified against
Google Tag Manager, which answers `404` for an id it does not recognise. A dead
id means `gtag` never initialises, so a store looks correctly tagged while
recording nothing and a campaign can spend for months at zero conversions. A
consent app carrying a stale id from an old property is the usual cause, and
this failure appears nowhere else.

## US Tariff Lookup

Find the right US tariff code for a product and the duty rate that governs it,
read live from the official USITC Harmonized Tariff Schedule.

- `find_hts_code` - candidates from a plain-language product description
- `lookup_us_duty_rate` - the governing rate, with free-trade eligibility by origin
- `estimate_us_duty` - indicative duty on a customs value

Two traps it handles. **Rates sit on the 8-digit line**, while the 10-digit
statistical lines below are blank and inherit, so reading the rate off the code
you were handed looks duty-free. And **duty follows the country of origin of the
goods, not the seller's address**: `AU` appears in the special column for most
apparel, and for apparel the rules of origin are yarn-forward, so Australian
wool spun and sewn in China is Chinese origin and pays the general rate.

Making the search usable took four fixes, each found by testing real products.
The official search is an OR match returned in tariff-number order rather than
by relevance, so it is re-ranked locally with terms weighted by rarity. Consumer
words are translated to trade terms and the translation is reported, because the
schedule matches whole words: "bra" returns nothing while "brassiere" finds
heading 6212, and "leggings" returns frog legs.

Trade remedies are excluded from every figure and said to be. Section 301,
Section 232, antidumping and countervailing duties all sit in Chapter 99, stack
on top, and routinely exceed the base rate. Chapter 98 and 99 lines are returned
in a separate list so a conditional `Free` rate cannot be read as the answer.

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
npx wrangler deploy     # needs CLOUDFLARE_ACCOUNT_ID in .env
```

The Cloudflare account id is deliberately not in `wrangler.jsonc`. Put it in a
gitignored `.env` as `CLOUDFLARE_ACCOUNT_ID=...`; wrangler reads it from there.
Without it, a deploy fails on any login with more than one account available.

`node --check` is not a sufficient gate: it accepts code that esbuild rejects.
Use `npx wrangler deploy --dry-run --outdir /tmp/out` instead.

## Limits

Rates are indicative. International prices exclude destination duty and tax.
Holiday data is cached at the edge for 24 hours. Nothing here is advice, and for
anything that costs money the carrier's own contract and the official government
calendar govern.
