# Ecosine Auction Intelligence

Daily automated screen over Al Qaryah auction inventory. Identifies lots Ecosine
Transport can buy for its fleet, prices each one, and emails purchasing a ranked
list with a firm bid ceiling.

Built to `SPEC.md` v1.1. **Al Qaryah only** — no source abstraction, no adapter
registry, no hooks for a second site (§10).

```
sitemap ──▶ pre-gate ──▶ fetch ──▶ gate ──▶ vision ──▶ score ──▶ digest
  (XML)      (free)     (browser)  (free)   (paid)     (free)    (SMTP)
                                                │
                                                ▼
                                            watchlist ──▶ watcher
```

Cost ordering is the design principle: every stage is cheaper than the one after
it and eliminates as much volume as it can. Vision is the only paid step and
never sees a lot a free check could have killed.

---

## Runbook

```bash
npm install
npx playwright install chromium
cp .env.example .env          # ARK_API_KEY + SMTP

npm run calibrate             # §11 step 1 — do this FIRST
npm run login                 # one-time, interactive, own credentials
npm run run                   # daily screen
npm run watch                 # during a live auction
```

Cron, 06:00 Gulf:

```
0 6 * * * cd /opt/ecosine-auction-agent && /usr/bin/npm run run >> logs/run.log 2>&1
```

### Development

| Command | What it does |
|---|---|
| `npm run verify` | The §12 acceptance criteria, executable. No network, no browser. |
| `npm run preview` | Renders the digest to `preview/` with sample data — no SMTP, no network. |
| `npm run check:responsive` | Renders the digest in Chromium at 320–700px and asserts no horizontal overflow. |
| `npm run typecheck` | `tsc --noEmit`. |

---

## Start with calibration

`npm run calibrate` walks the full sitemap with gates on, vision off and no
email, then reports total lots, survivors after the year gate, survivors after
the target-model gate, and the share with `clean_title: true`. It also prints
which target make/models actually appear and whether `FLEET_READY_VALUES` covers
their years.

**This determines whether the rest is worth running.** If clean-title inventory
in the target models is negligible, stop and revisit §10 rather than relaxing a
gate to increase the count.

---

## The parts that are load-bearing

**Registrability is a hard gate, not a scoring input.** A written-off car is
worth zero to Ecosine at any price — not "worth less". `clean_title === false`
rejects outright; `TITLE_KILL_PATTERNS` is a narration safety net that can only
ever reject, never promote.

**Silence is never a pass.** An absent `clean_title` surfaces the lot as
`UNVERIFIED` for physical inspection. It is not quietly treated as clean.

**Every request to Al Qaryah goes through the browser.** Plain `fetch` from a
datacenter IP is served a Cloudflare challenge, and a challenge is a 200 with no
`<loc>` in it — so a naive sitemap read turns a block into "nothing listed
today". Sitemap XML, detail pages and lot photos all go through one Chromium
context, which is why the browser opens before the sitemap walk and closes after
the vision stage. `npm run preflight` walks that whole path for real, ending at
one lot's photo bytes, and its sitemap check is gating.

**Unobserved data is a gap, not an omission.** A watchlist lot the watcher fails
to price is written to `bid_observation` with `amount = NULL` and a populated
`gap_reason`. Capture failures cluster during the busy, fast stretches of an
auction, and those stretches are not randomly distributed with respect to price
— silently dropping them produces a clean-looking dataset that misrepresents the
market. `captureReport()` is the system health metric.

**`fleetReadyValue()` returning `null` is correct behaviour.** Exact make +
model + year only: no interpolation, no nearest-year fallback, no averaging
across models. A lot with no defensible valuation goes to `INSPECT` with no
ceiling. A fabricated valuation carried into a live auction costs more than a
missing one.

**`startingBid` is a floor, never a sale price.** Hammer prices are not exposed
anonymously and are never inferred, estimated or synthesised.

**`assessment` is append-only** and carries `config_version`, so any past
decision can be reconstructed exactly. **VIN is the dedup key for relistings** —
an unsold lot returning to a later auction is the same car and appends an
assessment rather than duplicating inventory.

---

## The vision stage

Damage assessment runs on **BytePlus ModelArk** (`seed-2-0-pro-260328`) by
default. It is the only per-lot cost in the pipeline, and what it is asked for
is bounded and well specified — a tier, three flags, a repair range and a
confidence — so it runs on the cheaper capable model rather than a frontier one.
Set `VISION_PROVIDER=anthropic` to run the identical prompt and schema through
Claude instead; that is worth paying for on a calibration run you intend to
grade ModelArk against, not on a daily screen.

