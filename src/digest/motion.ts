/**
 * motion.ts — the microanimation layer.
 *
 * ── The one rule everything here follows ────────────────────────────────────
 *
 * No element is ever hidden by a plain CSS rule. Every "from" state
 * (opacity 0, scaleX(0), blur) lives ONLY inside an @keyframes block.
 *
 * Why: email clients strip CSS unevenly. A client that keeps `opacity: 0` but
 * drops the @keyframes that would have animated it back to 1 renders an
 * invisible email. Under this rule the worst case is an `animation` property
 * naming a rule that does not exist — which is a no-op. The static page is
 * always the finished page; motion is pure enhancement.
 *
 * Everything is additionally wrapped in `prefers-reduced-motion: no-preference`,
 * so a reader who has asked for stillness gets the finished state immediately
 * rather than a faster version of the same movement.
 *
 * Support: Apple Mail (macOS/iOS), Outlook for Mac, Samsung Mail, Thunderbird,
 * and most browser previews animate. Gmail and Outlook for Windows show the
 * finished static composition. Both are intended outcomes.
 */

/** Easing that decelerates without overshoot — restrained, not bouncy. */
const EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)';

/**
 * Stagger delay for the nth item, in ms. Grows sublinearly and caps, so a
 * digest with thirty lots does not take nine seconds to finish arriving.
 */
export function stagger(index: number, step = 55, cap = 620): number {
  return Math.min(Math.round(step * Math.sqrt(index + 1) * 1.6), cap);
}

/** Per-element animation declarations, emitted as inline `style` fragments. */
export const anim = {
  rise: (delayMs: number) => `animation: ecoRise 620ms ${EASE} ${delayMs}ms both;`,
  ledger: (delayMs: number) => `animation: ecoLedger 720ms ${EASE} ${delayMs}ms both;`,
  grow: (delayMs: number) =>
    `transform-origin: left center; animation: ecoGrow 780ms ${EASE} ${delayMs}ms both;`,
  pip: (delayMs: number) => `animation: ecoPip 380ms ${EASE} ${delayMs}ms both;`,
  sweep: () => `animation: ecoSweep 2200ms ease-in-out 240ms 1 both;`,
  /** Three beats, then rest. An indefinitely pulsing email is a hostile email. */
  pulse: () => `animation: ecoPulse 1900ms ease-in-out 900ms 3 both;`,
} as const;

/**
 * The <style> block. Keyframes, motion guard, hover microinteractions,
 * dark-mode overrides and the small-screen layout all live here — none of it
 * is required for the email to read correctly.
 */
