/**
 * index.ts — the daily screen.
 *
 *   sitemap ──▶ pre-gate ──▶ fetch ──▶ gate ──▶ vision ──▶ score ──▶ digest
 *     (XML)      (free)     (browser)  (free)   (paid)     (free)    (SMTP)
 *                                                    │
 *                                                    ▼
 *                                                watchlist
 *
 * Cost ordering is the core design principle (§3): every stage is cheaper than
 * the one after it and eliminates as much volume as it can. Vision runs only
 * on lots that survived every free check.
 */
import {
  CONFIG_VERSION,
  MAX_RENDERS_PER_RUN,
  MIN_MODEL_YEAR,
  RECHECK_CAP,
  VISION_ENABLED,
} from './config.js';
import {
  addToWatchlist,
  appendAssessment,
  db,
  finishRun,
  isFirstAppearance,
  latestCaptureRate,
  markDelisted,
  recordDigestAppearance,
  recordPriceState,
  startRun,
  upsertVehicle,
} from './db.js';
import { sendDigest } from './digest.js';
import { Fetcher } from './fetcher.js';
import { gate, preGate } from './gates.js';
import { commitSnapshot, diffSitemap } from './sitemap.js';
import { score, stalenessWarnings } from './scoring.js';
import type { DigestLot, DigestModel, FunnelStats, LotRef, NormalisedVehicle, VisionResult } from './types.js';
import * as ui from './ui.js';
import { assess } from './vision.js';

function titleOf(v: NormalisedVehicle): string {
  if (v.description) return v.description;
  return [v.year, v.make, v.model].filter(Boolean).join(' ') || v.id;
}

/** Year half of the pre-gate, reported separately so the funnel shows both stages. */
const passesYear = (l: LotRef): boolean => Number.isFinite(l.year) && l.year >= MIN_MODEL_YEAR;

/**
 * Render budget. New arrivals first — they are the reason the run exists —
 * then a capped re-check of already-known open lots, preferring the ones we
 * have never successfully rendered.
 */
function selectForRender(added: LotRef[], stillListed: LotRef[]): LotRef[] {
  const known = new Set(
    (db().prepare(`SELECT id FROM vehicle`).all() as { id: string }[]).map((r) => r.id),
  );
  const recheck = [...stillListed].sort((a, b) => Number(known.has(a.id)) - Number(known.has(b.id)));
  return [...added, ...recheck.slice(0, RECHECK_CAP)].slice(0, MAX_RENDERS_PER_RUN);
}

