/**
 * gates.ts — free hard filters (§6.4). No network, no model calls (§4).
 *
 * Order is load-bearing and must not be reordered for convenience:
 *
 *   1. year >= MIN_MODEL_YEAR              → reject
 *   2. make/model on TARGET_MODELS         → reject
 *   3. clean_title === false               → reject   (titleStatus: 'salvage')
 *   4. TITLE_KILL_PATTERNS on narration    → reject   (safety net only)
 *   5. clean_title !== true (field absent) → unverified
 *   6. startCode present and not R&D       → unverified
 *   7. otherwise                           → pass
 *
 * Registrability is a hard gate, not a scoring input. A written-off car is
 * worth zero at any price — not "worth less" (§1.1). Silence is never treated
 * as a pass (§1.3).
 */
import { MIN_MODEL_YEAR, RUN_AND_DRIVE_CODES, TARGET_MODELS, TITLE_KILL_PATTERNS } from './config.js';
import type { GateResult, LotRef, NormalisedVehicle } from './types.js';

/**
 * Pre-gate (§6.2). Make, model and year come from the URL, so this runs before
 * any browser work. Render only survivors.
 */
export function preGate(ref: LotRef): boolean {
  if (!Number.isFinite(ref.year) || ref.year < MIN_MODEL_YEAR) return false;
  return TARGET_MODELS.has(ref.key);
}

function isRunAndDrive(v: NormalisedVehicle): boolean {
  const code = v.startCode?.code?.trim().toUpperCase().replace(/\s+/g, '');
  const title = v.startCode?.title?.trim().toLowerCase();
  if (code && [...RUN_AND_DRIVE_CODES].some((c) => c.toUpperCase().replace(/\s+/g, '') === code)) return true;
  return title === 'run & drive' || title === 'run and drive';
}

export function gate(v: NormalisedVehicle): GateResult {
  // 1 — model year
  if (v.year === null || v.year < MIN_MODEL_YEAR) {
    return {
      verdict: 'reject',
      titleStatus: 'unknown',
      reason: `year ${v.year ?? 'unknown'} below MIN_MODEL_YEAR ${MIN_MODEL_YEAR}`,
    };
  }

  // 2 — target model list
  if (!TARGET_MODELS.has(v.key)) {
    return { verdict: 'reject', titleStatus: 'unknown', reason: `${v.key} not on TARGET_MODELS` };
  }

  // 3 — the registrability gate. Structured boolean, checked as-is.
  if (v.cleanTitle === false) {
    return { verdict: 'reject', titleStatus: 'salvage', reason: 'clean_title = false' };
  }

  // 4 — narration safety net. Catches text that contradicts the structured
  //     field. Only ever rejects; never promotes a lot to clean.
  const hit = TITLE_KILL_PATTERNS.find((p) => p.test(v.narration));
  if (hit) {
    return {
      verdict: 'reject',
      titleStatus: 'salvage',
      reason: `title kill pattern matched: ${hit.source}`,
    };
  }

  // 5 — field absent. Surfaced for physical inspection, not quietly promoted.
  if (v.cleanTitle !== true) {
    return {
      verdict: 'unverified',
      titleStatus: 'unknown',
      reason: 'clean_title absent — physical check required',
    };
  }

  // 6 — start code present but not Run & Drive.
  if (v.startCode && (v.startCode.code || v.startCode.title) && !isRunAndDrive(v)) {
    const label = v.startCode.title ?? v.startCode.code ?? 'unknown';
    return {
      verdict: 'unverified',
      titleStatus: 'clean',
      reason: `start code "${label}" — not run & drive`,
    };
  }

  // 7
  return { verdict: 'pass', titleStatus: 'clean', reason: 'gates passed' };
}
