/**
 * verify.ts — the §12 acceptance criteria, executable.
 *
 *   npm run verify
 *
 * Deliberately dependency-free: node:assert and the real modules, no test
 * framework. Every check below maps to a numbered line in the spec, including
 * the ones about what must NOT happen.
 */
import assert from 'node:assert/strict';
import { auctionRoomUrl, decodeFrame, extractObservations } from './auctionroom.js';
import {
  ANTHROPIC_VISION_MODEL,
  ARK_VISION_MODEL,
  BROWSER_LAUNCH_ARGS,
  CONFIG_VERSION,
  MAX_RENDERS_PER_RUN,
  MIN_MODEL_YEAR,
  VISION_MODEL,
  VISION_PROVIDER,
} from './config.js';
import { renderDigest } from './digest.js';
import { MOTION_CSS, stagger } from './digest/motion.js';
import { gate, preGate } from './gates.js';
import { coerceYear, normalise, normaliseDamage, toKm } from './normalise.js';
import { sniffMime } from './photos.js';
import { httpXmlReader, modelKey, parseDetailUrl, walkSitemap } from './sitemap.js';
import { computeMaxBid, fleetReadyValue, score } from './scoring.js';
import type { DigestLot, DigestModel, GateResult, LotRef, VehiclePayload, VisionResult } from './types.js';
import * as ui from './ui.js';
import { arkJsonSchema, assess, DamageAssessment, VisionError } from './vision.js';

let passed = 0;
const failures: string[] = [];
/** Async checks are awaited before the report; a rejected one must not slip past. */
const pending: Promise<void>[] = [];

function check(name: string, fn: () => void | Promise<void>): void {
  const pass = (): void => {
    passed += 1;
    ui.note(`${ui.c.good('✓')} ${name}`);
  };
  const fail = (err: unknown): void => {
    failures.push(`${name}: ${(err as Error).message}`);
    ui.note(`${ui.c.bad('✕')} ${name} — ${(err as Error).message}`);
  };
  try {
    const result = fn();
    if (result instanceof Promise) pending.push(result.then(pass, fail));
    else pass();
  } catch (err) {
    fail(err);
  }
}

// ── fixtures ───────────────────────────────────────────────────────────────

const REF: LotRef = {
  id: '695bd4635ef41f04b3555439',
  url: 'https://www.alqaryahauction.com/vehicle-details/toyota/camry/2025-695bd4635ef41f04b3555439',
  make: 'toyota',
  model: 'camry',
  year: 2025,
  key: 'toyota|camry',
};

/** The confirmed payload from §2.4, retargeted onto a TARGET_MODELS entry. */
function payload(overrides: Partial<VehiclePayload> = {}): VehiclePayload {
  return {
    _id: REF.id,
    lotNo: 192_211,
    vin: 'WBA23GG01S7T64711',
    year: '2025',
    make: 'Toyota',
    model: 'Camry',
    carDescription: '2025 Toyota Camry LE',
    clean_title: true,
    primaryDamage: 'RIGHT FRONT',
    secondaryDamage: '-',
    startCode: { title: 'Run & Drive', code: 'R & D', description: 'Vehicle starts and drives' },
    milage: 9916,
    mileageUnit: 'mi',
    startingBid: 28_500,
    auctionVehicleStatus: 'sold',
    auctionId: '69e768732a1aec4814c3ba5e',
    lane: 'lane-a',
    ...overrides,
  };
}

const VISION_CLEAN: VisionResult = {
  tier: 2,
  structural: false,
  floodIndicators: false,
  airbagsDeployed: false,
  repairLowAed: 9_400,
  repairMidAed: 10_800,
  repairHighAed: 12_000,
  confidence: 0.82,
  notes: 'panel work only',
  photosUsed: 6,
};

// ── §7 economics ───────────────────────────────────────────────────────────

ui.banner('Acceptance criteria', '§12 — executable');

check('§7 worked example: 85,000 value, tier 2, repair high 12,000 → max_bid 39,900', () => {
  assert.equal(computeMaxBid(85_000, 12_000), 39_900);
});

check('§7 ceiling is solved for, not subtracted (fee and VAT compound on hammer)', () => {
  // 44,050 net ÷ 1.1025 = 39,954 → floor to 100.
  const net = 85_000 - 12_000 - 3_000 - 6_500 - 750 - 85_000 * 0.22;
  assert.equal(net, 44_050);
  assert.equal(Math.floor(net / 1.1025 / 100) * 100, 39_900);
});

