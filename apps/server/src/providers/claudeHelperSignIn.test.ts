import { describe, expect, it } from "vitest";

import { decodeProviderInstanceId, type ProviderInstance } from "@octant/contracts";

import { claudeHelperSignInFromBroker, readClaudeHelperSignIn } from "./claudeHelperSignIn";
import { createClaudeHelperSignInService } from "./claudeHelperSignInRoutes";
import type { ClaudeSetupTokenOutcome } from "./claudeSetupToken";
import type { ProviderCredentialStore } from "./credentialBrokerClient";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000901");
const TOKEN = "sk-ant-oat01-fixture_Token-0123456789abcdefghij";

function memoryBroker(initial?: string) {
  const entries = new Map<string, string>();
  if (initial !== undefined) entries.set(String(instanceId), initial);
  const broker: ProviderCredentialStore = {
    has: async (id) => entries.has(id),
    resolve: async (id) => {
      const value = entries.get(id);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    set: async (id, value) => {
      entries.set(id, value);
    },
    delete: async (id) => {
      entries.delete(id);
    },
  };
  return { broker, entries };
}

function claudeInstance(authentication: "subscription" | "api-key"): ProviderInstance {
  return {
    id: instanceId,
    displayName: "Claude Code",
    driverKind: "claude",
    enabled: true,
    environmentPolicy: "inherit-host",
    configuration: {
      kind: "claude-agent-sdk",
      binaryPath: "/usr/local/bin/claude",
      authentication,
    },
    version: 1,
    createdAt: "2026-10-06T12:00:00.000Z",
    updatedAt: "2026-10-06T12:00:00.000Z",
  } as unknown as ProviderInstance;
}

describe("Claude for helpers sign-in", () => {
  it("connects, reports connected, and removes the token on disconnect", async () => {
    const { broker, entries } = memoryBroker();
    let finish: (outcome: ClaudeSetupTokenOutcome) => void = () => undefined;
    const service = createClaudeHelperSignInService({
      store: claudeHelperSignInFromBroker(broker),
      readInstance: () => claudeInstance("subscription"),
      runSetupToken: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });

    expect(await service.status(instanceId)).toEqual({ kind: "not-connected" });
    expect(await service.connect(instanceId)).toEqual({ kind: "connecting" });
    expect(await service.status(instanceId)).toEqual({ kind: "connecting" });
    finish({ kind: "captured", token: TOKEN });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const view = await service.status(instanceId);
    expect(view).toEqual({ kind: "connected" });
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(readClaudeHelperSignIn(entries.get(String(instanceId)) ?? "")).toEqual({
      state: "connected",
      token: TOKEN,
    });

    expect(await service.disconnect(instanceId)).toEqual({ kind: "not-connected" });
    expect(entries.has(String(instanceId))).toBe(false);
  });

  it("says why a connect attempt failed and keeps nothing", async () => {
    const { broker, entries } = memoryBroker();
    const service = createClaudeHelperSignInService({
      store: claudeHelperSignInFromBroker(broker),
      readInstance: () => claudeInstance("subscription"),
      runSetupToken: async () => ({
        kind: "refused",
        reason: "Claude did not finish connecting. Try again.",
      }),
    });

    await service.connect(instanceId);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await service.status(instanceId)).toEqual({
      kind: "refused",
      reason: "Claude did not finish connecting. Try again.",
    });
    expect(entries.size).toBe(0);
  });

  it("never reads an API key as a helper token, and never removes one", async () => {
    const { broker, entries } = memoryBroker("sk-ant-api03-a-real-shaped-api-key-value");
    const store = claudeHelperSignInFromBroker(broker);

    expect(await store.read(String(instanceId))).toEqual({ kind: "not-connected" });
    await store.disconnect(String(instanceId));
    await store.markExpired(String(instanceId), "sk-ant-api03-a-real-shaped-api-key-value");
    expect(entries.get(String(instanceId))).toBe("sk-ant-api03-a-real-shaped-api-key-value");
  });

  it("marks only the refused token expired, so a newer connection survives", async () => {
    const { broker } = memoryBroker();
    const store = claudeHelperSignInFromBroker(broker);
    await store.connect(String(instanceId), TOKEN);

    await store.markExpired(String(instanceId), `${TOKEN}-older`);
    expect(await store.read(String(instanceId))).toEqual({ kind: "connected", token: TOKEN });

    await store.markExpired(String(instanceId), TOKEN);
    expect(await store.read(String(instanceId))).toEqual({ kind: "expired" });
  });

  it("refuses to connect a Claude Code instance that signs in with an API key", async () => {
    const { broker } = memoryBroker();
    let ran = false;
    const service = createClaudeHelperSignInService({
      store: claudeHelperSignInFromBroker(broker),
      readInstance: () => claudeInstance("api-key"),
      runSetupToken: async () => {
        ran = true;
        return { kind: "captured", token: TOKEN };
      },
    });

    expect(await service.connect(instanceId)).toMatchObject({ kind: "refused" });
    expect(ran).toBe(false);
  });
});
