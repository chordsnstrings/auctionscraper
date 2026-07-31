/**
 * config.ts — every tunable value. No logic (§4).
 *
 * Anything that changes a buy decision lives here and is hashed into
 * CONFIG_VERSION, so any past `assessment` row can be reconstructed (§5).
 */
import { createHash } from 'node:crypto';
import 'dotenv/config';

// ── Source ──────────────────────────────────────────────────────────────────
// Al Qaryah only (§10). No adapter layer, no per-source fee configuration.

export const SITE_ORIGIN = 'https://www.alqaryahauction.com';
export const API_ORIGIN = 'https://erpapiv1.alqaryahauction.com';
export const ROOT_SITEMAP = `${SITE_ORIGIN}/sitemap.xml`;
export const VEHICLE_SITEMAP = `${SITE_ORIGIN}/sitemaps/vehicle/sitemap.xml`;

/** Matches any API response we want to intercept during render (§6.3). */
export const API_RESPONSE_PATTERN = /erpapiv1?\.alqaryahauction\.com/;

// ── Crawl / render budget ───────────────────────────────────────────────────

export const SITEMAP_DELAY_MS = 150;
/**
 * Parallel browser pages. Chromium peaks near 865 MB with a single page, so on
 * the 1 GB App Platform container this stays at 1; raise it only on a box with
 * headroom to spare.
 */
export const CONCURRENCY = Number(process.env.CONCURRENCY ?? 1);
export const DELAY_MS = Number(process.env.DELAY_MS ?? 1200);

/** Acceptance criterion: a full run renders no more than ~400 pages (§12). */
export const MAX_RENDERS_PER_RUN = 400;
/** Cap on already-known open lots re-checked alongside new arrivals (§6.2). */
export const RECHECK_CAP = 80;

export const NAV_TIMEOUT_MS = 45_000;
export const API_CAPTURE_TIMEOUT_MS = 20_000;

/** Behind a TLS-intercepting proxy Playwright contexts need this (§2.1). */
export const IGNORE_HTTPS_ERRORS = true;

/**
 * Chromium launch arguments, in one place because getting them wrong fails at
 * the container and nowhere else.
 *
 * `--no-sandbox` is not optional here: the image runs as root, and Chromium
 * refuses to start as root with the sandbox on. `--disable-dev-shm-usage`
 * matters for the same reason — the default /dev/shm in a container is 64 MB,
 * which Chromium exhausts and then crashes mid-render.
 */
export const BROWSER_LAUNCH_ARGS: readonly string[] = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

/**
 * Headers for plain `fetch`, which sends almost nothing by default.
 *
 * These are NOT for a Playwright context. They describe a top-level
 * navigation — `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`,
 * `Accept: text/html`, `Upgrade-Insecure-Requests` — and Playwright's
 * `extraHTTPHeaders` applies whatever it is given to *every* request, so
 * setting them on a context stamps "I am a page navigation" onto every script,
 * stylesheet and XHR the page makes. No real browser does that, and Cloudflare
 * drops those subresource requests: the detail page then loads its document,
 * fetches nothing else at all, and the SPA never calls the API. Use
 * CONTEXT_EXTRA_HEADERS for a browser.
 */
export const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Ch-Ua': '"Chromium";v="131", "Not_A Brand";v="24"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"macOS"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * What a Playwright context may add on top of what Chromium already sends.
 *
 * Only headers that are the same on every request regardless of what is being
 * fetched. Everything per-request — `Accept`, `Accept-Encoding`, the whole
 * `Sec-Fetch-*` family, `Upgrade-Insecure-Requests` — is Chromium's to set, and
 * it sets them consistently with the rest of its fingerprint. Overriding them
 * is what made the SPA load its shell and then nothing else.
 *
 * `User-Agent` is absent deliberately: it is a context option, not an extra
 * header, so that navigator.userAgent agrees with the wire.
 */
export const CONTEXT_EXTRA_HEADERS: Record<string, string> = Object.fromEntries(
  Object.entries(BROWSER_HEADERS).filter(([k]) =>
    /^(?:Accept-Language|Sec-Ch-Ua|Sec-Ch-Ua-Mobile|Sec-Ch-Ua-Platform)$/i.test(k),
  ),
);

