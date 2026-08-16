import type { OpenAiCompatibleProviderConfiguration, ProviderFailure } from "@octant/contracts";
import { Effect, Either } from "effect";
import { describe, expect, it, vi } from "vitest";
import { type CompatibleFetch, makeOpenAiCompatibleEndpoint } from "./openAiCompatibleEndpoint";
import {
  makeRuntimeProtocolCache,
  selectCompatibleProtocol,
  type CompatibleProtocolAttempt,
} from "./openAiProtocolSelection";
import {
  type ProtocolTurnFailureMetadata,
  type ResponsesTurnInput,
  sendResponsesTurn,
} from "./openAiResponses";

const instanceId = "019f64cf-7241-7000-8000-000000000001";
const responsesConfiguration: OpenAiCompatibleProviderConfiguration = {
  kind: "openai-compatible-http",
  baseUrl: "https://provider.example/v1",
  authentication: "none",
  protocol: "auto",
  manualModelIds: ["manual-model" as never],
};

function responsesInput(fetch: CompatibleFetch): ResponsesTurnInput {
  return {
    endpoint: makeOpenAiCompatibleEndpoint({
      instanceId,
      configuration: responsesConfiguration,
      fetch,
      limits: { responseBodyBytes: 16_384 },
    }),
    modelId: "manual-model",
    history: [],
    prompt: "next",
  };
}

function realResponsesAttempt(
  fetch: CompatibleFetch,
): CompatibleProtocolAttempt<{ protocol: string; terminal: "completed" | "tool-calls" }> {
  return async (protocol) => {
    if (protocol === "chat-completions") return succeeded(protocol);
    let metadata: ProtocolTurnFailureMetadata | undefined;
    const effect = sendResponsesTurn({
      ...responsesInput(fetch),
      onAttemptFailure: (value) => {
        metadata = value;
      },
    });
    const either = await Effect.runPromise(Effect.either(effect));
    if (Either.isRight(either)) return { ok: true, value: either.right };
    return {
      ok: false,
      failure: either.left,
      accepted: metadata?.accepted ?? false,
      outputStarted: metadata?.outputStarted ?? false,
      ...(metadata?.httpStatus === undefined ? {} : { httpStatus: metadata.httpStatus }),
    };
  };
}

function succeeded(protocol: "responses" | "chat-completions") {
  return { ok: true as const, value: { protocol, terminal: "completed" as const } };
}

function failed(
  status: number | undefined,
  overrides: Partial<
    Extract<Awaited<ReturnType<CompatibleProtocolAttempt<unknown>>>, { ok: false }>
  > = {},
) {
  return {
    ok: false as const,
    failure: {
      category: "unsupported",
      message: "The provider route is unavailable.",
    } as ProviderFailure,
    accepted: false,
    outputStarted: false,
    ...(status === undefined ? {} : { httpStatus: status }),
    ...overrides,
  };
}

