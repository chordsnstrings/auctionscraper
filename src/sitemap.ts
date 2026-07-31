/**
 * sitemap.ts — crawl + diff the XML tree (§6.1). Al Qaryah-specific by design;
 * no Source interface, no adapter registry (§4.1). Does not render pages.
 *
 *   /sitemap.xml
 *     └── /sitemaps/vehicle/sitemap.xml
 *           └── /sitemaps/vehicle/{make}/sitemap.xml
 *                 └── /sitemaps/vehicle/{make}/{model}.xml
 *                       └── /vehicle-details/{make}/{model}/{year}-{objectid}
 *
 * Never crawl paginated listing pages — diff this tree instead (§2.2).
 */
import { BROWSER_HEADERS, ROOT_SITEMAP, SITEMAP_DELAY_MS, VEHICLE_SITEMAP } from './config.js';
import { previousSnapshot, writeSnapshot } from './db.js';
import type { LotRef, SitemapDiff } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LOC = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
const DETAIL = /\/vehicle-details\/([^/]+)\/([^/]+)\/(\d{4})-([0-9a-f]{24})\/?$/i;

/** `make|model` with non-alphanumerics collapsed — the TARGET_MODELS key. */
export function modelKey(make: string, model: string): string {
  const slug = (s: string) =>
    decodeURIComponent(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  return `${slug(make)}|${slug(model)}`;
}

/** Parse a detail URL. Returns null for anything that is not a vehicle page. */
export function parseDetailUrl(url: string): LotRef | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = DETAIL.exec(path);
  if (!m) return null;
  const [, make, model, year, id] = m as unknown as [string, string, string, string, string];
  return {
    id: id.toLowerCase(),
    url,
    make: decodeURIComponent(make),
    model: decodeURIComponent(model),
    year: Number(year),
    key: modelKey(make, model),
  };
}

function extractLocs(xml: string): string[] {
  const out: string[] = [];
  LOC.lastIndex = 0;
  for (let m = LOC.exec(xml); m; m = LOC.exec(xml)) {
    if (m[1]) out.push(m[1].replace(/&amp;/g, '&'));
  }
  return out;
}

async function fetchXml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { ...BROWSER_HEADERS, Accept: 'application/xml,text/xml,*/*' } });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export interface WalkOptions {
  onProgress?: (seen: number, note: string) => void;
  /** Stop after this many detail URLs. Calibration convenience only. */
  limit?: number;
}

/**
 * Walk the tree breadth-first, following nested sitemaps and collecting the
 * detail URLs. Rate-limited between XML fetches.
 */
export async function walkSitemap(opts: WalkOptions = {}): Promise<LotRef[]> {
  const queue: string[] = [VEHICLE_SITEMAP];
  const visited = new Set<string>();
  const lots = new Map<string, LotRef>();

  // If the vehicle sitemap moves, recover the entry point from the root index.
  const probe = await fetchXml(VEHICLE_SITEMAP);
  if (probe === null) {
    const root = await fetchXml(ROOT_SITEMAP);
    if (root) {
      queue.length = 0;
      for (const loc of extractLocs(root)) {
        if (/\/sitemaps\/vehicle\//i.test(loc)) queue.push(loc);
      }
    }
  }

  while (queue.length > 0) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);

    const xml = url === VEHICLE_SITEMAP && probe !== null ? probe : await fetchXml(url);
    await sleep(SITEMAP_DELAY_MS);
    if (!xml) continue;

    for (const loc of extractLocs(xml)) {
      const lot = parseDetailUrl(loc);
      if (lot) {
        lots.set(lot.id, lot);
        if (opts.limit && lots.size >= opts.limit) return [...lots.values()];
      } else if (/\.xml(\?|$)/i.test(loc) && !visited.has(loc)) {
        queue.push(loc);
      }
    }
    opts.onProgress?.(lots.size, url);
  }

  return [...lots.values()];
}

/** Compare against yesterday's index and emit the diff (§6.1). */
export async function diffSitemap(opts: WalkOptions = {}): Promise<SitemapDiff> {
  const all = await walkSitemap(opts);
  const prev = previousSnapshot();
  const current = new Set(all.map((l) => l.id));

  const added = all.filter((l) => !prev.has(l.id));
  const stillListed = all.filter((l) => prev.has(l.id));
  const removedIds = [...prev.keys()].filter((id) => !current.has(id));

  return { added, stillListed, removedIds, all };
}

export function commitSnapshot(diff: SitemapDiff): void {
  writeSnapshot(diff.all);
}