// ── Pre-gate (§6.2) — free, runs on URL fields before any browser work ──────

export const MIN_MODEL_YEAR = 2021;

/**
 * `make|model` slugs Ecosine will operate. Lowercase, non-alphanumerics
 * collapsed to a single `-` before matching.
 */
export const TARGET_MODELS: ReadonlySet<string> = new Set([
  'toyota|camry',
  'toyota|corolla',
  'toyota|yaris',
  'toyota|hiace',
  'toyota|land-cruiser',
  'toyota|rav4',
  'nissan|altima',
  'nissan|sunny',
  'nissan|sentra',
  'nissan|urvan',
  'nissan|patrol',
  'nissan|x-trail',
  'honda|accord',
  'honda|civic',
  'honda|cr-v',
  'hyundai|elantra',
  'hyundai|sonata',
  'hyundai|accent',
  'hyundai|tucson',
  'hyundai|h1',
  'kia|k5',
  'kia|optima',
  'kia|cerato',
  'kia|sportage',
  'kia|carnival',
  'mitsubishi|lancer',
  'mitsubishi|attrage',
  'mitsubishi|pajero',
  'chevrolet|malibu',
  'chevrolet|captiva',
  'mazda|mazda6',
  'mazda|cx-5',
  'volkswagen|passat',
  'ford|transit',
]);

// ── Gate (§6.4) ─────────────────────────────────────────────────────────────

/**
 * Safety net only. `clean_title` is the structured gate; these patterns catch
 * narration that contradicts it. Never used to *promote* a lot (§1.3).
 */
export const TITLE_KILL_PATTERNS: readonly RegExp[] = [
  /\bsalvage\b/i,
  /\bwrite[\s-]?off\b/i,
  /\bwritten[\s-]?off\b/i,
  /\btotal(?:ed|led)?\s+loss\b/i,
  /\bscrap(?:ped)?\b/i,
  /\bflood(?:ed|\s*damage)?\b/i,
  /\bwater\s*damage\b/i,
  /\bsubmerg/i,
  /\bcertificate\s+of\s+destruction\b/i,
  /\bnon[\s-]?repairable\b/i,
  /\bchassis\s+(?:bent|damaged?|cut)\b/i,
  /\bstructural(?:ly)?\s+(?:damaged?|repaired?|compromised)\b/i,
  /\bburn(?:t|ed)?\b/i,
  /\bfire\s+damage\b/i,
];

/** Start codes accepted without an UNVERIFIED flag (§6.4 step 6). */
export const RUN_AND_DRIVE_CODES: ReadonlySet<string> = new Set(['R & D', 'R&D', 'RD']);

// ── Vision (§6.5) ───────────────────────────────────────────────────────────

export const VISION_ENABLED = process.env.VISION_ENABLED !== 'false';

/**
 * Which vision provider assesses damage.
 *
 * ModelArk is the default: it is the account that actually holds a working key,
 * it is roughly two orders of magnitude cheaper per lot than a frontier model,
 * and the assessment it returns is a tier plus a repair range — a bounded,
 * well-specified judgement rather than open-ended reasoning. Anthropic remains
 * selectable for a side-by-side calibration run (§11 step 1), which is the one
 * situation where paying frontier prices per lot is worth it.
 */
export type VisionProvider = 'modelark' | 'anthropic';
export const VISION_PROVIDER: VisionProvider =
  process.env.VISION_PROVIDER === 'anthropic' ? 'anthropic' : 'modelark';

/** BytePlus ModelArk, OpenAI-compatible surface. Singapore endpoint by default. */
export const ARK_BASE_URL = (
  process.env.ARK_BASE_URL ?? 'https://ark.ap-southeast.bytepluses.com/api/v3'
).replace(/\/+$/, '');
export const ARK_API_KEY = process.env.ARK_API_KEY ?? '';
/** Seed 2.0 Pro: image understanding, strict JSON schema output, adaptive reasoning. */
export const ARK_VISION_MODEL = process.env.ARK_VISION_MODEL ?? 'seed-2-0-pro-260328';
export const ANTHROPIC_VISION_MODEL = 'claude-opus-5';

