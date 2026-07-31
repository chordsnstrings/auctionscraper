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
import { existsSync } from 'node:fs';
import { joinLane, type LiveObservation, type RoomSession } from './auctionroom.js';
import {
  SESSION_STATE_PATH,
  WATCHER_PAUSED_BACKOFF_MS,
  WATCHER_POLL_MS,
  WATCHER_RECONNECT_BASE_MS,
  WATCHER_RECONNECT_MAX_MS,
} from './config.js';
import {
  captureReport,
  closeDb,
  migrate,
  recordObservation,
  resolveWatch,
  watchlistFor,
  type WatchTarget,
} from './db.js';
import { Fetcher } from './fetcher.js';
import type { AuctionPayload } from './types.js';
import * as ui from './ui.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Route 1: authenticated capture from the auction room ──────────────────
//
// Implemented in auctionroom.ts: the watcher joins
// /auction-join?id={auctionId}&lane={lane} with the saved bidder session and
// reads prices off the room's websocket. See that file for why the frame
// schema is treated as unconfirmed rather than assumed.

// ── Lane worker ────────────────────────────────────────────────────────────

class LaneWorker {
  private readonly seen = new Set<string>();
  private backoff = WATCHER_RECONNECT_BASE_MS;
  private room: RoomSession | null = null;
  /** Best price seen per lot, keyed by lot number. */
  private readonly prices = new Map<number, LiveObservation>();

  constructor(
    private readonly fetcher: Fetcher,
    private readonly auctionId: string,
    private readonly lane: string,
  ) {}

  /** Lots on this lane, re-read from the DB every poll — never cached (§8.5). */
  private async targets(): Promise<WatchTarget[]> {
    return (await watchlistFor(this.auctionId)).filter((t) => (t.lane ?? '') === this.lane);
  }

  async run(stopAt: () => boolean): Promise<void> {
    ui.step(`lane ${this.lane}`, 'worker started');

    // Join the room first: the websocket is the only anonymous-invisible source
    // of a hammer price, and polling alone can only ever see sold/unsold.
    try {
      this.room = await joinLane(
        this.fetcher.browserContext(),
        this.auctionId,
        this.lane,
        (o) => this.onLive(o),
        (m) => ui.note(`lane ${this.lane}: ${m}`),
      );
    } catch (err) {
      ui.warn(`lane ${this.lane}: could not join room — ${(err as Error).message.slice(0, 80)}`);
      ui.note('falling back to poll-only capture; every unobserved lot is gap-flagged');
    }

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
      for (const t of await this.targets()) {
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

    await this.room?.close();
    await this.sweep();
  }

  /** A price from the room. Highest wins; a named final price always wins. */
  private onLive(o: LiveObservation): void {
    if (o.lotNo === null || o.amount === null) return;
    const prev = this.prices.get(o.lotNo);
    if (!prev || (o.confident && !prev.confident) || o.amount > (prev.amount ?? 0)) {
      this.prices.set(o.lotNo, o);
      ui.note(`lane ${this.lane}: lot ${o.lotNo} @ ${o.amount} (${o.via}${o.confident ? '' : ', unconfirmed'})`);
    }
  }

  /**
   * Close out the lane. Every remaining target gets a row — priced if the
   * socket parser produced one, gap-flagged otherwise. Never omitted (§8.4).
   */
  private async sweep(): Promise<void> {
    for (const t of await this.targets()) {
      const seen = t.lot_no !== null ? this.prices.get(Number(t.lot_no)) : undefined;

      // A price is only recorded when the room named it as a bid or sale. An
      // ambiguous match is reported as a gap carrying the candidate, so it can
      // be reconciled against the frame log rather than trusted as money.
      if (seen && seen.confident) {
        await recordObservation({
          vehicleId: t.vehicle_id,
          auctionId: this.auctionId,
          lane: this.lane,
          amount: seen.amount,
          source: 'socket',
          gapReason: null,
        });
        await resolveWatch(t.vehicle_id, seen.status ?? 'observed');
      } else {
        await recordObservation({
          vehicleId: t.vehicle_id,
          auctionId: this.auctionId,
          lane: this.lane,
          amount: null,
          source: seen ? 'socket' : 'poll',
          gapReason: seen
            ? `ambiguous price ${seen.amount} via "${seen.via}" — not confirmed as a bid or sale`
            : 'no price frame observed for this lot',
        });
        await resolveWatch(t.vehicle_id, 'unobserved');
      }
    }
  }
}

// ── Entry point ────────────────────────────────────────────────────────────

async function watch(): Promise<void> {
  ui.banner('Live auction watcher', 'watchlist only · reports, never bids');
  await migrate();

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
      const targets = await watchlistFor(id);
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

      const report = await captureReport(id);
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
    await closeDb();
  }

}

watch().catch((err: unknown) => {
  ui.fail(`watcher failed: ${(err as Error).stack ?? String(err)}`);
  process.exitCode = 1;
});