`DamageAssessment` in `src/vision.ts` is the single definition of what an
assessment is. ModelArk receives it as a strict JSON schema, Anthropic as a
structured-output format, and **both replies are validated against it** before
any number reaches scoring. A provider that answers off-schema raises an error;
it is never coerced into a usable-looking assessment.

**Photos are inlined, not linked.** ModelArk will fetch an image URL from its
own egress, but Al Qaryah's images sit behind the same Cloudflare tenancy that
already refuses this container's plain `fetch` — a stranger's datacenter IP will
score no better than ours. So the bytes are pulled here, through the browser
context that already holds the clearance cookie, and sent as base64. That is
also why the browser stays open through the vision stage rather than closing
after the render. When some photos fail to load, the prompt says how many are
missing so the model lowers its own confidence rather than assessing a thin set
as though it were complete.

---

## The digest

Single HTML email, sorted by **auction close time ascending, never by margin** —
purchasing needs to know what they lose today. Two sections: `BID` (ceiling is
firm) and `INSPECT` (title unconfirmed, low vision confidence, or no defensible
valuation). Repair figures are always a range. It sends even when empty, so
silence is never mistaken for a healthy run.

Brand per §9: Navy `#0B1A2E`, Gold `#C9A84C`, Georgia headings, Calibri body.
`src/digest/theme.ts` derives everything else from those four so the palette
stays coherent.

### The ledger bar

Each priced lot carries a stacked bar whose four segments sum to fleet-ready
value by construction:

```
value = bid×(1+fee)(1+VAT) + repair + compliance + margin
```

It is the §7 arithmetic drawn, not a decoration of it — which is why the
segments are labelled with their actual AED figures.

### Motion

Row reveals, ledger-bar builds, tier-pip pops, a single pass of light along the
masthead rule, and a three-beat pulse on `CLOSING`. Hover adds a card lift and a
gold underline that draws in from the left.

**One rule governs all of it: no element is ever hidden by a plain CSS rule.**
Every "from" state — `opacity: 0`, `scaleX(0)`, `blur()` — lives *only* inside
an `@keyframes` block. Mail clients strip CSS unevenly, and a client that keeps
`opacity: 0` but drops the keyframes that would animate it back renders an
invisible email. Under this rule the worst case is an `animation` property
naming a rule that does not exist, which is a no-op. The static page is always
the finished page.

Everything is additionally wrapped in `prefers-reduced-motion: no-preference`,
so a reader who has asked for stillness gets the finished state immediately
rather than a faster version of the same movement.

`npm run verify` asserts both properties structurally against the rendered HTML,
rather than trusting the convention.

Apple Mail, iOS Mail, Outlook for Mac, Samsung Mail and Thunderbird animate.
Gmail and Outlook for Windows show the finished static composition. Both are
intended outcomes. Dark mode and the 320px-up responsive layout are likewise
progressive: `npm run check:responsive` proves the reflow in a real browser,
because that failure mode is invisible to a full-page screenshot.

---

## Still to build

Ordered, from §11:

1. ~~Calibration crawl~~ — `npm run calibrate`
2. **`FLEET_READY_VALUES`** — seeded with a starting table in `config.ts`.
   Extend it to whatever calibration shows actually appears. Nothing produces a
   bid ceiling until an entry exists. Reviewed quarterly by purchasing; entries
   older than 90 days raise a staleness warning in the digest footer.
3. ~~Field normalisation at the fetch boundary~~ — `src/normalise.ts`
4. ~~VIN relisting dedup~~ — `src/db.ts`
5. **Socket frame schema** — `src/auctionroom.ts` joins
   `/auction-join?id=…&lane=…` with the saved bidder session and reads prices off
   the room's websocket, but the frame shape is inferred by key name rather than
   known. A price is only recorded when the frame names it as a bid or a sale;
   anything else is gap-flagged carrying the candidate. Run one authenticated
   capture during a live auction with `DUMP_FRAMES=1`, which writes every frame
   to `logs/socket-frames.jsonl`, then replace the heuristic with an exact parse.
6. **Wire to the ARKS UAE market comps step** once (2) is proven in production.

---

## Non-goals

No automated bidding. No sale-price inference. No DOM scraping. No credential
storage. No listing-page crawling. No second source. No synthesised valuations.

---

## Housekeeping

`robots.txt` permits the paths used; terms of service are a separate document
and should be reviewed.

With a single source, the case for a sanctioned integration gets stronger rather
than weaker. Ecosine is a registered trade buyer, and requesting direct API
access or a post-sale results feed from Al Qaryah would remove the Cloudflare
dependency, the session management and most of §8 entirely — one relationship to
negotiate, one integration to maintain. Worth making that call before hardening
the watcher.

Note also that the API returns the full VIN while the UI masks it. That is
presumably unintentional and is a further reason to move to a sanctioned
integration rather than depend on current behaviour.