check('§7 max_bid rounds DOWN to the nearest 100, never up', () => {
  const bid = computeMaxBid(85_000, 12_000);
  assert.equal(bid % 100, 0);
  assert.ok(bid <= 44_050 / 1.1025);
});

// ── §7.1 fleetReadyValue ───────────────────────────────────────────────────

check('§12 fleetReadyValue never interpolates, averages, or falls back to a nearby year', () => {
  assert.ok(fleetReadyValue('toyota|camry', 2025), 'exact match should resolve');
  assert.equal(fleetReadyValue('toyota|camry', 2023), null, 'year below table must not fall back');
  assert.equal(fleetReadyValue('toyota|camry', 2027), null, 'year above table must not fall back');
  assert.equal(fleetReadyValue('toyota|corolla-hybrid', 2025), null, 'near-miss model must not resolve');
  assert.equal(fleetReadyValue('toyota|camry', null), null, 'unknown year returns null');
});

check('§13 a lot with no valuation gets INSPECT and no ceiling — never a synthesised one', () => {
  const v = normalise(payload({ make: 'Kia', model: 'Carnival' }), { ...REF, key: 'kia|carnival' });
  const s = score(v, { verdict: 'pass', titleStatus: 'clean', reason: 'gates passed' }, VISION_CLEAN);
  assert.equal(s.action, 'INSPECT');
  assert.equal(s.maxBid, null);
  assert.equal(s.fleetReadyValue, null);
});

// ── §6.4 gate order and verdicts ───────────────────────────────────────────

check('§6.4 clean_title: false → REJECT (salvage)', () => {
  const g = gate(normalise(payload({ clean_title: false }), REF));
  assert.equal(g.verdict, 'reject');
  assert.equal(g.titleStatus, 'salvage');
  assert.match(g.reason, /clean_title = false/);
});

check('§6.4 clean_title: true → PASS', () => {
  const g = gate(normalise(payload(), REF));
  assert.equal(g.verdict, 'pass');
  assert.equal(g.reason, 'gates passed');
});

check('§6.4 clean_title: true, not Run & Drive → UNVERIFIED', () => {
  const g = gate(
    normalise(payload({ startCode: { title: 'Engine Start Program', code: 'ESP' } }), REF),
  );
  assert.equal(g.verdict, 'unverified');
  assert.match(g.reason, /not run & drive/);
});

check('§6.4 clean_title field absent → UNVERIFIED, never promoted to clean (§1.3)', () => {
  const p = payload();
  delete p.clean_title;
  const g = gate(normalise(p, REF));
  assert.equal(g.verdict, 'unverified');
  assert.equal(g.titleStatus, 'unknown');
  assert.match(g.reason, /absent/);
});

check('§6.4 the year gate runs before the title gate', () => {
  const g = gate(normalise(payload({ year: '2019', clean_title: false }), { ...REF, year: 2019 }));
  assert.equal(g.verdict, 'reject');
  assert.match(g.reason, /MIN_MODEL_YEAR/, 'year must be the reported reason, not the title');
});

check('§6.4 step 4 title-kill patterns catch narration that contradicts the structured field', () => {
  const g = gate(normalise(payload({ inventoryRemarks: 'Flood damaged, water to dash' }), REF));
  assert.equal(g.verdict, 'reject');
  assert.equal(g.titleStatus, 'salvage');
});

check('§1.1 a rejected lot is worth zero, not "worth less" — no ceiling is computed', () => {
  const v = normalise(payload({ clean_title: false }), REF);
  const s = score(v, gate(v), VISION_CLEAN);
  assert.equal(s.action, 'DROP');
  assert.equal(s.maxBid, null);
});

// ── §7.2 auto-drop ─────────────────────────────────────────────────────────

for (const [label, patch] of [
  ['structural', { structural: true }],
  ['floodIndicators', { floodIndicators: true }],
  ['tier > MAX_DAMAGE_TIER', { tier: 5 as const }],
] as const) {
  check(`§7.2 ${label} auto-drops regardless of price`, () => {
    const v = normalise(payload(), REF);
    const s = score(v, gate(v), { ...VISION_CLEAN, ...patch });
    assert.equal(s.action, 'DROP');
    assert.equal(s.maxBid, null);
  });
}

// ── §11 step 3 normalisation ───────────────────────────────────────────────

check('§11.3 year arrives as a string and is coerced to a number', () => {
  assert.equal(coerceYear('2025'), 2025);
  assert.equal(normalise(payload(), REF).year, 2025);
  assert.equal(coerceYear('not a year'), null);
});