export async function run(): Promise<void> {
  const startedAt = Date.now();
  const runId = startRun('daily');
  ui.banner('Daily purchasing screen', 'Al Qaryah Auction · Sharjah · single source');

  // ── 1. Sitemap diff ──────────────────────────────────────────────────────
  ui.step('Walking sitemap tree', '(never paginated listing pages)');
  const walk = new ui.Progress('sitemap');
  const diff = await diffSitemap({ onProgress: (seen) => walk.update(seen, seen, 'lots indexed') });
  walk.done(`${diff.all.length} lots · ${diff.added.length} new · ${diff.removedIds.length} gone`);

  // ── 2. Pre-gate (free, pre-render) ──────────────────────────────────────
  const afterYear = diff.all.filter(passesYear);
  const afterModel = diff.all.filter(preGate);
  ui.step('Pre-gate', `year → ${afterYear.length}, target models → ${afterModel.length}`);

  const toRender = selectForRender(diff.added.filter(preGate), diff.stillListed.filter(preGate));
  ui.note(`${toRender.length} pages queued for render (cap ${MAX_RENDERS_PER_RUN})`);

  // ── 3. Fetch ─────────────────────────────────────────────────────────────
  const fetcher = new Fetcher();
  await fetcher.open();

  let auctionCloses = new Map<string, Date>();
  let auctionTitle: string | null = null;
  try {
    const auctions = await fetcher.activeAuctions();
    for (const a of auctions) {
      if (a._id && a.auctionDate) {
        const d = new Date(a.auctionDate);
        if (!Number.isNaN(d.getTime())) auctionCloses.set(a._id, d);
      }
    }
    auctionTitle = auctions.find((a) => a.isAuctionActive)?.title ?? auctions[0]?.title ?? null;
    if (auctions.length) ui.note(`${auctions.length} active auction(s) · ${auctionTitle ?? 'untitled'}`);
  } catch {
    ui.warn('could not read active auctions — close times will be blank');
  }

  const fetchBar = new ui.Progress('render');
  const vehicles = await fetcher.fetchMany(toRender, (_v, _ref, done) =>
    fetchBar.update(done, toRender.length, 'detail pages'),
  );
  fetchBar.done(`${vehicles.length}/${toRender.length} payloads captured`);
  await fetcher.close();

  // ── 4. Gate (free) ───────────────────────────────────────────────────────
  const gated = vehicles.map((v) => ({ v, g: gate(v) }));
  const rejected = gated.filter((x) => x.g.verdict === 'reject');
  const survivors = gated.filter((x) => x.g.verdict !== 'reject');
  const cleanTitleCount = vehicles.filter((v) => v.cleanTitle === true).length;

  ui.step(
    'Gate',
    `${survivors.filter((s) => s.g.verdict === 'pass').length} pass · ` +
      `${survivors.filter((s) => s.g.verdict === 'unverified').length} unverified · ${rejected.length} reject`,
  );

  // ── 5. Vision (paid) — survivors only ───────────────────────────────────
  const visionResults = new Map<string, VisionResult>();
  let visionCalls = 0;

  if (VISION_ENABLED && survivors.length > 0) {
    const bar = new ui.Progress('vision');
    for (const [i, s] of survivors.entries()) {
      try {
        const result = await assess(s.v);
        if (result) {
          visionResults.set(s.v.id, result);
          visionCalls += 1;
        }
      } catch (err) {
        ui.warn(`vision failed for ${s.v.id}: ${(err as Error).message}`);
      }
      bar.update(i + 1, survivors.length, 'lots assessed');
    }
    bar.done(`${visionCalls} assessed`);
  } else if (!VISION_ENABLED) {
    ui.note('vision disabled (VISION_ENABLED=false)');
  }

  // ── 6. Score + persist ───────────────────────────────────────────────────
  const bid: DigestLot[] = [];
  const inspect: DigestLot[] = [];

  for (const { v, g } of gated) {
    const vision = visionResults.get(v.id) ?? null;
    const s = score(v, g, vision);

    const vehicleId = upsertVehicle({
      id: v.id,
      vin: v.vin,
      lotNo: v.lotNo,
      url: v.url,
      make: v.make,
      model: v.model,
      modelKey: v.key,
      year: v.year,
      description: v.description,
      startingBid: v.startingBid,
      cleanTitle: v.cleanTitle,
      primaryDamage: v.primaryDamage,
      secondaryDamage: v.secondaryDamage,
      startCode: v.startCode ? JSON.stringify(v.startCode) : null,
      mileageKm: v.mileageKm,
      auctionId: v.auctionId,
      lane: v.lane,
      photo: v.photos[0] ?? null,
      raw: v.raw,
    });

    // Outcome + floor only. Never a sale price (§2.6).
    recordPriceState(vehicleId, v.startingBid, v.auctionVehicleStatus, v.auctionId);

    appendAssessment({
      vehicleId,
      configVersion: CONFIG_VERSION,
      gate: g.verdict,
      titleStatus: g.titleStatus,
      gateReason: g.reason,
      vision,
      action: s.action,
      fleetReadyValue: s.fleetReadyValue,
      repairEstimate: s.repairEstimate,
      maxBid: s.maxBid,
      marginAed: s.marginAed,
      reasons: s.reasons,
    });

    if (s.action === 'DROP') continue;

    const lot: DigestLot = {
      id: vehicleId,
      url: v.url,
      lotNo: v.lotNo,
      title: titleOf(v),
      year: v.year,
      mileageKm: v.mileageKm,
      primaryDamage: v.primaryDamage,
      secondaryDamage: v.secondaryDamage,
      startCodeTitle: v.startCode?.title ?? null,
      titleStatus: g.titleStatus,
      gate: g.verdict,
      vision,
      score: s,
      lane: v.lane,
      closesAt: v.auctionId ? auctionCloses.get(v.auctionId) ?? null : null,
      isNew: isFirstAppearance(vehicleId),
      photo: v.photos[0] ?? null,
    };

    (s.action === 'BID' ? bid : inspect).push(lot);

    // Every lot reaching BID or INSPECT goes on the watchlist (§8.2).
    addToWatchlist({
      vehicleId,
      auctionId: v.auctionId,
      lotNo: v.lotNo,
      lane: v.lane,
      sequenceNo: null,
      maxBid: s.maxBid,
    });
  }

  // ── 7. Digest ────────────────────────────────────────────────────────────
  const funnel: FunnelStats = {
    sitemapTotal: diff.all.length,
    afterYearGate: afterYear.length,
    afterModelGate: afterModel.length,
    rendered: vehicles.length,
    gatePassed: survivors.filter((s) => s.g.verdict === 'pass').length,
    gateUnverified: survivors.filter((s) => s.g.verdict === 'unverified').length,
    gateRejected: rejected.length,
    visionCalls,
    cleanTitleShare: vehicles.length ? cleanTitleCount / vehicles.length : null,
  };

  const model: DigestModel = {
    generatedAt: new Date(),
    auctionTitle,
    bid,
    inspect,
    funnel,
    stalenessWarnings: stalenessWarnings(),
    captureRate: latestCaptureRate(),
    configVersion: CONFIG_VERSION,
    runDurationMs: Date.now() - startedAt,
  };

  const outcome = await sendDigest(model);
  // Only after the digest is out — otherwise a failed send would silently burn
  // the NEW badge for every lot in it.
  recordDigestAppearance([...bid, ...inspect].map((l) => l.id));

  // ── 8. Snapshot + housekeeping ──────────────────────────────────────────
  markDelisted(diff.removedIds);
  commitSnapshot(diff);
  finishRun(runId, funnel);

  ui.funnel([
    { label: 'sitemap', n: funnel.sitemapTotal },
    { label: 'year gate', n: funnel.afterYearGate },
    { label: 'model gate', n: funnel.afterModelGate },
    { label: 'rendered', n: funnel.rendered },
    { label: 'vision', n: funnel.visionCalls },
    { label: 'surfaced', n: bid.length + inspect.length },
  ]);

  ui.summary([
    ['bid', String(bid.length)],
    ['inspect', String(inspect.length)],
    ['clean title share', funnel.cleanTitleShare === null ? '—' : `${Math.round(funnel.cleanTitleShare * 100)}%`],
    ['digest', outcome],
    ['config', CONFIG_VERSION],
    ['elapsed', `${((Date.now() - startedAt) / 1000).toFixed(1)}s`],
  ]);
}

run().catch((err: unknown) => {
  ui.fail(`run failed: ${(err as Error).stack ?? String(err)}`);
  process.exitCode = 1;
});
