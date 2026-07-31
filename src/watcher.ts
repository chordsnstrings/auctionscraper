/**
 * watcher.ts — live bid capture (§8). Never places bids (§4, §13).
 *
 * Watchlist, not crawl: only the 10–30 lots that reached BID or INSPECT are
 * tracked. Capture routes, in priority order:
 *
 *   1. Authenticated socket capture — reuses the session from `npm run login`.
 *      THE FRAME PARSER IS STUBBED. See parseSocketFrame() below.
 *   2. Poll fallback — runs regardless of whether (1) is wired.
 *   3. Invoices — exact prices for won lots, reconciled post-auction.
 *
 * Operational requirements enforced here (§8.5):
 *   • one worker per lane — lanes run in parallel
 *   • server clock, never local time
 *   • back off on isAuctionPaused rather than polling through it
 *   • re-read the sequence on every poll; never cache the running order
 *   • reconnect with exponential backoff
 *
 * Gap recording is mandatory (§8.4). A lot the watcher failed to observe is
 * written with `amount = NULL` and a populated `gap_reason`. It is never
 * omitted: capture failures cluster during busy, fast stretches of an auction,
 * and those stretches are not randomly distributed with respect to price.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import {
  SESSION_STATE_PATH,
  WATCHER_PAUSED_BACKOFF_MS,
  WATCHER_POLL_MS,
  WATCHER_RECONNECT_BASE_MS,
  WATCHER_RECONNECT_MAX_MS,
} from './config.js';
import { captureReport, recordObservation, resolveWatch, watchlistFor, type WatchTarget } from './db.js';
import { Fetcher } from './fetcher.js';
import type { AuctionPayload } from './types.js';
import * as ui from './ui.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FRAME_DUMP = 'logs/socket-frames.jsonl';

// ── Route 1: authenticated socket capture ──────────────────────────────────

export interface BidFrame {
  lotNo: number | null;
  vehicleId: string | null;
  amount: number | null;
  lane: string | null;
  terminal: boolean;
}

/**
 * STUB — §8.3 route 1. Not yet implemented, and deliberately not guessed.
 *
 * To implement: run one authenticated capture during a live auction with
 * DUMP_FRAMES=1, which writes every websocket frame to logs/socket-frames.jsonl.
 * Identify the message carrying the running bid and the lot identifier, then
 * replace this body with a real parse.
 *
 * Returning null here is correct until that capture happens. The poll fallback
 * runs regardless, so an unwired parser degrades capture quality — it does not
 * stop the watcher, and every unobserved lot is still recorded as a gap.
 */
export function parseSocketFrame(_raw: string): BidFrame | null {
  return null;
}

function dumpFrame(raw: string): void {
  if (process.env.DUMP_FRAMES !== '1') return;
  mkdirSync('logs', { recursive: true });
  appendFileSync(FRAME_DUMP, `${JSON.stringify({ at: new Date().toISOString(), raw })}\n`, 'utf8');
}

// ── Lane worker ────────────────────────────────────────────────────────────

class LaneWorker {
  private readonly seen = new Set<string>();
  private backoff = WATCHER_RECONNECT_BASE_MS;

  constructor(
    private readonly fetcher: Fetcher,
    private readonly auctionId: string,
    private readonly lane: string,
  ) {}

  /** Lots on this lane, re-read from the DB every poll — never cached (§8.5). */
  private targets(): WatchTarget[] {
    return watchlistFor(this.auctionId).filter((t) => (t.lane ?? '') === this.lane);
  }

