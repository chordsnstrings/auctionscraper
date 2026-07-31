/**
 * db.ts — SQLite via better-sqlite3, WAL mode (§5).
 *
 * Two invariants the schema enforces rather than trusts:
 *   • `assessment` is append-only. There is no update path in this module.
 *   • VIN is the dedup key for relistings. One `vehicle` row per VIN; a
 *     returning lot appends an assessment rather than duplicating inventory.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DB_PATH } from './config.js';

export type DB = Database.Database;

let handle: DB | null = null;

export function db(): DB {
  if (handle) return handle;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const d = new Database(DB_PATH);
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  d.pragma('busy_timeout = 5000');
  migrate(d);
  handle = d;
  return d;
}

function migrate(d: DB): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS vehicle (
      id                TEXT PRIMARY KEY,
      vin               TEXT,
      lot_no            INTEGER,
      url               TEXT NOT NULL,
      make              TEXT,
      model             TEXT,
      model_key         TEXT,
      year              INTEGER,
      description       TEXT,
      starting_bid      INTEGER,
      clean_title       INTEGER,          -- 1 | 0 | NULL (absent ⇒ unverified)
      primary_damage    TEXT,
      secondary_damage  TEXT,             -- NULL when payload said "-"
      start_code        TEXT,
      mileage_km        INTEGER,
      auction_id        TEXT,
      lane              TEXT,
      photo             TEXT,
      raw               TEXT,             -- full payload, verbatim
      first_seen_at     TEXT NOT NULL,
      last_seen_at      TEXT NOT NULL,
      delisted_at       TEXT
    );

    -- VIN dedup for relistings (§5). Partial index: many rows legitimately
    -- have no VIN, and those must not collide with each other.
    CREATE UNIQUE INDEX IF NOT EXISTS vehicle_vin_uniq
      ON vehicle (vin) WHERE vin IS NOT NULL;
    CREATE INDEX IF NOT EXISTS vehicle_open ON vehicle (delisted_at);

    -- Immutable. One row per evaluation; re-runs append. Never updated.
    CREATE TABLE IF NOT EXISTS assessment (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id      TEXT NOT NULL REFERENCES vehicle(id),
      assessed_at     TEXT NOT NULL,
      config_version  TEXT NOT NULL,
      gate            TEXT NOT NULL,
      title_status    TEXT NOT NULL,
      gate_reason     TEXT,
      vision_json     TEXT,
      action          TEXT NOT NULL,
      fleet_ready_value INTEGER,
      repair_estimate INTEGER,
      max_bid         INTEGER,
      margin_aed      INTEGER,
      reasons         TEXT
    );
    CREATE INDEX IF NOT EXISTS assessment_vehicle ON assessment (vehicle_id, assessed_at);

    -- Outcome + floor only, until §8 capture lands. Never a sale price.
    CREATE TABLE IF NOT EXISTS price_history (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id    TEXT NOT NULL REFERENCES vehicle(id),
      observed_at   TEXT NOT NULL,
      starting_bid  INTEGER,
      status        TEXT,
      auction_id    TEXT
    );
    CREATE INDEX IF NOT EXISTS price_history_vehicle ON price_history (vehicle_id);

    CREATE TABLE IF NOT EXISTS watchlist (
      vehicle_id   TEXT PRIMARY KEY REFERENCES vehicle(id),
      auction_id   TEXT,
      lot_no       INTEGER,
      lane         TEXT,
      sequence_no  INTEGER,
      max_bid      INTEGER,
      added_at     TEXT NOT NULL,
      resolved_at  TEXT,
      outcome      TEXT
    );
    CREATE INDEX IF NOT EXISTS watchlist_open ON watchlist (auction_id, resolved_at);

    -- amount IS NULL ⇒ gap_reason populated. A lot is never omitted (§8.4).
    CREATE TABLE IF NOT EXISTS bid_observation (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id   TEXT NOT NULL REFERENCES vehicle(id),
      auction_id   TEXT,
      lane         TEXT,
      observed_at  TEXT NOT NULL,
      amount       INTEGER,
      source       TEXT NOT NULL,        -- socket | poll | invoice
      gap_reason   TEXT,
      CHECK (amount IS NOT NULL OR gap_reason IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS bid_observation_auction ON bid_observation (auction_id);

    CREATE TABLE IF NOT EXISTS sitemap_snapshot (
      lot_id     TEXT PRIMARY KEY,
      url        TEXT NOT NULL,
      seen_on    TEXT NOT NULL
    );

    -- Prevents re-reporting a lot as NEW on a same-day re-run (§12).
    CREATE TABLE IF NOT EXISTS digest_log (
      vehicle_id     TEXT NOT NULL,
      first_sent_on  TEXT NOT NULL,
      last_sent_on   TEXT NOT NULL,
      PRIMARY KEY (vehicle_id)
    );

    CREATE TABLE IF NOT EXISTS run_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at   TEXT NOT NULL,
      finished_at  TEXT,
      kind         TEXT NOT NULL,
      stats_json   TEXT
    );
  `);
}

export const nowIso = (): string => new Date().toISOString();
export const today = (): string => new Date().toISOString().slice(0, 10);

// ── vehicle ────────────────────────────────────────────────────────────────

export interface VehicleUpsert {
  id: string;
  vin: string | null;
  lotNo: number | null;
  url: string;
  make: string | null;
  model: string | null;
  modelKey: string;
  year: number | null;
  description: string | null;
  startingBid: number | null;
  cleanTitle: boolean | undefined;
  primaryDamage: string | null;
  secondaryDamage: string | null;
  startCode: string | null;
  mileageKm: number | null;
  auctionId: string | null;
  lane: string | null;
  photo: string | null;
  raw: unknown;
}

/**
 * Returns the canonical vehicle id. When the VIN already exists under a
 * different lot id, the existing row is refreshed and its id returned — a
 * relisting is the same car, not new inventory (§5).
 */
