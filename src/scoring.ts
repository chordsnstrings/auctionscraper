/**
 * scoring.ts — max-bid arithmetic (§7). Invents no valuations (§4).
 *
 *   max_bid = ( fleet_ready_value
 *             − repair_estimate            ← REPAIR_ESTIMATE_BASIS, default 'high'
 *             − HIDDEN_DAMAGE_RESERVE_AED
 *             − RTA_COMPLIANCE_COST_AED
 *             − LOGISTICS_AED
 *             − fleet_ready_value × TARGET_MARGIN_PCT )
 *             ÷ ( (1 + auction_fee_pct) × (1 + VAT_PCT) )
 *
 * Fee and VAT apply to the hammer price, so the ceiling is solved for, not
 * subtracted. Rounded down to the nearest 100.
 */
import {
  AUCTION_FEE_PCT,
  BID_ROUNDING_AED,
  FLEET_READY_VALUES,
  FLEET_VALUE_STALE_DAYS,
  HIDDEN_DAMAGE_RESERVE_AED,
  LOGISTICS_AED,
  MAX_DAMAGE_TIER,
  REPAIR_ESTIMATE_BASIS,
  RTA_COMPLIANCE_COST_AED,
  TARGET_MARGIN_PCT,
  VAT_PCT,
  VISION_MIN_CONFIDENCE,
} from './config.js';
import type { GateResult, NormalisedVehicle, ScoreResult, VisionResult } from './types.js';

export interface FleetValueLookup {
  aed: number;
  reviewedOn: string;
  stale: boolean;
}

/**
 * Retail value of a repaired, inspected, plated car.
 *
 * Exact make + model + year match only. No interpolation, no nearest-year
 * fallback, no averaging across models. A missing entry returns null, and
 * returning null is correct behaviour — a fabricated valuation carried into a
 * live auction costs more than a missing one (§7.1).
 */
export function fleetReadyValue(key: string, year: number | null): FleetValueLookup | null {
  if (year === null) return null;
  const byYear = FLEET_READY_VALUES[key];
  if (!byYear) return null;
  const entry = byYear[year];
  if (!entry) return null;

  const ageDays = (Date.now() - Date.parse(entry.reviewed_on)) / 86_400_000;
  return {
    aed: entry.aed,
    reviewedOn: entry.reviewed_on,
    stale: Number.isFinite(ageDays) && ageDays > FLEET_VALUE_STALE_DAYS,
  };
}

export function repairEstimateFrom(v: VisionResult): number {
  switch (REPAIR_ESTIMATE_BASIS) {
    case 'low':
      return v.repairLowAed;
    case 'mid':
      return v.repairMidAed;
    default:
      return v.repairHighAed;
  }
}

/** The §7 formula in isolation, so the worked example is directly testable. */
export function computeMaxBid(fleetReadyValue: number, repairEstimate: number): number {
  const net =
    fleetReadyValue -
    repairEstimate -
    HIDDEN_DAMAGE_RESERVE_AED -
    RTA_COMPLIANCE_COST_AED -
    LOGISTICS_AED -
    fleetReadyValue * TARGET_MARGIN_PCT;
  const ceiling = net / ((1 + AUCTION_FEE_PCT) * (1 + VAT_PCT));
  return Math.floor(ceiling / BID_ROUNDING_AED) * BID_ROUNDING_AED;
}

export function score(
  v: NormalisedVehicle,
  g: GateResult,
  vision: VisionResult | null,
): ScoreResult {
  const reasons: string[] = [];
  const lookup = fleetReadyValue(v.key, v.year);

  const base: ScoreResult = {
    action: 'DROP',
    fleetReadyValue: lookup?.aed ?? null,
    fleetValueReviewedOn: lookup?.reviewedOn ?? null,
    fleetValueStale: lookup?.stale ?? false,
    repairEstimate: vision ? repairEstimateFrom(vision) : null,
    maxBid: null,
    bidToValue: null,
    marginAed: null,
    reasons,
  };

  // Gate rejection is terminal. Registrability is not an economic input (§1.1).
  if (g.verdict === 'reject') {
    reasons.push(g.reason);
    return base;
  }

  // Auto-drop regardless of price (§7.2). These fail inspection; they are not
  // economic decisions, so they are evaluated before any arithmetic.
  if (vision) {
    if (vision.structural) reasons.push('structural damage — fails RTA inspection');
    if (vision.floodIndicators) reasons.push('flood indicators — fails RTA inspection');
    if (vision.tier > MAX_DAMAGE_TIER) reasons.push(`damage tier ${vision.tier} > MAX_DAMAGE_TIER ${MAX_DAMAGE_TIER}`);
    if (reasons.length > 0) return base;
  }

  // No defensible valuation ⇒ INSPECT with no ceiling. Never a synthesised one.
  if (!lookup) {
    reasons.push(`no FLEET_READY_VALUES entry for ${v.key} ${v.year ?? '?'}`);
    return { ...base, action: 'INSPECT' };
  }
  if (lookup.stale) reasons.push(`valuation last reviewed ${lookup.reviewedOn}`);

  if (!vision) {
    reasons.push('no vision assessment — repair range unknown');
    return { ...base, action: 'INSPECT' };
  }

  const repairEstimate = repairEstimateFrom(vision);
  const maxBid = computeMaxBid(lookup.aed, repairEstimate);

  if (maxBid <= 0) {
    reasons.push('repair and compliance costs exceed fleet-ready value at target margin');
    return { ...base, repairEstimate, maxBid: null };
  }

  const marginAed = Math.round(lookup.aed * TARGET_MARGIN_PCT);
  const bidToValue = maxBid / lookup.aed;

  // Title unconfirmed or low vision confidence ⇒ INSPECT, ceiling still shown
  // so purchasing knows what it would be worth if the physical check clears.
  if (g.verdict === 'unverified') {
    reasons.push(g.reason);
    return { ...base, action: 'INSPECT', repairEstimate, maxBid, bidToValue, marginAed };
  }
  if (vision.confidence < VISION_MIN_CONFIDENCE) {
    reasons.push(`vision confidence ${vision.confidence.toFixed(2)} below ${VISION_MIN_CONFIDENCE}`);
    return { ...base, action: 'INSPECT', repairEstimate, maxBid, bidToValue, marginAed };
  }

  reasons.push('ceiling is firm');
  return { ...base, action: 'BID', repairEstimate, maxBid, bidToValue, marginAed };
}

/** Every stale valuation currently reachable, for the digest footer (§7.1a). */
export function stalenessWarnings(): string[] {
  const out: string[] = [];
  const cutoff = Date.now() - FLEET_VALUE_STALE_DAYS * 86_400_000;
  for (const [key, years] of Object.entries(FLEET_READY_VALUES)) {
    for (const [year, entry] of Object.entries(years)) {
      const t = Date.parse(entry.reviewed_on);
      if (Number.isFinite(t) && t < cutoff) {
        out.push(`${key.replace('|', ' ')} ${year} — last reviewed ${entry.reviewed_on}`);
      }
    }
  }
  return out.sort();
}
