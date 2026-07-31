/**
 * db.ts — Postgres via `pg` (§5).
 *
 * App Platform containers have no persistent disk, so the store is a managed
 * database rather than a local SQLite file. Everything below is async as a
 * consequence; the schema and the guarantees are otherwise unchanged.
 *
 * Two invariants the schema enforces rather than trusts:
 *   • `assessment` is append-only. There is no update path in this module.
 *   • VIN is the dedup key for relistings. One `vehicle` row per VIN; a
 *     returning lot appends an assessment rather than duplicating inventory.
 */
import { Pool, type PoolClient } from 'pg';
import { DATABASE_URL, DB_SSL } from './config.js';

/** Application-owned schema. See the search_path note in db(). */
const SCHEMA = (process.env.DB_SCHEMA ?? 'ecosine').replace(/[^a-z0-9_]/gi, '');

let pool: Pool | null = null;

export function db(): Pool {
  if (pool) return pool;
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is not set — the app cannot reach its database.');
  }
  // `sslmode` inside the connection string wins over the `ssl` option object,
  // and pg maps sslmode=require onto verify-full — which fails against managed
  // Postgres, whose CA the container does not carry. Strip the parameter so the
  // explicit ssl option below is what actually applies.
  //
  // The connection is still TLS-encrypted; only chain verification is relaxed,
  // and it never leaves DigitalOcean's private network. To tighten it, fetch the
  // cluster CA and pass it as `ssl.ca` instead.
  let connectionString = DATABASE_URL;
  let ssl: false | { rejectUnauthorized: boolean } = false;
  try {
    const url = new URL(DATABASE_URL);
    const mode = url.searchParams.get('sslmode');
    if (mode && mode !== 'disable') ssl = { rejectUnauthorized: false };
    url.searchParams.delete('sslmode');
    connectionString = url.toString();
  } catch {
    // Not a parsable URL (a libpq key=value DSN). Fall back to the flag.
    if (DB_SSL) ssl = { rejectUnauthorized: false };
  }

  pool = new Pool({
    connectionString,
    ssl,
    // Postgres 15 revoked CREATE on `public` from everyone but the database
    // owner, and managed providers hand out a non-owner role, so the app owns
    // its own schema instead.
    //
    // This is passed as a startup option rather than a `SET` statement on
    // purpose: `SET` binds to one pooled connection, so a later query served by
    // a different connection would silently fall back to `public` and fail.
    // The server applies `options` when each connection is established, so
    // every connection in the pool is identical by construction.
    options: `-c search_path=${SCHEMA},public`,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });

  return pool;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = null;
}

const q = async <T = unknown>(text: string, values: readonly unknown[] = []): Promise<T[]> =>
  (await db().query(text, values as unknown[])).rows as T[];

export const nowIso = (): string => new Date().toISOString();
export const today = (): string => new Date().toISOString().slice(0, 10);

// ── schema ─────────────────────────────────────────────────────────────────

