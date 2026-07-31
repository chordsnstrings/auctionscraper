/**
 * components.ts — the digest's visual vocabulary.
 *
 * Layout is table-based so Outlook's Word engine renders it correctly; colour
 * and spacing are inlined so Gmail cannot strip them. The <style> block in
 * motion.ts adds hover, dark mode, small-screen layout and the animations —
 * every one of which is optional. This file must produce a finished-looking
 * email with the <style> block deleted entirely.
 */
import {
  AUCTION_FEE_PCT,
  CLOSING_SOON_HOURS,
  DIGEST_TIMEZONE,
  HIDDEN_DAMAGE_RESERVE_AED,
  LOGISTICS_AED,
  RTA_COMPLIANCE_COST_AED,
  TARGET_MARGIN_PCT,
  VAT_PCT,
} from '../config.js';
import type { DigestLot, FunnelStats } from '../types.js';
import { anim, stagger } from './motion.js';
import { layout, ledgerColours, palette, tierColour, tierLabel, type } from './theme.js';

// ── primitives ─────────────────────────────────────────────────────────────

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const nf = new Intl.NumberFormat('en-GB');
export const int = (n: number): string => nf.format(Math.round(n));
export const aed = (n: number): string => nf.format(Math.round(n));

export function km(n: number | null): string {
  return n === null ? '—' : `${nf.format(n)} km`;
}

const timeFmt = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: DIGEST_TIMEZONE,
});
const dateFmt = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: DIGEST_TIMEZONE,
});
const dayFmt = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: DIGEST_TIMEZONE,
});

export const clock = (d: Date): string => timeFmt.format(d);
export const longDate = (d: Date): string => dateFmt.format(d);

export function hoursUntil(d: Date, from: Date): number {
  return (d.getTime() - from.getTime()) / 3_600_000;
}

export function untilLabel(d: Date | null, from: Date): string {
  if (!d) return '—';
  const h = hoursUntil(d, from);
  if (h < 0) return 'closed';
  if (h < 1) return `in ${Math.max(1, Math.round(h * 60))} min`;
  if (h < 24) return `in ${Math.round(h)} h`;
  return dayFmt.format(d);
}

// ── type helpers ───────────────────────────────────────────────────────────

export function eyebrow(text: string, colour: string = palette.muted, cls = 'eco-muted'): string {
  return `<div class="${cls}" style="font-family:${type.body};font-size:10px;line-height:14px;letter-spacing:.14em;text-transform:uppercase;color:${colour};">${esc(text)}</div>`;
}

/** Gold hairline. A single pass of light travels along it, once. */
export function goldRule(sweep = false): string {
  const base = `background-color:${palette.gold};`;
  const swept = sweep
    ? `background-image:linear-gradient(90deg,${palette.goldDeep} 0%,${palette.gold} 34%,#FFF6DF 50%,${palette.gold} 66%,${palette.goldDeep} 100%);background-size:220% 100%;background-repeat:no-repeat;${anim.sweep()}`
    : '';
  return `<div style="height:2px;font-size:0;line-height:0;${base}${swept}">&nbsp;</div>`;
}

export function hairline(cls = 'eco-rule'): string {
  return `<div class="${cls}" style="height:1px;font-size:0;line-height:0;background-color:${palette.rule};">&nbsp;</div>`;
}

export function spacer(px: number): string {
  return `<div style="height:${px}px;font-size:0;line-height:0;">&nbsp;</div>`;
}

// ── badges ─────────────────────────────────────────────────────────────────

type BadgeKind = 'new' | 'closing' | 'unverified' | 'firm' | 'plain';

const BADGE: Record<BadgeKind, { fg: string; bg: string; cls: string }> = {
  new: { fg: palette.goldDeep, bg: palette.goldWash, cls: 'eco-wash-gold' },
  closing: { fg: palette.bad, bg: palette.badWash, cls: 'eco-wash-bad' },
  unverified: { fg: palette.warn, bg: palette.warnWash, cls: 'eco-wash-warn' },
  firm: { fg: palette.good, bg: palette.goodWash, cls: 'eco-wash-good' },
  plain: { fg: palette.muted, bg: palette.cardSunk, cls: 'eco-sunk' },
};

