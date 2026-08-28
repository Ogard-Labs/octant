import { decodeProviderInstanceId, type ProviderModelId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ProviderCredentialResolver } from "../providers/credentialBrokerClient";
import { GEMINI_IMAGE_API_BASE_URL, type ImageHttpFetch } from "./imageHttp";
import { makeGeminiImageAdapter } from "./geminiImageAdapter";

const SECRET = "gemini-fixture-super-secret";
const instanceId = decodeProviderInstanceId("a2000000-0000-4000-8000-000000000011");
const modelId = "gemini-3.1-flash-image" as ProviderModelId;
const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const pngB64 = Buffer.from(png).toString("base64");

function resolver(credential = SECRET): ProviderCredentialResolver {
  return {
    has: vi.fn(async () => true),
    resolve: vi.fn(async () => credential),
  };
}

function adapter(fetch: ImageHttpFetch, limits?: { connectionTimeoutMs?: number }) {
  return makeGeminiImageAdapter({
    instanceId,
    credentialResolver: resolver(),
    fetch,
    ...(limits === undefined ? {} : { limits }),
  });
}

function inlineResponse(data: string) {
  return Response.json({
    candidates: [
      {
        content: { parts: [{ inlineData: { mimeType: "image/png", data } }] },
        finishReason: "STOP",
      },
    ],
  });
}

describe("Gemini image adapter", () => {
  it("posts generateContent to the fixed Gemini URL with a per-request key", async () => {
    const fetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe(`${GEMINI_IMAGE_API_BASE_URL}/models/${modelId}:generateContent`);
      const headers = new Headers(init?.headers);
      expect(headers.get("x-goog-api-key")).toBe(SECRET);
      expect(headers.get("authorization")).toBeNull();
      return inlineResponse(pngB64);
    });

    const result = await adapter(fetch).generate({
      instanceId,
      modelId,
      prompt: "a lighthouse at dusk",
    });
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.images[0]?.mediaType).toBe("image/png");
    }
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("asks for the requested variant count and rejects extra inline images before completion", async () => {
    const fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        generationConfig: { candidateCount: number };
      };
      expect(body.generationConfig.candidateCount).toBe(1);
      return Response.json({
        candidates: [
          {
            content: {
              parts: [
                { inlineData: { mimeType: "image/png", data: pngB64 } },
                { inlineData: { mimeType: "image/png", data: pngB64 } },
              ],
            },
            finishReason: "STOP",
          },
        ],
      });
    });

    const result = await adapter(fetch).generate({
      instanceId,
      modelId,
      prompt: "one cube",
      variantCount: 1,
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.providerFailure.category).toBe("protocol");
      expect(result.providerFailure.message).toContain("more images");
    }
  });

  it("sends reference images as inline data for an edit", async () => {
    const fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        contents: Array<{ parts: Array<Record<string, unknown>> }>;
      };
      expect(body.contents[0]?.parts).toHaveLength(2);
      expect(body.contents[0]?.parts[1]).toMatchObject({
        inlineData: { mimeType: "image/png" },
      });
      return inlineResponse(pngB64);
    });

    const result = await adapter(fetch).generate({
      instanceId,
      modelId,
      prompt: "make it night",
      references: [{ bytes: png, mediaType: "image/png" }],
    });
    expect(result.status).toBe("completed");
  });

  it("surfaces a safety refusal from prompt feedback", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        promptFeedback: {
          blockReason: "SAFETY",
          blockReasonMessage: "The prompt was blocked by safety filters.",
        },
      }),
    );
    const result = await adapter(fetch).generate({ instanceId, modelId, prompt: "disallowed" });
    expect(result).toEqual({
      status: "refused",
      safetyRefusal: "The prompt was blocked by safety filters.",
    });
  });

  it("rejects a file URI payload instead of journaling a provider URL", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        candidates: [
          {
            content: {
              parts: [{ fileData: { fileUri: "https://generativelanguage.googleapis.com/file" } }],
            },
          },
        ],
      }),
    );
    const result = await adapter(fetch).generate({ instanceId, modelId, prompt: "a cube" });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.providerFailure.category).toBe("protocol");
      expect(JSON.stringify(result)).not.toContain("generativelanguage.googleapis.com/file");
    }
  });

  it("rejects malformed inline bytes", async () => {
    const fetch = vi.fn(async () => inlineResponse(Buffer.from("nope").toString("base64")));
    const result = await adapter(fetch).generate({ instanceId, modelId, prompt: "a cube" });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.providerFailure.category).toBe("protocol");
  });

  it("classifies a rate limit without exposing the credential", async () => {
    const fetch = vi.fn(async () => new Response(`quota ${SECRET}`, { status: 429 }));
    const result = await adapter(fetch).generate({ instanceId, modelId, prompt: "a cube" });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.providerFailure.category).toBe("rate-limited");
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  it("times out a hanging request", async () => {
    const fetch = vi.fn(async () => new Promise<Response>(() => undefined));
    const result = await adapter(fetch, { connectionTimeoutMs: 20 }).generate({
      instanceId,
      modelId,
      prompt: "a cube",
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.providerFailure.category).toBe("unavailable");
  });

  it("cancels a hanging request via AbortSignal", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const pending = adapter(fetch).generate({
      instanceId,
      modelId,
      prompt: "a cube",
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.providerFailure.category).toBe("interrupted");
  });

  it("redacts the key when Gemini echoes it in an error body", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: { message: `API key ${SECRET} rejected` } }, { status: 400 }),
    );
    const result = await adapter(fetch).generate({ instanceId, modelId, prompt: "a cube" });
    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
