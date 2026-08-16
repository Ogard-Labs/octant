import type { OpenAiCompatibleProviderConfiguration, ProviderModel } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ProviderCredentialResolver } from "./credentialBrokerClient";
import {
  type CompatibleFetch,
  classifyCompatibleHttpFailure,
  makeOpenAiCompatibleEndpoint,
  markCompatibleModelVerified,
  probeModels,
  requestGeneration,
} from "./openAiCompatibleEndpoint";

const configuration: OpenAiCompatibleProviderConfiguration = {
  kind: "openai-compatible-http",
  baseUrl: "https://host.example/gateway/v1",
  authentication: "bearer",
  protocol: "auto",
  manualModelIds: ["manual-a" as never],
};

function resolver(credential = "provider-secret"): ProviderCredentialResolver {
  return {
    has: vi.fn(async () => true),
    resolve: vi.fn(async () => credential),
  };
}

function endpoint(
  fetch: CompatibleFetch,
  overrides: Partial<OpenAiCompatibleProviderConfiguration> = {},
  credentialResolver: ProviderCredentialResolver = resolver(),
  requestBodyBytes?: number,
) {
  return makeOpenAiCompatibleEndpoint({
    instanceId: "5ef85ae4-bb67-4137-9ba0-70ee21db0ddb",
    configuration: { ...configuration, ...overrides },
    credentialResolver,
    fetch,
    limits: {
      connectionTimeoutMs: 50,
      responseBodyBytes: 128,
      ...(requestBodyBytes === undefined ? {} : { requestBodyBytes }),
    },
  });
}

