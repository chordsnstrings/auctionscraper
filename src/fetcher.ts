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
  BROWSER_LAUNCH_ARGS,
  CONTEXT_EXTRA_HEADERS,
  CONCURRENCY,
  DELAY_MS,
  IGNORE_HTTPS_ERRORS,
  NAV_TIMEOUT_MS,
  PHOTO_TIMEOUT_MS,
  SESSION_STATE_PATH,
} from './config.js';
import { normalise } from './normalise.js';
import {
  browserPhotoLoader,
  httpPhotoLoader,
  type BytesReader,
  type BytesResponse,
  type PhotoLoader,
} from './photos.js';
import { httpXmlReader, type XmlReader } from './sitemap.js';
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
      args: [...BROWSER_LAUNCH_ARGS],
    });
    this.context = await this.browser.newContext({
      ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS,
      userAgent: BROWSER_HEADERS['User-Agent'],
      locale: 'en-GB',
      timezoneId: 'Asia/Dubai',
      viewport: { width: 1440, height: 900 },
      extraHTTPHeaders: CONTEXT_EXTRA_HEADERS,
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

  /** The live auction room opens its own pages against this context (§8.3). */
  browserContext(): BrowserContext {
    return this.ctx();
  }

  /**
   * Read a URL's raw bytes through a real navigation.
   *
   * This is the only way out of this process that Al Qaryah accepts.
   * `context.request` looks like the browser — it shares the cookie jar — but
   * it is Playwright's Node HTTP stack underneath, so its TLS and HTTP/2
   * fingerprint is a script's and Cloudflare challenges it exactly like plain
   * `fetch`. A navigation goes through Chromium's own network stack.
   *
   * Navigations are `document` requests, so the image-blocking route above does
   * not touch them, and `response.body()` returns the bytes off the wire rather
   * than anything Chromium rendered from them.
   */
  async readBytes(url: string, timeoutMs = NAV_TIMEOUT_MS): Promise<BytesResponse | null> {
    if (!this.context) return null;
    const page = await this.context.newPage();
    try {
      // `commit` returns as soon as the response arrives — there is nothing to
      // wait for here, and an image would otherwise be decoded for nothing.
      const res = await page.goto(url, { waitUntil: 'commit', timeout: timeoutMs });
      if (!res) return null;
      return { ok: res.ok(), body: await res.body() };
    } catch {
      return null;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /**
   * An XML reader bound to this context, for the sitemap walk.
   *
   * The sitemap is the entry point to everything: if Cloudflare serves it a
   * challenge, the crawl finds zero lots and the digest is empty for a reason
   * no one can see. Requiring a `<loc>` is what turns that into a failure.
   */
  xmlReader(): XmlReader {
    return async (url) => {
      if (!this.context) return httpXmlReader(url);
      const res = await this.readBytes(url);
      if (!res?.ok) return null;
      const body = res.body.toString('utf8');
      return /<loc>/i.test(body) ? body : null;
    };
  }

  /**
   * A photo loader bound to this context, for the vision stage.
   *
   * Images are aborted during render precisely so they cost nothing there —
   * but the vision provider still has to be shown the bytes, and its own egress
   * has no standing with Cloudflare. Once the fetcher is closed the loader
   * degrades to plain HTTP rather than throwing.
   */
  photoLoader(): PhotoLoader {
    const read: BytesReader = (url) => this.readBytes(url, PHOTO_TIMEOUT_MS);
    return async (url) => {
      if (!this.context) return httpPhotoLoader(url);
      return browserPhotoLoader(read)(url);
    };
  }

  /** JSON from the API host, read the same way and for the same reason. */
  private async readJson(url: string, timeoutMs = NAV_TIMEOUT_MS): Promise<unknown | null> {
    const res = await this.readBytes(url, timeoutMs);
    if (!res?.ok) return null;
    try {
      return JSON.parse(res.body.toString('utf8')) as unknown;
    } catch {
      return null;
    }
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
   * Render one detail page and report what it actually did.
   *
   * Used only by preflight, and only when `fetchLot` came back empty. "No
   * payload" has several very different causes — the page 404s, Cloudflare
   * challenges the XHR, the API host moved, the id in the body is cased
   * differently — and they are indistinguishable from the outside. This records
   * every response the page made so the log says which one it was.
   */
  async diagnoseLot(ref: LotRef): Promise<{
    status: number;
    finalUrl: string;
    title: string;
    responses: { url: string; status: number; hasId: boolean; bytes: number }[];
  }> {
    const page = await this.ctx().newPage();
    const responses: { url: string; status: number; hasId: boolean; bytes: number }[] = [];
    const needle = ref.id.toLowerCase();

    // Every response, whatever the host: if the API moved off
    // alqaryahauction.com entirely, filtering by that domain is exactly what
    // would hide it.
    const onResponse = async (res: {
      url(): string;
      status(): number;
      text(): Promise<string>;
    }): Promise<void> => {
      const url = res.url();
      if (/\.(?:css|woff2?|png|jpe?g|gif|svg|webp|ico|mp4)(?:\?|$)/i.test(url)) return;
      let body = '';
      try {
        body = await res.text();
      } catch {
        /* body already consumed, or a redirect with none */
      }
      responses.push({
        url: url.slice(0, 140),
        status: res.status(),
        hasId: body.toLowerCase().includes(needle),
        bytes: body.length,
      });
    };

    page.on('response', onResponse);
    try {
      const nav = await page.goto(ref.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
      return {
        status: nav?.status() ?? 0,
        finalUrl: page.url(),
        title: (await page.title().catch(() => '')).slice(0, 80),
        responses,
      };
    } catch (err) {
      return { status: -1, finalUrl: (err as Error).message.slice(0, 80), title: '', responses };
    } finally {
      page.off('response', onResponse);
      await page.close().catch(() => undefined);
    }
  }

  /**
   * Does the rendered page itself carry the lot data?
   *
   * §2.1 recorded that the detail HTML holds no vehicle fields, which is why
   * this scrapes nothing and intercepts instead. If a server-rendered build has
   * since shipped, the data would be sitting in the document and the absence of
   * an XHR would be the expected behaviour rather than a fault — so check
   * before concluding the pipeline is blocked.
   */
  async inspectRenderedPage(
    ref: LotRef,
  ): Promise<{ idInHtml: boolean; jsonBlobs: number; bytes: number; scripts: string[]; sample: string }> {
    const page = await this.ctx().newPage();
    try {
      await page.goto(ref.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
      const html = await page.content();
      const needle = ref.id.toLowerCase();
      const lower = html.toLowerCase();
      const blobs = html.match(/<script[^>]+type=["']application\/(?:ld\+)?json["'][^>]*>/gi) ?? [];
      const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1] ?? '');
      const at = lower.indexOf(needle);
      return {
        idInHtml: at >= 0,
        jsonBlobs: blobs.length,
        bytes: html.length,
        scripts: scripts.slice(0, 8),
        sample: at >= 0 ? html.slice(Math.max(0, at - 120), at + 120).replace(/\s+/g, ' ') : '',
      };
    } catch (err) {
      return { idInHtml: false, jsonBlobs: 0, bytes: 0, scripts: [], sample: (err as Error).message.slice(0, 80) };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /**
   * The same render on a context with none of our configuration.
   *
   * The detail page loads its document and then requests nothing at all — not
   * even its own bundles. That is far more consistent with something we are
   * doing to the context than with the site changing: the `**\/*` route, and
   * `extraHTTPHeaders` that pin `Sec-Fetch-Dest: document` and
   * `Sec-Fetch-Mode: navigate` onto every subresource, which is a combination
   * no real browser ever sends for a script. This isolates that.
   */
  async diagnoseWithPlainContext(ref: LotRef): Promise<{ responses: number; payloadFound: boolean; hosts: string[] }> {
    if (!this.browser) return { responses: 0, payloadFound: false, hosts: [] };
    const ctx = await this.browser.newContext({
      ignoreHTTPSErrors: IGNORE_HTTPS_ERRORS,
      userAgent: BROWSER_HEADERS['User-Agent'],
      locale: 'en-GB',
      timezoneId: 'Asia/Dubai',
    });
    const page = await ctx.newPage();
    const hosts = new Set<string>();
    let responses = 0;
    let payloadFound = false;
    const needle = ref.id.toLowerCase();

    const onResponse = async (res: { url(): string; text(): Promise<string> }): Promise<void> => {
      responses += 1;
      try {
        hosts.add(new URL(res.url()).host);
      } catch {
        /* opaque url */
      }
      if (!API_RESPONSE_PATTERN.test(res.url())) return;
      try {
        if ((await res.text()).toLowerCase().includes(needle)) payloadFound = true;
      } catch {
        /* unreadable body */
      }
    };

    page.on('response', onResponse);
    try {
      await page.goto(ref.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
    } catch {
      /* report what was seen up to the failure */
    } finally {
      page.off('response', onResponse);
      await ctx.close().catch(() => undefined);
    }
    return { responses, payloadFound, hosts: [...hosts].slice(0, 8) };
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
    const json = await this.readJson(`${API_ORIGIN}/auction/active-auctions`);
    return json === null ? [] : harvestAuctions(json);
  }

  /** Server clock. Never key auction timing off local time (§8.5). */
  async serverTime(): Promise<Date | null> {
    const res = await this.readBytes(`${API_ORIGIN}/getdbtime/getCurrentTime?timezone=UTC`, 15_000);
    if (!res?.ok) return null;
    const text = res.body.toString('utf8');
    const iso = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/.exec(text)?.[0];
    if (!iso) return null;
    const normalised = iso.replace(' ', 'T');
    const d = new Date(normalised.endsWith('Z') ? normalised : `${normalised}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
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