check('§11.3 mileageUnit "mi" is normalised to km', () => {
  assert.equal(toKm(9916, 'mi'), 15_958); // 9916 × 1.609344 = 15958.26
  assert.equal(toKm(9916, 'km'), 9_916);
  assert.equal(toKm(9916, undefined), 9_916, 'no unit means the value is already km');
  assert.equal(normalise(payload(), REF).mileageKm, 15_958);
});

check('§11.3 secondaryDamage of "-" means none and is stored as null', () => {
  assert.equal(normaliseDamage('-'), null);
  assert.equal(normaliseDamage('n/a'), null);
  assert.equal(normaliseDamage('Left side'), 'Left side');
  assert.equal(normalise(payload(), REF).secondaryDamage, null);
});

check('§14 the API returns a full VIN; it is captured, not the UI-masked form', () => {
  assert.equal(normalise(payload(), REF).vin, 'WBA23GG01S7T64711');
});

// ── §2.2 URL parsing ───────────────────────────────────────────────────────

check('§2.2 detail URLs parse to make, model, year and 24-hex ObjectId', () => {
  const parsed = parseDetailUrl(REF.url);
  assert.ok(parsed);
  assert.equal(parsed.id, '695bd4635ef41f04b3555439');
  assert.equal(parsed.year, 2025);
  assert.equal(parsed.key, 'toyota|camry');
});

check('§2.2 non-vehicle and malformed URLs are rejected, not coerced', () => {
  assert.equal(parseDetailUrl('https://www.alqaryahauction.com/auctions'), null);
  assert.equal(parseDetailUrl('https://www.alqaryahauction.com/vehicle-details/toyota/camry/2025-abc'), null);
  assert.equal(parseDetailUrl('not a url'), null);
});

check('§2.2 model keys normalise punctuation consistently', () => {
  assert.equal(modelKey('Mercedes-Benz', 'C-Class'), 'mercedes-benz|c-class');
  assert.equal(modelKey('TOYOTA', 'Land Cruiser'), 'toyota|land-cruiser');
});

// ── §6.2 pre-gate ──────────────────────────────────────────────────────────

check('§6.2 pre-gate rejects on year and model before any browser work', () => {
  assert.equal(preGate(REF), true);
  assert.equal(preGate({ ...REF, year: MIN_MODEL_YEAR - 1 }), false);
  assert.equal(preGate({ ...REF, key: 'ferrari|488' }), false);
});

// ── §12 digest guarantees ──────────────────────────────────────────────────

function digestModel(lots: DigestLot[]): DigestModel {
  return {
    generatedAt: new Date('2026-07-31T06:00:00Z'),
    auctionTitle: 'Onsite & Online Auction (Friday)',
    bid: lots.filter((l) => l.score.action === 'BID'),
    inspect: lots.filter((l) => l.score.action === 'INSPECT'),
    funnel: {
      sitemapTotal: 4912,
      afterYearGate: 1208,
      afterModelGate: 214,
      rendered: 96,
      gatePassed: 12,
      gateUnverified: 9,
      gateRejected: 61,
      visionCalls: 21,
      cleanTitleShare: 0.36,
    },
    stalenessWarnings: [],
    captureRate: 0.82,
    configVersion: 'testcfg',
    runDurationMs: 1000,
  };
}

function sampleLot(gateResult: GateResult, vision: VisionResult | null): DigestLot {
  const v = normalise(payload(), REF);
  return {
    id: v.id,
    url: v.url,
    lotNo: v.lotNo,
    title: '2025 Toyota Camry LE',
    year: v.year,
    mileageKm: v.mileageKm,
    primaryDamage: v.primaryDamage,
    secondaryDamage: v.secondaryDamage,
    startCodeTitle: v.startCode?.title ?? null,
    titleStatus: gateResult.titleStatus,
    gate: gateResult.verdict,
    vision,
    score: score(v, gateResult, vision),
    lane: v.lane,
    closesAt: new Date('2026-07-31T13:45:00Z'),
    isNew: true,
    photo: null,
  };
}

const CLEAN_GATE: GateResult = { verdict: 'pass', titleStatus: 'clean', reason: 'gates passed' };

check('§12 the digest sends on an empty result set', () => {
  const r = renderDigest(digestModel([]));
  assert.match(r.html, /No lot cleared the gates today/);
  assert.match(r.subject, /no qualifying lots/);
  assert.ok(r.text.length > 0, 'plain-text alternative must exist');
});