describe("OpenAI-compatible endpoint policy", () => {
  it("joins final URLs without replacing a configured path prefix", async () => {
    const fetch = vi.fn(async () => Response.json({ data: [] }));

    await probeModels(endpoint(fetch));

    expect(fetch).toHaveBeenCalledWith(
      "https://host.example/gateway/v1/models",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
  });

  it("resolves Bearer credentials only for the scoped request", async () => {
    const credentialResolver = resolver();
    const fetch = vi.fn(async () => Response.json({ data: [] }));

    await probeModels(endpoint(fetch, {}, credentialResolver));

    expect(credentialResolver.resolve).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { authorization: "Bearer provider-secret" } }),
    );
  });

  it("does not resolve or send credentials in no-auth mode", async () => {
    const credentialResolver = resolver();
    const fetch = vi.fn(async () => Response.json({ data: [] }));

    await probeModels(endpoint(fetch, { authentication: "none" }, credentialResolver));

    expect(credentialResolver.resolve).not.toHaveBeenCalled();
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toEqual({});
  });

  it("fails as unauthenticated when Bearer resolution fails without exposing details", async () => {
    const credentialResolver: ProviderCredentialResolver = {
      has: vi.fn(async () => false),
      resolve: vi.fn(async () => {
        throw new Error("private resolver diagnostic");
      }),
    };

    const failure = await probeModels(endpoint(vi.fn(), {}, credentialResolver)).catch(
      (error: unknown) => error,
    );

    expect(failure).toEqual({
      category: "unauthenticated",
      message: "The provider credential is missing or unavailable.",
    });
    expect(JSON.stringify(failure)).not.toContain("private resolver diagnostic");
  });

  it("times out while credential resolution remains pending", async () => {
    const credentialResolver: ProviderCredentialResolver = {
      has: vi.fn(async () => true),
      resolve: vi.fn(() => new Promise<string>(() => undefined)),
    };
    const fetch = vi.fn(async () => Response.json({ data: [] }));

    await expect(probeModels(endpoint(fetch, {}, credentialResolver))).rejects.toEqual({
      category: "unavailable",
      message: "The provider request timed out.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("caller cancellation settles a hanging credential resolution without a late fetch", async () => {
    const controller = new AbortController();
    let rejectResolution: ((reason: unknown) => void) | undefined;
    const credentialResolver: ProviderCredentialResolver = {
      has: vi.fn(async () => true),
      resolve: vi.fn(
        () =>
          new Promise<string>((_resolve, reject) => {
            rejectResolution = reject;
          }),
      ),
    };
    const fetch = vi.fn(async () => Response.json({ data: [] }));
    const request = probeModels(endpoint(fetch, {}, credentialResolver), controller.signal);

    controller.abort();

    await expect(request).rejects.toEqual({
      category: "interrupted",
      message: "The provider request was cancelled.",
    });
    expect(fetch).not.toHaveBeenCalled();
    rejectResolution?.(new Error("late private credential failure"));
    await Promise.resolve();
  });

  it("rejects redirects and never forwards credentials", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 307 }));

    await expect(probeModels(endpoint(fetch))).rejects.toEqual({
      category: "invalid-configuration",
      message: "The configured endpoint returned a redirect.",
    });
    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init).toMatchObject({ redirect: "manual" });
  });

  it("cancels a redirect response body before rejecting it", async () => {
    let cancelled = false;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 307, headers: { location: "https://redirect.example/v1/models" } },
        ),
    );

    await expect(probeModels(endpoint(fetch))).rejects.toMatchObject({
      category: "invalid-configuration",
    });
    expect(cancelled).toBe(true);
  });

  it("cancels rejected response bodies without reading their payload", async () => {
    let cancelled = false;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 401 },
        ),
    );

    await expect(probeModels(endpoint(fetch))).rejects.toMatchObject({
      category: "unauthenticated",
    });
    expect(cancelled).toBe(true);
  });

  it("discovers strict models without sending a prompt", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ data: [{ id: "model-a" }, { id: "manual-a" }] }),
    );

    const result = await probeModels(endpoint(fetch));

    expect(result.readiness).toBe("ready");
    expect(result.models.map(({ id, source }) => [id, source])).toEqual([
      ["model-a", "discovered"],
      ["manual-a", "discovered"],
    ]);
    expect(JSON.stringify(fetch.mock.calls)).not.toContain("prompt");
  });

  it("deduplicates repeated discovered model IDs", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ data: [{ id: "model-a" }, { id: "model-a" }] }),
    );

    const result = await probeModels(endpoint(fetch, { manualModelIds: [] }));

    expect(result.models.map(({ id }) => id)).toEqual(["model-a"]);
  });

  it.each([
    { object: "list", data: [{ id: "model-a" }] },
    { data: [{ id: "model-a", owned_by: "owner" }] },
    { data: [{ id: "model-a" }], extra: true },
  ])("accepts a standard OpenAI/Foundry models payload with extra metadata", async (body) => {
    const fetch = vi.fn(async () => Response.json(body));

    const result = await probeModels(endpoint(fetch, { manualModelIds: [] }));

    expect(result.models.map(({ id }) => id)).toEqual(["model-a"]);
  });

  it.each([{ data: [{ id: 42 }] }, { data: [{ id: " model-a " }] }, { data: "model-a" }])(
    "rejects a non-strict models payload",
    async (body) => {
      const fetch = vi.fn(async () => Response.json(body));

      await expect(probeModels(endpoint(fetch))).rejects.toEqual({
        category: "protocol",
        message: "The provider returned an invalid models response.",
      });
    },
  );

  it.each([404, 405, 501])(
    "returns degraded manual fallback for unsupported models status %s",
    async (status) => {
      const fetch = vi.fn(async () => new Response(null, { status }));

      const result = await probeModels(endpoint(fetch));

      expect(result).toMatchObject({
        readiness: "degraded",
        failure: { category: "unsupported" },
        models: [{ id: "manual-a", source: "manual", verification: "unverified" }],
      });
    },
  );

  it("reports unsupported discovery without inventing models", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));

    const result = await probeModels(endpoint(fetch, { manualModelIds: [] }));

    expect(result).toMatchObject({
      readiness: "unavailable",
      models: [],
      failure: { category: "unsupported" },
    });
  });

  it("bounds model response bodies", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ id: "x".repeat(200) }] })),
    );

    await expect(probeModels(endpoint(fetch))).rejects.toEqual({
      category: "protocol",
      message: "The provider response exceeded the configured size limit.",
    });
  });

  it("times out a request before response headers arrive", async () => {
    const fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );

    await expect(probeModels(endpoint(fetch))).rejects.toEqual({
      category: "unavailable",
      message: "The provider request timed out.",
    });
  });

  it("cancels a response body that arrives after the request deadline", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    let bodyCancelled = false;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const request = probeModels(endpoint(fetch, { authentication: "none" }));

    await expect(request).rejects.toEqual({
      category: "unavailable",
      message: "The provider request timed out.",
    });

    resolveFetch?.(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            bodyCancelled = true;
          },
        }),
      ),
    );
    await vi.waitFor(() => expect(bodyCancelled).toBe(true));
  });

  it("keeps caller cancellation distinct from timeout", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const request = requestGeneration(endpoint(fetch), {
      path: "responses",
      body: { privatePrompt: "do not expose" },
      signal: controller.signal,
    });
    controller.abort();

    const failure = await request.catch((error: unknown) => error);
    expect(failure).toEqual({
      category: "interrupted",
      message: "The provider request was cancelled.",
    });
    expect(JSON.stringify(failure)).not.toContain("do not expose");
  });

  it("uses manual redirects and rejects oversized generation responses", async () => {
    const fetch = vi.fn(async () => new Response("x", { headers: { "content-length": "129" } }));

    await expect(
      requestGeneration(endpoint(fetch), { path: "responses", body: { model: "manual-a" } }),
    ).rejects.toEqual({
      category: "protocol",
      message: "The provider response exceeded the configured size limit.",
    });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
  });

  it("observes only sanitized rejection status and failure metadata", async () => {
    const observed = vi.fn();
    const fetch = vi.fn(async () =>
      Response.json({ private: "provider payload" }, { status: 404 }),
    );

    const failure = await requestGeneration(endpoint(fetch), {
      path: "responses",
      body: { model: "manual-a" },
      onRejected: observed,
    }).catch((error: unknown) => error);

    expect(failure).toEqual({
      category: "unsupported",
      message: "The provider does not support this endpoint.",
    });
    expect(observed).toHaveBeenCalledWith({
      httpStatus: 404,
      failure,
    });
    expect(JSON.stringify(observed.mock.calls)).not.toContain("provider payload");
  });

  it("allows a generation request at the exact UTF-8 byte limit", async () => {
    const fetch = vi.fn(async () => new Response(null));

    await requestGeneration(endpoint(fetch, {}, resolver(), 4), {
      path: "responses",
      body: "é",
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBe('"é"');
  });

  it("rejects a generation request over the UTF-8 byte limit before network access", async () => {
    const fetch = vi.fn(async () => new Response(null));

    const failure = await requestGeneration(endpoint(fetch, {}, resolver(), 3), {
      path: "responses",
      body: "é",
    }).catch((error: unknown) => error);

    expect(failure).toEqual({
      category: "invalid-configuration",
      message: "The provider request exceeded the configured size limit.",
    });
    expect(JSON.stringify(failure)).not.toContain("é");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels a pending response body read", async () => {
    const controller = new AbortController();
    let bodyCancelled = false;
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              bodyCancelled = true;
            },
          }),
        ),
    );
    const response = await requestGeneration(endpoint(fetch), {
      path: "responses",
      body: { model: "manual-a" },
      signal: controller.signal,
    });
    const body = response.text();
    controller.abort();

    const failure = await Promise.race([
      body.catch((error: unknown) => error),
      new Promise<Error>((resolve) =>
        setTimeout(() => resolve(new Error("response body cancellation timed out")), 100),
      ),
    ]);
    expect(failure).toEqual({
      category: "interrupted",
      message: "The provider request was cancelled.",
    });
    expect(bodyCancelled).toBe(true);
  });
});