export function badge(kind: BadgeKind, text: string, pulse = false): string {
  const t = BADGE[kind];
  return (
    `<span class="eco-badge ${t.cls}" style="display:inline-block;font-family:${type.body};font-size:9px;` +
    `line-height:11px;letter-spacing:.13em;text-transform:uppercase;color:${t.fg};background-color:${t.bg};` +
    `border-radius:${layout.radius}px;padding:4px 7px;margin-left:5px;white-space:nowrap;${pulse ? anim.pulse() : ''}">` +
    `${esc(text)}</span>`
  );
}

// ── tier meter ─────────────────────────────────────────────────────────────

/** Five pips; the filled ones carry the tier colour and pop in left to right. */
export function tierPips(tier: number, baseDelay: number): string {
  const colour = tierColour(tier);
  const cells = Array.from({ length: 5 }, (_, i) => {
    const on = i < tier;
    // Unfilled pips carry .eco-track so they darken with the rest of the page;
    // left on the light rule colour they would out-glow the filled ones.
    return (
      `<td style="padding:0 3px 0 0;">` +
      `<div${on ? '' : ' class="eco-track"'} style="width:14px;height:5px;border-radius:1px;` +
      `background-color:${on ? colour : palette.rule};${anim.pip(baseDelay + i * 70)}">&nbsp;</div></td>`
    );
  }).join('');

  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${cells}` +
    `<td style="padding-left:7px;font-family:${type.body};font-size:11px;line-height:11px;color:${palette.muted};` +
    `white-space:nowrap;" class="eco-muted">Tier ${tier} · ${esc(tierLabel(tier))}</td></tr></table>`
  );
}

// ── ledger bar ─────────────────────────────────────────────────────────────

export interface LedgerSegment {
  label: string;
  aed: number;
  colour: string;
  pct: number;
}

/**
 * The §7 arithmetic drawn as one bar. The four components sum to fleet-ready
 * value by construction:
 *
 *   value = bid×(1+fee)(1+VAT) + repair + compliance + margin
 *
 * so the bar is the economic model itself, not a decoration of it.
 */
export function ledgerSegments(lot: DigestLot): LedgerSegment[] | null {
  const { fleetReadyValue: value, maxBid, repairEstimate } = lot.score;
  if (value === null || maxBid === null || repairEstimate === null || value <= 0) return null;

  const grossBid = maxBid * (1 + AUCTION_FEE_PCT) * (1 + VAT_PCT);
  const compliance = HIDDEN_DAMAGE_RESERVE_AED + RTA_COMPLIANCE_COST_AED + LOGISTICS_AED;
  const margin = Math.max(0, value - grossBid - repairEstimate - compliance);

  const raw: Omit<LedgerSegment, 'pct'>[] = [
    { label: 'Bid + fees', aed: grossBid, colour: ledgerColours.bid },
    { label: 'Repair', aed: repairEstimate, colour: ledgerColours.repair },
    { label: 'Compliance', aed: compliance, colour: ledgerColours.compliance },
    { label: 'Margin', aed: margin, colour: ledgerColours.margin },
  ];

  const pcts = raw.map((s) => Math.max(0, (s.aed / value) * 100));
  // Let the final segment absorb rounding so the bar always totals exactly 100.
  const head = pcts.slice(0, -1).map((p) => Math.round(p * 10) / 10);
  const tail = Math.max(0, Math.round((100 - head.reduce((a, b) => a + b, 0)) * 10) / 10);

  return raw.map((s, i) => ({ ...s, pct: i === raw.length - 1 ? tail : (head[i] as number) }));
}

