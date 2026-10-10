import { describe, expect, it } from "vitest";
import { addApiKey, listApiKeys, removeApiKey, replaceApiKeySecret } from "@octant/host-runtime";
import {
  makeAnthropicCompatibleEndpoint,
  requestAnthropicGeneration,
  type AnthropicCompatibleFetch,
} from "./anthropicCompatibleEndpoint";
import type { ProviderCredentialStore } from "./credentialBrokerClient";
import {
  makeOpenAiCompatibleEndpoint,
  requestGeneration,
  type CompatibleFetch,
} from "./openAiCompatibleEndpoint";
import { makeProviderApiKeyPool } from "./providerApiKeyPool";

const instanceId = "pool-test-instance";
const FIRST = "sk-first-0000";
const SECOND = "sk-second-1111";

const SPEND_LIMIT_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "rate_limit_error",
    message: "Your organization has reached its spend limit.",
    details: { error_code: "enforced_spend_limit_reached" },
  },
});

function memoryStore(
  initial: string,
): ProviderCredentialStore & { readonly stored: () => string | undefined } {
  let value: string | undefined = initial;
  return {
    has: async () => value !== undefined,
    resolve: async () => {
      if (value === undefined) throw new Error("missing");
      return value;
    },
    set: async (_id, credential) => {
      value = credential;
    },
    delete: async () => {
      value = undefined;
    },
    stored: () => value,
  };
}

function twoKeyStore(): ProviderCredentialStore {
  const first = addApiKey(undefined, { secret: FIRST, label: "Work" });
  const second = addApiKey(first.stored, { secret: SECOND, label: "Personal" });
  return memoryStore(second.stored);
}

function clock(start = 1_000) {
  let current = start;
  return { now: () => current, advance: (ms: number) => (current += ms) };
}

describe("provider API key pool", () => {
  it("sends the first key of the pool", async () => {
    const pool = makeProviderApiKeyPool(twoKeyStore());
    expect(await pool.resolve(instanceId)).toBe(FIRST);
  });

  it("moves to the next key after a spend-limit refusal, then returns once it cools", async () => {
    const time = clock();
    const pool = makeProviderApiKeyPool(twoKeyStore(), time.now);

    const lease = await pool.lease(instanceId);
    lease.reportRejected({ status: 429, body: SPEND_LIMIT_BODY });

    expect(await pool.resolve(instanceId)).toBe(SECOND);
    time.advance(60 * 60_000 + 1);
    expect(await pool.resolve(instanceId)).toBe(FIRST);
  });

  it("keeps the first key after a bad-key refusal, because another key would not fix it", async () => {
    const pool = makeProviderApiKeyPool(twoKeyStore());
    const lease = await pool.lease(instanceId);
    lease.reportRejected({ status: 401, body: "invalid x-api-key" });
    expect(await pool.resolve(instanceId)).toBe(FIRST);
  });

  it("gives a plain rate limit one minute, then the first key again", async () => {
    const time = clock();
    const pool = makeProviderApiKeyPool(twoKeyStore(), time.now);
    const lease = await pool.lease(instanceId);
    lease.reportRejected({ status: 429, body: "rate limited", retryAfterSeconds: 5 });
    expect(await pool.resolve(instanceId)).toBe(SECOND);
    time.advance(5_001);
    expect(await pool.resolve(instanceId)).toBe(FIRST);
  });

  it("keeps a single key in use even while it cools, since there is nothing else to send", async () => {
    const pool = makeProviderApiKeyPool(memoryStore(FIRST));
    const lease = await pool.lease(instanceId);
    lease.reportRejected({ status: 429, body: SPEND_LIMIT_BODY });
    expect(await pool.resolve(instanceId)).toBe(FIRST);
  });

  it("treats a plain stored key exactly as before the pool existed", async () => {
    const pool = makeProviderApiKeyPool(memoryStore(FIRST));
    expect(await pool.resolve(instanceId)).toBe(FIRST);
  });

  it("forgets cooldowns when the instance's keys are replaced or deleted", async () => {
    const store = twoKeyStore();
    const pool = makeProviderApiKeyPool(store);
    const lease = await pool.lease(instanceId);
    lease.reportRejected({ status: 402, body: "" });
    expect(await pool.resolve(instanceId)).toBe(SECOND);

    await pool.set(instanceId, FIRST);
    expect(await pool.resolve(instanceId)).toBe(FIRST);
  });

  it("uses a rotated key once it has replaced the refused one", async () => {
    const store = twoKeyStore();
    const pool = makeProviderApiKeyPool(store);
    const lease = await pool.lease(instanceId);
    lease.reportRejected({ status: 402, body: "" });

    const firstKeyId = listApiKeys(await store.resolve(instanceId))[0]?.id ?? "";
    const rotated = replaceApiKeySecret(
      await store.resolve(instanceId),
      firstKeyId,
      "sk-rotated-2222",
    );
    await pool.set(instanceId, rotated);
    expect(await pool.resolve(instanceId)).toBe("sk-rotated-2222");
  });

  it("keeps the other keys when one is removed", async () => {
    const store = twoKeyStore();
    const pool = makeProviderApiKeyPool(store);
    const firstKeyId = listApiKeys(await store.resolve(instanceId))[0]?.id ?? "";
    const remaining = removeApiKey(await store.resolve(instanceId), firstKeyId);
    await pool.set(instanceId, remaining ?? "");
    expect(await pool.resolve(instanceId)).toBe(SECOND);
  });
});

