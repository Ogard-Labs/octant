import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderModelId,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { ClaudeResumeIdentityStore } from "./claudeResumeIdentityStore";

const providerInstanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000071");
const otherProviderInstanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000073");
const octantSessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000072");
const modelId = "claude-sonnet" as ProviderModelId;

describe("ClaudeResumeIdentityStore", () => {
  it("fails before mutation when per-provider or global capacity is exhausted", async () => {
    const store = new ClaudeResumeIdentityStore({
      maxIdentities: 2,
      maxIdentitiesPerProvider: 1,
    });
    const signal = new AbortController().signal;
    const identity = {
      providerInstanceId,
      octantSessionId,
      sdkSessionId: "sdk-one",
      projectRoot: "/tmp/project",
      modelId,
      authentication: "subscription" as const,
    };
    await store.put(identity, signal);

    await expect(
      store.put({ ...identity, sdkSessionId: "sdk-provider-overflow" }, signal),
    ).rejects.toMatchObject({ name: "ClaudeResumeIdentityStoreCapacityExceeded" });
    expect(store.identityCount()).toBe(1);
    await expect(
      store.lookup({ providerInstanceId, sdkSessionId: "sdk-one" }, signal),
    ).resolves.toEqual(identity);

    await store.put(
      { ...identity, providerInstanceId: otherProviderInstanceId, sdkSessionId: "sdk-two" },
      signal,
    );
    await expect(
      store.put(
        {
          ...identity,
          providerInstanceId: decodeProviderInstanceId("80000000-0000-4000-8000-000000000074"),
          sdkSessionId: "sdk-global-overflow",
        },
        signal,
      ),
    ).rejects.toMatchObject({ name: "ClaudeResumeIdentityStoreCapacityExceeded" });
    expect(store.identityCount()).toBe(2);
  });

  it("admits only one concurrent new identity when one global slot remains", async () => {
    const store = new ClaudeResumeIdentityStore({
      maxIdentities: 1,
      maxIdentitiesPerProvider: 1,
    });
    const signal = new AbortController().signal;
    const results = await Promise.allSettled([
      store.put(
        {
          providerInstanceId,
          octantSessionId,
          sdkSessionId: "sdk-one",
          projectRoot: "/tmp/project",
          modelId,
          authentication: "subscription",
        },
        signal,
      ),
      store.put(
        {
          providerInstanceId: otherProviderInstanceId,
          octantSessionId,
          sdkSessionId: "sdk-two",
          projectRoot: "/tmp/project",
          modelId,
          authentication: "api-key",
        },
        signal,
      ),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(store.identityCount()).toBe(1);
  });

  it("removes every identity for one provider without touching another provider", async () => {
    const store = new ClaudeResumeIdentityStore();
    const signal = new AbortController().signal;
    const base = {
      octantSessionId,
      projectRoot: "/tmp/project",
      modelId,
      authentication: "subscription" as const,
    };
    await store.put({ ...base, providerInstanceId, sdkSessionId: "sdk-one" }, signal);
    await store.put({ ...base, providerInstanceId, sdkSessionId: "sdk-two" }, signal);
    await store.put(
      { ...base, providerInstanceId: otherProviderInstanceId, sdkSessionId: "sdk-other" },
      signal,
    );

    await store.removeProvider(providerInstanceId, signal);

    expect(store.identityCount()).toBe(1);
    await expect(
      store.lookup({ providerInstanceId, sdkSessionId: "sdk-one" }, signal),
    ).resolves.toBeUndefined();
    await expect(
      store.lookup(
        { providerInstanceId: otherProviderInstanceId, sdkSessionId: "sdk-other" },
        signal,
      ),
    ).resolves.toBeDefined();
  });

  it("does not clear a provider when provider removal is already aborted", async () => {
    const store = new ClaudeResumeIdentityStore();
    const signal = new AbortController().signal;
    await store.put(
      {
        providerInstanceId,
        octantSessionId,
        sdkSessionId: "sdk-one",
        projectRoot: "/tmp/project",
        modelId,
        authentication: "subscription",
      },
      signal,
    );
    const aborted = new AbortController();
    aborted.abort();

    await expect(store.removeProvider(providerInstanceId, aborted.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(store.identityCount()).toBe(1);
  });

  it("stores an immutable exact resume identity by provider and SDK session", async () => {
    const store = new ClaudeResumeIdentityStore();
    const identity = {
      providerInstanceId,
      octantSessionId,
      sdkSessionId: "sdk-session",
      projectRoot: "/tmp/project",
      modelId,
      authentication: "subscription" as const,
    };

    await store.put(identity, new AbortController().signal);

    const stored = await store.lookup(
      { providerInstanceId, sdkSessionId: "sdk-session" },
      new AbortController().signal,
    );
    expect(stored).toEqual(identity);
    expect(stored).not.toBe(identity);
    expect(Object.isFrozen(stored)).toBe(true);
  });

  it("rejects cancellation before mutating the store", async () => {
    const store = new ClaudeResumeIdentityStore();
    const cancelled = new AbortController();
    cancelled.abort();

    await expect(
      store.put(
        {
          providerInstanceId,
          octantSessionId,
          sdkSessionId: "cancelled-session",
          projectRoot: "/tmp/project",
          modelId,
          authentication: "api-key",
        },
        cancelled.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      store.lookup(
        { providerInstanceId, sdkSessionId: "cancelled-session" },
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
  });

  it("removes only the exact provider and SDK session identity", async () => {
    const store = new ClaudeResumeIdentityStore();
    const signal = new AbortController().signal;
    await store.put(
      {
        providerInstanceId,
        octantSessionId,
        sdkSessionId: "sdk-session",
        projectRoot: "/tmp/project",
        modelId,
        authentication: "subscription",
      },
      signal,
    );

    await store.remove({ providerInstanceId, sdkSessionId: "sdk-session" }, signal);

    await expect(
      store.lookup({ providerInstanceId, sdkSessionId: "sdk-session" }, signal),
    ).resolves.toBeUndefined();
  });

  it("clears identities and rejects every operation after close", async () => {
    const store = new ClaudeResumeIdentityStore();
    const signal = new AbortController().signal;
    await store.put(
      {
        providerInstanceId,
        octantSessionId,
        sdkSessionId: "sdk-session",
        projectRoot: "/tmp/project",
        modelId,
        authentication: "subscription",
      },
      signal,
    );
    expect(store.identityCount()).toBe(1);

    await store.close();

    expect(store.identityCount()).toBe(0);
    await expect(
      store.lookup({ providerInstanceId, sdkSessionId: "sdk-session" }, signal),
    ).rejects.toMatchObject({ name: "ClaudeResumeIdentityStoreClosed" });
  });

  it("prevents a held operation from mutating after shutdown begins", async () => {
    const store = new ClaudeResumeIdentityStore();
    const pending = store.put(
      {
        providerInstanceId,
        octantSessionId,
        sdkSessionId: "late-session",
        projectRoot: "/tmp/project",
        modelId,
        authentication: "subscription",
      },
      new AbortController().signal,
    );

    await store.close();

    await expect(pending).rejects.toMatchObject({ name: "ClaudeResumeIdentityStoreClosed" });
    expect(store.identityCount()).toBe(0);
  });
});
