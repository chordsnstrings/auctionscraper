/**
 * theme.ts — the digest's design tokens. Single source of truth.
 *
 * Brand is fixed by §9: Navy #0B1A2E, Gold #C9A84C, Georgia headings,
 * Calibri body. Everything else here is derived from those four so the
 * palette stays coherent rather than accumulating one-off colours.
 *
 * Values are plain TS constants, not CSS custom properties: Outlook's Word
 * engine does not resolve `var()`, and this email must be beautiful in the
 * clients that strip the most, not only in the ones that strip the least.
 */

export const brand = {
  /** §9 */
  navy: '#0B1A2E',
  gold: '#C9A84C',
} as const;

export const palette = {
  // Ink — the navy family.
  ink: brand.navy,
  inkRaised: '#16293F',
  inkSoft: '#22384F',
  inkHair: 'rgba(255,255,255,0.14)',

  // Paper — warm, so the gold reads as metal rather than yellow.
  paper: '#F3F1EB',
  card: '#FFFFFF',
  cardSunk: '#FAF8F3',
  rule: '#E4DFD4',
  ruleSoft: '#EFEBE1',

  // Gold.
  gold: brand.gold,
  goldDeep: '#A8873A',
  goldWash: '#F6EFDC',

  // Text.
  text: '#1B2733',
  textSoft: '#4A5765',
  muted: '#7A8695',
  onInk: '#F1EEE6',
  onInkMuted: '#9DAABB',

  // Semantics — aged rather than saturated, so they sit with navy and gold.
  good: '#3F7D5B',
  goodWash: '#E8F0EA',
  warn: '#B8842B',
  warnWash: '#FAF0DC',
  bad: '#A33A34',
  badWash: '#F7E7E5',
  neutral: '#8A94A2',
} as const;

/** Dark-mode overrides. Applied via prefers-color-scheme; navy stays navy. */
export const dark = {
  paper: '#0A1420',
  card: '#101E2E',
  cardSunk: '#0D1927',
  rule: '#20344A',
  ruleSoft: '#1A2B3D',
  text: '#E7E3D9',
  textSoft: '#B9C2CE',
  muted: '#8695A6',
  goldWash: '#2A2317',
  goodWash: '#132419',
  warnWash: '#2B2113',
  badWash: '#2C1614',
} as const;

export const type = {
  /** §9 */
  head: "Georgia, 'Times New Roman', 'Droid Serif', serif",
  body: "Calibri, 'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif",
  /** Aligns digits in the money column across rows. */
  numeric: "'Georgia', 'Cambria', 'Times New Roman', serif",
} as const;

export const layout = {
  width: 600,
  gutter: 28,
  radius: 3,
} as const;

/** Tier 1–5 → the colour it is drawn in. Green through to red. */
export const tierColour = (tier: number): string =>
  [palette.good, palette.good, palette.warn, palette.bad, palette.bad][
    Math.min(Math.max(tier, 1), 5) - 1
  ] as string;

export const tierLabel = (tier: number): string =>
  (
    ['Cosmetic', 'Panel work', 'Significant', 'Heavy', 'Severe'][Math.min(Math.max(tier, 1), 5) - 1] ??
    'Unknown'
  );

/**
 * The four components of §7's arithmetic, which sum to fleet-ready value.
 * Drawn as one stacked bar so the economic model is legible at a glance.
 */
export const ledgerColours = {
  bid: palette.gold,
  repair: palette.warn,
  compliance: palette.neutral,
  margin: palette.inkSoft,
} as const;
