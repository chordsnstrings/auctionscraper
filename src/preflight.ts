/**
 * preflight.ts — is this host actually able to do the job?
 *
 *   npm run preflight
 *
 * Runs before the first scheduled screen and on demand. It exists because the
 * expensive failure here is silent: Al Qaryah sits behind Cloudflare, which
 * scores datacenter IP ranges aggressively. A blocked host produces zero lots,
 * which is indistinguishable from "a quiet day at the auction" unless something
 * says otherwise out loud.
 *
 * Exit code 0 = safe to run the screen. Non-zero = do not trust an empty result.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import {
  API_ORIGIN,
  API_RESPONSE_PATTERN,
  ARK_API_KEY,
  ARK_BASE_URL,
  ARK_VISION_MODEL,
  BROWSER_HEADERS,
  DATABASE_URL,
  MIN_MODEL_YEAR,
  ROOT_SITEMAP,
  SITE_ORIGIN,
  SMTP,
  VISION_ENABLED,
  VISION_MODEL,
  VISION_PROVIDER,
} from './config.js';
import { closeDb, db, migrate } from './db.js';
import { Fetcher } from './fetcher.js';
import { preGate } from './gates.js';
import { walkSitemap } from './sitemap.js';
import type { LotRef } from './types.js';
import * as ui from './ui.js';

/**
 * How far into the sitemap preflight walks, and how many lots it renders.
 * The sample is wide because it is filtered down to lots the run would actually
 * render, and the walk stops at the first document that yields this many.
 */
const SITEMAP_SAMPLE = 800;
const DETAIL_ATTEMPTS = 3;

type Status = 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  status: Status;
  detail: string;
  /** A failure here means an empty digest cannot be trusted. */
  gating: boolean;
}

const results: Check[] = [];
const add = (c: Check): void => {
  results.push(c);
  const mark = c.status === 'ok' ? ui.c.good('✓') : c.status === 'warn' ? ui.c.warn('!') : ui.c.bad('✕');
  ui.note(`${mark} ${c.name.padEnd(30)} ${c.detail}`);
};

/** Cloudflare's block page, as opposed to a genuine 403 from the origin. */
function isCloudflareChallenge(body: string): boolean {
  return /Attention Required|cf-browser-verification|Cloudflare Ray ID|__cf_chl/i.test(body);
}

async function checkHttp(label: string, url: string, gating: boolean): Promise<void> {
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(25_000) });
    const body = await res.text().catch(() => '');
    if (res.ok) {
      add({ name: label, status: 'ok', detail: `${res.status} · ${body.length} bytes`, gating });
      return;
    }
    add({
      name: label,
      status: 'fail',
      detail: isCloudflareChallenge(body)
        ? `${res.status} — Cloudflare challenge (this IP is not trusted)`
        : `${res.status}`,
      gating,
    });
  } catch (err) {
    add({ name: label, status: 'fail', detail: (err as Error).message.slice(0, 60), gating });
  }
}

/**
 * The decisive check. A real browser presents a very different TLS and HTTP/2
 * fingerprint from `fetch`, so plain HTTP failing does not by itself mean the
 * pipeline is blocked — this is what the pipeline actually uses.
 */
