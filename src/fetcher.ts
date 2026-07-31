/**
 * fetcher.ts — Playwright render, intercept API responses (§6.3).
 * Does not parse the DOM (§4). Al Qaryah-specific by design (§4.1).
 *
 * The detail page is an Angular SPA whose HTML contains no vehicle data —
 * generic <title>, no JSON-LD, no fields. DOM scraping is not viable (§2.1),
 * so we attach a `response` listener, capture the JSON, and select the payload
 * whose body contains the vehicle id.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import {
  API_CAPTURE_TIMEOUT_MS,
  API_ORIGIN,
  API_RESPONSE_PATTERN,
  BROWSER_HEADERS,
  CONCURRENCY,
  DELAY_MS,
  IGNORE_HTTPS_ERRORS,
  NAV_TIMEOUT_MS,
  SESSION_STATE_PATH,
} from './config.js';
import { normalise } from './normalise.js';
import type { AuctionPayload, LotRef, NormalisedVehicle, VehiclePayload } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Images are aborted — photo URLs come from the JSON, not the rendered DOM. */
const BLOCKED_RESOURCES = new Set(['image', 'media', 'font']);

export class Fetcher {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  async open(useSession = false): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    this.context = await this.browser.newContext({
      ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS,
      userAgent: BROWSER_HEADERS['User-Agent'],
      locale: 'en-GB',
      timezoneId: 'Asia/Dubai',
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: Object.fromEntries(
        Object.entries(BROWSER_HEADERS).filter(([k]) => k !== 'User-Agent'),
      ),
      ...(useSession && existsSync(SESSION_STATE_PATH) ? { storageState: SESSION_STATE_PATH } : {}),
    });

    await this.context.route('**/*', (route) => {
      if (BLOCKED_RESOURCES.has(route.request().resourceType())) return route.abort();
      return route.continue();
    });
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
    this.context = null;
    this.browser = null;
  }

  private ctx(): BrowserContext {
    if (!this.context) throw new Error('Fetcher.open() was not called');
    return this.context;
  }

  /**
   * Render one detail page and return the intercepted vehicle payload.
   * Selects the response whose body contains the lot's ObjectId — the page
   * fires several API calls and only one of them is the vehicle record.
   */
  async fetchLot(ref: LotRef): Promise<NormalisedVehicle | null> {
    const page: Page = await this.ctx().newPage();
    const candidates: VehiclePayload[] = [];

    const onResponse = async (res: { url(): string; ok(): boolean; text(): Promise<string> }) => {
      if (!API_RESPONSE_PATTERN.test(res.url())) return;
      let body: string;
      try {
        body = await res.text();
      } catch {
        return;
      }
      if (!body.includes(ref.id)) return;
      try {
        const json = JSON.parse(body) as unknown;
        for (const v of harvestVehicles(json, ref.id)) candidates.push(v);
      } catch {
        /* non-JSON responses on the API host are not vehicle records */
      }
    };

    page.on('response', onResponse);

    try {
      await page.goto(ref.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

      const deadline = Date.now() + API_CAPTURE_TIMEOUT_MS;
      while (candidates.length === 0 && Date.now() < deadline) await sleep(250);

      // The SPA sometimes needs the XHR to settle after first paint.
      if (candidates.length === 0) {
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
      }

      const payload = candidates.find((c) => c._id?.toLowerCase() === ref.id) ?? candidates[0];
      return payload ? normalise(payload, ref) : null;
    } catch {
      return null;
    } finally {
      page.off('response', onResponse);
      await page.close().catch(() => undefined);
    }
  }

  /**
   * Render a batch with CONCURRENCY workers and DELAY_MS between navigations.
   * `onLot` is invoked as each result lands so the caller can stream progress.
   */
  async fetchMany(
    refs: readonly LotRef[],
    onLot?: (v: NormalisedVehicle | null, ref: LotRef, done: number) => void,
  ): Promise<NormalisedVehicle[]> {
    const out: NormalisedVehicle[] = [];
    let cursor = 0;
    let done = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor++;
        const ref = refs[i];
        if (!ref) return;
        const v = await this.fetchLot(ref);
        done += 1;
        if (v) out.push(v);
        onLot?.(v, ref, done);
        await sleep(DELAY_MS);
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, refs.length) }, worker));
    return out;
  }

  /** Unauthenticated auction state (§2.3). Used by the run and the watcher. */
  async activeAuctions(): Promise<AuctionPayload[]> {
    const page = await this.ctx().newPage();
    try {
      const res = await page.request.get(`${API_ORIGIN}/auction/active-auctions`, {
        headers: BROWSER_HEADERS,
        timeout: NAV_TIMEOUT_MS,
      });
      if (!res.ok()) return [];
      const json = (await res.json()) as unknown;
      return harvestAuctions(json);
    } catch {
      return [];
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /** Server clock. Never key auction timing off local time (§8.5). */
  async serverTime(): Promise<Date | null> {
    const page = await this.ctx().newPage();
    try {
      const res = await page.request.get(`${API_ORIGIN}/getdbtime/getCurrentTime?timezone=UTC`, {
        headers: BROWSER_HEADERS,
        timeout: 15_000,
      });
      if (!res.ok()) return null;
      const text = await res.text();
      const iso = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/.exec(text)?.[0];
      if (!iso) return null;
      const d = new Date(iso.replace(' ', 'T').endsWith('Z') ? iso.replace(' ', 'T') : `${iso.replace(' ', 'T')}Z`);
      return Number.isNaN(d.getTime()) ? null : d;
    } catch {
      return null;
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

// ── payload harvesting ─────────────────────────────────────────────────────

function isVehicle(o: unknown, id: string): o is VehiclePayload {
  return (
    typeof o === 'object' &&
    o !== null &&
    typeof (o as { _id?: unknown })._id === 'string' &&
    (o as { _id: string })._id.toLowerCase() === id
  );
}

/** The record can be at the root, under `data`, or inside a paginated array. */
function harvestVehicles(json: unknown, id: string, depth = 0): VehiclePayload[] {
  if (depth > 4 || json === null || typeof json !== 'object') return [];
  if (isVehicle(json, id)) return [json];
  const out: VehiclePayload[] = [];
  const values = Array.isArray(json) ? json : Object.values(json as Record<string, unknown>);
  for (const v of values) out.push(...harvestVehicles(v, id, depth + 1));
  return out;
}

function harvestAuctions(json: unknown, depth = 0): AuctionPayload[] {
  if (depth > 4 || json === null || typeof json !== 'object') return [];
  const o = json as Record<string, unknown>;
  if (typeof o._id === 'string' && ('auctionDate' in o || 'lanes' in o || 'isAuctionActive' in o)) {
    return [o as AuctionPayload];
  }
  const out: AuctionPayload[] = [];
  const values = Array.isArray(json) ? json : Object.values(o);
  for (const v of values) out.push(...harvestAuctions(v, depth + 1));
  return out;
}