export async function migrate(): Promise<void> {
  // Owned by the connecting role, so it has CREATE here even though Postgres 15
  // denies it on `public`. Explicitly named, so it does not depend on
  // search_path pointing anywhere useful yet.
  await q(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA} AUTHORIZATION CURRENT_USER`);

  // Belt and braces for the runtime queries, which use unqualified names.
  // Startup `options` and per-session `SET` are both discarded by a
  // transaction-pooling proxy; a role-level default survives it because the
  // server applies it when each backend session starts.
  await q(`ALTER ROLE CURRENT_USER SET search_path TO ${SCHEMA}, public`).catch(() => undefined);
  await q(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.vehicle (
      id                TEXT PRIMARY KEY,
      vin               TEXT,
      lot_no            BIGINT,
      url               TEXT NOT NULL,
      make              TEXT,
      model             TEXT,
      model_key         TEXT,
      year              INTEGER,
      description       TEXT,
      starting_bid      BIGINT,
      clean_title       BOOLEAN,           -- NULL ⇒ absent ⇒ unverified
      primary_damage    TEXT,
      secondary_damage  TEXT,              -- NULL when payload said "-"
      start_code        TEXT,
      mileage_km        BIGINT,
      auction_id        TEXT,
      lane              TEXT,
      photo             TEXT,
      raw               JSONB,
      first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      delisted_at       TIMESTAMPTZ
    );

    -- VIN dedup for relistings (§5). Partial: many rows legitimately have no
    -- VIN, and those must not collide with one another.
    CREATE UNIQUE INDEX IF NOT EXISTS vehicle_vin_uniq ON ${SCHEMA}.vehicle (vin) WHERE vin IS NOT NULL;
    CREATE INDEX IF NOT EXISTS vehicle_open ON ${SCHEMA}.vehicle (delisted_at);

    -- Immutable. One row per evaluation; re-runs append. Never updated.
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.assessment (
      id                BIGGENERATED,
      vehicle_id        TEXT NOT NULL REFERENCES ${SCHEMA}.vehicle(id),
      assessed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      config_version    TEXT NOT NULL,
      gate              TEXT NOT NULL,
      title_status      TEXT NOT NULL,
      gate_reason       TEXT,
      vision_json       JSONB,
      action            TEXT NOT NULL,
      fleet_ready_value BIGINT,
      repair_estimate   BIGINT,
      max_bid           BIGINT,
      margin_aed        BIGINT,
      reasons           JSONB
    );
    CREATE INDEX IF NOT EXISTS assessment_vehicle ON ${SCHEMA}.assessment (vehicle_id, assessed_at);

    CREATE TABLE IF NOT EXISTS ${SCHEMA}.price_history (
      id            BIGGENERATED,
      vehicle_id    TEXT NOT NULL REFERENCES ${SCHEMA}.vehicle(id),
      observed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      starting_bid  BIGINT,
      status        TEXT,
      auction_id    TEXT
    );
    CREATE INDEX IF NOT EXISTS price_history_vehicle ON ${SCHEMA}.price_history (vehicle_id);

    CREATE TABLE IF NOT EXISTS ${SCHEMA}.watchlist (
      vehicle_id   TEXT PRIMARY KEY REFERENCES ${SCHEMA}.vehicle(id),
      auction_id   TEXT,
      lot_no       BIGINT,
      lane         TEXT,
      sequence_no  INTEGER,
      max_bid      BIGINT,
      added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at  TIMESTAMPTZ,
      outcome      TEXT
    );
    CREATE INDEX IF NOT EXISTS watchlist_open ON ${SCHEMA}.watchlist (auction_id, resolved_at);

    -- amount IS NULL ⇒ gap_reason populated. A lot is never omitted (§8.4).
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.bid_observation (
      id           BIGGENERATED,
      vehicle_id   TEXT NOT NULL REFERENCES ${SCHEMA}.vehicle(id),
      auction_id   TEXT,
      lane         TEXT,
      observed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      amount       BIGINT,
      source       TEXT NOT NULL,
      gap_reason   TEXT,
      CONSTRAINT amount_or_gap CHECK (amount IS NOT NULL OR gap_reason IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS bid_observation_auction ON ${SCHEMA}.bid_observation (auction_id);

    CREATE TABLE IF NOT EXISTS ${SCHEMA}.sitemap_snapshot (
      lot_id   TEXT PRIMARY KEY,
      url      TEXT NOT NULL,
      seen_on  DATE NOT NULL
    );

    -- Prevents re-reporting a lot as NEW on a same-day re-run (§12).
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.digest_log (
      vehicle_id     TEXT PRIMARY KEY,
      first_sent_on  DATE NOT NULL,
      last_sent_on   DATE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ${SCHEMA}.run_log (
      id           BIGGENERATED,
      started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at  TIMESTAMPTZ,
      kind         TEXT NOT NULL,
      stats_json   JSONB
    );
  `.replace(/BIGGENERATED/g, 'BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY'));

  // The DDL above is schema-qualified, so it always lands correctly. The
  // runtime queries are not, so prove resolution works on a *fresh* connection
  // rather than discovering it mid-run at 06:00.
  await closeDb();
  const [check] = await q<{ resolved: string | null }>(`SELECT to_regclass('vehicle')::text AS resolved`);
  if (!check?.resolved) {
    throw new Error(
      `search_path does not resolve unqualified names to ${SCHEMA}. ` +
        `Set it on the database role, or qualify the runtime queries.`,
    );
  }
}

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
export async function upsertVehicle(v: VehicleUpsert): Promise<string> {
  const existing = v.vin
    ? await q<{ id: string }>(`SELECT id FROM vehicle WHERE vin = $1`, [v.vin])
    : [];
  const canonicalId = existing[0]?.id ?? v.id;

  await q(
    `INSERT INTO vehicle (
       id, vin, lot_no, url, make, model, model_key, year, description,
       starting_bid, clean_title, primary_damage, secondary_damage, start_code,
       mileage_km, auction_id, lane, photo, raw, first_seen_at, last_seen_at, delisted_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now(),now(),NULL)
     ON CONFLICT (id) DO UPDATE SET
       vin              = COALESCE(EXCLUDED.vin, vehicle.vin),
       lot_no           = EXCLUDED.lot_no,
       url              = EXCLUDED.url,
       starting_bid     = EXCLUDED.starting_bid,
       clean_title      = EXCLUDED.clean_title,
       primary_damage   = EXCLUDED.primary_damage,
       secondary_damage = EXCLUDED.secondary_damage,
       start_code       = EXCLUDED.start_code,
       mileage_km       = EXCLUDED.mileage_km,
       auction_id       = EXCLUDED.auction_id,
       lane             = EXCLUDED.lane,
       photo            = COALESCE(EXCLUDED.photo, vehicle.photo),
       raw              = EXCLUDED.raw,
       last_seen_at     = now(),
       delisted_at      = NULL`,
    [
      canonicalId, v.vin, v.lotNo, v.url, v.make, v.model, v.modelKey, v.year, v.description,
      v.startingBid, v.cleanTitle ?? null, v.primaryDamage, v.secondaryDamage, v.startCode,
      v.mileageKm, v.auctionId, v.lane, v.photo, JSON.stringify(v.raw ?? null),
    ],
  );
  return canonicalId;
}

