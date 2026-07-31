/**
 * types.ts — shared shapes.
 *
 * Field names on `VehiclePayload` were captured live on 31-Jul-2026 against a
 * real listing (§2.4). They are confirmed, not inferred. Do not guess alternates.
 */

// ── Sitemap ─────────────────────────────────────────────────────────────────

/** Everything parseable from a detail URL, before any browser work (§2.2). */
export interface LotRef {
  /** 24-hex Mongo ObjectId. */
  id: string;
  url: string;
  make: string;
  model: string;
  year: number;
  /** `make|model`, slug-normalised — the TARGET_MODELS / valuation key. */
  key: string;
}

export interface SitemapDiff {
  added: LotRef[];
  stillListed: LotRef[];
  removedIds: string[];
  /** Every lot seen this walk, for the snapshot write. */
  all: LotRef[];
}

// ── Al Qaryah API ───────────────────────────────────────────────────────────

export interface StartCode {
  title?: string;
  code?: string;
  description?: string;
}

export interface VinImage {
  imageType?: string;
  type?: string;
  image?: string;
  defaultimage?: number;
}

/** Confirmed vehicle record (§2.4). Optional throughout — absence is signal. */
export interface VehiclePayload {
  _id: string;
  lotNo?: number;
  /** Full VIN. The UI masks this; the API does not (§14). */
  vin?: string;
  /** Arrives as a STRING. Coerced at the fetch boundary (§11 step 3). */
  year?: string | number;
  make?: string;
  model?: string;
  series?: string;
  carDescription?: string;

  /** THE REGISTRABILITY GATE. Structured boolean. Absence ⇒ UNVERIFIED (§1.3). */
  clean_title?: boolean;
  clean_Title_pdf?: string | null;

  primaryDamage?: string;
  /** "-" means none. Normalised to null (§11 step 3). */
  secondaryDamage?: string;
  startCode?: StartCode;

  milage?: number;
  /** "mi" on US imports. Normalised to km (§11 step 3). */
  mileageUnit?: string;
  bodys?: string;
  drivetypes?: string;
  fueltypes?: string;
  transmission?: string;
  engines?: string;
  cylinder?: number;
  color?: string;

  /** Floor only. NOT a sale price — never presented or used as one (§2.6). */
  startingBid?: number;
  auctionVehicleStatus?: string;
  inventoryStatus?: number;
  status?: string;

  auctionId?: string;
  auctionDisplayNo?: number;
  lane?: string;
  branchs?: string;
  warehouses?: string;

  vinimages?: VinImage[];
  singleImages?: string;

  inspection?: Record<string, { status?: boolean; notes?: string }>;
  inventoryRemarks?: string;
  createdAt?: string;
  [k: string]: unknown;
}

/** Confirmed auction record (§2.5). */
export interface AuctionPayload {
  _id: string;
  title?: string;
  auctionDate?: string;
  auctionTime?: string;
  auctionType?: string;
  isAuctionActive?: boolean;
  isAuctionEnded?: boolean;
  isAuctionFinished?: boolean;
  isAuctionPaused?: boolean;
  auctionStart?: boolean;
  auctionClose?: number;
  greenLightBidValue?: number;
  redLightBidValue?: number;
  totalUnsoldCar?: number;
  branchName?: string;
  lanes?: { _id?: string; lane?: string; start?: boolean; finish?: boolean }[];
  sequenceListPdf?: string;
  multiImagePdf?: string;
  [k: string]: unknown;
}

// ── Normalised record (fetch boundary, §11 step 3) ─────────────────────────

export interface NormalisedVehicle {
  id: string;
  url: string;
  lotNo: number | null;
  vin: string | null;
  /** Coerced to number. */
  year: number | null;
  make: string | null;
  model: string | null;
  key: string;
  description: string | null;

  cleanTitle: boolean | undefined;
  primaryDamage: string | null;
  /** null when the payload said "-". */
  secondaryDamage: string | null;
  startCode: StartCode | null;

  /** Always km, whatever the source unit was. */
  mileageKm: number | null;
  startingBid: number | null;
  auctionVehicleStatus: string | null;
  auctionId: string | null;
  lane: string | null;
  photos: string[];
  narration: string;
  raw: VehiclePayload;
}

// ── Gate (§6.4) ─────────────────────────────────────────────────────────────

export type GateVerdict = 'pass' | 'unverified' | 'reject';
export type TitleStatus = 'clean' | 'salvage' | 'unknown';

export interface GateResult {
  verdict: GateVerdict;
  titleStatus: TitleStatus;
  /** Human-readable, stored verbatim on the assessment row. */
  reason: string;
}

// ── Vision (§6.5) ───────────────────────────────────────────────────────────

export interface VisionResult {
  tier: 1 | 2 | 3 | 4 | 5;
  structural: boolean;
  floodIndicators: boolean;
  airbagsDeployed: boolean;
  repairLowAed: number;
  repairMidAed: number;
  repairHighAed: number;
  confidence: number;
  notes: string;
  /** Photos actually shown to the model. */
  photosUsed: number;
}

// ── Scoring (§7) ────────────────────────────────────────────────────────────

export type Action = 'BID' | 'INSPECT' | 'DROP';

export interface ScoreResult {
  action: Action;
  /** null when no defensible valuation exists. Missing means missing (§13). */
  fleetReadyValue: number | null;
  fleetValueReviewedOn: string | null;
  fleetValueStale: boolean;
  repairEstimate: number | null;
  maxBid: number | null;
  /** maxBid as a share of fleetReadyValue. null when either is missing. */
  bidToValue: number | null;
  marginAed: number | null;
  reasons: string[];
}

// ── Digest (§9) ─────────────────────────────────────────────────────────────

export interface DigestLot {
  id: string;
  url: string;
  lotNo: number | null;
  title: string;
  year: number | null;
  mileageKm: number | null;
  primaryDamage: string | null;
  secondaryDamage: string | null;
  startCodeTitle: string | null;
  titleStatus: TitleStatus;
  gate: GateVerdict;
  vision: VisionResult | null;
  score: ScoreResult;
  lane: string | null;
  closesAt: Date | null;
  isNew: boolean;
  photo: string | null;
}

export interface FunnelStats {
  sitemapTotal: number;
  afterYearGate: number;
  afterModelGate: number;
  rendered: number;
  gatePassed: number;
  gateUnverified: number;
  gateRejected: number;
  visionCalls: number;
  cleanTitleShare: number | null;
}

export interface DigestModel {
  generatedAt: Date;
  auctionTitle: string | null;
  bid: DigestLot[];
  inspect: DigestLot[];
  funnel: FunnelStats;
  /** Stale FLEET_READY_VALUES entries surfaced in the footer (§7.1a). */
  stalenessWarnings: string[];
  /** Share of watchlist lots with an observed price. System health (§8.4). */
  captureRate: number | null;
  configVersion: string;
  runDurationMs: number;
}
