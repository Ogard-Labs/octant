/**
 * Pure, versioned standard-rate API pricing for billed image generation.
 *
 * Rates are a checked-in snapshot of published provider API pricing tables.
 * This module performs no network or host I/O; when a provider, model, or
 * option has no known rate it returns `unpriced` so an active monetary spend
 * ceiling fails closed instead of treating unknown spend as free.
 */

import type { ProviderDriverKind } from "@octant/contracts";

export const IMAGE_GENERATION_PRICING_REVISION = "2026-11-21";

export type ImageGenerationUnpricedReason =
  | "unknown-provider"
  | "unknown-model"
  | "unknown-option"
  | "invalid-variant-count"
  | "overflow";

export type ImageGenerationPriceEstimate =
  | {
      readonly kind: "api-estimate";
      /** Estimated cost per single image in integer micro-dollars (1 cent = 10,000 micros). */
      readonly perImageUsdMicros: number;
      /** Total estimated cost across `variantCount` images in integer micro-dollars. */
      readonly usdMicros: number;
      /** Conservative whole US cents to reserve before dispatch (`ceil(usdMicros / 10_000)`). */
      readonly usdCents: number;
      readonly pricingRevision: string;
    }
  | {
      readonly kind: "unpriced";
      readonly reason: ImageGenerationUnpricedReason;
    };

export interface ImageGenerationPricingInput {
  readonly driverKind: ProviderDriverKind;
  readonly modelId: string;
  readonly variantCount: number;
  readonly quality?: string;
  readonly size?: string;
  readonly resolution?: string;
  /**
   * For an outside image driver only: the per-image price its trusted
   * package declares for this model, or absent when it declares none. The
   * host reads it from the package manifest, never from the running driver.
   */
  readonly declaredUsdMicrosPerImage?: number;
}

type OpenAiConcreteQuality = "low" | "medium" | "high";
type OpenAiConcreteSize = "1024x1024" | "1536x1024" | "1024x1536";
type GeminiConcreteResolution = "1K" | "2K" | "4K";

interface OpenAiModelImageRates {
  readonly square: Readonly<Record<OpenAiConcreteQuality, number>>;
  readonly rectangular: Readonly<Record<OpenAiConcreteQuality, number>>;
}

/**
 * Standard OpenAI Image API per-image rates in integer micro-dollars.
 * Sources: https://developers.openai.com/api/docs/pricing (accessed 2026-11-21).
 */
const OPENAI_IMAGE_RATES: ReadonlyMap<string, OpenAiModelImageRates> = new Map([
  [
    "gpt-image-2",
    {
      square: { low: 6_000, medium: 13_000, high: 53_000 },
      rectangular: { low: 9_000, medium: 20_000, high: 80_000 },
    },
  ],
  [
    "gpt-image-1.5",
    {
      square: { low: 9_000, medium: 34_000, high: 133_000 },
      rectangular: { low: 13_000, medium: 50_000, high: 200_000 },
    },
  ],
  [
    "gpt-image-1",
    {
      square: { low: 11_000, medium: 42_000, high: 167_000 },
      rectangular: { low: 16_000, medium: 63_000, high: 250_000 },
    },
  ],
  [
    "gpt-image-1-mini",
    {
      square: { low: 5_000, medium: 11_000, high: 36_000 },
      rectangular: { low: 6_000, medium: 15_000, high: 52_000 },
    },
  ],
]);

/**
 * Standard Gemini API per-image rates in integer micro-dollars by output resolution.
 * Omitted resolution defaults to 1K on the Gemini API.
 * Sources: https://ai.google.dev/gemini-api/docs/pricing (accessed 2026-11-21).
 */
const GEMINI_IMAGE_RATES: ReadonlyMap<
  string,
  Readonly<Partial<Record<GeminiConcreteResolution, number>>>
> = new Map([
  ["gemini-3.1-flash-image", { "1K": 67_000, "2K": 101_000, "4K": 150_000 }],
  ["gemini-3-pro-image", { "1K": 134_000, "2K": 134_000, "4K": 240_000 }],
  ["gemini-2.5-flash-image", { "1K": 39_000 }],
]);

/**
 * Standard Black Forest Labs FLUX API default-resolution per-image rates in micro-dollars.
 * The adapter submits `{ prompt }` with default dimensions, one image per job.
 */
const BFL_IMAGE_RATES: ReadonlyMap<string, number> = new Map([
  ["flux-pro-1.1", 40_000],
  ["flux-pro-1.1-ultra", 60_000],
  ["flux-dev", 25_000],
  ["flux-kontext-pro", 40_000],
  ["flux-kontext-max", 80_000],
  ["flux-2-pro", 30_000],
]);

