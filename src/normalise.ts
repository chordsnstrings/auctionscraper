/**
 * normalise.ts — field normalisation at the fetch boundary (§11 step 3).
 *
 *   • `year` arrives as a string        → coerce to number
 *   • `mileageUnit` is "mi" on imports  → convert to km, store mileage_km
 *   • `secondaryDamage` of "-"          → null (means none)
 *
 * Kept separate from fetcher.ts so it is testable without a browser.
 */
import { modelKey } from './sitemap.js';
import type { LotRef, NormalisedVehicle, VehiclePayload } from './types.js';

const MI_TO_KM = 1.609344;

export function coerceYear(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number.parseInt(v.trim(), 10);
    if (Number.isFinite(n) && n > 1900 && n < 2100) return n;
  }
  return null;
}

/** Normalise to km whatever the source unit. Miles on US imports. */
export function toKm(value: unknown, unit: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const u = String(unit ?? '').trim().toLowerCase();
  const isMiles = u === 'mi' || u === 'mile' || u === 'miles';
  return Math.round(isMiles ? value * MI_TO_KM : value);
}

/** "-", "", "n/a", "none" all mean "no secondary damage". */
export function normaliseDamage(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === '' || s === '-' || s === '--') return null;
  if (/^(n\/?a|none|nil|null)$/i.test(s)) return null;
  return s;
}

function cleanString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' ? null : s;
}

/**
 * Photo URLs, most useful first. Images are aborted during render — these come
 * from the JSON, so vision still has what it needs (§6.3).
 */
export function collectPhotos(p: VehiclePayload): string[] {
  const out: string[] = [];
  const push = (u: unknown) => {
    if (typeof u === 'string' && /^https?:\/\//i.test(u) && !out.includes(u)) out.push(u);
  };
  const images = Array.isArray(p.vinimages) ? [...p.vinimages] : [];
  images.sort((a, b) => (b.defaultimage ?? 0) - (a.defaultimage ?? 0));
  for (const img of images) if (img.type === 'carimage' || img.imageType === 'inventory') push(img.image);
  for (const img of images) push(img.image);
  push(p.singleImages);
  return out;
}

/**
 * Every free-text field the title-kill safety net should read, plus the raw
 * payload so a stray narration field is not silently missed (§6.4 step 4).
 */
export function narrationOf(p: VehiclePayload): string {
  const parts: (string | null | undefined)[] = [
    p.carDescription,
    p.inventoryRemarks,
    p.primaryDamage,
    p.secondaryDamage,
    p.status,
    p.startCode?.title,
    p.startCode?.description,
  ];
  for (const v of Object.values(p.inspection ?? {})) parts.push(v?.notes);
  let payload = '';
  try {
    payload = JSON.stringify(p);
  } catch {
    /* circular payloads are not expected; narration degrades to fields only */
  }
  return [...parts.filter(Boolean), payload].join(' — ');
}

export function normalise(payload: VehiclePayload, ref: LotRef): NormalisedVehicle {
  const make = cleanString(payload.make) ?? ref.make;
  const model = cleanString(payload.model) ?? ref.model;

  return {
    id: (cleanString(payload._id) ?? ref.id).toLowerCase(),
    url: ref.url,
    lotNo: typeof payload.lotNo === 'number' ? payload.lotNo : null,
    vin: cleanString(payload.vin)?.toUpperCase() ?? null,
    year: coerceYear(payload.year) ?? ref.year ?? null,
    make,
    model,
    key: modelKey(make, model),
    description: cleanString(payload.carDescription),

    // Absent stays absent. Silence is never treated as a pass (§1.3).
    cleanTitle: typeof payload.clean_title === 'boolean' ? payload.clean_title : undefined,
    primaryDamage: normaliseDamage(payload.primaryDamage),
    secondaryDamage: normaliseDamage(payload.secondaryDamage),
    startCode: payload.startCode ?? null,

    mileageKm: toKm(payload.milage, payload.mileageUnit),
    startingBid: typeof payload.startingBid === 'number' ? payload.startingBid : null,
    auctionVehicleStatus: cleanString(payload.auctionVehicleStatus),
    auctionId: cleanString(payload.auctionId),
    lane: cleanString(payload.lane),
    photos: collectPhotos(payload),
    narration: narrationOf(payload),
    raw: payload,
  };
}