export function ledgerBar(segments: readonly LedgerSegment[], baseDelay: number): string {
  const cells = segments
    .filter((s) => s.pct > 0)
    .map(
      (s, i) =>
        `<td width="${s.pct}%" style="width:${s.pct}%;padding:0;font-size:0;line-height:0;">` +
        `<div style="height:7px;background-color:${s.colour};${anim.grow(baseDelay + i * 110)}">&nbsp;</div></td>`,
    )
    .join('');

  // Inline-block items, not table cells. Four nowrap cells in one row give the
  // legend a ~390px min-content width, which propagates up and puts a hard
  // horizontal floor under the whole email; as spans they reflow to 2×2 on a
  // phone. nowrap stays *inside* each item so a figure never splits from
  // its label.
  const legend = segments
    .map(
      (s) =>
        `<span class="eco-muted" style="display:inline-block;white-space:nowrap;margin:0 12px 3px 0;` +
        `font-family:${type.body};font-size:10px;line-height:14px;color:${palette.muted};">` +
        `<span style="display:inline-block;width:7px;height:7px;border-radius:1px;background-color:${s.colour};` +
        `margin-right:5px;">&nbsp;</span>${esc(s.label)} ${aed(s.aed)}</span>`,
    )
    .join('');

  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="eco-track" ` +
    `style="width:100%;background-color:${palette.ruleSoft};border-radius:2px;overflow:hidden;">` +
    `<tr>${cells}</tr></table>` +
    `<div style="margin-top:7px;">${legend}</div>`
  );
}

// ── metric cell ────────────────────────────────────────────────────────────

export interface Metric {
  label: string;
  value: string;
  unit?: string;
  /** Renders in Georgia gold at figure size — reserved for the max bid. */
  emphasis?: boolean;
  delay?: number;
  /** Skip the uppercase treatment — right for "in 6 h", wrong for "AED". */
  unitPlain?: boolean;
}

export function metricCell(m: Metric, first: boolean): string {
  const valueStyle = m.emphasis
    ? `font-family:${type.numeric};font-size:27px;line-height:30px;color:${palette.goldDeep};` +
      `letter-spacing:-.01em;${m.delay !== undefined ? anim.ledger(m.delay) : ''}`
    : `font-family:${type.numeric};font-size:15px;line-height:20px;color:${palette.text};`;

  return (
    `<td class="eco-metric${first ? ' eco-metric--first' : ''}" valign="top" ` +
    `style="padding:0 14px;${first ? 'padding-left:0;' : `border-left:1px solid ${palette.rule};`}">` +
    eyebrow(m.label) +
    `<div class="${m.emphasis ? '' : 'eco-ink'}" style="${valueStyle}margin-top:5px;">${esc(m.value)}` +
    (m.unit
      ? `<span class="eco-muted" style="font-family:${type.body};font-size:10px;` +
        `${m.unitPlain ? '' : 'letter-spacing:.1em;text-transform:uppercase;'}` +
        `color:${palette.muted};margin-left:4px;">${esc(m.unit)}</span>`
      : '') +
    `</div></td>`
  );
}

// ── lot card ───────────────────────────────────────────────────────────────