/**
 * Vision is the only paid stage and must never see a lot a free check could
 * have killed (§3). The effective model id is hashed into CONFIG_VERSION, so
 * switching provider re-versions every assessment written afterwards.
 */
export const VISION_MODEL = VISION_PROVIDER === 'modelark' ? ARK_VISION_MODEL : ANTHROPIC_VISION_MODEL;
export const VISION_EFFORT: 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'medium';
export const VISION_MAX_TOKENS = 8_000;
export const VISION_MAX_PHOTOS = 6;
export const VISION_MIN_CONFIDENCE = 0.55;
/** Transient ModelArk failures (429, 5xx, socket resets) are retried this many times. */
export const VISION_RETRIES = 3;

/**
 * ModelArk fetches remote image URLs from its own egress, where the auction
 * CDN's bot rules apply to a stranger rather than to our session. Photos are
 * therefore inlined as base64 from inside this container, which is also the
 * only route that works once Cloudflare is in play. These bound that.
 */
export const PHOTO_MAX_BYTES = 5_000_000;
export const PHOTO_TIMEOUT_MS = 20_000;

// ── Economics (§7) ──────────────────────────────────────────────────────────

/** Single global value. Not per-source (§4.1). */
export const AUCTION_FEE_PCT = 0.05;
export const VAT_PCT = 0.05;

export const TARGET_MARGIN_PCT = 0.22;
/** Flat. Standing rule since 05-Jun-2026. */
export const HIDDEN_DAMAGE_RESERVE_AED = 3_000;
/** RTA inspection, insurance uplift, GPS, signage. */
export const RTA_COMPLIANCE_COST_AED = 6_500;
export const LOGISTICS_AED = 750;

/** Which end of the vision repair range feeds the ceiling. */
export const REPAIR_ESTIMATE_BASIS: 'low' | 'mid' | 'high' = 'high';

/** Auto-drop regardless of price (§7.2). */
export const MAX_DAMAGE_TIER = 3;

export const BID_ROUNDING_AED = 100;

// ── Fleet-ready values (§7.1a) ──────────────────────────────────────────────

export interface FleetReadyEntry {
  /** Retail value in AED of a repaired, inspected, plated car. */
  aed: number;
  /** ISO date. Entries older than FLEET_VALUE_STALE_DAYS warn in the digest. */
  reviewed_on: string;
}

/**
 * Keyed make|model → year → entry. Exact match only. A missing entry returns
 * null — no interpolation, no nearest-year fallback, no cross-model averaging.
 * Reviewed quarterly by purchasing, not edited ad hoc mid-cycle.
 */
export const FLEET_READY_VALUES: Record<string, Record<number, FleetReadyEntry>> = {
  'toyota|camry': {
    2024: { aed: 78_000, reviewed_on: '2026-07-01' },
    2025: { aed: 88_000, reviewed_on: '2026-07-01' },
    2026: { aed: 96_000, reviewed_on: '2026-07-01' },
  },
  'toyota|corolla': {
    2024: { aed: 62_000, reviewed_on: '2026-07-01' },
    2025: { aed: 70_000, reviewed_on: '2026-07-01' },
    2026: { aed: 76_000, reviewed_on: '2026-07-01' },
  },
  'nissan|altima': {
    2024: { aed: 62_000, reviewed_on: '2026-07-01' },
    2025: { aed: 70_000, reviewed_on: '2026-07-01' },
    2026: { aed: 78_000, reviewed_on: '2026-07-01' },
  },
  'nissan|sunny': {
    2024: { aed: 44_000, reviewed_on: '2026-07-01' },
    2025: { aed: 49_000, reviewed_on: '2026-07-01' },
    2026: { aed: 54_000, reviewed_on: '2026-07-01' },
  },
  'honda|accord': {
    2024: { aed: 74_000, reviewed_on: '2026-07-01' },
    2025: { aed: 82_000, reviewed_on: '2026-07-01' },
    2026: { aed: 90_000, reviewed_on: '2026-07-01' },
  },
  'hyundai|elantra': {
    2024: { aed: 55_000, reviewed_on: '2026-07-01' },
    2025: { aed: 61_000, reviewed_on: '2026-07-01' },
    2026: { aed: 67_000, reviewed_on: '2026-07-01' },
  },
  'kia|k5': {
    2024: { aed: 63_000, reviewed_on: '2026-07-01' },
    2025: { aed: 70_000, reviewed_on: '2026-07-01' },
    2026: { aed: 77_000, reviewed_on: '2026-07-01' },
  },
  'mitsubishi|attrage': {
    2024: { aed: 40_000, reviewed_on: '2026-07-01' },
    2025: { aed: 45_000, reviewed_on: '2026-07-01' },
    2026: { aed: 49_000, reviewed_on: '2026-07-01' },
  },
  // Extend from what the calibration crawl (§11 step 1) actually surfaces.
};

