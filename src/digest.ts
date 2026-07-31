/**
 * digest.ts — the HTML email (§9). Single channel, SMTP via nodemailer.
 *
 * Sorted by auction close time ascending, never by margin: purchasing needs to
 * know what they lose today. This module does not filter or re-rank on
 * business logic (§4) — scoring.ts decided BID vs INSPECT; this presents it.
 *
 * Repair figures are always a range, never a point estimate.
 */
import nodemailer from 'nodemailer';
import { writeFileSync, mkdirSync } from 'node:fs';
import { CLOSING_SOON_HOURS, DIGEST_DRY_RUN, SEND_EMPTY_DIGEST, SMTP } from './config.js';
import type { DigestLot, DigestModel } from './types.js';
import {
  aed,
  clock,
  emptyState,
  esc,
  eyebrow,
  funnelStrip,
  goldRule,
  hairline,
  hoursUntil,
  int,
  km,
  longDate,
  lotCard,
  sectionHeader,
  spacer,
  untilLabel,
} from './digest/components.js';
import { anim, stagger } from './digest/motion.js';
import { MOTION_CSS } from './digest/motion.js';
import { layout, palette, type } from './digest/theme.js';

/** Ascending close time; lots with no known close time sort last (§9). */
function byCloseTime(a: DigestLot, b: DigestLot): number {
  const at = a.closesAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const bt = b.closesAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (at !== bt) return at - bt;
  return (a.lotNo ?? 0) - (b.lotNo ?? 0);
}

// ── masthead ───────────────────────────────────────────────────────────────

function masthead(m: DigestModel): string {
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${palette.ink};">
  <tr><td class="eco-pad" style="padding:34px ${layout.gutter}px 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="top">
        <div style="font-family:${type.body};font-size:10px;line-height:14px;letter-spacing:.28em;text-transform:uppercase;color:${palette.gold};">Ecosine</div>
        <div style="font-family:${type.body};font-size:10px;line-height:14px;letter-spacing:.16em;text-transform:uppercase;color:${palette.onInkMuted};margin-top:3px;">Auction Intelligence</div>
      </td>
      <td valign="top" align="right">
        <div style="font-family:${type.body};font-size:10px;line-height:14px;letter-spacing:.13em;text-transform:uppercase;color:${palette.onInkMuted};">Al Qaryah · Sharjah</div>
      </td>
    </tr></table>

    <div style="font-family:${type.head};font-size:31px;line-height:40px;color:${palette.onInk};margin-top:22px;letter-spacing:-.01em;${anim.rise(60)}">
      ${esc(m.auctionTitle ?? 'Daily purchasing brief')}
    </div>
    <div style="font-family:${type.body};font-size:12.5px;line-height:19px;color:${palette.onInkMuted};margin-top:5px;${anim.rise(120)}">
      ${esc(longDate(m.generatedAt))}
    </div>
  </td></tr>
  <tr><td class="eco-pad" style="padding:24px ${layout.gutter}px 0;">${goldRule(true)}</td></tr>
  <tr><td style="height:0;font-size:0;line-height:0;">&nbsp;</td></tr>
</table>`.trim();
}

// ── summary strip ──────────────────────────────────────────────────────────

function summaryStrip(m: DigestModel): string {
  const all = [...m.bid, ...m.inspect].sort(byCloseTime);
  const next = all.find((l) => l.closesAt && hoursUntil(l.closesAt, m.generatedAt) >= 0);
  const committed = m.bid.reduce((sum, l) => sum + (l.score.maxBid ?? 0), 0);

  const cells: { label: string; value: string; note: string; colour?: string }[] = [
    {
      label: 'To bid',
      value: String(m.bid.length),
      note: m.bid.length ? `${aed(committed)} AED ceiling total` : 'ceiling is firm',
      colour: palette.goldDeep,
    },
    {
      label: 'To inspect',
      value: String(m.inspect.length),
      note: 'physical check required',
    },
    {
      label: 'Next close',
      value: next?.closesAt ? clock(next.closesAt) : '—',
      note: next?.closesAt ? untilLabel(next.closesAt, m.generatedAt) : 'nothing scheduled',
    },
  ];

  const tds = cells
    .map((c, i) => {
      const first = i === 0;
      return (
        `<td class="eco-summary-cell${first ? ' eco-summary-cell--first' : ''}" width="33%" valign="top" ` +
        `style="padding:0 16px;${first ? 'padding-left:0;' : `border-left:1px solid ${palette.rule};`}${anim.rise(stagger(i, 70))}">` +
        eyebrow(c.label) +
        `<div class="${c.colour ? '' : 'eco-ink'}" style="font-family:${type.numeric};font-size:29px;line-height:34px;` +
        `color:${c.colour ?? palette.ink};margin-top:6px;">${esc(c.value)}</div>` +
        `<div class="eco-muted" style="font-family:${type.body};font-size:11px;line-height:16px;color:${palette.muted};margin-top:3px;">${esc(c.note)}</div>` +
        `</td>`
      );
    })
    .join('');

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;"><tr>${tds}</tr></table>`;
}