export function upsertVehicle(v: VehicleUpsert): string {
  const d = db();
  const ts = nowIso();

  const existing = v.vin
    ? (d.prepare(`SELECT id FROM vehicle WHERE vin = ?`).get(v.vin) as { id: string } | undefined)
    : undefined;
  const canonicalId = existing?.id ?? v.id;

  d.prepare(
    `INSERT INTO vehicle (
       id, vin, lot_no, url, make, model, model_key, year, description,
       starting_bid, clean_title, primary_damage, secondary_damage, start_code,
       mileage_km, auction_id, lane, photo, raw, first_seen_at, last_seen_at, delisted_at
     ) VALUES (
       @id, @vin, @lotNo, @url, @make, @model, @modelKey, @year, @description,
       @startingBid, @cleanTitle, @primaryDamage, @secondaryDamage, @startCode,
       @mileageKm, @auctionId, @lane, @photo, @raw, @ts, @ts, NULL
     )
     ON CONFLICT(id) DO UPDATE SET
       vin = COALESCE(excluded.vin, vehicle.vin),
       lot_no = excluded.lot_no,
       url = excluded.url,
       starting_bid = excluded.starting_bid,
       clean_title = excluded.clean_title,
       primary_damage = excluded.primary_damage,
       secondary_damage = excluded.secondary_damage,
       start_code = excluded.start_code,
       mileage_km = excluded.mileage_km,
       auction_id = excluded.auction_id,
       lane = excluded.lane,
       photo = COALESCE(excluded.photo, vehicle.photo),
       raw = excluded.raw,
       last_seen_at = excluded.last_seen_at,
       delisted_at = NULL`,
  ).run({
    ...v,
    id: canonicalId,
    cleanTitle: v.cleanTitle === undefined ? null : v.cleanTitle ? 1 : 0,
    raw: JSON.stringify(v.raw),
    ts,
  });

  return canonicalId;
}

