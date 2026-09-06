import { decodeProviderInstanceId, type ProviderModelId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ProviderCredentialResolver } from "../providers/credentialBrokerClient";
import { makeIdeogramImageAdapter } from "./ideogramImageAdapter";
import { IDEOGRAM_IMAGE_API_BASE_URL, type ImageHttpFetch } from "./imageHttp";

const SECRET = "ideogram-fixture-super-secret";
const instanceId = decodeProviderInstanceId("a2000000-0000-4000-8000-000000000022");
const modelId = "ideogram-v3" as ProviderModelId;
const GENERATE_URL = `${IDEOGRAM_IMAGE_API_BASE_URL}/v1/${modelId}/generate`;
const IMAGE_URL_1 = "https://signed.example/generated-1.png?token=secret";
const IMAGE_URL_2 = "https://signed.example/generated-2.png?token=secret";
const IMAGE_URL_3 = "https://signed.example/generated-3.png?token=secret";
const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

function resolver(credential = SECRET): ProviderCredentialResolver {
  return {
    has: vi.fn(async () => true),
    resolve: vi.fn(async () => credential),
  };
}

function adapter(fetch: ImageHttpFetch) {
  return makeIdeogramImageAdapter({
    instanceId,
    credentialResolver: resolver(),
    fetch,
  });
}

function request(overrides: {
  prompt?: string;
  signal?: AbortSignal;
  variantCount?: number;
  references?: ReadonlyArray<{ bytes: Uint8Array; mediaType: "image/png" }>;
}) {
  return {
    instanceId,
    modelId,
    prompt: overrides.prompt ?? "a red cube",
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    ...(overrides.variantCount === undefined ? {} : { variantCount: overrides.variantCount }),
    ...(overrides.references === undefined ? {} : { references: overrides.references }),
  };
}

function generateResponse(
  items: ReadonlyArray<{ url: string | null; isImageSafe: boolean }>,
  status = 200,
) {
  return Response.json(
    {
      created: "2026-09-06T10:00:00.000Z",
      data: items.map((item) => ({
        url: item.url,
        prompt: "a red cube",
        resolution: "1024x1024",
        is_image_safe: item.isImageSafe,
        seed: 1,
        style_type: "AUTO",
      })),
    },
    { status },
  );
}

function formBody(init: RequestInit | undefined): FormData {
  if (!(init?.body instanceof FormData)) throw new Error("expected a multipart form body");
  return init.body;
}