describe("selectCompatibleProtocol", () => {
  it.each([404, 405, 501])(
    "uses real Responses rejection metadata to fallback status %s",
    async (status) => {
      const attempt = vi.fn(
        realResponsesAttempt(vi.fn(async () => new Response(null, { status }))),
      );

      await expect(
        selectCompatibleProtocol({
          instanceId,
          preference: "auto",
          cache: makeRuntimeProtocolCache(),
          attempt,
        }),
      ).resolves.toMatchObject({ protocol: "chat-completions" });
      expect(attempt).toHaveBeenCalledTimes(2);
    },
  );

  it.each([400, 422])(
    "does not fallback for a real store:false rejection status %s",
    async (status) => {
      const fetch = vi.fn(async () =>
        Response.json(
          {
            error: {
              message: "private store rejection",
              type: "invalid_request_error",
              param: "store",
              code: "unsupported_parameter",
            },
          },
          { status },
        ),
      );
      const attempt = vi.fn(realResponsesAttempt(fetch));

      await expect(
        selectCompatibleProtocol({
          instanceId,
          preference: "auto",
          cache: makeRuntimeProtocolCache(),
          attempt,
        }),
      ).rejects.toMatchObject({ category: "unsupported" });
      expect(attempt).toHaveBeenCalledOnce();
    },
  );

  it.each([401, 403, 408, 429, 500])(
    "does not fallback for a real non-route rejection status %s",
    async (status) => {
      const attempt = vi.fn(
        realResponsesAttempt(vi.fn(async () => new Response(null, { status }))),
      );

      await expect(
        selectCompatibleProtocol({
          instanceId,
          preference: "auto",
          cache: makeRuntimeProtocolCache(),
          attempt,
        }),
      ).rejects.toBeDefined();
      expect(attempt).toHaveBeenCalledOnce();
    },
  );

  it.each([404, 405, 501])("falls back before acceptance on route status %s", async (status) => {
    const calls: string[] = [];
    const attempt: CompatibleProtocolAttempt<{ protocol: string; terminal: "completed" }> = vi.fn(
      async (protocol) => {
        calls.push(`${protocol}:stream`);
        return protocol === "responses" ? failed(status) : succeeded(protocol);
      },
    );

    const result = await selectCompatibleProtocol({
      instanceId,
      preference: "auto",
      cache: makeRuntimeProtocolCache(),
      attempt,
    });

    expect(result.protocol).toBe("chat-completions");
    expect(calls).toEqual(["responses:stream", "chat-completions:stream"]);
  });

  it.each([401, 408, 429, 500])("does not cross-protocol retry status %s", async (status) => {
    const attempt = vi.fn(async () => failed(status));

    await expect(
      selectCompatibleProtocol({
        instanceId,
        preference: "auto",
        cache: makeRuntimeProtocolCache(),
        attempt,
      }),
    ).rejects.toEqual({ category: "unsupported", message: "The provider route is unavailable." });
    expect(attempt).toHaveBeenCalledOnce();
  });

  it.each(["unauthenticated", "unavailable", "rate-limited", "provider-failed"] as const)(
    "does not fallback when route metadata contradicts a %s failure",
    async (category) => {
      const attempt = vi.fn(async () =>
        failed(404, {
          failure: { category, message: "The request failed before acceptance." },
        }),
      );

      await expect(
        selectCompatibleProtocol({
          instanceId,
          preference: "auto",
          cache: makeRuntimeProtocolCache(),
          attempt,
        }),
      ).rejects.toMatchObject({ category });
      expect(attempt).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { accepted: true, outputStarted: false },
    { accepted: false, outputStarted: true },
    { accepted: true, outputStarted: true },
  ])("does not fall back after acceptance or output %#", async (metadata) => {
    const attempt = vi.fn(async () => failed(404, metadata));

    await expect(
      selectCompatibleProtocol({
        instanceId,
        preference: "auto",
        cache: makeRuntimeProtocolCache(),
        attempt,
      }),
    ).rejects.toBeDefined();
    expect(attempt).toHaveBeenCalledOnce();
  });

  it.each(["responses", "chat-completions"] as const)(
    "never cross-falls back for explicit %s",
    async (preference) => {
      const attempt = vi.fn(async () => failed(404));

      await expect(
        selectCompatibleProtocol({
          instanceId,
          preference,
          cache: makeRuntimeProtocolCache(),
          attempt,
        }),
      ).rejects.toBeDefined();
      expect(attempt).toHaveBeenCalledOnce();
      expect(attempt).toHaveBeenCalledWith(preference);
    },
  );

  it("caches only a successful auto-selected protocol in runtime memory", async () => {
    const cache = makeRuntimeProtocolCache();
    const first = vi.fn(async (protocol: "responses" | "chat-completions") =>
      protocol === "responses" ? failed(404) : succeeded(protocol),
    );

    await selectCompatibleProtocol({ instanceId, preference: "auto", cache, attempt: first });
    expect(cache.get(instanceId)).toBe("chat-completions");

    const second = vi.fn(async (protocol: "responses" | "chat-completions") => succeeded(protocol));
    await selectCompatibleProtocol({ instanceId, preference: "auto", cache, attempt: second });
    expect(second).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledWith("chat-completions");
  });

  it("does not cache failures or explicit overrides", async () => {
    const cache = makeRuntimeProtocolCache();
    await expect(
      selectCompatibleProtocol({
        instanceId,
        preference: "auto",
        cache,
        attempt: async () => failed(500),
      }),
    ).rejects.toBeDefined();
    expect(cache.get(instanceId)).toBeUndefined();

    await selectCompatibleProtocol({
      instanceId,
      preference: "chat-completions",
      cache,
      attempt: async (protocol) => succeeded(protocol),
    });
    expect(cache.get(instanceId)).toBeUndefined();
  });

  it("does not reverse-fallback from a cached Chat protocol", async () => {
    const cache = makeRuntimeProtocolCache();
    cache.set(instanceId, "chat-completions");
    const attempt = vi.fn(async () => failed(404));

    await expect(
      selectCompatibleProtocol({ instanceId, preference: "auto", cache, attempt }),
    ).rejects.toBeDefined();
    expect(attempt).toHaveBeenCalledOnce();
    expect(attempt).toHaveBeenCalledWith("chat-completions");
  });

  it("sanitizes thrown attempt diagnostics instead of exposing raw payloads", async () => {
    const raw = { payload: "private upstream body", message: "private diagnostic" };

    await expect(
      selectCompatibleProtocol({
        instanceId,
        preference: "auto",
        cache: makeRuntimeProtocolCache(),
        attempt: async () => {
          throw raw;
        },
      }),
    ).rejects.toEqual({
      category: "provider-failed",
      message: "The provider protocol attempt failed.",
    });
  });
});
