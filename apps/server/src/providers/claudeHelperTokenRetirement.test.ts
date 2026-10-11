import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeProviderInstance, decodeProviderInstanceId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";

import type { ProviderCredentialStore } from "./credentialBrokerClient";
import { createClaudeHelperTokenRetirementStore } from "./claudeHelperTokenRetirement";

const claudeId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000821");
const otherClaudeId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000822");
const now = "2026-07-14T10:00:00.000Z";

function claudeInstance(
  id = claudeId,
  overrides: Record<string, unknown> = {},
) {
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

describe("Claude helper token retirement", () => {
  it("deletes only leftover helper envelopes and leaves API keys", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "octant-claude-retire-"));
    const broker = memoryBroker({
      [String(claudeId)]: JSON.stringify({ kind: "claude-helper-sign-in" }),
      [String(otherClaudeId)]: "sk-ant-not-a-helper-envelope",
    });
    const store = createClaudeHelperTokenRetirementStore({ dataDirectory, broker });

    await expect(store.retire([claudeInstance(), claudeInstance(otherClaudeId)])).resolves.toEqual({
      deletedCount: 1,
      acknowledged: false,
    });
    expect(broker.delete).toHaveBeenCalledWith(String(claudeId));
    expect(broker.delete).not.toHaveBeenCalledWith(String(otherClaudeId));
    expect(await broker.has(String(otherClaudeId))).toBe(true);
    expect(await broker.has(String(claudeId))).toBe(false);
  });

  it("writes the retirement notice once and treats a second retire as already done", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "octant-claude-retire-"));
    const broker = memoryBroker({
      [String(claudeId)]: JSON.stringify({ kind: "claude-helper-sign-in" }),
    });
    const store = createClaudeHelperTokenRetirementStore({ dataDirectory, broker });
    const first = await store.retire([claudeInstance()]);
    expect(first).toEqual({ deletedCount: 1, acknowledged: false });
    expect(
      JSON.parse(await readFile(join(dataDirectory, "claude-helper-token-retirement.json"), "utf8")),
    ).toEqual({ deletedCount: 1, acknowledged: false });

    broker.delete.mockClear();
    await expect(store.retire([claudeInstance()])).resolves.toEqual({
      deletedCount: 1,
      acknowledged: false,
    });
    expect(broker.delete).not.toHaveBeenCalled();
  });

  it("is a no-op when the credential broker is missing", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "octant-claude-retire-"));
    const store = createClaudeHelperTokenRetirementStore({ dataDirectory });
    await expect(store.retire([claudeInstance()])).resolves.toBeUndefined();
    await expect(store.notice()).resolves.toBeUndefined();
  });
});