export function markDelisted(ids: readonly string[]): void {
  if (ids.length === 0) return;
  const d = db();
  const stmt = d.prepare(`UPDATE vehicle SET delisted_at = ? WHERE id = ? AND delisted_at IS NULL`);
  const ts = nowIso();
  d.transaction(() => ids.forEach((id) => stmt.run(ts, id)))();
}

export function openVehicleIds(): string[] {
  return (db().prepare(`SELECT id FROM vehicle WHERE delisted_at IS NULL`).all() as { id: string }[]).map(
    (r) => r.id,
  );
}

// ── assessment (append-only) ───────────────────────────────────────────────

export interface AssessmentRow {
  vehicleId: string;
  configVersion: string;
  gate: string;
  titleStatus: string;
  gateReason: string | null;
  vision: unknown | null;
  action: string;
  fleetReadyValue: number | null;
  repairEstimate: number | null;
  maxBid: number | null;
  marginAed: number | null;
  reasons: readonly string[];
}

export function appendAssessment(a: AssessmentRow): void {
  db()
    .prepare(
      `INSERT INTO assessment (
         vehicle_id, assessed_at, config_version, gate, title_status, gate_reason,
         vision_json, action, fleet_ready_value, repair_estimate, max_bid, margin_aed, reasons
       ) VALUES (
         @vehicleId, @assessedAt, @configVersion, @gate, @titleStatus, @gateReason,
         @visionJson, @action, @fleetReadyValue, @repairEstimate, @maxBid, @marginAed, @reasons
       )`,
    )
    .run({
      ...a,
      assessedAt: nowIso(),
      visionJson: a.vision ? JSON.stringify(a.vision) : null,
      reasons: JSON.stringify(a.reasons),
    });
}

// ── price_history ──────────────────────────────────────────────────────────