export const FLEET_VALUE_STALE_DAYS = 90;

// ── Digest (§9) ─────────────────────────────────────────────────────────────

/** Send even when empty, so silence is never mistaken for a healthy run. */
export const SEND_EMPTY_DIGEST = true;
export const CLOSING_SOON_HOURS = 24;
export const DIGEST_TIMEZONE = 'Asia/Dubai';
export const DIGEST_DRY_RUN = process.env.DIGEST_DRY_RUN === 'true';

export const SMTP = {
  host: process.env.SMTP_HOST ?? '',
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: process.env.SMTP_SECURE === 'true',
  user: process.env.SMTP_USER ?? '',
  pass: process.env.SMTP_PASS ?? '',
  from: process.env.DIGEST_FROM ?? 'Ecosine Auction Intelligence <auctions@ecosine.ae>',
  to: process.env.DIGEST_TO ?? '',
} as const;

// ── Watcher (§8) ────────────────────────────────────────────────────────────

export const SESSION_STATE_PATH = process.env.SESSION_STATE_PATH ?? 'data/session.json';

/**
 * Postgres connection string. App Platform injects this from the attached
 * database component as ${db.DATABASE_URL}; locally it comes from .env.
 */
export const DATABASE_URL = process.env.DATABASE_URL ?? '';
/** Managed Postgres presents a CA the container does not carry. */
export const DB_SSL = process.env.DB_SSL !== 'false' && /(^|[?&])sslmode=require/.test(DATABASE_URL);

export const WATCHER_POLL_MS = 4_000;
export const WATCHER_PAUSED_BACKOFF_MS = 30_000;
export const WATCHER_RECONNECT_BASE_MS = 1_000;
export const WATCHER_RECONNECT_MAX_MS = 60_000;
/** Refresh the session this long before the auction window, not reactively. */
export const SESSION_REFRESH_LEAD_MIN = 45;

// ── Config version ──────────────────────────────────────────────────────────

/**
 * Hash of every value that can change a decision. Stamped onto each
 * `assessment` row so a past decision can be reconstructed exactly (§5).
 */
export const CONFIG_VERSION: string = createHash('sha256')
  .update(
    JSON.stringify({
      MIN_MODEL_YEAR,
      TARGET_MODELS: [...TARGET_MODELS].sort(),
      TITLE_KILL_PATTERNS: TITLE_KILL_PATTERNS.map((r) => r.source),
      RUN_AND_DRIVE_CODES: [...RUN_AND_DRIVE_CODES].sort(),
      AUCTION_FEE_PCT,
      VAT_PCT,
      TARGET_MARGIN_PCT,
      HIDDEN_DAMAGE_RESERVE_AED,
      RTA_COMPLIANCE_COST_AED,
      LOGISTICS_AED,
      REPAIR_ESTIMATE_BASIS,
      MAX_DAMAGE_TIER,
      BID_ROUNDING_AED,
      VISION_PROVIDER,
      VISION_MODEL,
      VISION_EFFORT,
      VISION_MIN_CONFIDENCE,
      FLEET_READY_VALUES,
    }),
  )
  .digest('hex')
  .slice(0, 12);
