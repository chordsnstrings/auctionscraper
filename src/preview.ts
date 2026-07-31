/**
 * preview.ts — render the digest to disk without a live run.
 *
 * The email is the product surface, so it needs to be reviewable on its own:
 * open the output in a browser to see the animations, drag the window narrow
 * for the responsive layout, and flip the OS to dark mode for that variant.
 *
 *   npm run preview
 *
 * Writes preview/sample.html (populated) and preview/empty.html (the
 * SEND_EMPTY_DIGEST case, which has to look like a completed run).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { CONFIG_VERSION } from './config.js';
import { renderDigest } from './digest.js';
import { score } from './scoring.js';
import type { DigestLot, DigestModel, GateResult, NormalisedVehicle, VisionResult } from './types.js';
import * as ui from './ui.js';

const NOW = new Date('2026-07-31T06:04:00.000Z');
const closes = (hoursFromNow: number) => new Date(NOW.getTime() + hoursFromNow * 3_600_000);

interface Sample {
  id: string;
  lotNo: number;
  key: string;
  year: number;
  title: string;
  mileageKm: number;
  primaryDamage: string;
  secondaryDamage: string | null;
  startCode: string;
  lane: string;
  cleanTitle: boolean | undefined;
  vision: Omit<VisionResult, 'photosUsed'> | null;
  closesIn: number;
  isNew: boolean;
}

const SAMPLES: Sample[] = [
  {
    id: '695bd4635ef41f04b3555431',
    lotNo: 192_211,
    key: 'toyota|camry',
    year: 2025,
    title: '2025 Toyota Camry LE',
    mileageKm: 15_958,
    primaryDamage: 'Right front',
    secondaryDamage: null,
    startCode: 'Run & Drive',
    lane: 'lane-a',
    cleanTitle: true,
    vision: {
      tier: 2,
      structural: false,
      floodIndicators: false,
      airbagsDeployed: false,
      repairLowAed: 9_400,
      repairMidAed: 10_800,
      repairHighAed: 12_000,
      confidence: 0.82,
      notes:
        'Right front bumper cover, headlamp and wing are bolt-on replacements; the rail and radiator support look straight in the three-quarter shot. No interior or underbody angle supplied.',
    },
    closesIn: 6.2,
    isNew: true,
  },
  {
    id: '695bd4635ef41f04b3555432',
    lotNo: 192_388,
    key: 'honda|accord',
    year: 2025,
    title: '2025 Honda Accord Sport',
    mileageKm: 28_410,
    primaryDamage: 'Rear',
    secondaryDamage: 'Left side',
    startCode: 'Run & Drive',
    lane: 'lane-a',
    cleanTitle: true,
    vision: {
      tier: 2,
      structural: false,
      floodIndicators: false,
      airbagsDeployed: false,
      repairLowAed: 11_200,
      repairMidAed: 13_500,
      repairHighAed: 15_800,
      confidence: 0.74,
      notes:
        'Rear bumper and boot floor lip deformed; quarter panel creased but not cut. Rear impact severity is hard to bound without a boot-open shot.',
    },
    closesIn: 6.2,
    isNew: false,
  },
  {
    id: '695bd4635ef41f04b3555433',
    lotNo: 192_504,
    key: 'nissan|altima',
    year: 2026,
    title: '2026 Nissan Altima SV',
    mileageKm: 9_120,
    primaryDamage: 'Front end',
    secondaryDamage: null,
    startCode: 'Run & Drive',
    lane: 'lane-b',
    cleanTitle: true,
    vision: {
      tier: 1,
      structural: false,
      floodIndicators: false,
      airbagsDeployed: false,
      repairLowAed: 4_800,
      repairMidAed: 6_100,
      repairHighAed: 7_400,
      confidence: 0.88,
      notes:
        'Cosmetic only: bumper cover scuffed through, grille cracked, one fog surround missing. Bonnet gaps are even and the crash bar is untouched.',
    },
    closesIn: 30.5,
    isNew: true,
  },
  {
    id: '695bd4635ef41f04b3555434',
    lotNo: 192_641,
    key: 'hyundai|elantra',
    year: 2025,
    title: '2025 Hyundai Elantra',
    mileageKm: 41_780,
    primaryDamage: 'Left front',
    secondaryDamage: null,
    startCode: 'Engine Start Program',
    lane: 'lane-b',
    cleanTitle: true,
    vision: {
      tier: 3,
      structural: false,
      floodIndicators: false,
      airbagsDeployed: true,
      repairLowAed: 16_500,
      repairMidAed: 19_200,
      repairHighAed: 23_000,
      confidence: 0.61,
      notes:
        'Driver airbag deployed and the left strut tower area is obscured by the wing in every supplied angle. Confidence lowered accordingly — a structural check is the deciding factor here.',
    },
    closesIn: 30.5,
    isNew: false,
  },
  {
    id: '695bd4635ef41f04b3555435',
    lotNo: 192_702,
    key: 'kia|k5',
    year: 2025,
    title: '2025 Kia K5 GT-Line',
    mileageKm: 22_310,
    primaryDamage: 'Right side',
    secondaryDamage: null,
    startCode: 'Run & Drive',
    lane: 'lane-b',
    cleanTitle: undefined,
    vision: {
      tier: 2,
      structural: false,
      floodIndicators: false,
      airbagsDeployed: false,
      repairLowAed: 8_900,
      repairMidAed: 10_400,
      repairHighAed: 12_600,
      confidence: 0.79,
      notes:
        'Both right doors creased, mirror gone; rocker and B-pillar look undisturbed. Panel work rather than structural.',
    },
    closesIn: 54,
    isNew: true,
  },
];

function toDigestLot(s: Sample): DigestLot {
  const vehicle = {
    key: s.key,
    year: s.year,
  } as unknown as NormalisedVehicle;

  const gate: GateResult =
    s.cleanTitle === true && s.startCode === 'Run & Drive'
      ? { verdict: 'pass', titleStatus: 'clean', reason: 'gates passed' }
      : s.cleanTitle === undefined
        ? { verdict: 'unverified', titleStatus: 'unknown', reason: 'clean_title absent — physical check required' }
        : { verdict: 'unverified', titleStatus: 'clean', reason: `start code "${s.startCode}" — not run & drive` };

  const vision: VisionResult | null = s.vision ? { ...s.vision, photosUsed: 6 } : null;

  return {
    id: s.id,
    url: `https://www.alqaryahauction.com/vehicle-details/${s.key.split('|')[0]}/${s.key.split('|')[1]}/${s.year}-${s.id}`,
    lotNo: s.lotNo,
    title: s.title,
    year: s.year,
    mileageKm: s.mileageKm,
    primaryDamage: s.primaryDamage,
    secondaryDamage: s.secondaryDamage,
    startCodeTitle: s.startCode,
    titleStatus: gate.titleStatus,
    gate: gate.verdict,
    vision,
    score: score(vehicle, gate, vision),
    lane: s.lane,
    closesAt: closes(s.closesIn),
    isNew: s.isNew,
    photo: null,
  };
}

function build(lots: DigestLot[]): DigestModel {
  return {
    generatedAt: NOW,
    auctionTitle: 'Onsite & Online Auction (Friday)',
    bid: lots.filter((l) => l.score.action === 'BID'),
    inspect: lots.filter((l) => l.score.action === 'INSPECT'),
    funnel: {
      sitemapTotal: 4_912,
      afterYearGate: 1_208,
      afterModelGate: 214,
      rendered: 96,
      gatePassed: lots.filter((l) => l.gate === 'pass').length,
      gateUnverified: lots.filter((l) => l.gate === 'unverified').length,
      gateRejected: 61,
      visionCalls: lots.length,
      cleanTitleShare: 0.36,
    },
    stalenessWarnings: [],
    captureRate: 0.82,
    configVersion: CONFIG_VERSION,
    runDurationMs: 218_400,
  };
}

function main(): void {
  mkdirSync('preview', { recursive: true });
  ui.banner('Digest preview', 'rendered to disk · no SMTP, no network');

  const lots = SAMPLES.map(toDigestLot);
  const populated = renderDigest(build(lots));
  writeFileSync('preview/sample.html', populated.html, 'utf8');
  writeFileSync('preview/sample.txt', populated.text, 'utf8');

  const emptyModel = build([]);
  emptyModel.funnel.visionCalls = 0;
  emptyModel.stalenessWarnings = ['toyota corolla 2024 — last reviewed 2026-03-02'];
  const empty = renderDigest(emptyModel);
  writeFileSync('preview/empty.html', empty.html, 'utf8');

  ui.ok(`preview/sample.html  (${lots.filter((l) => l.score.action === 'BID').length} bid, ${lots.filter((l) => l.score.action === 'INSPECT').length} inspect)`);
  ui.ok('preview/empty.html   (SEND_EMPTY_DIGEST case)');
  ui.note('Open in a browser: animations run once on load; narrow the window for the mobile layout.');
  ui.note(`Subject line: ${populated.subject}`);
}

main();