// ── footer ─────────────────────────────────────────────────────────────────

function footer(m: DigestModel): string {
  const capture =
    m.captureRate === null
      ? 'no auction observed yet'
      : `${Math.round(m.captureRate * 100)}% of watchlist lots priced`;
  const captureColour =
    m.captureRate !== null && m.captureRate < 0.7 ? palette.warn : palette.muted;

  const staleness = m.stalenessWarnings.length
    ? `<div style="margin-top:16px;">` +
      eyebrow('Valuation staleness', palette.warn) +
      m.stalenessWarnings
        .map(
          (w) =>
            `<div class="eco-muted" style="font-family:${type.body};font-size:11.5px;line-height:18px;color:${palette.muted};margin-top:3px;">${esc(w)}</div>`,
        )
        .join('') +
      `</div>`
    : '';

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;">
  <tr><td class="eco-pad" style="padding:0 ${layout.gutter}px;">
    ${hairline()}
    <div style="padding:20px 0 0;">
      ${eyebrow('Run integrity')}
      <div class="eco-ink-soft" style="font-family:${type.body};font-size:11.5px;line-height:19px;color:${palette.textSoft};margin-top:7px;">
        Capture rate <span style="color:${captureColour};">${esc(capture)}</span>.
        Unobserved lots are recorded as gaps, never omitted — comps stay untrustworthy until capture is consistently high.
      </div>
      <div class="eco-muted" style="font-family:${type.body};font-size:11px;line-height:18px;color:${palette.muted};margin-top:10px;">
        Starting bid is a floor, never a sale price. Hammer prices are not exposed anonymously and are never inferred.
        Every lot here has a positively established or explicitly unverified title; nothing is promoted by silence.
      </div>
      ${staleness}
      <div class="eco-muted" style="font-family:${type.body};font-size:10px;line-height:16px;letter-spacing:.1em;text-transform:uppercase;color:${palette.muted};margin-top:20px;">
        Config ${esc(m.configVersion)} · ${int(m.funnel.sitemapTotal)} lots indexed · ${int(m.funnel.rendered)} rendered · ${(m.runDurationMs / 1000).toFixed(0)}s
      </div>
    </div>
    ${spacer(30)}
  </td></tr>
</table>`.trim();
}

// ── document ───────────────────────────────────────────────────────────────

function preheader(m: DigestModel): string {
  const text =
    m.bid.length + m.inspect.length === 0
      ? 'No lot cleared the gates today. Funnel enclosed.'
      : `${m.bid.length} to bid, ${m.inspect.length} to inspect. Sorted by close time.`;
  // Zero-width joiners stop clients from padding the preview with body copy.
  return (
    `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all;">` +
    `${esc(text)}${'&#8204;&nbsp;'.repeat(60)}</div>`
  );
}

export interface RenderedDigest {
  subject: string;
  html: string;
  text: string;
}

export function renderDigest(m: DigestModel): RenderedDigest {
  const bid = [...m.bid].sort(byCloseTime);
  const inspect = [...m.inspect].sort(byCloseTime);
  const empty = bid.length === 0 && inspect.length === 0;

  let cursor = 0;
  const sections: string[] = [];

  if (empty) {
    sections.push(emptyState(stagger(cursor++)));
  } else {
    if (bid.length > 0) {
      sections.push(sectionHeader('Bid', 'ceiling is firm', bid.length, stagger(cursor++)));
      sections.push(bid.map((l, i) => lotCard(l, cursor + i, m.generatedAt)).join(''));
      cursor += bid.length;
      sections.push(spacer(18));
    }
    if (inspect.length > 0) {
      sections.push(
        sectionHeader(
          'Inspect',
          'title unconfirmed, low confidence, or no defensible valuation',
          inspect.length,
          stagger(cursor++),
        ),
      );
      sections.push(inspect.map((l, i) => lotCard(l, cursor + i, m.generatedAt)).join(''));
      cursor += inspect.length;
    }
  }

  const funnelDelay = stagger(cursor++);

  const html = `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>Ecosine Auction Intelligence</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>${MOTION_CSS}</style>
</head>
<body class="eco-body" style="margin:0;padding:0;background-color:${palette.paper};">
${preheader(m)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="eco-body" style="width:100%;background-color:${palette.paper};">
<tr><td align="center" style="padding:0;">

<table role="presentation" width="${layout.width}" cellpadding="0" cellspacing="0" border="0" class="eco-shell" style="width:${layout.width}px;max-width:${layout.width}px;background-color:${palette.paper};">

  <tr><td style="padding:0;">${masthead(m)}</td></tr>

  <tr><td class="eco-pad" style="padding:26px ${layout.gutter}px 0;">${summaryStrip(m)}</td></tr>

  <tr><td class="eco-pad" style="padding:26px ${layout.gutter}px 0;">${hairline()}</td></tr>

  <tr><td class="eco-pad" style="padding:26px ${layout.gutter}px 0;">
    ${sections.join('\n')}
  </td></tr>

  <tr><td class="eco-pad" style="padding:30px ${layout.gutter}px 0;">
    <div style="${anim.rise(funnelDelay)}">
      ${eyebrow('Funnel')}
      <div class="eco-muted" style="font-family:${type.body};font-size:11px;line-height:17px;color:${palette.muted};margin:5px 0 14px;">
        Each stage is cheaper than the one after it. Vision never sees a lot a free check could have killed.
        Bar length is logarithmic; the figures are exact.
      </div>
      ${funnelStrip(m.funnel, funnelDelay + 120)}
    </div>
  </td></tr>

  <tr><td class="eco-pad" style="padding:30px ${layout.gutter}px 0;">&nbsp;</td></tr>
  <tr><td style="padding:0;">${footer(m)}</td></tr>

</table>

</td></tr>
</table>
</body>
</html>`;

  return { subject: subjectFor(m), html, text: plainText(m, bid, inspect) };
}

