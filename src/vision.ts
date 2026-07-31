/**
 * vision.ts — photo damage tier + repair range (§6.5).
 *
 * The only paid stage. It never sees a lot a free check could have killed —
 * callers must filter to `gate !== 'reject'` first (§3).
 *
 * It does not make buy decisions (§4). It returns a tier, three hard flags,
 * a repair range and a confidence; scoring.ts turns that into a ceiling.
 *
 * Two providers, one schema. `DamageAssessment` below is the single definition
 * of what an assessment is: ModelArk receives it as a strict JSON schema and
 * Anthropic as a structured-output format, and both replies are validated
 * against it before anything downstream sees a number. A provider that answers
 * off-schema is an error, never a silently-coerced assessment (§1.4).
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
// The SDK's zod helper is built against the v4 schema API; importing the
// classic v3 surface here makes the inferred `parsed_output` collapse to `{}`.
import * as z from 'zod/v4';
import {
  ANTHROPIC_VISION_MODEL,
  ARK_API_KEY,
  ARK_BASE_URL,
  ARK_VISION_MODEL,
  VISION_EFFORT,
  VISION_MAX_PHOTOS,
  VISION_MAX_TOKENS,
  VISION_PROVIDER,
  VISION_RETRIES,
  type VisionProvider,
} from './config.js';
import { httpPhotoLoader, loadPhotos, type PhotoLoader } from './photos.js';
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

type Assessment = z.infer<typeof DamageAssessment>;

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

export class VisionError extends Error {
  override readonly name = 'VisionError';
}

// ── Prompt ─────────────────────────────────────────────────────────────────

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

function instruction(v: NormalisedVehicle, photoCount: number, available: number): string {
  const shortfall =
    photoCount < available
      ? `\n\nNOTE: ${available - photoCount} of the ${available} listed photographs could not be retrieved. ` +
        `Assess only what you can see and let that missing coverage lower your confidence.`
      : '';
  return (
    `${priors(v)}\n\n` +
    `${photoCount} photograph${photoCount === 1 ? '' : 's'} above.\n\n` +
    `Assess the damage. Reconcile the platform priors against what you can actually see, ` +
    `and lower your confidence for anything the photos do not cover.${shortfall}`
  );
}

/** Keep the range monotonic even if the model emits it out of order. */
function toResult(parsed: Assessment, photosUsed: number): VisionResult {
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
    photosUsed,
  };
}

// ── ModelArk (default) ─────────────────────────────────────────────────────

/**
 * The zod schema as JSON Schema, minus `$schema` — ModelArk's strict mode
 * rejects the dialect declaration but accepts the draft-2020-12 body,
 * `minimum`/`maximum`/`maxLength` included.
 */
export function arkJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(DamageAssessment) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/**
 * Seed's reasoning is adaptive by default and is worth paying for here: the
 * repair range is solved straight into a bid ceiling. Only `low` turns it off.
 */
function arkThinking(): { type: 'disabled' } | undefined {
  return VISION_EFFORT === 'low' ? { type: 'disabled' } : undefined;
}

interface ArkChoice {
  message?: { content?: string | null };
  finish_reason?: string;
}
interface ArkResponse {
  choices?: ArkChoice[];
  error?: { code?: string; message?: string };
  usage?: { total_tokens?: number };
}

/** Retry only what retrying can fix: rate limits, 5xx, and dropped sockets. */
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const backoff = (attempt: number): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.min(1_000 * 2 ** (attempt - 1), 8_000)));

