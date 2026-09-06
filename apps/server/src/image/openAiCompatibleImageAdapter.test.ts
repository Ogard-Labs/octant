import {
  decodeProviderInstance,
  type OpenAiCompatibleProviderInstance,
  type ProviderModelId,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ProviderCredentialResolver } from "../providers/credentialBrokerClient";
import type { CompatibleFetch } from "../providers/openAiCompatibleEndpoint";
import { makeOpenAiCompatibleImageAdapter } from "./openAiCompatibleImageAdapter";

const SECRET = "sk-fixture-super-secret";
const now = "2026-09-05T10:00:00.000Z";
const modelId = "recraftv3" as ProviderModelId;
const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const pngB64 = Buffer.from(png).toString("base64");

function instance(
  overrides: Partial<OpenAiCompatibleProviderInstance["configuration"]> = {},
): OpenAiCompatibleProviderInstance {
  const decoded = decodeProviderInstance({
    id: "00000000-0000-4000-8000-00000000e001",
    displayName: "Recraft",
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl: "https://api.recraft.ai/v1",
      authentication: "bearer",
      protocol: "auto",
      manualModelIds: [],
      ...overrides,
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  if (decoded.driverKind !== "openai-compatible") throw new Error("expected compatible");
  return decoded;
}

function resolver(credential = SECRET): ProviderCredentialResolver {
  return {
    has: vi.fn(async () => true),
    resolve: vi.fn(async () => credential),
  };
}

function adapter(
  fetch: CompatibleFetch,
  overrides: {
    readonly credentialResolver?: ProviderCredentialResolver;
    readonly compatible?: OpenAiCompatibleProviderInstance;
  } = {},
) {
  return makeOpenAiCompatibleImageAdapter({
    instance: overrides.compatible ?? instance(),
    credentialResolver: overrides.credentialResolver ?? resolver(),
    fetch,
  });
}

function request(
  overrides: { prompt?: string; signal?: AbortSignal; references?: typeof png } = {},
) {
  return {
    instanceId: instance().id,
    modelId,
    prompt: overrides.prompt ?? "a red cube",
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
    ...(overrides.references === undefined
      ? {}
      : { references: [{ bytes: overrides.references, mediaType: "image/png" as const }] }),
  };
}

describe("OpenAI-compatible image adapter", () => {
  it("posts generations to the instance's own base URL with its credential", async () => {
    const fetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://api.recraft.ai/v1/images/generations");
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

  it("posts edits as multipart to the instance's own edits path with a reference image", async () => {
    const fetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://api.recraft.ai/v1/images/edits");
      expect(init?.body).toBeInstanceOf(FormData);
      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toBeNull();
      return Response.json({ data: [{ b64_json: pngB64 }] });
    });

    const result = await adapter(fetch).generate(request({ references: png }));
    expect(result.status).toBe("completed");
    const call = fetch.mock.calls[0];
    if (call === undefined) throw new Error("fetch was not called");
    const form = (call[1] as RequestInit).body as FormData;
    expect(form.get("model")).toBe(modelId);
    expect(form.get("prompt")).toBe("a red cube");
    expect(form.get("image[]")).toBeInstanceOf(Blob);
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
        data: [{ url: "https://cdn.recraft.ai/generated.png?token=secret" }],
      }),
    );

    const result = await adapter(fetch).generate(request());
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.providerFailure.category).toBe("protocol");
      expect(JSON.stringify(result)).not.toContain("cdn.recraft.ai");
    }
  });

  it("classifies an HTTP error without exposing the credential", async () => {
    const fetch = vi.fn(async () => new Response(`unauthorized ${SECRET}`, { status: 401 }));
    const result = await adapter(fetch).generate(request());
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.providerFailure.category).toBe("unauthenticated");
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  it("rejects an empty prompt before any request", async () => {
    const fetch = vi.fn(async () => Response.json({ data: [{ b64_json: pngB64 }] }));
    const result = await adapter(fetch).generate(request({ prompt: "   " }));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.providerFailure.category).toBe("invalid-configuration");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an oversized prompt before any request", async () => {
    const fetch = vi.fn(async () => Response.json({ data: [{ b64_json: pngB64 }] }));
    const result = await adapter(fetch).generate(request({ prompt: "a".repeat(32_001) }));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.providerFailure.category).toBe("invalid-configuration");
    }
    expect(fetch).not.toHaveBeenCalled();
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

  it("speaks to an unauthenticated loopback instance without ever calling the resolver", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ data: [{ b64_json: pngB64 }] }),
    );
    const credentialResolver = resolver();
    const loopback = instance({ baseUrl: "http://127.0.0.1:8000/v1", authentication: "none" });

    const result = await adapter(fetch, { credentialResolver, compatible: loopback }).generate(
      request(),
    );

    expect(result.status).toBe("completed");
    expect(credentialResolver.resolve).not.toHaveBeenCalled();
    const { url, init } = { url: String(fetch.mock.calls[0]?.[0]), init: fetch.mock.calls[0]?.[1] };
    expect(url).toBe("http://127.0.0.1:8000/v1/images/generations");
    expect((init?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
  });
});