export function lotCard(lot: DigestLot, index: number, now: Date): string {
  const delay = stagger(index);
  const closingSoon =
    lot.closesAt !== null && hoursUntil(lot.closesAt, now) >= 0 && hoursUntil(lot.closesAt, now) <= CLOSING_SOON_HOURS;

  const meta = [
    lot.lotNo !== null ? `Lot ${lot.lotNo}` : null,
    lot.lane ? lot.lane.replace(/^lane-/, 'Lane ').toUpperCase() : null,
  ]
    .filter(Boolean)
    .join('&nbsp;&nbsp;·&nbsp;&nbsp;');

  const spec = [
    km(lot.mileageKm),
    lot.primaryDamage,
    lot.secondaryDamage,
    lot.startCodeTitle,
  ]
    .filter(Boolean)
    .map((s) => esc(s))
    .join('&nbsp;&nbsp;·&nbsp;&nbsp;');

  const badges =
    (lot.isNew ? badge('new', 'New') : '') +
    (closingSoon ? badge('closing', 'Closing', true) : '') +
    (lot.gate === 'unverified' ? badge('unverified', 'Unverified') : '');

  const repairRange = lot.vision
    ? `${aed(lot.vision.repairLowAed)} – ${aed(lot.vision.repairHighAed)}`
    : 'not assessed';

  const metrics: Metric[] = [
    { label: 'Est. repair range', value: repairRange, unit: lot.vision ? 'AED' : undefined },
    lot.score.maxBid !== null
      ? { label: 'Max bid', value: aed(lot.score.maxBid), unit: 'AED', emphasis: true, delay: delay + 180 }
      : { label: 'Max bid', value: 'no ceiling', unit: undefined },
    {
      label: 'Closes',
      value: lot.closesAt ? clock(lot.closesAt) : '—',
      unit: lot.closesAt ? untilLabel(lot.closesAt, now) : undefined,
      unitPlain: true,
    },
  ];

  const segments = ledgerSegments(lot);

  const reasonLine =
    lot.score.action === 'INSPECT' && lot.score.reasons.length > 0
      ? `<div class="eco-muted" style="font-family:${type.body};font-size:11.5px;line-height:17px;` +
        `color:${palette.muted};margin-top:12px;">${esc(lot.score.reasons[0])}</div>`
      : '';

  const visionNote = lot.vision?.notes
    ? `<div class="eco-ink-soft" style="font-family:${type.body};font-size:12px;line-height:18px;` +
      `color:${palette.textSoft};margin-top:10px;">${esc(lot.vision.notes)}</div>`
    : '';

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-bottom:14px;${anim.rise(delay)}">
  <tr><td class="eco-lot eco-surface" style="background-color:${palette.card};border:1px solid ${palette.rule};border-radius:${layout.radius}px;padding:20px 22px;">

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="top">
        ${meta ? `<div class="eco-muted" style="font-family:${type.body};font-size:10px;line-height:14px;letter-spacing:.13em;text-transform:uppercase;color:${palette.muted};">${meta}</div>` : ''}
        <a href="${esc(lot.url)}" class="eco-link eco-ink" style="display:inline-block;font-family:${type.head};font-size:18px;line-height:25px;color:${palette.ink};margin-top:4px;">${esc(lot.title)}</a>
      </td>
      <td valign="top" align="right" style="white-space:nowrap;padding-left:10px;">${badges}</td>
    </tr></table>

    ${spec ? `<div class="eco-ink-soft" style="font-family:${type.body};font-size:12.5px;line-height:19px;color:${palette.textSoft};margin-top:6px;">${spec}</div>` : ''}

    ${lot.vision ? `<div style="margin-top:13px;">${tierPips(lot.vision.tier, delay + 120)}</div>` : ''}

    <div style="margin:16px 0 15px;">${hairline()}</div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;"><tr>
      ${metrics.map((m, i) => metricCell(m, i === 0)).join('')}
    </tr></table>

    ${segments ? `<div style="margin-top:17px;">${ledgerBar(segments, delay + 240)}</div>` : ''}
    ${visionNote}
    ${reasonLine}

  </td></tr>
</table>`.trim();
}

// ── funnel ─────────────────────────────────────────────────────────────────

/**
 * Cost ordering is the core design principle (§3): each stage must be cheaper
 * than the one after it and must eliminate as much volume as possible. This
 * draws that, so a run whose funnel stops narrowing is visible at a glance.
 */
export function funnelStrip(f: FunnelStats, baseDelay: number): string {
  const steps: { label: string; n: number }[] = [
    { label: 'Sitemap', n: f.sitemapTotal },
    { label: 'Year', n: f.afterYearGate },
    { label: 'Model', n: f.afterModelGate },
    { label: 'Rendered', n: f.rendered },
    { label: 'Vision', n: f.visionCalls },
    { label: 'Surfaced', n: f.gatePassed + f.gateUnverified },
  ];
  const max = Math.max(1, ...steps.map((s) => s.n));

  // Bar length is logarithmic. The funnel spans three orders of magnitude by
  // design (thousands → tens), and on a linear scale every stage after the
  // model gate collapses into a two-pixel sliver — which hides exactly the
  // narrowing the strip exists to show. Printed figures stay exact.
  const denom = Math.log10(max + 1);
  const scale = (n: number): number =>
    n <= 0 ? 0 : Math.max(4, Math.round((Math.log10(n + 1) / denom) * 100));

  const cells = steps
    .map((s, i) => {
      const pct = scale(s.n);
      const last = i === steps.length - 1;
      // eco-fn-cell / eco-fn-label let the narrowest screens tighten the
      // tracking on six side-by-side labels — otherwise the strip alone puts a
      // ~316px floor under the email, which overflows a 320px viewport.
      return (
        `<td class="eco-fn-cell" width="${Math.round(100 / steps.length)}%" valign="bottom" style="padding:0 6px 0 0;">` +
        `<div class="eco-track" style="height:4px;background-color:${palette.ruleSoft};border-radius:2px;overflow:hidden;">` +
        `<div style="width:${pct}%;height:4px;background-color:${last ? palette.gold : palette.inkSoft};` +
        `${anim.grow(baseDelay + i * 90)}">&nbsp;</div></div>` +
        `<div class="eco-ink" style="font-family:${type.numeric};font-size:14px;line-height:19px;color:${palette.text};margin-top:7px;">${int(s.n)}</div>` +
        `<div class="eco-muted eco-fn-label" style="font-family:${type.body};font-size:9.5px;line-height:13px;letter-spacing:.11em;text-transform:uppercase;color:${palette.muted};">${esc(s.label)}</div>` +
        `</td>`
      );
    })
    .join('');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;"><tr>${cells}</tr></table>`;
}

