/**
 * vision.ts — photo damage tier + repair range (§6.5).
 *
 * The only paid stage. It never sees a lot a free check could have killed —
 * callers must filter to `gate !== 'reject'` first (§3).
 *
 * It does not make buy decisions (§4). It returns a tier, three hard flags,
 * a repair range and a confidence; scoring.ts turns that into a ceiling.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
// The SDK's zod helper is built against the v4 schema API; importing the
// classic v3 surface here makes the inferred `parsed_output` collapse to `{}`.
import * as z from 'zod/v4';
import {
  VISION_EFFORT,
  VISION_MAX_PHOTOS,
  VISION_MAX_TOKENS,
  VISION_MODEL,
} from './config.js';
import type { NormalisedVehicle, VisionResult } from './types.js';

const DamageAssessment = z.object({
  tier: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe(
      'Overall damage severity. 1 = cosmetic only. 2 = bolt-on panel/light replacement. ' +
        '3 = significant bodywork, still economically repairable. ' +
        '4 = heavy damage, suspected structural or mechanical involvement. ' +
        '5 = severe; consistent with a total loss.',
    ),
  structural: z
    .boolean()
    .describe(
      'True if any load-bearing structure is visibly damaged: frame rail, unibody, A/B/C pillar, ' +
        'firewall, radiator support, strut tower, rocker, or a rear quarter that is cut or kinked. ' +
        'Bolted panels (bumper cover, bonnet, wing, door skin) are NOT structural.',
    ),
  floodIndicators: z
    .boolean()
    .describe(
      'True on any water-immersion sign: interior silt or mud line, waterline staining on trim or ' +
        'door cards, corroded seat rails or belt anchors, condensation inside lamp housings, ' +
        'mould on upholstery or headliner.',
    ),
  airbagsDeployed: z.boolean().describe('True if any airbag is visibly deployed or any module is torn open.'),
  repairLowAed: z.number().int().min(0).describe('Optimistic repair cost in AED at UAE trade labour rates.'),
  repairMidAed: z.number().int().min(0).describe('Most likely repair cost in AED.'),
  repairHighAed: z
    .number()
    .int()
    .min(0)
    .describe('Pessimistic repair cost in AED, assuming hidden damage behind what the photos show.'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      'Confidence in this assessment. LOWER this rather than guessing when the angles provided hide ' +
        'the front structure, the underbody, or the interior.',
    ),
  notes: z.string().max(600).describe('One or two sentences: what is visible, and what the photos do not show.'),
});

const SYSTEM = `You assess damaged vehicles for Ecosine Transport, a UAE commercial fleet operator.

Ecosine buys cars that must be repaired, inspected, registered with the RTA and then
operated commercially. That constraint drives everything you report:

- A car that will fail RTA technical inspection is worth nothing to Ecosine at any price.
  RTA inspection specifically targets structural repair and flood damage, and vehicle
  history is checked at that inspection.
- Repair costs are UAE trade rates in AED: independent body shop labour, mixed OEM and
  aftermarket parts, no main-dealer pricing.
- The photo set is the ONLY evidence you have. It is usually incomplete.

Calibrating confidence is part of the job, not a formality. When the angles provided hide
the front structure, the underbody, or the interior, LOWER your confidence rather than
guessing. A confident wrong tier costs more than an honest uncertain one, because the bid
ceiling is solved directly against your repair range and carried into a live auction.

The platform's own damage codes and start code are supplied as priors. They are usually
accurate about the primary impact point. Treat them as evidence to reconcile against the
photos, not as ground truth to repeat — and say so in your notes when the photos disagree
with them.`;

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

function priors(v: NormalisedVehicle): string {
  const lines = [
    `Vehicle: ${v.year ?? '?'} ${v.make ?? '?'} ${v.model ?? '?'}`,
    `Odometer: ${v.mileageKm !== null ? `${v.mileageKm.toLocaleString('en-GB')} km` : 'not reported'}`,
    `Platform primary damage: ${v.primaryDamage ?? 'not reported'}`,
    `Platform secondary damage: ${v.secondaryDamage ?? 'none reported'}`,
    `Platform start code: ${v.startCode?.title ?? 'not reported'}${
      v.startCode?.description ? ` — ${v.startCode.description}` : ''
    }`,
  ];
  return lines.join('\n');
}

export class VisionError extends Error {}

/**
 * Assess one lot. Returns null when there is nothing to look at — an absent
 * assessment is recorded as a gap, never silently treated as clean (§1.4).
 */
export async function assess(v: NormalisedVehicle): Promise<VisionResult | null> {
  const photos = v.photos.slice(0, VISION_MAX_PHOTOS);
  if (photos.length === 0) return null;

  const response = await anthropic().messages.parse({
    model: VISION_MODEL,
    max_tokens: VISION_MAX_TOKENS,
    // Frozen prefix: the system prompt is byte-identical across every lot, so
    // it caches once per run rather than per call.
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: {
      effort: VISION_EFFORT,
      format: zodOutputFormat(DamageAssessment),
    },
    messages: [
      {
        role: 'user',
        content: [
          ...photos.map((url) => ({ type: 'image' as const, source: { type: 'url' as const, url } })),
          {
            type: 'text' as const,
            text:
              `${priors(v)}\n\n` +
              `${photos.length} photograph${photos.length === 1 ? '' : 's'} above.\n\n` +
              `Assess the damage. Reconcile the platform priors against what you can actually see, ` +
              `and lower your confidence for anything the photos do not cover.`,
          },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new VisionError(`vision refused: ${response.stop_details?.category ?? 'unspecified'}`);
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new VisionError(`vision returned no parsable assessment (stop: ${response.stop_reason})`);

  // Keep the range monotonic even if the model emits it out of order.
  const [low, mid, high] = [parsed.repairLowAed, parsed.repairMidAed, parsed.repairHighAed].sort(
    (a, b) => a - b,
  ) as [number, number, number];

  return {
    tier: parsed.tier as VisionResult['tier'],
    structural: parsed.structural,
    floodIndicators: parsed.floodIndicators,
    airbagsDeployed: parsed.airbagsDeployed,
    repairLowAed: low,
    repairMidAed: mid,
    repairHighAed: high,
    confidence: parsed.confidence,
    notes: parsed.notes,
    photosUsed: photos.length,
  };
}