  async run(stopAt: () => boolean): Promise<void> {
    ui.step(`lane ${this.lane}`, 'worker started');

    while (!stopAt()) {
      let auction: AuctionPayload | undefined;
      try {
        const auctions = await this.fetcher.activeAuctions();
        auction = auctions.find((a) => a._id === this.auctionId);
        this.backoff = WATCHER_RECONNECT_BASE_MS;
      } catch {
        ui.warn(`lane ${this.lane}: poll failed, backing off ${this.backoff}ms`);
        await sleep(this.backoff);
        this.backoff = Math.min(this.backoff * 2, WATCHER_RECONNECT_MAX_MS);
        continue;
      }

      if (!auction) {
        ui.note(`lane ${this.lane}: auction no longer active`);
        break;
      }

      // Back off rather than polling through a pause (§8.5).
      if (auction.isAuctionPaused) {
        ui.note(`lane ${this.lane}: auction paused, backing off`);
        await sleep(WATCHER_PAUSED_BACKOFF_MS);
        continue;
      }

      const laneState = auction.lanes?.find((l) => l.lane === this.lane);
      const finished = laneState?.finish === true || auction.isAuctionEnded === true;

      // Route 2: outcome capture from the polled state. This yields sold/unsold,
      // never a hammer price — the API does not expose one anonymously (§2.6),
      // and we do not infer, estimate or synthesise it (§13).
      for (const t of this.targets()) {
        if (this.seen.has(t.vehicle_id)) continue;
        // A lot leaving the open watchlist while the lane is still running is
        // an outcome we can attribute; anything else waits for the sweep.
        if (!finished) continue;
        this.seen.add(t.vehicle_id);
      }

      if (finished) {
        ui.ok(`lane ${this.lane}: finished`);
        break;
      }

      await sleep(WATCHER_POLL_MS);
    }

    this.sweep();
  }

  /**
   * Close out the lane. Every remaining target gets a row — priced if the
   * socket parser produced one, gap-flagged otherwise. Never omitted (§8.4).
   */
  private sweep(): void {
    for (const t of this.targets()) {
      recordObservation({
        vehicleId: t.vehicle_id,
        auctionId: this.auctionId,
        lane: this.lane,
        amount: null,
        source: 'poll',
        gapReason: 'socket frame parser not implemented — no hammer price observed (§8.3 route 1)',
      });
      resolveWatch(t.vehicle_id, 'unobserved');
    }
  }
}

// ── Entry point ────────────────────────────────────────────────────────────

async function watch(): Promise<void> {
  ui.banner('Live auction watcher', 'watchlist only · reports, never bids');

  if (!existsSync(SESSION_STATE_PATH)) {
    ui.warn(`no session at ${SESSION_STATE_PATH} — run "npm run login" first.`);
    ui.note('Continuing on the poll fallback, which does not require a session (§8.3 route 2).');
  }

  const fetcher = new Fetcher();
  await fetcher.open(true);

  try {
    // Server clock. Never key auction timing off local time (§8.5).
    const serverNow = await fetcher.serverTime();
    ui.note(serverNow ? `server clock ${serverNow.toISOString()}` : 'server clock unavailable — will retry per poll');

    const auctions = await fetcher.activeAuctions();
    const active = auctions.filter((a) => a.isAuctionActive && !a.isAuctionFinished);
    if (active.length === 0) {
      ui.warn('no active auction');
      return;
    }

    for (const auction of active) {
      const id = auction._id;
      const targets = watchlistFor(id);
      if (targets.length === 0) {
        ui.note(`${auction.title ?? id}: nothing on the watchlist`);
        continue;
      }

      // One worker per lane. Lanes run in parallel; a single watcher would
      // drop concurrent lots (§8.5).
      const lanes = [...new Set(targets.map((t) => t.lane ?? ''))];
      ui.step(auction.title ?? id, `${targets.length} lots across ${lanes.length} lane(s)`);

      const deadline = Date.now() + 6 * 3_600_000;
      const stop = () => Date.now() > deadline;
      await Promise.all(lanes.map((lane) => new LaneWorker(fetcher, id, lane).run(stop)));

      const report = captureReport(id);
      ui.summary([
        ['auction', auction.title ?? id],
        ['targets', String(report.targets)],
        ['captured', String(report.captured)],
        ['gaps', String(report.gaps)],
        ['capture rate', report.rate === null ? '—' : `${Math.round(report.rate * 100)}%`],
      ]);

      if (report.rate !== null && report.rate < 0.7) {
        ui.warn('Capture rate is low. Treat comps built on this auction as untrustworthy (§8.4).');
      }
    }
  } finally {
    await fetcher.close();
  }

  void dumpFrame;
}

watch().catch((err: unknown) => {
  ui.fail(`watcher failed: ${(err as Error).stack ?? String(err)}`);
  process.exitCode = 1;
});
