/**
 * auctionroom.ts — live capture from the auction room (§8.3 route 1).
 *
 *   https://alqaryahauction.com/auction-join?id={auctionId}&lane={lane}
 *
 * This is the page that actually carries a hammer price. The public REST
 * surface does not: `/vehicle/inventory-details` gives a floor (`startingBid`)
 * and an outcome (`auctionVehicleStatus`) and nothing between them, and
 * `/bid/get-pre-bids` returns an empty array without a session (§2.6). The
 * running and final prices arrive over the room's websocket instead.
 *
 * ── On the frame schema ────────────────────────────────────────────────────
 *
 * The exact message shape has NOT been observed against a live auction — the
 * room is behind Cloudflare and only populated while an auction is running, so
 * it could not be confirmed from here. Rather than guess a shape and silently
 * mis-parse real money, this module:
 *
 *   1. records every frame verbatim to `logs/socket-frames.jsonl`, and
 *   2. runs a schema-agnostic extractor that looks for a lot identifier and a
 *      price-shaped field in the same object, reporting how confident it is.
 *
 * Anything it cannot interpret is still written to the frame log and still
 * produces a gap row, never a fabricated price (§8.4, §13). One live capture
 * turns the heuristic into an exact parse — the log is the input for that.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import type { BrowserContext, Page } from 'playwright';
import { SITE_ORIGIN } from './config.js';

const FRAME_LOG = 'logs/socket-frames.jsonl';

export interface LiveObservation {
  lotNo: number | null;
  vehicleId: string | null;
  amount: number | null;
  status: string | null;
  /** How the value was identified, for triage against the frame log. */
  via: string;
  confident: boolean;
  raw: unknown;
}

export const auctionRoomUrl = (auctionId: string, lane: string): string =>
  `${SITE_ORIGIN.replace('//www.', '//')}/auction-join?id=${encodeURIComponent(auctionId)}&lane=${encodeURIComponent(lane)}`;

// Field names are ordered most-specific first: a `hammerPrice` is unambiguous,
// an `amount` is not.
const FINAL_PRICE_KEYS = [
  'hammerprice', 'soldprice', 'soldamount', 'winningbid', 'finalprice', 'saleprice', 'closingbid',
];
const RUNNING_PRICE_KEYS = [
  'currentbid', 'currentprice', 'runningbid', 'highestbid', 'lastbid', 'bidamount', 'latestbid',
];
const WEAK_PRICE_KEYS = ['amount', 'price', 'bid', 'value'];

const LOT_KEYS = ['lotno', 'lot_no', 'lotnumber', 'lot'];
const ID_KEYS = ['inventoryid', 'vehicleid', 'carid', '_id', 'id'];
const STATUS_KEYS = ['status', 'auctionvehiclestatus', 'lotstatus', 'state'];

const norm = (k: string): string => k.toLowerCase().replace(/[^a-z_]/g, '');

function pickNumber(obj: Record<string, unknown>, keys: readonly string[]): [number, string] | null {
  for (const [k, v] of Object.entries(obj)) {
    if (!keys.includes(norm(k))) continue;
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[,\s]/g, '')) : NaN;
    if (Number.isFinite(n) && n > 0) return [Math.round(n), k];
  }
  return null;
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const [k, v] of Object.entries(obj)) {
    if (keys.includes(norm(k)) && typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Walk a decoded frame and pull out every object that pairs a lot identifier
 * with a price. Nested payloads are common in socket envelopes, so this
 * recurses rather than assuming a flat body.
 */
export function extractObservations(payload: unknown, depth = 0): LiveObservation[] {
  if (depth > 6 || payload === null || typeof payload !== 'object') return [];

  const out: LiveObservation[] = [];

  if (!Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>;
    const lot = pickNumber(obj, LOT_KEYS);
    const vid = pickString(obj, ID_KEYS);
    const status = pickString(obj, STATUS_KEYS);

    const final = pickNumber(obj, FINAL_PRICE_KEYS);
    const running = pickNumber(obj, RUNNING_PRICE_KEYS);
    const weak = pickNumber(obj, WEAK_PRICE_KEYS);
    const hit = final ?? running ?? weak;

    if (hit && (lot || vid)) {
      out.push({
        lotNo: lot?.[0] ?? null,
        vehicleId: vid && /^[0-9a-f]{24}$/i.test(vid) ? vid.toLowerCase() : null,
        amount: hit[0],
        status,
        via: hit[1],
        // A named final/running price alongside a lot id is trustworthy; a bare
        // `amount` could be anything, so it is flagged for review instead.
        confident: Boolean(final ?? running),
        raw: obj,
      });
    }
  }

  for (const v of Array.isArray(payload) ? payload : Object.values(payload as Record<string, unknown>)) {
    out.push(...extractObservations(v, depth + 1));
  }
  return out;
}

/** Socket payloads are often a JSON string, sometimes wrapped by a protocol. */
export function decodeFrame(raw: string): unknown {
  const text = raw.trim();
  // socket.io-style "42[...]" and engine.io numeric prefixes.
  const stripped = /^\d+/.test(text) ? text.replace(/^\d+/, '') : text;
  for (const candidate of [text, stripped]) {
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next form */
    }
  }
  return null;
}

export function recordFrame(direction: 'in' | 'out', raw: string): void {
  if (process.env.DUMP_FRAMES !== '1') return;
  try {
    mkdirSync('logs', { recursive: true });
    appendFileSync(
      FRAME_LOG,
      `${JSON.stringify({ at: new Date().toISOString(), direction, raw: raw.slice(0, 8000) })}\n`,
      'utf8',
    );
  } catch {
    /* the frame log is diagnostic; never let it break capture */
  }
}

export interface RoomSession {
  page: Page;
  close(): Promise<void>;
}

/**
 * Open the room for one lane and stream observations to `onObservation`.
 *
 * One page per lane: lanes run in parallel and a single page would drop
 * concurrent lots (§8.5). Never bids — it only listens (§13).
 */
export async function joinLane(
  ctx: BrowserContext,
  auctionId: string,
  lane: string,
  onObservation: (o: LiveObservation) => void | Promise<void>,
  onLog?: (msg: string) => void,
): Promise<RoomSession> {
  const page = await ctx.newPage();
  const url = auctionRoomUrl(auctionId, lane);

  const handle = (source: string, raw: string): void => {
    recordFrame('in', raw);
    const decoded = decodeFrame(raw);
    if (decoded === null) return;
    for (const o of extractObservations(decoded)) {
      void onObservation({ ...o, via: `${source}:${o.via}` });
    }
  };

  page.on('websocket', (ws) => {
    onLog?.(`websocket open ${ws.url()}`);
    ws.on('framereceived', (f) => {
      if (typeof f.payload === 'string') handle('ws', f.payload);
    });
    ws.on('socketerror', (e) => onLog?.(`websocket error ${String(e)}`));
    ws.on('close', () => onLog?.('websocket closed'));
  });

  // The room also polls REST while it runs; those responses carry the same
  // fields and cost nothing extra to read.
  page.on('response', (res) => {
    if (!/alqaryahauction\.com/.test(res.url())) return;
    if (!/json/i.test(res.headers()['content-type'] ?? '')) return;
    res
      .text()
      .then((t) => handle('http', t))
      .catch(() => undefined);
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  onLog?.(`joined ${url}`);

  return {
    page,
    close: async () => {
      await page.close().catch(() => undefined);
    },
  };
}