export const MOTION_CSS = `
/* ── Motion ─────────────────────────────────────────────────────────────── */
/* Guarded so a reader who prefers reduced motion sees the finished state. */
@media (prefers-reduced-motion: no-preference) {
  @keyframes ecoRise {
    from { opacity: 0; transform: translateY(9px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  /* The money number resolves into focus rather than sliding. */
  @keyframes ecoLedger {
    from { opacity: 0; transform: translateY(7px); filter: blur(5px); letter-spacing: 0.04em; }
    60%  { opacity: 1; filter: blur(0); }
    to   { opacity: 1; transform: translateY(0); filter: blur(0); letter-spacing: 0; }
  }
  /* Ledger bar segments build left to right. */
  @keyframes ecoGrow {
    from { transform: scaleX(0); }
    to   { transform: scaleX(1); }
  }
  @keyframes ecoPip {
    from { opacity: 0; transform: scale(0.42); }
    to   { opacity: 1; transform: scale(1); }
  }
  /* A single pass of light along the masthead hairline. */
  @keyframes ecoSweep {
    from { background-position: -140% 0; }
    to   { background-position: 240% 0; }
  }
  @keyframes ecoPulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(163,58,52,0.00); }
    45%      { box-shadow: 0 0 0 4px rgba(163,58,52,0.13); }
  }
}

/* ── Hover microinteractions ────────────────────────────────────────────── */
/* Ignored by touch clients and by Outlook. Nothing depends on them. */
.eco-lot {
  transition: box-shadow 240ms ease, border-color 240ms ease, transform 240ms ease;
}
.eco-lot:hover {
  border-color: #C9A84C !important;
  box-shadow: 0 10px 26px -14px rgba(11,26,46,0.42);
  transform: translateY(-1px);
}
/* The gold rule under a vehicle name draws itself in from the left. */
.eco-link {
  background-image: linear-gradient(#C9A84C, #C9A84C);
  background-repeat: no-repeat;
  background-position: 0 100%;
  background-size: 0% 1px;
  transition: background-size 300ms cubic-bezier(0.22,0.61,0.36,1), color 200ms ease;
}
.eco-lot:hover .eco-link, .eco-link:hover { background-size: 100% 1px; color: #0B1A2E !important; }
.eco-badge { transition: transform 200ms ease; }
.eco-lot:hover .eco-badge { transform: translateY(-1px); }
.eco-cta { transition: color 200ms ease, border-color 200ms ease; }
.eco-cta:hover { color: #A8873A !important; border-color: #A8873A !important; }

/* ── Small screens ──────────────────────────────────────────────────────── */
@media only screen and (max-width: 620px) {
  .eco-shell { width: 100% !important; }
  .eco-pad { padding-left: 18px !important; padding-right: 18px !important; }
  .eco-metric { display: block !important; width: 100% !important; text-align: left !important;
                padding: 10px 0 0 0 !important; border-left: 0 !important; }
  .eco-metric--first { padding-top: 0 !important; }
  .eco-summary-cell { display: block !important; width: 100% !important;
                      border-left: 0 !important; border-top: 1px solid #E4DFD4 !important;
                      padding: 14px 0 !important; }
  .eco-summary-cell--first { border-top: 0 !important; padding-top: 0 !important; }
  .eco-title { font-size: 19px !important; }
  .eco-figure { font-size: 25px !important; }
  .eco-hide-sm { display: none !important; }
}

/* The funnel keeps six columns at every width — it is a shape, and stacking it
   would stop it reading as a funnel. On the narrowest screens the tracking
   gives up the pixels instead. */
@media only screen and (max-width: 380px) {
  .eco-fn-label { font-size: 9px !important; letter-spacing: .02em !important; }
  .eco-fn-cell { padding-right: 4px !important; }
}

/* ── Dark mode ──────────────────────────────────────────────────────────── */
/* Apple Mail, iOS Mail and Outlook for Mac honour this; the rest keep paper. */
@media (prefers-color-scheme: dark) {
  .eco-body, .eco-shell { background-color: #0A1420 !important; }
  .eco-surface { background-color: #101E2E !important; border-color: #20344A !important; }
  .eco-sunk { background-color: #0D1927 !important; }
  .eco-ink { color: #E7E3D9 !important; }
  .eco-ink-soft { color: #B9C2CE !important; }
  .eco-muted { color: #8695A6 !important; }
  .eco-rule { border-color: #20344A !important; background-color: #20344A !important; }
  .eco-wash-gold { background-color: #2A2317 !important; }
  .eco-wash-good { background-color: #132419 !important; }
  .eco-wash-warn { background-color: #2B2113 !important; }
  .eco-wash-bad  { background-color: #2C1614 !important; }
  .eco-track { background-color: #1A2B3D !important; }
}

/* ── Client resets ──────────────────────────────────────────────────────── */
body { margin: 0; padding: 0; width: 100% !important; }
table { border-collapse: collapse; mso-table-lspace: 0; mso-table-rspace: 0; }
img { border: 0; line-height: 100%; outline: none; -ms-interpolation-mode: bicubic; }
a { text-decoration: none; }
/* Stop iOS and Windows Mail from auto-linking and restyling plain data. */
a[x-apple-data-detectors], .unstyle-auto-detected-links a, .aBn {
  color: inherit !important; text-decoration: none !important; font-size: inherit !important;
  font-family: inherit !important; font-weight: inherit !important; line-height: inherit !important;
  border-bottom: 0 !important;
}
`.trim();