check('§12 every digest lot with a max_bid has a non-null fleet_ready_value', () => {
  const lot = sampleLot(CLEAN_GATE, VISION_CLEAN);
  const r = renderDigest(digestModel([lot]));
  for (const l of [...digestModel([lot]).bid, ...digestModel([lot]).inspect]) {
    if (l.score.maxBid !== null) assert.notEqual(l.score.fleetReadyValue, null);
  }
  assert.match(r.html, /Max bid/);
});

check('§12 startingBid is never presented as a sale price', () => {
  const lot = sampleLot(CLEAN_GATE, VISION_CLEAN);
  const r = renderDigest(digestModel([lot]));
  assert.ok(!r.html.includes('28,500'), 'the 28,500 floor must not appear in the digest');
  assert.ok(!r.text.includes('28,500'));
  assert.ok(!('startingBid' in lot.score), 'ScoreResult must not carry a starting bid');
});

check('§9 repair figures are presented as a range, never a point estimate', () => {
  const r = renderDigest(digestModel([sampleLot(CLEAN_GATE, VISION_CLEAN)]));
  assert.match(r.html, /9,400\s*–\s*12,000/);
  assert.ok(!/Est\. repair range<\/div>\s*<div[^>]*>10,800/.test(r.html), 'the mid value must not stand alone');
});

check('§9 both sections carry their labels and the brand colours are present', () => {
  const r = renderDigest(digestModel([sampleLot(CLEAN_GATE, VISION_CLEAN)]));
  assert.ok(r.html.includes('#0B1A2E'), 'navy');
  assert.ok(r.html.includes('#C9A84C'), 'gold');
  assert.match(r.html, /Georgia/);
  assert.match(r.html, /Calibri/);
});

check('§9 lots are sorted by close time ascending, not by margin', () => {
  const early = sampleLot(CLEAN_GATE, VISION_CLEAN);
  early.closesAt = new Date('2026-07-31T09:00:00Z');
  early.title = 'EARLY CLOSE';
  const late = sampleLot(CLEAN_GATE, { ...VISION_CLEAN, repairLowAed: 1, repairMidAed: 1, repairHighAed: 1 });
  late.id = 'later';
  late.closesAt = new Date('2026-07-31T20:00:00Z');
  late.title = 'LATE CLOSE';
  // `late` has the fatter margin; close time must still win.
  const r = renderDigest(digestModel([late, early]));
  assert.ok(r.html.indexOf('EARLY CLOSE') < r.html.indexOf('LATE CLOSE'));
});

// ── microanimation invariants ──────────────────────────────────────────────

/**
 * The rule from motion.ts: no element is ever hidden by a plain CSS rule. Every
 * "from" state lives only inside @keyframes, so a client that strips keyframes
 * still renders the finished page. This asserts it structurally rather than
 * trusting the convention.
 */
function stripKeyframes(css: string): string {
  return css.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\}\s*)*\}/g, '');
}

