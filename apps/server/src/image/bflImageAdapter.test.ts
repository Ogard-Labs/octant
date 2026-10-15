import {
  decodeProviderInstance,
  decodeProviderInstanceId,
  type ProviderModelId,
} from "@octant/contracts";
import { runImageGenerationConformance } from "@octant/provider-sdk/image-generation-conformance";
import { describe, expect, it, vi } from "vitest";
import type { ProviderCredentialResolver } from "../providers/credentialBrokerClient";
import { bflImageDriver, makeBflImageAdapter } from "./bflImageAdapter";
import { makeImageGenerationPorts, type ImageHttpFetch } from "./imageHttp";

const SECRET = "bfl-fixture-super-secret";
const instanceId = decodeProviderInstanceId("a2000000-0000-4000-8000-000000000021");
const modelId = "flux-pro-1.1" as ProviderModelId;
const SUBMIT_URL = `https://api.bfl.ai/v1/${modelId}`;
const POLL_URL = "https://api.bfl.ai/v1/poll/job-1";
const SAMPLE_URL = "https://signed.example/generated.png?token=secret";
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

function adapter(
  fetch: ImageHttpFetch,
  overrides: {
    limits?: { connectionTimeoutMs?: number };
    pollIntervalMs?: number;
    maxPollAttempts?: number;
    baseUrl?: string;
  } = {},
) {
  return makeBflImageAdapter({
    ports: makeImageGenerationPorts({
      instanceId: String(instanceId),
      credentialResolver: resolver(),
      endpoint: {
        providerHosts: bflImageDriver.providerHosts,
        ...(overrides.baseUrl === undefined ? {} : { baseUrl: overrides.baseUrl }),
      },
      fetch,
      ...(overrides.limits === undefined ? {} : { limits: overrides.limits }),
    }),
    pollIntervalMs: overrides.pollIntervalMs ?? 1,
    ...(overrides.baseUrl === undefined ? {} : { baseUrl: overrides.baseUrl }),
    ...(overrides.maxPollAttempts === undefined
      ? {}
      : { maxPollAttempts: overrides.maxPollAttempts }),
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

function submitResponse(pollingUrl = POLL_URL) {
  return Response.json({
    id: "job-1",
    polling_url: pollingUrl,
    cost: null,
    input_mp: null,
    output_mp: null,
  });
}

function pollResponse(status: string, extra: Record<string, unknown> = {}) {
  return Response.json({ id: "job-1", status, ...extra });
}

describe("BFL image adapter", () => {
  it("submits to the model-named path with a raw x-key header and completes after a pending poll", async () => {
    let callCount = 0;
    const fetch = vi.fn(async (url, init) => {
      callCount += 1;
      if (callCount === 1) {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-key")).toBe(SECRET);
        expect(headers.get("authorization")).toBeNull();
        expect(String(url)).toBe(SUBMIT_URL);
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ prompt: "a red cube" });
        return submitResponse();
      }
      if (callCount === 2) {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-key")).toBe(SECRET);
        expect(String(url)).toBe(POLL_URL);
        expect(init?.method).toBe("GET");
        return pollResponse("Pending");
      }
      if (callCount === 3) {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-key")).toBe(SECRET);
        return pollResponse("Ready", { result: { sample: SAMPLE_URL } });
      }
      // The approved-URL fetch carries no provider credential: the signed
      // URL is already self-authenticating, and this call must never send
      // the BFL API key to whatever host issued the signed URL.
      const headers = new Headers(init?.headers);
      expect(headers.has("x-key")).toBe(false);
      expect(String(url)).toBe(SAMPLE_URL);
      return new Response(png, { status: 200 });
    });

    const result = await adapter(fetch).generate(request({}));

    expect(callCount).toBe(4);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.images).toHaveLength(1);
      expect(result.images[0]?.mediaType).toBe("image/png");
      expect(Buffer.from(result.images[0]!.bytes).equals(Buffer.from(png))).toBe(true);
    }
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("token=secret");
  });

  it.each(["Request Moderated", "Content Moderated"])(
    "maps a %s poll status to a terminal safety refusal built from the moderation reasons",
    async (status) => {
      const fetch = vi.fn(async (_url, init) => {
        if (init?.method === "POST") return submitResponse();
        return pollResponse(status, { details: { "Moderation Reasons": ["Violence", "Gore"] } });
      });

      const result = await adapter(fetch).generate(request({}));
      expect(result).toEqual({ status: "refused", safetyRefusal: "Violence, Gore" });
    },
  );

  it("falls back to a generic refusal message when no moderation reasons are given", async () => {
    const fetch = vi.fn(async (_url, init) => {
      if (init?.method === "POST") return submitResponse();
      return pollResponse("Request Moderated");
    });

    const result = await adapter(fetch).generate(request({}));
    expect(result).toEqual({
      status: "refused",
      safetyRefusal: "The provider refused this request (Request Moderated).",
    });
  });

  it.each(["Error", "Task not found"])(
    "maps a %s poll status to a provider failure, not a refusal",
    async (status) => {
      const fetch = vi.fn(async (_url, init) => {
        if (init?.method === "POST") return submitResponse();
        return pollResponse(status);
      });

      const result = await adapter(fetch).generate(request({}));
      expect(result.status).toBe("failed");
      if (result.status === "failed")
        expect(result.providerFailure.category).toBe("provider-failed");
    },
  );

  it.each([
    [400, "invalid-configuration"],
    [402, "unauthorized"],
    [403, "unauthorized"],
    [422, "invalid-configuration"],
    [500, "provider-failed"],
    [503, "unavailable"],
  ] as const)("maps a submit HTTP %d to category %s", async (status, category) => {
    const fetch = vi.fn(async () => new Response("failure", { status }));
    const result = await adapter(fetch).generate(request({}));
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.providerFailure.category).toBe(category);
  });

  it("gives a denial-specific message for a submit 403, distinct from a 402", async () => {
    const fetch = vi.fn(async () => new Response("forbidden", { status: 403 }));
    const result = await adapter(fetch).generate(request({}));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.providerFailure.category).toBe("unauthorized");
      expect(result.providerFailure.message).toBe("The provider denied this request.");
    }
  });

  it("classifies a submit rate limit and parses retry-after without exposing the credential", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(`rate limited ${SECRET}`, { status: 429, headers: { "retry-after": "2" } }),
    );
    const result = await adapter(fetch).generate(request({}));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.providerFailure.category).toBe("rate-limited");
      expect(result.providerFailure.retryAfterMs).toBe(2_000);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  it("classifies HTTP errors returned from the poll step the same way as submit", async () => {
    const fetch = vi.fn(async (_url, init) => {
      if (init?.method === "POST") return submitResponse();
      return new Response("insufficient credits", { status: 402 });
    });
    const result = await adapter(fetch).generate(request({}));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.providerFailure.category).toBe("unauthorized");
      expect(result.providerFailure.message).toContain("insufficient credits");
    }
  });

  it("rejects a variantCount greater than one instead of fanning out requests", async () => {
    const fetch = vi.fn(async () => submitResponse());
    const result = await adapter(fetch).generate(request({ variantCount: 2 }));
    expect(result).toEqual({
      status: "failed",
      providerFailure: {
        category: "invalid-configuration",
        message: "This provider generates one image per request.",
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a request that supplies reference images", async () => {
    const fetch = vi.fn(async () => submitResponse());
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

  it("times out when Ready never arrives within the attempt cap", async () => {
    const fetch = vi.fn(async (_url, init) => {
      if (init?.method === "POST") return submitResponse();
      return pollResponse("Pending");
    });
    const result = await adapter(fetch, { maxPollAttempts: 3 }).generate(request({}));
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.providerFailure.category).toBe("unavailable");
      expect(result.providerFailure.message).toContain("timed out");
    }
    // One submit plus exactly maxPollAttempts polls, never more.
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("stops polling as soon as the signal aborts mid-sleep, not only on the next HTTP call", async () => {
    const controller = new AbortController();
    let pollCount = 0;
    const fetch = vi.fn(async (_url, init) => {
      if (init?.method === "POST") return submitResponse();
      pollCount += 1;
      return pollResponse("Pending");
    });
    // Fires while the adapter is asleep between the first and second poll
    // (a 100ms interval), not while any request is in flight.
    setTimeout(() => controller.abort(), 10);

    const result = await adapter(fetch, { pollIntervalMs: 100, maxPollAttempts: 50 }).generate(
      request({ signal: controller.signal }),
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.providerFailure.category).toBe("interrupted");
    // Exactly one poll happened before the sleep began; the abort during
    // that sleep must pre-empt every later poll, not merely fail whichever
    // HTTP call would have come next.
    expect(pollCount).toBe(1);
  });

  it("rejects an invalid model id before it reaches the URL path", async () => {
    const fetch = vi.fn(async () => submitResponse());
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
});

describe("BFL image driver behind the image seam", () => {
  it("keeps the image seam's conformance promises", async () => {
    await expect(
      runImageGenerationConformance({
        driver: bflImageDriver,
        instance: bflProfile(),
        request: request({}),
        respond: (call) =>
          call.method === "POST"
            ? submitResponse()
            : pollResponse("Ready", { result: { sample: SAMPLE_URL } }),
        expectedImageCount: 1,
      }),
    ).resolves.toMatchObject({ completedWithHostMediaTypes: true });
  });

  it("calls a configured base URL but fetches the signed result exactly where the provider put it", async () => {
    const calls: Array<{ readonly url: string; readonly key: string | null }> = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), key: new Headers(init?.headers).get("x-key") });
      if (init?.method === "POST") {
        return submitResponse("https://proxy.example.test/bfl/v1/poll/job-1");
      }
      if (String(url).startsWith("https://proxy.example.test/")) {
        return pollResponse("Ready", { result: { sample: SAMPLE_URL } });
      }
      return new Response(png, { status: 200 });
    });
    const generator = bflImageDriver.create({
      instance: bflProfile("https://proxy.example.test/bfl/"),
      ports: makeImageGenerationPorts({
        instanceId: String(instanceId),
        credentialResolver: resolver(),
        endpoint: {
          providerHosts: bflImageDriver.providerHosts,
          baseUrl: "https://proxy.example.test/bfl/",
        },
        fetch,
      }),
    });

    const result = await generator.generate(request({}));

    expect(result.status).toBe("completed");
    expect(calls).toEqual([
      { url: `https://proxy.example.test/bfl/v1/${modelId}`, key: SECRET },
      { url: "https://proxy.example.test/bfl/v1/poll/job-1", key: SECRET },
      { url: SAMPLE_URL, key: null },
    ]);
  });
});

function bflProfile(baseUrl?: string) {
  return decodeProviderInstance({
    id: instanceId,
    displayName: "FLUX",
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: "2026-10-15T00:00:00.000Z",
    updatedAt: "2026-10-15T00:00:00.000Z",
    driverKind: "bfl-image",
    configuration: {
      kind: "bfl-image-http",
      modelAllowlist: [modelId],
      defaultModel: modelId,
      ...(baseUrl === undefined ? {} : { baseUrl }),
    },
  });
}