export async function markDelisted(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await q(`UPDATE vehicle SET delisted_at = now() WHERE id = ANY($1) AND delisted_at IS NULL`, [ids]);
}

export async function knownVehicleIds(): Promise<Set<string>> {
  return new Set((await q<{ id: string }>(`SELECT id FROM vehicle`)).map((r) => r.id));
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

export async function appendAssessment(a: AssessmentRow): Promise<void> {
  await q(
    `INSERT INTO assessment (
       vehicle_id, config_version, gate, title_status, gate_reason,
       vision_json, action, fleet_ready_value, repair_estimate, max_bid, margin_aed, reasons
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      a.vehicleId, a.configVersion, a.gate, a.titleStatus, a.gateReason,
      a.vision ? JSON.stringify(a.vision) : null, a.action,
      a.fleetReadyValue, a.repairEstimate, a.maxBid, a.marginAed, JSON.stringify(a.reasons),
    ],
  );
}

// ── price_history ──────────────────────────────────────────────────────────

export async function recordPriceState(
  vehicleId: string,
  startingBid: number | null,
  status: string | null,
  auctionId: string | null,
): Promise<void> {
  await q(
    `INSERT INTO price_history (vehicle_id, starting_bid, status, auction_id) VALUES ($1,$2,$3,$4)`,
    [vehicleId, startingBid, status, auctionId],
  );
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

export async function addToWatchlist(e: WatchlistEntry): Promise<void> {
  await q(
    `INSERT INTO watchlist (vehicle_id, auction_id, lot_no, lane, sequence_no, max_bid)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (vehicle_id) DO UPDATE SET
       auction_id  = EXCLUDED.auction_id,
       lot_no      = EXCLUDED.lot_no,
       lane        = EXCLUDED.lane,
       sequence_no = EXCLUDED.sequence_no,
       max_bid     = EXCLUDED.max_bid`,
    [e.vehicleId, e.auctionId, e.lotNo, e.lane, e.sequenceNo, e.maxBid],
  );
}

export interface WatchTarget {
  vehicle_id: string;
  auction_id: string | null;
  lot_no: number | null;
  lane: string | null;
  sequence_no: number | null;
  max_bid: number | null;
}

export async function watchlistFor(auctionId: string): Promise<WatchTarget[]> {
  return q<WatchTarget>(
    `SELECT vehicle_id, auction_id, lot_no, lane, sequence_no, max_bid
     FROM watchlist WHERE auction_id = $1 AND resolved_at IS NULL`,
    [auctionId],
  );
}

export async function resolveWatch(vehicleId: string, outcome: string): Promise<void> {
  await q(`UPDATE watchlist SET resolved_at = now(), outcome = $2 WHERE vehicle_id = $1`, [
    vehicleId,
    outcome,
  ]);
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
export async function recordObservation(o: Observation): Promise<void> {
  await q(
    `INSERT INTO bid_observation (vehicle_id, auction_id, lane, amount, source, gap_reason)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [o.vehicleId, o.auctionId, o.lane, o.amount, o.source, o.gapReason],
  );
}

export interface CaptureReport {
  targets: number;
  captured: number;
  gaps: number;
  rate: number | null;
}

/** Treat capture rate as the system health metric; distrust comps below it (§8.4). */
export async function captureReport(auctionId: string): Promise<CaptureReport> {
  const [row] = await q<{ targets: string; captured: string; gaps: string }>(
    `SELECT
       (SELECT COUNT(*) FROM watchlist WHERE auction_id = $1) AS targets,
       (SELECT COUNT(DISTINCT vehicle_id) FROM bid_observation
          WHERE auction_id = $1 AND amount IS NOT NULL) AS captured,
       (SELECT COUNT(DISTINCT vehicle_id) FROM bid_observation
          WHERE auction_id = $1 AND amount IS NULL) AS gaps`,
    [auctionId],
  );
  const targets = Number(row?.targets ?? 0);
  const captured = Number(row?.captured ?? 0);
  return { targets, captured, gaps: Number(row?.gaps ?? 0), rate: targets ? captured / targets : null };
}

export async function latestCaptureRate(): Promise<number | null> {
  const [row] = await q<{ auction_id: string }>(
    `SELECT auction_id FROM watchlist WHERE auction_id IS NOT NULL ORDER BY added_at DESC LIMIT 1`,
  );
  return row ? (await captureReport(row.auction_id)).rate : null;
}

// ── sitemap_snapshot ───────────────────────────────────────────────────────

export async function previousSnapshot(): Promise<Map<string, string>> {
  const rows = await q<{ lot_id: string; url: string }>(`SELECT lot_id, url FROM sitemap_snapshot`);
  return new Map(rows.map((r) => [r.lot_id, r.url]));
}

export async function writeSnapshot(lots: readonly { id: string; url: string }[]): Promise<void> {
  const client: PoolClient = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM sitemap_snapshot');
    // One statement rather than N round trips — a full catalogue is thousands.
    for (let i = 0; i < lots.length; i += 500) {
      const chunk = lots.slice(i, i + 500);
      const values = chunk.map((_, k) => `($${k * 2 + 1}, $${k * 2 + 2}, CURRENT_DATE)`).join(',');
      await client.query(
        `INSERT INTO sitemap_snapshot (lot_id, url, seen_on) VALUES ${values}
         ON CONFLICT (lot_id) DO UPDATE SET url = EXCLUDED.url, seen_on = EXCLUDED.seen_on`,
        chunk.flatMap((l) => [l.id, l.url]),
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── digest_log ─────────────────────────────────────────────────────────────

/** True the first time a lot appears in a digest; re-runs do not re-badge (§12). */
export async function isFirstAppearance(vehicleId: string): Promise<boolean> {
  return (await q(`SELECT 1 FROM digest_log WHERE vehicle_id = $1`, [vehicleId])).length === 0;
}

export async function recordDigestAppearance(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await q(
    `INSERT INTO digest_log (vehicle_id, first_sent_on, last_sent_on)
     SELECT unnest($1::text[]), CURRENT_DATE, CURRENT_DATE
     ON CONFLICT (vehicle_id) DO UPDATE SET last_sent_on = EXCLUDED.last_sent_on`,
    [ids],
  );
}

// ── run_log ────────────────────────────────────────────────────────────────

export async function startRun(kind: string): Promise<number> {
  const [row] = await q<{ id: string }>(`INSERT INTO run_log (kind) VALUES ($1) RETURNING id`, [kind]);
  return Number(row?.id ?? 0);
}

export async function finishRun(id: number, stats: unknown): Promise<void> {
  await q(`UPDATE run_log SET finished_at = now(), stats_json = $2 WHERE id = $1`, [
    id,
    JSON.stringify(stats),
  ]);
}