async function arkAssess(
  v: NormalisedVehicle,
  photos: readonly { dataUrl: string }[],
  available: number,
): Promise<VisionResult> {
  if (!ARK_API_KEY) throw new VisionError('ARK_API_KEY is not set');

  const body = {
    model: ARK_VISION_MODEL,
    max_tokens: VISION_MAX_TOKENS,
    ...(arkThinking() ? { thinking: arkThinking() } : {}),
    messages: [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          ...photos.map((p) => ({ type: 'image_url' as const, image_url: { url: p.dataUrl } })),
          { type: 'text' as const, text: instruction(v, photos.length, available) },
        ],
      },
    ],
    response_format: {
      type: 'json_schema' as const,
      json_schema: { name: 'damage_assessment', strict: true, schema: arkJsonSchema() },
    },
  };

  let lastError = '';
  for (let attempt = 1; attempt <= VISION_RETRIES; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(`${ARK_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ARK_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      lastError = `transport: ${(err as Error).message}`;
      if (attempt < VISION_RETRIES) await backoff(attempt);
      continue;
    }

    const json = (await res.json().catch(() => ({}))) as ArkResponse;

    if (!res.ok || json.error) {
      lastError = `${res.status} ${json.error?.code ?? ''} ${json.error?.message ?? ''}`.trim().slice(0, 200);
      if (RETRYABLE.has(res.status) && attempt < VISION_RETRIES) {
        await backoff(attempt);
        continue;
      }
      throw new VisionError(`ModelArk refused the assessment: ${lastError}`);
    }

    const choice = json.choices?.[0];
    const content = choice?.message?.content;
    if (!content) {
      // A length stop means the schema never closed; a longer budget is the fix,
      // not a retry, so say which it was rather than looping on it.
      throw new VisionError(
        `ModelArk returned no assessment (finish_reason: ${choice?.finish_reason ?? 'unknown'})`,
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      throw new VisionError(`ModelArk returned unparsable JSON: ${content.slice(0, 120)}`);
    }

    const parsed = DamageAssessment.safeParse(raw);
    if (!parsed.success) {
      throw new VisionError(
        `ModelArk answered off-schema: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')} ${i.message}`)
          .join('; ')}`,
      );
    }
    return toResult(parsed.data, photos.length);
  }

  throw new VisionError(`ModelArk unreachable after ${VISION_RETRIES} attempts: ${lastError}`);
}

// ── Anthropic (calibration / fallback) ─────────────────────────────────────

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

/**
 * Anthropic is passed the photo URLs rather than inline bytes: its fetcher has
 * historically had no trouble with this CDN, and URLs keep the frozen system
 * prefix cacheable across a run.
 */
async function anthropicAssess(v: NormalisedVehicle, photoUrls: readonly string[]): Promise<VisionResult> {
  const response = await anthropic().messages.parse({
    model: ANTHROPIC_VISION_MODEL,
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
          ...photoUrls.map((url) => ({ type: 'image' as const, source: { type: 'url' as const, url } })),
          { type: 'text' as const, text: instruction(v, photoUrls.length, photoUrls.length) },
        ],
      },
    ],
  });

  if (response.stop_reason === 'refusal') {
    throw new VisionError(`vision refused: ${response.stop_details?.category ?? 'unspecified'}`);
  }
  const parsed = response.parsed_output;
  if (!parsed) throw new VisionError(`vision returned no parsable assessment (stop: ${response.stop_reason})`);

  return toResult(parsed as Assessment, photoUrls.length);
}

// ── Entry point ────────────────────────────────────────────────────────────

/**
 * Assess one lot. Returns null when there is nothing to look at — an absent
 * assessment is recorded as a gap, never silently treated as clean (§1.4).
 *
 * `loader` supplies the photo bytes for ModelArk. The run passes the browser's
 * request context so images come down the same authenticated, Cloudflare-cleared
 * path as the detail pages; plain HTTP is the fallback.
 */
export async function assess(
  v: NormalisedVehicle,
  loader: PhotoLoader = httpPhotoLoader,
  provider: VisionProvider = VISION_PROVIDER,
): Promise<VisionResult | null> {
  const photoUrls = v.photos.slice(0, VISION_MAX_PHOTOS);
  if (photoUrls.length === 0) return null;

  if (provider === 'anthropic') return anthropicAssess(v, photoUrls);

  const inlined = await loadPhotos(photoUrls, loader);
  if (inlined.length === 0) {
    // Photos exist but none could be retrieved. That is a fetch failure, not a
    // clean car, and it must surface as one.
    throw new VisionError(`no photo could be retrieved (0 of ${photoUrls.length} listed)`);
  }
  return arkAssess(v, inlined, photoUrls.length);
}

export { DamageAssessment, SYSTEM };
