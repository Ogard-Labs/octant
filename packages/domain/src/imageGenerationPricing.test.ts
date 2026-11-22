import { describe, expect, it } from "vitest";
import {
  IMAGE_GENERATION_PRICING_REVISION,
  estimateImageGenerationCost,
} from "./imageGenerationPricing";

describe("estimateImageGenerationCost", () => {
  it("estimates OpenAI GPT Image prices by model, quality, size, and variant count", () => {
    const lowSquare = estimateImageGenerationCost({
      driverKind: "openai-image",
      modelId: "gpt-image-1",
      quality: "low",
      size: "1024x1024",
      variantCount: 1,
    });
    expect(lowSquare).toEqual({
      kind: "api-estimate",
      perImageUsdMicros: 11_000,
      usdMicros: 11_000,
      usdCents: 2,
      pricingRevision: IMAGE_GENERATION_PRICING_REVISION,
    });

    const twoMediumWide = estimateImageGenerationCost({
      driverKind: "openai-image",
      modelId: "gpt-image-1",
      quality: "medium",
      size: "1536x1024",
      variantCount: 2,
    });
    expect(twoMediumWide).toEqual({
      kind: "api-estimate",
      perImageUsdMicros: 63_000,
      usdMicros: 126_000,
      usdCents: 13,
      pricingRevision: IMAGE_GENERATION_PRICING_REVISION,
    });

    const gptImage2 = estimateImageGenerationCost({
      driverKind: "openai-image",
      modelId: "gpt-image-2",
      quality: "high",
      size: "1024x1024",
      variantCount: 1,
    });
    expect(gptImage2).toMatchObject({
      kind: "api-estimate",
      perImageUsdMicros: 53_000,
      usdMicros: 53_000,
      usdCents: 6,
    });
  });

  it("uses the conservative upper bound for OpenAI auto or omitted quality and size", () => {
    const omitted = estimateImageGenerationCost({
      driverKind: "openai-image",
      modelId: "gpt-image-1",
      variantCount: 1,
    });
    expect(omitted).toMatchObject({
      kind: "api-estimate",
      perImageUsdMicros: 250_000,
      usdCents: 25,
    });

    const autoSize = estimateImageGenerationCost({
      driverKind: "openai-image",
      modelId: "gpt-image-2",
      quality: "medium",
      size: "auto",
      variantCount: 2,
    });
    expect(autoSize).toMatchObject({
      kind: "api-estimate",
      perImageUsdMicros: 20_000,
      usdMicros: 40_000,
      usdCents: 4,
    });
  });

  it("estimates Gemini native image prices by model and resolution", () => {
    expect(
      estimateImageGenerationCost({
        driverKind: "gemini-native-image",
        modelId: "gemini-3.1-flash-image",
        variantCount: 1,
      }),
    ).toMatchObject({
      kind: "api-estimate",
      perImageUsdMicros: 67_000,
      usdCents: 7,
    });

    expect(
      estimateImageGenerationCost({
        driverKind: "gemini-native-image",
        modelId: "gemini-3.1-flash-image",
        resolution: "4K",
        variantCount: 2,
      }),
    ).toMatchObject({
      kind: "api-estimate",
      perImageUsdMicros: 150_000,
      usdMicros: 300_000,
      usdCents: 30,
    });

    expect(
      estimateImageGenerationCost({
        driverKind: "gemini-native-image",
        modelId: "gemini-3-pro-image",
        resolution: "4K",
        variantCount: 1,
      }),
    ).toMatchObject({
      kind: "api-estimate",
      perImageUsdMicros: 240_000,
      usdCents: 24,
    });
  });

  it("estimates Black Forest Labs and Ideogram model prices", () => {
    expect(
      estimateImageGenerationCost({
        driverKind: "bfl-image",
        modelId: "flux-pro-1.1",
        variantCount: 1,
      }),
    ).toMatchObject({
      kind: "api-estimate",
      perImageUsdMicros: 40_000,
      usdCents: 4,
    });

    expect(
      estimateImageGenerationCost({
        driverKind: "ideogram-image",
        modelId: "ideogram-v3",
        variantCount: 2,
      }),
    ).toMatchObject({
      kind: "api-estimate",
      perImageUsdMicros: 60_000,
      usdMicros: 120_000,
      usdCents: 12,
    });
  });

  it("returns unpriced for unknown models, custom OpenAI-compatible sources, and invalid options", () => {
    expect(
      estimateImageGenerationCost({
        driverKind: "openai-image",
        modelId: "unlisted-image-model",
        variantCount: 1,
      }),
    ).toEqual({ kind: "unpriced", reason: "unknown-model" });

    expect(
      estimateImageGenerationCost({
        driverKind: "openai-compatible",
        modelId: "recraftv3",
        variantCount: 1,
      }),
    ).toEqual({ kind: "unpriced", reason: "unknown-provider" });

    expect(
      estimateImageGenerationCost({
        driverKind: "openai-image",
        modelId: "gpt-image-1",
        quality: "ultra" as never,
        variantCount: 1,
      }),
    ).toEqual({ kind: "unpriced", reason: "unknown-option" });

    expect(
      estimateImageGenerationCost({
        driverKind: "bfl-image",
        modelId: "flux-pro-1.1",
        variantCount: 0,
      }),
    ).toEqual({ kind: "unpriced", reason: "invalid-variant-count" });
  });
});