describe("compatible HTTP failures", () => {
  it.each([
    [401, "unauthenticated"],
    [403, "unauthorized"],
    [404, "unsupported"],
    [405, "unsupported"],
    [501, "unsupported"],
    [500, "provider-failed"],
  ] as const)("classifies status %s as %s", (status, category) => {
    expect(classifyCompatibleHttpFailure(new Response(null, { status }))).toMatchObject({
      category,
    });
  });

  it("normalizes and caps Retry-After without exposing headers", () => {
    expect(
      classifyCompatibleHttpFailure(
        new Response(null, { status: 429, headers: { "retry-after": "99999" } }),
      ),
    ).toEqual({
      category: "rate-limited",
      message: "The provider rate limit was reached.",
      retryAfterMs: 3_600_000,
    });
    expect(
      classifyCompatibleHttpFailure(
        new Response(null, { status: 429, headers: { "retry-after": "not-valid" } }),
      ),
    ).not.toHaveProperty("retryAfterMs");
  });

  it("normalizes a bounded HTTP-date Retry-After", () => {
    expect(
      classifyCompatibleHttpFailure(
        new Response(null, {
          status: 429,
          headers: { "retry-after": "Wed, 15 Jul 2026 12:00:30 GMT" },
        }),
        Date.parse("2026-07-15T12:00:00Z"),
      ),
    ).toMatchObject({ retryAfterMs: 30_000 });
  });
});

it("verifies only the matching manual runtime model without mutating input", () => {
  const models: readonly ProviderModel[] = [
    {
      id: "manual-a" as never,
      displayName: "manual-a",
      source: "manual",
      verification: "unverified",
      reasoning: "unavailable",
      inputModalities: ["text"],
      options: [],
    },
    {
      id: "manual-b" as never,
      displayName: "manual-b",
      source: "manual",
      verification: "unverified",
      reasoning: "unavailable",
      inputModalities: ["text"],
      options: [],
    },
  ];

  const updated = markCompatibleModelVerified(models, "manual-a");

  expect(updated.map(({ verification }) => verification)).toEqual(["verified", "unverified"]);
  expect(models.map(({ verification }) => verification)).toEqual(["unverified", "unverified"]);
});