// ── section header ─────────────────────────────────────────────────────────

export function sectionHeader(title: string, note: string, count: number, delay: number): string {
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 14px;${anim.rise(delay)}"><tr>
  <td valign="bottom">
    <span class="eco-ink" style="font-family:${type.head};font-size:15px;line-height:20px;letter-spacing:.2em;text-transform:uppercase;color:${palette.ink};">${esc(title)}</span>
    <span class="eco-muted" style="font-family:${type.numeric};font-size:15px;line-height:20px;color:${palette.muted};margin-left:9px;">${count}</span>
  </td>
  <td valign="bottom" align="right" class="eco-hide-sm">
    <span class="eco-muted" style="font-family:${type.body};font-size:11px;line-height:16px;color:${palette.muted};">${esc(note)}</span>
  </td>
</tr></table>
<div style="margin-bottom:16px;">${goldRule()}</div>`.trim();
}

// ── empty state ────────────────────────────────────────────────────────────

/**
 * The digest sends even when empty (§9), so the empty state has to look like a
 * completed run rather than a failure. The funnel below it carries the proof.
 */
export function emptyState(delay: number): string {
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;${anim.rise(delay)}">
  <tr><td class="eco-surface" align="center" style="background-color:${palette.card};border:1px solid ${palette.rule};border-radius:${layout.radius}px;padding:44px 28px;">
    <div style="width:40px;margin:0 auto 18px;">${goldRule()}</div>
    <div class="eco-ink" style="font-family:${type.head};font-size:19px;line-height:27px;color:${palette.ink};">No lot cleared the gates today.</div>
    <div class="eco-muted" style="font-family:${type.body};font-size:12.5px;line-height:19px;color:${palette.muted};margin-top:9px;max-width:380px;">
      The screen ran to completion. The funnel below is the evidence — an empty
      result is a finding, not a failure.
    </div>
  </td></tr>
</table>`.trim();
}