describe("Ideogram image adapter", () => {
  it("submits a multipart request with a raw Api-Key header and completes with multiple images", async () => {
    let callCount = 0;
    const fetch = vi.fn(async (url, init) => {
      callCount += 1;
      if (callCount === 1) {
        const headers = new Headers(init?.headers);
        expect(headers.get("Api-Key")).toBe(SECRET);
        expect(headers.get("authorization")).toBeNull();
        expect(String(url)).toBe(GENERATE_URL);
        expect(init?.method).toBe("POST");
        const form = formBody(init);
        expect(form.get("prompt")).toBe("a red cube");
        expect(form.get("num_images")).toBe("2");
        return generateResponse([
          { url: IMAGE_URL_1, isImageSafe: true },
          { url: IMAGE_URL_2, isImageSafe: true },
        ]);
      }
      // The approved-URL fetches carry no provider credential: each signed
      // URL is already self-authenticating and must never see the API key.
      const headers = new Headers(init?.headers);
      expect(headers.has("Api-Key")).toBe(false);
      return new Response(png, { status: 200 });
    });

    const result = await adapter(fetch).generate(request({ variantCount: 2 }));

    expect(callCount).toBe(3);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.images).toHaveLength(2);
      for (const image of result.images) {
        expect(image.mediaType).toBe("image/png");
        expect(Buffer.from(image.bytes).equals(Buffer.from(png))).toBe(true);
      }
    }
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("token=secret");
  });

  it("returns every image when all items pass the per-image safety check", async () => {
    let callCount = 0;
    const fetch = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        return generateResponse([
          { url: IMAGE_URL_1, isImageSafe: true },
          { url: IMAGE_URL_2, isImageSafe: true },
          { url: IMAGE_URL_3, isImageSafe: true },
        ]);
      }
      return new Response(png, { status: 200 });
    });

    const result = await adapter(fetch).generate(request({ variantCount: 3 }));

    expect(callCount).toBe(4);
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.images).toHaveLength(3);
  });

  it("maps a 422 response to a terminal safety refusal built from the error field", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: "Prompt rejected by safety system" }, { status: 422 }),
    );
    const result = await adapter(fetch).generate(request({}));
    expect(result).toEqual({
      status: "refused",
      safetyRefusal: "Prompt rejected by safety system",
    });
  });

  it("falls back to a generic refusal message when the 422 body has no error field", async () => {
    const fetch = vi.fn(async () => Response.json({}, { status: 422 }));
    const result = await adapter(fetch).generate(request({}));
    expect(result).toEqual({
      status: "refused",
      safetyRefusal: "The provider refused this request.",
    });
  });

  it("refuses the whole result when any item is unsafe, even alongside safe images", async () => {
    const fetch = vi.fn(async () =>
      generateResponse([
        { url: IMAGE_URL_1, isImageSafe: true },
        { url: null, isImageSafe: false },
      ]),
    );
    const result = await adapter(fetch).generate(request({ variantCount: 2 }));
    expect(result).toEqual({
      status: "refused",
      safetyRefusal: "The provider refused this request (unsafe content detected).",
    });
    // No image bytes are fetched once any item fails the safety check: this
    // must never return a partial success with fewer images than requested.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, "invalid-configuration"],
    [401, "unauthenticated"],
    [429, "rate-limited"],
    [500, "provider-failed"],
  ] as const)("maps a generate HTTP %d to category %s", async (status, category) => {
    const fetch = vi.fn(async () => new Response("failure", { status }));
    const result = await adapter(fetch).generate(request({}));
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.providerFailure.category).toBe(category);
  });

  it("gives a credential-specific message for a 401, distinct from other errors", async () => {
    const fetch = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const result = await adapter(fetch).generate(request({}));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.providerFailure.message).toBe(
        "The provider rejected the configured credential.",
      );
    }
  });

  it("classifies a rate limit without parsing retry-after, unlike the other adapters", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(`rate limited ${SECRET}`, { status: 429, headers: { "retry-after": "2" } }),
    );
    const result = await adapter(fetch).generate(request({}));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.providerFailure.category).toBe("rate-limited");
      expect(result.providerFailure.retryAfterMs).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  it("rejects a request that supplies reference images", async () => {
    const fetch = vi.fn(async () => generateResponse([{ url: IMAGE_URL_1, isImageSafe: true }]));
    const result = await adapter(fetch).generate(
      request({ references: [{ bytes: png, mediaType: "image/png" }] }),
    );
    expect(result).toEqual({
      status: "failed",
      providerFailure: {
        category: "invalid-configuration",
        message: "This provider does not support reference images.",
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an invalid model id before it reaches the URL path", async () => {
    const fetch = vi.fn(async () => generateResponse([{ url: IMAGE_URL_1, isImageSafe: true }]));
    const result = await adapter(fetch).generate({
      instanceId,
      modelId: "../etc/passwd" as ProviderModelId,
      prompt: "a red cube",
    });
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.providerFailure.category).toBe("invalid-configuration");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels mid-request when the signal aborts before the response resolves", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    const pending = adapter(fetch).generate(request({ signal: controller.signal }));
    controller.abort();
    const result = await pending;
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.providerFailure.category).toBe("interrupted");
  });

  it("returns the interrupted failure immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn(async () => generateResponse([{ url: IMAGE_URL_1, isImageSafe: true }]));

    const result = await adapter(fetch).generate(request({ signal: controller.signal }));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.providerFailure.category).toBe("interrupted");
  });
});