function subjectFor(m: DigestModel): string {
  const d = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Dubai' }).format(
    m.generatedAt,
  );
  if (m.bid.length === 0 && m.inspect.length === 0) return `Ecosine · no qualifying lots · ${d}`;
  const parts: string[] = [];
  if (m.bid.length) parts.push(`${m.bid.length} to bid`);
  if (m.inspect.length) parts.push(`${m.inspect.length} to inspect`);
  const closing = [...m.bid, ...m.inspect].filter(
    (l) => l.closesAt && hoursUntil(l.closesAt, m.generatedAt) <= CLOSING_SOON_HOURS,
  ).length;
  return `Ecosine · ${parts.join(', ')}${closing ? ` · ${closing} closing today` : ''} · ${d}`;
}

function plainText(m: DigestModel, bid: DigestLot[], inspect: DigestLot[]): string {
  const line = (l: DigestLot): string =>
    [
      `  ${l.lotNo !== null ? `Lot ${l.lotNo}` : '—'}  ${l.title}`,
      `    ${km(l.mileageKm)}${l.primaryDamage ? ` · ${l.primaryDamage}` : ''}${l.vision ? ` · tier ${l.vision.tier}` : ''}`,
      `    repair ${l.vision ? `${aed(l.vision.repairLowAed)}–${aed(l.vision.repairHighAed)} AED` : 'not assessed'}` +
        `  |  max bid ${l.score.maxBid !== null ? `${aed(l.score.maxBid)} AED` : 'no ceiling'}` +
        `  |  closes ${l.closesAt ? clock(l.closesAt) : '—'}`,
      `    ${l.url}`,
    ].join('\n');

  const out = [
    'ECOSINE AUCTION INTELLIGENCE',
    longDate(m.generatedAt),
    'Al Qaryah · Sharjah',
    '',
    `To bid: ${bid.length}    To inspect: ${inspect.length}`,
    '',
  ];
  if (bid.length) out.push('BID — ceiling is firm', ...bid.map(line), '');
  if (inspect.length) out.push('INSPECT — physical check required', ...inspect.map(line), '');
  if (!bid.length && !inspect.length) out.push('No lot cleared the gates today. The screen ran to completion.', '');
  out.push(
    `Funnel: ${int(m.funnel.sitemapTotal)} indexed -> ${int(m.funnel.afterYearGate)} year -> ` +
      `${int(m.funnel.afterModelGate)} model -> ${int(m.funnel.rendered)} rendered -> ` +
      `${int(m.funnel.visionCalls)} vision -> ${int(bid.length + inspect.length)} surfaced`,
    m.captureRate === null
      ? 'Capture rate: no auction observed yet.'
      : `Capture rate: ${Math.round(m.captureRate * 100)}% of watchlist lots priced.`,
    'Starting bid is a floor, never a sale price.',
    ...(m.stalenessWarnings.length ? ['', 'Stale valuations:', ...m.stalenessWarnings.map((w) => `  ${w}`)] : []),
    '',
    `Config ${m.configVersion}`,
  );
  return out.join('\n');
}

// ── delivery ───────────────────────────────────────────────────────────────

export async function sendDigest(m: DigestModel): Promise<'sent' | 'skipped' | 'written'> {
  const rendered = renderDigest(m);
  const empty = m.bid.length === 0 && m.inspect.length === 0;

  if (empty && !SEND_EMPTY_DIGEST) return 'skipped';

  if (DIGEST_DRY_RUN || !SMTP.host || !SMTP.to) {
    mkdirSync('preview', { recursive: true });
    const path = `preview/digest-${m.generatedAt.toISOString().slice(0, 10)}.html`;
    writeFileSync(path, rendered.html, 'utf8');
    writeFileSync(path.replace(/\.html$/, '.txt'), rendered.text, 'utf8');
    console.log(`digest written to ${path}${SMTP.host ? '' : ' (SMTP not configured)'}`);
    return 'written';
  }

  const transport = nodemailer.createTransport({
    host: SMTP.host,
    port: SMTP.port,
    secure: SMTP.secure,
    ...(SMTP.user ? { auth: { user: SMTP.user, pass: SMTP.pass } } : {}),
  });

  await transport.sendMail({
    from: SMTP.from,
    to: SMTP.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });

  return 'sent';
}
