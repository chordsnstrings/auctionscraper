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
  ARK_API_KEY,
  ARK_BASE_URL,
  ARK_VISION_MODEL,
  BROWSER_HEADERS,
  DATABASE_URL,
  ROOT_SITEMAP,
  SITE_ORIGIN,
  SMTP,
  VISION_ENABLED,
  VISION_MODEL,
  VISION_PROVIDER,
} from './config.js';
import { closeDb, db, migrate } from './db.js';
import { Fetcher } from './fetcher.js';
import { walkSitemap } from './sitemap.js';
import type { LotRef } from './types.js';
import * as ui from './ui.js';

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

    // One real lot, all the way to its photo bytes. This is the only check that
    // proves the paid stage has anything to look at: the vision provider is
    // shown inlined bytes, so an image host that refuses us costs every
    // assessment in the run.
    if (lots[0]) await checkRenderAndPhoto(fetcher, lots[0]);
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
    const lots = await walkSitemap({ limit: 5, readXml: fetcher.xmlReader() });
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

/** Render one detail page and pull one photo's bytes — the vision stage's input. */
async function checkRenderAndPhoto(fetcher: Fetcher, ref: LotRef): Promise<void> {
  let vehicle: Awaited<ReturnType<Fetcher['fetchLot']>>;
  try {
    vehicle = await fetcher.fetchLot(ref);
  } catch (err) {
    add({ name: 'browser → detail page', status: 'fail', detail: (err as Error).message.slice(0, 60), gating: true });
    return;
  }

  if (!vehicle) {
    add({ name: 'browser → detail page', status: 'fail', detail: 'no vehicle payload intercepted', gating: true });
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