check('motion: no hiding declaration exists outside @keyframes', () => {
  const outside = stripKeyframes(MOTION_CSS);
  assert.ok(!/opacity\s*:\s*0\b/.test(outside), 'opacity:0 outside keyframes would blank a stripping client');
  assert.ok(!/scaleX\(0\)/.test(outside));
  assert.ok(!/blur\(\s*[1-9]/.test(outside));
});

check('motion: the rendered email hides nothing except the preheader', () => {
  const html = renderDigest(digestModel([sampleLot(CLEAN_GATE, VISION_CLEAN)])).html;
  const outside = stripKeyframes(html);
  const hits = outside.match(/opacity\s*:\s*0\b/g) ?? [];
  assert.equal(hits.length, 1, `expected only the preheader to be hidden, found ${hits.length}`);
  // And that one is hidden by display:none anyway — the opacity is belt-and-braces
  // for clients that ignore it, not the mechanism anything depends on.
  const idx = outside.search(/opacity\s*:\s*0\b/);
  const window = outside.slice(Math.max(0, idx - 200), idx + 200);
  assert.ok(window.includes('display:none'), 'the one hit must be the preheader');
  assert.ok(window.includes('mso-hide:all'), 'the preheader must also be hidden from Outlook');
});

check('motion: every animation is guarded by prefers-reduced-motion', () => {
  const guardStart = MOTION_CSS.indexOf('@media (prefers-reduced-motion: no-preference)');
  assert.ok(guardStart >= 0, 'the reduced-motion guard must exist');
  const names = [...MOTION_CSS.matchAll(/@keyframes\s+(\w+)/g)].map((m) => m[1]);
  assert.ok(names.length >= 5, 'expected the full keyframe set');
  for (const n of names) {
    assert.ok(
      MOTION_CSS.indexOf(`@keyframes ${n}`) > guardStart,
      `@keyframes ${n} must sit inside the reduced-motion guard`,
    );
  }
});

check('motion: stagger is sublinear and capped so long digests still land quickly', () => {
  assert.ok(stagger(0) < stagger(5));
  assert.ok(stagger(5) < stagger(20));
  assert.equal(stagger(200), stagger(400), 'delay must plateau');
  assert.ok(stagger(400) <= 700, 'the last row must not wait most of a second');
});

check('digest HTML is self-contained: no external CSS, JS or webfonts', () => {
  const html = renderDigest(digestModel([sampleLot(CLEAN_GATE, VISION_CLEAN)])).html;
  assert.ok(!/<script/i.test(html), 'no script tags — every mail client strips them');
  assert.ok(!/<link\b/i.test(html), 'no external stylesheets');
  assert.ok(!/@import/i.test(html), 'no font imports');
});

// ── §8.3 auction-room capture ──────────────────────────────────────────────

check('§8.3 socket envelopes decode (raw JSON and socket.io prefixed)', () => {
  assert.deepEqual(decodeFrame('{"a":1}'), { a: 1 });
  assert.deepEqual(decodeFrame('42[\"bid\",{\"lotNo\":5}]'), ['bid', { lotNo: 5 }]);
  assert.equal(decodeFrame('ping'), null);
  assert.equal(decodeFrame('2probe'), null);
});

check('§8.3 a named final price beside a lot number is extracted confidently', () => {
  const [o] = extractObservations({ event: 'sold', data: { lotNo: 192211, hammerPrice: 41500, status: 'sold' } });
  assert.ok(o);
  assert.equal(o.lotNo, 192211);
  assert.equal(o.amount, 41500);
  assert.equal(o.status, 'sold');
  assert.equal(o.confident, true);
});

check('§8.3 a running bid is extracted confidently', () => {
  const [o] = extractObservations({ lotNo: 7, currentBid: '38,500' });
  assert.equal(o?.amount, 38_500, 'thousands separators must not defeat the parse');
  assert.equal(o?.confident, true);
});

check('§8.3 a bare "amount" is captured but flagged unconfirmed, never trusted', () => {
  const [o] = extractObservations({ lotNo: 9, amount: 1234 });
  assert.equal(o?.amount, 1234);
  assert.equal(o?.confident, false, 'an ambiguous field must not be recorded as money');
});

check('§8.3 a price with no lot identifier is ignored', () => {
  assert.equal(extractObservations({ hammerPrice: 50_000 }).length, 0);
});

check('§8.3 nested envelopes are walked', () => {
  const found = extractObservations({ t: 'update', payload: { lanes: [{ lots: [{ lotNo: 1, currentBid: 100 }] }] } });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.lotNo, 1);
});

check('§8.3 the room URL is built for the lane', () => {
  assert.equal(
    auctionRoomUrl('6a673203222e2dd50395dcfd', 'lane-a'),
    'https://alqaryahauction.com/auction-join?id=6a673203222e2dd50395dcfd&lane=lane-a',
  );
});

// ── the Cloudflare path (§2.1) ─────────────────────────────────────────────

check('§2.1 the sitemap walk reads through the injected reader, not plain fetch', async () => {
  const asked: string[] = [];
  const lots = await walkSitemap({
    readXml: async (url) => {
      asked.push(url);
      return url.includes('vehicle') ? `<urlset><url><loc>${REF.url}</loc></url></urlset>` : null;
    },
  });
  assert.ok(asked.length > 0, 'the injected reader must be the only way out');
  assert.equal(lots.length, 1);
  assert.equal(lots[0]?.key, 'toyota|camry');
});

check('§2.1 a Cloudflare challenge is not read as an empty auction', async () => {
  // The whole trap: a challenge is a 200 with no <loc>, so a naive reader turns
  // a block into "nothing listed today". The reader must return null instead,
  // which is what makes the run say "block" rather than "quiet day".
  const challenge = '<html><title>Attention Required! | Cloudflare</title>Ray ID: 8f2c</html>';
  const asData = `data:text/html;base64,${Buffer.from(challenge).toString('base64')}`;
  assert.equal(await httpXmlReader(asData), null, 'a 200 challenge body is not a sitemap');

  const real = '<urlset><url><loc>https://www.alqaryahauction.com/sitemaps/vehicle/1.xml</loc></url></urlset>';
  assert.equal(
    await httpXmlReader(`data:application/xml;base64,${Buffer.from(real).toString('base64')}`),
    real,
    'and a genuine document still comes through',
  );
});

