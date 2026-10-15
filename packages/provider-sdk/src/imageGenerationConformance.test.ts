import { decodeProviderInstance, decodeProviderModelId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  classifyImageHttpFailure,
  imageFailure,
  imageInterrupted,
  isProviderFailure,
  readImageJson,
  sanitizeImageFailure,
  type ImageAdapterResult,
  type ImageGenerationDriver,
} from "./imageGeneration";
import { runImageGenerationConformance } from "./imageGenerationConformance";

const modelId = decodeProviderModelId("image-model");
const instance = decodeProviderInstance({
  id: "00000000-0000-4000-8000-0000000000a1",
  displayName: "Image profile",
  enabled: true,
  environmentPolicy: "inherit-host",
  version: 1,
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z",
  driverKind: "bfl-image",
  configuration: { kind: "bfl-image-http", modelAllowlist: [modelId], defaultModel: modelId },
});

/** A synchronous URL-result provider written only against the seam. */
const honestDriver: ImageGenerationDriver = {
  driverKind: "bfl-image",
  create: ({ ports }) => ({
    generate: async (request): Promise<ImageAdapterResult> => {
      try {
        if (request.signal?.aborted)
          return { status: "failed", providerFailure: imageInterrupted() };
        if (request.prompt.trim().length === 0) {
          return {
            status: "failed",
            providerFailure: imageFailure("invalid-configuration", "The prompt is empty."),
          };
        }
        const response = await ports.request({
          url: "https://images.example.test/v1/generate",
          method: "POST",
          auth: { header: "x-key" },
          body: JSON.stringify({ prompt: request.prompt }),
        });
        if (!response.ok) {
          return { status: "failed", providerFailure: classifyImageHttpFailure(response) };
        }
        const payload = await readImageJson(response);
        const url =
          typeof payload === "object" && payload !== null && "url" in payload
            ? String(payload.url)
            : "";
        const fetched = await ports.fetchApprovedImageUrl({ url });
        if ("failure" in fetched) return { status: "failed", providerFailure: fetched.failure };
        const mediaType = ports.sniffMediaType(fetched.bytes);
        if (mediaType === undefined) {
          return {
            status: "failed",
            providerFailure: imageFailure("protocol", "The image bytes are malformed."),
          };
        }
        return { status: "completed", images: [{ bytes: fetched.bytes, mediaType }] };
      } catch (error) {
        return { status: "failed", providerFailure: sanitizeImageFailure(error) };
      }
    },
  }),
};

const fixture = {
  driver: honestDriver,
  instance,
  request: { instanceId: instance.id, modelId, prompt: "a lighthouse at dusk" },
  respond: () => Response.json({ url: "https://delivery.example.test/sample.png" }),
  expectedImageCount: 1,
};

describe("image generation conformance", () => {
  it("passes a driver that keeps every seam promise", async () => {
    await expect(runImageGenerationConformance(fixture)).resolves.toEqual({
      cancelledBeforeAnyCall: true,
      emptyPromptRefusedBeforeAnyCall: true,
      unreachableProviderClassified: true,
      unexpectedErrorContained: true,
      completedWithHostMediaTypes: true,
      hostMediaRefusalHonored: true,
    });
  });

  it("refuses a driver that calls the provider for a cancelled request", async () => {
    const eager: ImageGenerationDriver = {
      driverKind: "bfl-image",
      create: (context) => ({
        generate: async (request) => {
          await context.ports.request({
            url: "https://images.example.test/v1/generate",
            method: "POST",
            auth: { header: "x-key" },
          });
          return honestDriver.create(context).generate(request);
        },
      }),
    };
    await expect(runImageGenerationConformance({ ...fixture, driver: eager })).rejects.toThrow(
      "a cancelled request still called the provider",
    );
  });

  it("refuses a driver whose generate rejects", async () => {
    const throwing: ImageGenerationDriver = {
      driverKind: "bfl-image",
      create: () => ({
        generate: async () => {
          throw new Error("boom");
        },
      }),
    };
    await expect(runImageGenerationConformance({ ...fixture, driver: throwing })).rejects.toThrow(
      "generate rejected instead of failing",
    );
  });

  it("refuses a driver that labels bytes itself instead of asking the host", async () => {
    const selfLabelling: ImageGenerationDriver = {
      driverKind: "bfl-image",
      create: (context) => {
        const honest = honestDriver.create({
          ...context,
          ports: { ...context.ports, sniffMediaType: () => "image/png" },
        });
        return { generate: (request) => honest.generate(request) };
      },
    };
    await expect(
      runImageGenerationConformance({ ...fixture, driver: selfLabelling }),
    ).rejects.toThrow("bytes the host's media-type check refused");
  });
});

describe("image provider failure mapping", () => {
  it("records a provider failure as itself and anything else as a generic failure", () => {
    expect(
      sanitizeImageFailure({
        category: "rate-limited",
        message: "Slow down.",
        retryAfterMs: 2_000,
      }),
    ).toEqual({ category: "rate-limited", message: "Slow down.", retryAfterMs: 2_000 });
    expect(sanitizeImageFailure({ category: "rate-limited", message: "x", raw: "body" })).toEqual({
      category: "provider-failed",
      message: "The provider request failed.",
    });
    expect(sanitizeImageFailure(new Error("private detail"))).toEqual({
      category: "provider-failed",
      message: "The provider request failed.",
    });
  });

  it("classifies a rate limit with the provider's capped retry delay", () => {
    const failure = classifyImageHttpFailure(
      new Response(null, { status: 429, headers: { "retry-after": "999999" } }),
    );
    expect(failure).toEqual({
      category: "rate-limited",
      message: "The provider rate limit was reached.",
      retryAfterMs: 3_600_000,
    });
    expect(isProviderFailure(failure)).toBe(true);
  });

  it("reports an unparseable response body as a protocol failure", async () => {
    await expect(readImageJson(new Response("not json"))).rejects.toEqual({
      category: "protocol",
      message: "The provider returned an invalid image response.",
    });
  });
});