/**
 * Standard Ideogram API default-speed per-image rates in micro-dollars.
 * The adapter submits `prompt` and `num_images` without overriding rendering speed.
 */
const IDEOGRAM_IMAGE_RATES: ReadonlyMap<string, number> = new Map([["ideogram-v3", 60_000]]);

function isOpenAiConcreteQuality(value: string): value is OpenAiConcreteQuality {
  return value === "low" || value === "medium" || value === "high";
}

function isOpenAiConcreteSize(value: string): value is OpenAiConcreteSize {
  return value === "1024x1024" || value === "1536x1024" || value === "1024x1536";
}

function isGeminiConcreteResolution(value: string): value is GeminiConcreteResolution {
  return value === "1K" || value === "2K" || value === "4K";
}

function resolveOpenAiPerImageMicros(
  modelId: string,
  quality: string | undefined,
  size: string | undefined,
): number | ImageGenerationUnpricedReason {
  const rates = OPENAI_IMAGE_RATES.get(modelId);
  if (rates === undefined) return "unknown-model";
  const qualities: ReadonlyArray<OpenAiConcreteQuality> =
    quality === undefined || quality === "auto"
      ? ["low", "medium", "high"]
      : isOpenAiConcreteQuality(quality)
        ? [quality]
        : [];
  if (qualities.length === 0) return "unknown-option";

  const sizes: ReadonlyArray<OpenAiConcreteSize> =
    size === undefined || size === "auto"
      ? ["1024x1024", "1536x1024", "1024x1536"]
      : isOpenAiConcreteSize(size)
        ? [size]
        : [];
  if (sizes.length === 0) return "unknown-option";

  // When quality or size is "auto" or omitted, reserve the conservative upper
  // bound across the allowed options so the ceiling cannot be exceeded.
  let maxMicros = 0;
  for (const candidateQuality of qualities) {
    for (const candidateSize of sizes) {
      const table = candidateSize === "1024x1024" ? rates.square : rates.rectangular;
      const rate = table[candidateQuality];
      if (rate > maxMicros) maxMicros = rate;
    }
  }
  return maxMicros > 0 ? maxMicros : "unknown-option";
}

function resolveGeminiPerImageMicros(
  modelId: string,
  resolution: string | undefined,
): number | ImageGenerationUnpricedReason {
  const rates = GEMINI_IMAGE_RATES.get(modelId);
  if (rates === undefined) return "unknown-model";
  const effective = resolution ?? "1K";
  if (!isGeminiConcreteResolution(effective)) return "unknown-option";
  const rate = rates[effective];
  return rate === undefined ? "unknown-option" : rate;
}

function resolvePerImageMicros(
  input: ImageGenerationPricingInput,
): number | ImageGenerationUnpricedReason {
  switch (input.driverKind) {
    case "openai-image":
      return resolveOpenAiPerImageMicros(input.modelId, input.quality, input.size);
    case "gemini-native-image":
      return resolveGeminiPerImageMicros(input.modelId, input.resolution);
    case "bfl-image":
      return BFL_IMAGE_RATES.get(input.modelId) ?? "unknown-model";
    case "ideogram-image":
      return IDEOGRAM_IMAGE_RATES.get(input.modelId) ?? "unknown-model";
    case "outside-image": {
      const declared = input.declaredUsdMicrosPerImage;
      if (declared === undefined) return "unknown-model";
      return Number.isSafeInteger(declared) && declared > 0 ? declared : "unknown-option";
    }
    default:
      return "unknown-provider";
  }
}

/**
 * Estimate the API-equivalent USD cost of an image generation request.
 *
 * Unknown providers (such as custom OpenAI-compatible image sources), unlisted
 * models, or unrecognized options return `unpriced` so an active monetary spend
 * ceiling refuses rather than guessing.
 */
export function estimateImageGenerationCost(
  input: ImageGenerationPricingInput,
): ImageGenerationPriceEstimate {
  if (!Number.isSafeInteger(input.variantCount) || input.variantCount < 1) {
    return { kind: "unpriced", reason: "invalid-variant-count" };
  }
  const perImage = resolvePerImageMicros(input);
  if (typeof perImage !== "number") {
    return { kind: "unpriced", reason: perImage };
  }
  const usdMicros = perImage * input.variantCount;
  if (!Number.isSafeInteger(usdMicros) || usdMicros <= 0) {
    return { kind: "unpriced", reason: "overflow" };
  }
  const usdCents = Math.ceil(usdMicros / 10_000);
  if (!Number.isSafeInteger(usdCents) || usdCents < 1) {
    return { kind: "unpriced", reason: "overflow" };
  }
  return {
    kind: "api-estimate",
    perImageUsdMicros: perImage,
    usdMicros,
    usdCents,
    pricingRevision: IMAGE_GENERATION_PRICING_REVISION,
  };
}