check('§2.1 Chromium is launched with the flags a root container requires', () => {
  // The image runs as root; without this Chromium refuses to start, and it fails
  // nowhere but in production.
  assert.ok(BROWSER_LAUNCH_ARGS.includes('--no-sandbox'));
  assert.ok(BROWSER_LAUNCH_ARGS.includes('--disable-dev-shm-usage'));
});

// ── vision provider (§6.5) ─────────────────────────────────────────────────

check('§6.5 the ModelArk schema is strict: every field required, nothing extra', () => {
  const s = arkJsonSchema() as { required?: string[]; additionalProperties?: boolean; properties?: object };
  const props = Object.keys(s.properties ?? {});
  assert.equal(s.additionalProperties, false, 'a provider must not invent fields');
  assert.deepEqual([...(s.required ?? [])].sort(), props.sort(), 'every field is required');
  assert.ok(props.includes('tier') && props.includes('repairHighAed') && props.includes('confidence'));
});

check('§6.5 the JSON schema carries no $schema — ModelArk strict mode rejects the dialect line', () => {
  assert.ok(!('$schema' in arkJsonSchema()));
});

check('§6.5 both providers are held to the same assessment shape', () => {
  const wellFormed = {
    tier: 3,
    structural: true,
    floodIndicators: false,
    airbagsDeployed: true,
    repairLowAed: 100,
    repairMidAed: 200,
    repairHighAed: 300,
    confidence: 0.8,
    notes: 'x',
  };
  assert.ok(DamageAssessment.safeParse(wellFormed).success);
  // The failure that matters: a plausible-looking reply that is out of range.
  assert.ok(!DamageAssessment.safeParse({ ...wellFormed, tier: 7 }).success, 'tier 7 is not an assessment');
  assert.ok(!DamageAssessment.safeParse({ ...wellFormed, confidence: 1.4 }).success);
  assert.ok(!DamageAssessment.safeParse({ ...wellFormed, repairMidAed: 'lots' }).success);
});

check('§1.4 photo bytes are sniffed, and a declared Content-Type is never trusted', () => {
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])), 'image/jpeg');
  assert.equal(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])), 'image/png');
  // The one that matters: Cloudflare serves its challenge with whatever
  // Content-Type it likes, and a paid assessment of an HTML page is worse than
  // no assessment at all.
  assert.equal(sniffMime(Buffer.from('<!doctype html><title>Attention Required</title>')), null);
  assert.equal(sniffMime(Buffer.from('{"error":"forbidden"}')), null);
});

check('§1.4 a lot whose photos all fail to load is an error, not a clean car', async () => {
  const v = { photos: ['https://example.invalid/a.jpg'] } as never;
  await assert.rejects(
    () => assess(v, async () => null, 'modelark'),
    (err: Error) => err instanceof VisionError && /no photo could be retrieved/.test(err.message),
  );
});

check('§6.5 a lot with no photos returns null rather than an assessment', async () => {
  assert.equal(await assess({ photos: [] } as never, async () => null, 'modelark'), null);
});

check('§5 CONFIG_VERSION covers the vision provider, so a switch re-versions assessments', () => {
  // The hash is over VISION_PROVIDER and the effective VISION_MODEL; the model
  // id differs per provider, so the two can never share a config version.
  assert.notEqual(ARK_VISION_MODEL, ANTHROPIC_VISION_MODEL);
  assert.equal(VISION_MODEL, VISION_PROVIDER === 'modelark' ? ARK_VISION_MODEL : ANTHROPIC_VISION_MODEL);
  assert.match(CONFIG_VERSION, /^[0-9a-f]{12}$/);
});

// ── budget ─────────────────────────────────────────────────────────────────

check('§12 the render budget is capped at ~400 pages', () => {
  assert.ok(MAX_RENDERS_PER_RUN <= 400);
});

// ── report ─────────────────────────────────────────────────────────────────

await Promise.all(pending);

ui.summary([
  ['checks passed', String(passed)],
  ['checks failed', String(failures.length)],
]);

if (failures.length > 0) {
  for (const f of failures) ui.fail(f);
  process.exitCode = 1;
} else {
  ui.ok('all acceptance criteria hold');
}
