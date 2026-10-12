import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeProviderInstance, decodeProviderInstanceId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";

import type { ProviderCredentialStore } from "./credentialBrokerClient";
import { retireClaudeHelperTokens } from "./claudeHelperTokenRetirement";

const claudeId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000821");
const otherClaudeId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000822");
const now = "2026-07-14T10:00:00.000Z";

function claudeInstance(id = claudeId, overrides: Record<string, unknown> = {}) {
  return decodeProviderInstance({
    id,
    displayName: "Claude local",
    driverKind: "claude",
    configuration: {
      kind: "claude-agent-sdk",
      binaryPath: "/opt/homebrew/bin/claude",
      authentication: "subscription",
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function memoryBroker(initial: Record<string, string>): ProviderCredentialStore {
  const values = new Map(Object.entries(initial));
  return {
    has: vi.fn(async (id) => values.has(id)),
    resolve: vi.fn(async (id) => {
      const value = values.get(id);
      if (value === undefined) throw new Error("missing");
      return value;
    }),
    set: vi.fn(async (id, credential) => {
      values.set(id, credential);
    }),
    delete: vi.fn(async (id) => {
      values.delete(id);
    }),
  };
}

const HELPER_ENVELOPE = JSON.stringify({ kind: "claude-helper-sign-in" });
const removedId = "80000000-0000-4000-8000-000000000823";

function temporaryDataDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "octant-claude-retire-"));
}

describe("Claude helper token retirement", () => {
  it("deletes only leftover helper envelopes and leaves API keys", async () => {
    const broker = memoryBroker({
      [String(claudeId)]: HELPER_ENVELOPE,
      [String(otherClaudeId)]: "sk-ant-not-a-helper-envelope",
    });

    await expect(
      retireClaudeHelperTokens({
        dataDirectory: await temporaryDataDirectory(),
        broker,
        instances: [claudeInstance(), claudeInstance(otherClaudeId)],
        removedInstanceIds: [],
      }),
    ).resolves.toEqual({ status: "retired", deletedCount: 1 });
    expect(await broker.has(String(claudeId))).toBe(false);
    expect(await broker.has(String(otherClaudeId))).toBe(true);
  });

  it("deletes the helper envelope of an account that was removed, and leaves a removed provider's key", async () => {
    const removedKeyId = "80000000-0000-4000-8000-000000000824";
    const broker = memoryBroker({
      [removedId]: HELPER_ENVELOPE,
      [removedKeyId]: "sk-ant-key-of-a-removed-provider",
    });

    await expect(
      retireClaudeHelperTokens({
        dataDirectory: await temporaryDataDirectory(),
        broker,
        instances: [],
        removedInstanceIds: [removedId, removedKeyId],
      }),
    ).resolves.toEqual({ status: "retired", deletedCount: 1 });
    expect(await broker.has(removedId)).toBe(false);
    expect(await broker.has(removedKeyId)).toBe(true);
  });

  it("runs once per data directory", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const broker = memoryBroker({ [String(claudeId)]: HELPER_ENVELOPE });
    const input = { dataDirectory, broker, instances: [claudeInstance()], removedInstanceIds: [] };
    await retireClaudeHelperTokens(input);
    const askedAfterFirst = vi.mocked(broker.has).mock.calls.length;

    await expect(retireClaudeHelperTokens(input)).resolves.toEqual({ status: "already-retired" });
    expect(vi.mocked(broker.has).mock.calls).toHaveLength(askedAfterFirst);
  });

  it("runs again after a pass that did not cover removed accounts", async () => {
    const dataDirectory = await temporaryDataDirectory();
    await writeFile(
      join(dataDirectory, "claude-helper-token-retirement.json"),
      JSON.stringify({ deletedCount: 0, acknowledged: true }),
    );
    const broker = memoryBroker({ [removedId]: HELPER_ENVELOPE });

    await expect(
      retireClaudeHelperTokens({
        dataDirectory,
        broker,
        instances: [],
        removedInstanceIds: [removedId],
      }),
    ).resolves.toEqual({ status: "retired", deletedCount: 1 });
  });

  it("tries again on the next start when the credential store could not be reached", async () => {
    const dataDirectory = await temporaryDataDirectory();
    const broker = memoryBroker({ [String(claudeId)]: HELPER_ENVELOPE });
    vi.mocked(broker.has).mockRejectedValueOnce(new Error("broker unavailable"));
    const input = { dataDirectory, broker, instances: [claudeInstance()], removedInstanceIds: [] };

    await expect(retireClaudeHelperTokens(input)).resolves.toEqual({ status: "unavailable" });
    await expect(retireClaudeHelperTokens(input)).resolves.toEqual({
      status: "retired",
      deletedCount: 1,
    });
  });

  it("does nothing on a host with no credential store", async () => {
    await expect(
      retireClaudeHelperTokens({
        dataDirectory: await temporaryDataDirectory(),
        broker: undefined,
        instances: [claudeInstance()],
        removedInstanceIds: [],
      }),
    ).resolves.toEqual({ status: "unavailable" });
  });
});