async function checkBrowser(): Promise<void> {
  const fetcher = new Fetcher();
  try {
    await fetcher.open();
  } catch (err) {
    // Almost always the container: Chromium will not start as root with the
    // sandbox on, and that failure looks nothing like a network problem.
    add({ name: 'chromium launch', status: 'fail', detail: (err as Error).message.slice(0, 70), gating: true });
    return;
  }

  try {
    const ctx = fetcher.browserContext();
    const page = await ctx.newPage();
    const res = await page.goto(SITE_ORIGIN, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    const status = res?.status() ?? 0;
    const body = await page.content().catch(() => '');
    await page.close().catch(() => undefined);

    if (status === 200 && !isCloudflareChallenge(body)) {
      add({ name: 'browser → site', status: 'ok', detail: '200 — Cloudflare passed', gating: true });
    } else {
      add({
        name: 'browser → site',
        status: 'fail',
        detail: isCloudflareChallenge(body)
          ? `${status} — Cloudflare challenge even from a real browser`
          : `${status}`,
        gating: true,
      });
    }

    // The sitemap is the entry point to every lot the run will ever see, and it
    // is the check that matters most: a challenge served here parses as zero
    // <loc> elements, so the run reports an empty auction instead of a block.
    const lots = await checkSitemapThroughBrowser(fetcher);

    // Real lots, all the way to photo bytes. This is the only check that proves
    // the paid stage has anything to look at: the vision provider is shown
    // inlined bytes, so an image host that refuses us costs every assessment in
    // the run. Several lots are tried because the head of the sitemap is
    // whatever the site lists first, which is often long delisted.
    if (lots.length > 0) await checkRenderAndPhoto(fetcher, lots);
  } catch (err) {
    add({ name: 'browser → site', status: 'fail', detail: (err as Error).message.slice(0, 60), gating: true });
  } finally {
    await fetcher.close().catch(() => undefined);
  }
}

/**
 * Walk far enough into the sitemap to prove lots come back, through the same
 * reader the run uses. `limit` keeps this to the first XML document.
 */
async function checkSitemapThroughBrowser(fetcher: Fetcher): Promise<LotRef[]> {
  try {
    const lots = await walkSitemap({ limit: SITEMAP_SAMPLE, readXml: fetcher.xmlReader() });
    // Print what was parsed, not just how many. A URL shape that changed shows
    // up here as a nonsense make/model pair long before it shows up as an
    // empty digest.
    for (const l of probeCandidates(lots, 3)) ui.note(`      ${l.key} ${l.year} · ${l.id} · ${l.url}`);
    add(
      lots.length > 0
        ? {
            name: 'browser → sitemap',
            status: 'ok',
            detail: `${lots.length}+ lots indexed · e.g. ${lots[0]?.key ?? '?'} ${lots[0]?.year ?? ''}`.trim(),
            gating: true,
          }
        : {
            name: 'browser → sitemap',
            status: 'fail',
            detail: 'no lots — the run would report an empty auction',
            gating: true,
          },
    );
    return lots;
  } catch (err) {
    add({ name: 'browser → sitemap', status: 'fail', detail: (err as Error).message.slice(0, 60), gating: true });
    return [];
  }
}

/**
 * Which lots to probe with.
 *
 * The head of the sitemap is not the front of the auction — in production it is
 * 1960 Ramblers and a 2012 lot the site files under Alfa Romeo. Those render a
 * page that never calls the vehicle API, so probing them proves nothing about
 * whether the pipeline works. Prefer exactly what the run would render, then
 * anything recent enough to still be listed, and only then the head.
 */
export function probeCandidates(lots: readonly LotRef[], want: number): LotRef[] {
  const recent = (l: LotRef): boolean => Number.isFinite(l.year) && l.year >= MIN_MODEL_YEAR;
  const seen = new Set<string>();
  const out: LotRef[] = [];
  for (const l of [...lots.filter(preGate), ...lots.filter(recent), ...lots]) {
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    out.push(l);
    if (out.length >= want) break;
  }
  return out;
}

/** Render detail pages and pull one photo's bytes — the vision stage's input. */
async function checkRenderAndPhoto(fetcher: Fetcher, refs: readonly LotRef[]): Promise<void> {
  let vehicle: Awaited<ReturnType<Fetcher['fetchLot']>> = null;
  let tried = 0;

  for (const ref of probeCandidates(refs, DETAIL_ATTEMPTS)) {
    tried += 1;
    try {
      vehicle = await fetcher.fetchLot(ref);
    } catch (err) {
      ui.note(`      ${ref.id} threw: ${(err as Error).message.slice(0, 70)}`);
      continue;
    }
    if (vehicle) break;
    ui.note(`      ${ref.id} rendered but produced no payload — ${ref.url}`);
  }

  if (!vehicle) {
    add({
      name: 'browser → detail page',
      status: 'fail',
      detail: `no vehicle payload from ${tried} lot(s)`,
      gating: true,
    });

    // Say which kind of failure it was rather than leaving it to be guessed.
    const probe = probeCandidates(refs, 1)[0];
    if (probe) {
      const d = await fetcher.diagnoseLot(probe);
      ui.note(`      page ${d.status} "${d.title}" → ${d.finalUrl.slice(0, 100)}`);
      if (d.responses.length === 0) {
        ui.note('      the page made no requests to alqaryahauction.com at all');
      }
      for (const r of d.responses.slice(0, 12)) {
        ui.note(`      ${String(r.status).padEnd(4)} ${r.hasId ? 'HAS-ID' : '      '} ${r.bytes}B ${r.url}`);
      }
      ui.note(`      API_RESPONSE_PATTERN = ${API_RESPONSE_PATTERN}`);
    }
    return;
  }
  add({
    name: 'browser → detail page',
    status: 'ok',
    detail: `${vehicle.year ?? '?'} ${vehicle.make ?? '?'} ${vehicle.model ?? '?'} · ${vehicle.photos.length} photo(s)`,
    gating: true,
  });

  if (!VISION_ENABLED) return;

  const first = vehicle.photos[0];
  if (!first) {
    add({ name: 'photo fetch', status: 'warn', detail: 'this lot lists no photos', gating: false });
    return;
  }

  const photo = await fetcher.photoLoader()(first);
  add(
    photo
      ? {
          name: 'photo fetch',
          status: 'ok',
          detail: `${photo.mime} · ${Math.round(photo.bytes / 1024)} KB inlined`,
          gating: false,
        }
      : {
          name: 'photo fetch',
          status: 'fail',
          detail: 'photo bytes refused — every assessment would fail',
          gating: false,
        },
  );
}

async function checkDatabase(): Promise<void> {
  if (!DATABASE_URL) {
    add({ name: 'postgres', status: 'fail', detail: 'DATABASE_URL not set', gating: true });
    return;
  }
  try {
    await migrate();
    const { rows } = await db().query<{ n: string; v: string }>(
      `SELECT (SELECT count(*) FROM information_schema.tables
                WHERE table_schema='public') AS n, version() AS v`,
    );
    add({
      name: 'postgres',
      status: 'ok',
      detail: `${rows[0]?.n ?? '?'} tables · ${(rows[0]?.v ?? '').split(' ').slice(0, 2).join(' ')}`,
      gating: true,
    });
  } catch (err) {
    add({ name: 'postgres', status: 'fail', detail: (err as Error).message.slice(0, 70), gating: true });
  }
}

/**
 * Vision reachability, checked for real rather than by looking for a key.
 *
 * The ModelArk probe is free: it sends a deliberately invalid request and reads
 * the error code back. `InvalidParameter` means the request got past auth and
 * entitlement and died in validation — key good, model callable, egress open.
 * `NotFound` means the key cannot call that model. Anything else is a network
 * or auth problem. All three are worth knowing before a run spends money.
 */
async function checkVision(): Promise<void> {
  if (!VISION_ENABLED) {
    add({ name: 'vision', status: 'warn', detail: 'disabled — no repair estimates, all lots INSPECT', gating: false });
    return;
  }

  if (VISION_PROVIDER === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY;
    add(
      key
        ? { name: 'vision', status: 'ok', detail: `anthropic · ${VISION_MODEL} · key present`, gating: false }
        : { name: 'vision', status: 'fail', detail: 'ANTHROPIC_API_KEY not set', gating: false },
    );
    return;
  }

  if (!ARK_API_KEY) {
    add({ name: 'vision', status: 'fail', detail: 'ARK_API_KEY not set', gating: false });
    return;
  }

  try {
    const res = await fetch(`${ARK_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ARK_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: ARK_VISION_MODEL, messages: [] }),
      signal: AbortSignal.timeout(25_000),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    const code = json.error?.code ?? String(res.status);

    if (code === 'InvalidParameter') {
      add({ name: 'vision', status: 'ok', detail: `modelark · ${ARK_VISION_MODEL} · callable`, gating: false });
    } else if (code === 'InvalidEndpointOrModel.NotFound') {
      add({ name: 'vision', status: 'fail', detail: `this key cannot call ${ARK_VISION_MODEL}`, gating: false });
    } else {
      add({ name: 'vision', status: 'fail', detail: `${code} ${(json.error?.message ?? '').slice(0, 50)}`, gating: false });
    }
  } catch (err) {
    add({ name: 'vision', status: 'fail', detail: `modelark unreachable: ${(err as Error).message.slice(0, 50)}`, gating: false });
  }
}

function checkConfig(): void {
  if (!SMTP.host || !SMTP.to) {
    add({ name: 'smtp', status: 'warn', detail: 'not configured — digest writes to disk instead', gating: false });
  } else {
    add({ name: 'smtp', status: 'ok', detail: `${SMTP.host}:${SMTP.port} → ${SMTP.to}`, gating: false });
  }
}

async function main(): Promise<void> {
  ui.banner('Preflight', 'can this host actually run the screen?');

  await checkDatabase();
  await checkVision();
  checkConfig();
  await checkHttp('plain fetch → sitemap', ROOT_SITEMAP, false);
  await checkHttp('plain fetch → api', `${API_ORIGIN}/auction/active-auctions`, false);
  await checkBrowser();

  const gatingFailures = results.filter((r) => r.gating && r.status === 'fail');
  const summary = {
    at: new Date().toISOString(),
    ok: gatingFailures.length === 0,
    checks: results,
  };

  mkdirSync('data', { recursive: true });
  writeFileSync('data/preflight.json', JSON.stringify(summary, null, 2), 'utf8');
  console.log(`PREFLIGHT_JSON ${JSON.stringify(summary)}`);
  await closeDb();

  ui.summary([
    ['checks', String(results.length)],
    ['gating failures', String(gatingFailures.length)],
    ['verdict', gatingFailures.length === 0 ? 'safe to run' : 'DO NOT TRUST AN EMPTY DIGEST'],
  ]);

  if (gatingFailures.length > 0) {
    ui.fail('Preflight failed. An empty result from this host is a block, not a finding.');
    for (const f of gatingFailures) ui.note(`   ${f.name}: ${f.detail}`);
    if (gatingFailures.some((f) => f.name.startsWith('browser') || f.detail.includes('Cloudflare'))) {
      ui.note('');
      ui.warn('Cloudflare is refusing this IP. Options, cheapest first:');
      ui.note('   1. Request sanctioned API access from Al Qaryah (§14) — removes the dependency entirely.');
      ui.note('   2. Route the browser through a residential proxy.');
      ui.note('   3. Move the host to an IP range Cloudflare scores better.');
    }
    process.exitCode = 1;
  } else {
    ui.ok('Preflight passed.');
  }
}

main().catch((err: unknown) => {
  ui.fail(`preflight crashed: ${(err as Error).stack ?? String(err)}`);
  process.exitCode = 1;
});

export { isCloudflareChallenge, existsSync };