export function recordPriceState(
  vehicleId: string,
  startingBid: number | null,
  status: string | null,
  auctionId: string | null,
): void {
  db()
    .prepare(
      `INSERT INTO price_history (vehicle_id, observed_at, starting_bid, status, auction_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(vehicleId, nowIso(), startingBid, status, auctionId);
}

// ── watchlist / bid_observation ────────────────────────────────────────────

export interface WatchlistEntry {
  vehicleId: string;
  auctionId: string | null;
  lotNo: number | null;
  lane: string | null;
  sequenceNo: number | null;
  maxBid: number | null;
}

export function addToWatchlist(e: WatchlistEntry): void {
  db()
    .prepare(
      `INSERT INTO watchlist (vehicle_id, auction_id, lot_no, lane, sequence_no, max_bid, added_at)
       VALUES (@vehicleId, @auctionId, @lotNo, @lane, @sequenceNo, @maxBid, @addedAt)
       ON CONFLICT(vehicle_id) DO UPDATE SET
         auction_id = excluded.auction_id,
         lot_no = excluded.lot_no,
         lane = excluded.lane,
         sequence_no = excluded.sequence_no,
         max_bid = excluded.max_bid`,
    )
    .run({ ...e, addedAt: nowIso() });
}

export interface WatchTarget {
  vehicle_id: string;
  auction_id: string | null;
  lot_no: number | null;
  lane: string | null;
  sequence_no: number | null;
  max_bid: number | null;
}

export function watchlistFor(auctionId: string): WatchTarget[] {
  return db()
    .prepare(`SELECT * FROM watchlist WHERE auction_id = ? AND resolved_at IS NULL`)
    .all(auctionId) as WatchTarget[];
}

export function resolveWatch(vehicleId: string, outcome: string): void {
  db()
    .prepare(`UPDATE watchlist SET resolved_at = ?, outcome = ? WHERE vehicle_id = ?`)
    .run(nowIso(), outcome, vehicleId);
}

export interface Observation {
  vehicleId: string;
  auctionId: string | null;
  lane: string | null;
  amount: number | null;
  source: 'socket' | 'poll' | 'invoice';
  gapReason: string | null;
}

/** A lot the watcher failed to observe is written with amount NULL (§8.4). */
export function recordObservation(o: Observation): void {
  db()
    .prepare(
      `INSERT INTO bid_observation (vehicle_id, auction_id, lane, observed_at, amount, source, gap_reason)
       VALUES (@vehicleId, @auctionId, @lane, @observedAt, @amount, @source, @gapReason)`,
    )
    .run({ ...o, observedAt: nowIso() });
}

export interface CaptureReport {
  targets: number;
  captured: number;
  gaps: number;
  rate: number | null;
}

/** Treat capture rate as the system health metric; distrust comps below it (§8.4). */
export function captureReport(auctionId: string): CaptureReport {
  const d = db();
  const targets = (
    d.prepare(`SELECT COUNT(*) n FROM watchlist WHERE auction_id = ?`).get(auctionId) as { n: number }
  ).n;
  const captured = (
    d
      .prepare(
        `SELECT COUNT(DISTINCT vehicle_id) n FROM bid_observation
         WHERE auction_id = ? AND amount IS NOT NULL`,
      )
      .get(auctionId) as { n: number }
  ).n;
  const gaps = (
    d
      .prepare(
        `SELECT COUNT(DISTINCT vehicle_id) n FROM bid_observation
         WHERE auction_id = ? AND amount IS NULL`,
      )
      .get(auctionId) as { n: number }
  ).n;
  return { targets, captured, gaps, rate: targets ? captured / targets : null };
}

export function latestCaptureRate(): number | null {
  const row = db()
    .prepare(
      `SELECT auction_id FROM watchlist
       WHERE auction_id IS NOT NULL
       ORDER BY added_at DESC LIMIT 1`,
    )
    .get() as { auction_id: string } | undefined;
  return row ? captureReport(row.auction_id).rate : null;
}

// ── sitemap_snapshot ───────────────────────────────────────────────────────

export function previousSnapshot(): Map<string, string> {
  const rows = db().prepare(`SELECT lot_id, url FROM sitemap_snapshot`).all() as {
    lot_id: string;
    url: string;
  }[];
  return new Map(rows.map((r) => [r.lot_id, r.url]));
}

export function writeSnapshot(lots: readonly { id: string; url: string }[]): void {
  const d = db();
  const seen = today();
  d.transaction(() => {
    d.prepare(`DELETE FROM sitemap_snapshot`).run();
    const stmt = d.prepare(`INSERT OR REPLACE INTO sitemap_snapshot (lot_id, url, seen_on) VALUES (?, ?, ?)`);
    for (const l of lots) stmt.run(l.id, l.url, seen);
  })();
}

// ── digest_log ─────────────────────────────────────────────────────────────

/**
 * True the first time a lot appears in a digest. Re-running the same day
 * does not re-badge it as NEW (§12).
 */
export function isFirstAppearance(vehicleId: string): boolean {
  return !db().prepare(`SELECT 1 FROM digest_log WHERE vehicle_id = ?`).get(vehicleId);
}

export function recordDigestAppearance(ids: readonly string[]): void {
  if (ids.length === 0) return;
  const d = db();
  const day = today();
  const stmt = d.prepare(
    `INSERT INTO digest_log (vehicle_id, first_sent_on, last_sent_on) VALUES (?, ?, ?)
     ON CONFLICT(vehicle_id) DO UPDATE SET last_sent_on = excluded.last_sent_on`,
  );
  d.transaction(() => ids.forEach((id) => stmt.run(id, day, day)))();
}

// ── run_log ────────────────────────────────────────────────────────────────

export function startRun(kind: string): number {
  const info = db().prepare(`INSERT INTO run_log (started_at, kind) VALUES (?, ?)`).run(nowIso(), kind);
  return Number(info.lastInsertRowid);
}

export function finishRun(id: number, stats: unknown): void {
  db()
    .prepare(`UPDATE run_log SET finished_at = ?, stats_json = ? WHERE id = ?`)
    .run(nowIso(), JSON.stringify(stats), id);
}