describe("pool through the Anthropic-compatible endpoint", () => {
  const configuration = {
    kind: "anthropic-compatible-http",
    baseUrl: "https://fixture.example/v1",
    authentication: "api-key",
    protocol: "messages",
    protocolVersion: "2023-06-01",
    manualModelIds: [],
  } as const;

  it("sends the next key on the next request after a spend-limit refusal", async () => {
    const sent: string[] = [];
    const fetch: AnthropicCompatibleFetch = async (_url, init) => {
      const key = new Headers(init?.headers).get("x-api-key") ?? "";
      sent.push(key);
      return key === FIRST
        ? new Response(SPEND_LIMIT_BODY, { status: 429 })
        : new Response("{}", { status: 200 });
    };
    const endpoint = makeAnthropicCompatibleEndpoint({
      instanceId,
      configuration: configuration as never,
      credentialResolver: makeProviderApiKeyPool(twoKeyStore()),
      fetch,
    });

    await expect(
      requestAnthropicGeneration(endpoint, { path: "messages", body: {} }),
    ).rejects.toBeDefined();
    await requestAnthropicGeneration(endpoint, { path: "messages", body: {} });

    expect(sent).toEqual([FIRST, SECOND]);
  });
});

describe("pool through the OpenAI-compatible endpoint", () => {
  it("sends the next key on the next request after a quota refusal", async () => {
    const sent: string[] = [];
    const fetch: CompatibleFetch = async (_url, init) => {
      const header = new Headers(init?.headers).get("authorization") ?? "";
      sent.push(header);
      return header === `Bearer ${FIRST}`
        ? new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 })
        : new Response("{}", { status: 200 });
    };
    const endpoint = makeOpenAiCompatibleEndpoint({
      instanceId,
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://fixture.example/v1",
        authentication: "bearer",
        protocol: "chat-completions",
        manualModelIds: [],
      } as never,
      credentialResolver: makeProviderApiKeyPool(twoKeyStore()),
      fetch,
    });

    await expect(
      requestGeneration(endpoint, { path: "chat/completions", body: {} }),
    ).rejects.toBeDefined();
    await requestGeneration(endpoint, { path: "chat/completions", body: {} });

    expect(sent).toEqual([`Bearer ${FIRST}`, `Bearer ${SECOND}`]);
  });
});
