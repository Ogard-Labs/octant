import { decodeProviderInstanceId, type ProviderModelId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ProviderCredentialResolver } from "../providers/credentialBrokerClient";
import type { ImageHttpFetch } from "./imageHttp";
import { OPENAI_IMAGE_API_BASE_URL } from "./imageHttp";
import { makeOpenAiImageAdapter } from "./openAiImageAdapter";

const SECRET = "sk-fixture-super-secret";
const instanceId = decodeProviderInstanceId("a2000000-0000-4000-8000-000000000001");
const modelId = "gpt-image-2" as ProviderModelId;
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
  return makeOpenAiImageAdapter({
    instanceId,
    credentialResolver: resolver(),
    fetch,
    ...(limits === undefined ? {} : { limits }),
  });
}

function request(
  overrides: { prompt?: string; signal?: AbortSignal; references?: typeof png } = {},
) {
  return {
    instanceId,
    modelId,
    prompt: overrides.prompt ?? "a red cube",
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    ...(overrides.references === undefined
      ? {}
      : { references: [{ bytes: overrides.references, mediaType: "image/png" as const }] }),
  };
}

describe("OpenAI image adapter", () => {
  it("posts generations to the fixed Image API URL with a per-request key", async () => {
    const fetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe(`${OPENAI_IMAGE_API_BASE_URL}/images/generations`);
      expect(init?.redirect).toBe("manual");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${SECRET}`);
      return Response.json({ data: [{ b64_json: pngB64 }] });
    });

    const result = await adapter(fetch).generate(request());

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.images).toHaveLength(1);
      expect(result.images[0]?.mediaType).toBe("image/png");
    }
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("posts edits as multipart to the fixed edits URL", async () => {
    const fetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe(`${OPENAI_IMAGE_API_BASE_URL}/images/edits`);
      expect(init?.body).toBeInstanceOf(FormData);
      return Response.json({ data: [{ b64_json: pngB64 }] });
    });

    const result = await adapter(fetch).generate(request({ references: png }));
    expect(result.status).toBe("completed");
  });

  it("surfaces a safety refusal as terminal and does not treat it as a retryable failure", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "moderation_blocked",
            message: "Your request was rejected by the safety system.",
          },
        },
        { status: 400 },
      ),
    );

    const result = await adapter(fetch).generate(request());
    expect(result).toEqual({
      status: "refused",
      safetyRefusal: "Your request was rejected by the safety system.",
    });
  });

  it("rejects a URL-form payload instead of journaling the provider URL", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        data: [{ url: "https://cdn.openai.com/generated.png?token=secret" }],
      }),
    );

    const result = await adapter(fetch).generate(request());
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.providerFailure.category).toBe("protocol");
      expect(JSON.stringify(result)).not.toContain("cdn.openai.com");
    }
  });

  it("rejects malformed image bytes", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ data: [{ b64_json: Buffer.from("not-an-image").toString("base64") }] }),
    );
    const result = await adapter(fetch).generate(request());
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.providerFailure.category).toBe("protocol");
  });

  it("rejects an oversized declared response before buffering the body", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(pngB64, {
          status: 200,
          headers: { "content-length": String(40_000_000), "content-type": "application/json" },
        }),
    );
    const result = await adapter(fetch).generate(request());
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.providerFailure.category).toBe("protocol");
  });

  it("classifies a rate limit without exposing the credential", async () => {
    const fetch = vi.fn(async () => new Response(`rate limited ${SECRET}`, { status: 429 }));
    const result = await adapter(fetch).generate(request());
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.providerFailure.category).toBe("rate-limited");
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  it("times out a hanging request", async () => {
    const fetch = vi.fn(async () => new Promise<Response>(() => undefined));
    const result = await adapter(fetch, { connectionTimeoutMs: 20 }).generate(request());
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.providerFailure.category).toBe("unavailable");
      expect(result.providerFailure.message).toContain("timed out");
    }
  });

  it("cancels a hanging request via AbortSignal", async () => {
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

  it("redacts the key when the provider echoes it in an error body", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: { message: `invalid key ${SECRET}` } }, { status: 401 }),
    );
    const result = await adapter(fetch).generate(request());
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.providerFailure.category).toBe("unauthenticated");
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });
});
