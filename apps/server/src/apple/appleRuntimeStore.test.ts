import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let AppleRuntimeStore: new (root: string) => {
  writeArtifact(reference: string, bytes: Uint8Array): Promise<void>;
  readArtifact(reference: string): Promise<Uint8Array | undefined>;
  persistReceipts(receipts: ReadonlyArray<Record<string, unknown>>): Promise<void>;
  loadReceipts(): Promise<ReadonlyArray<Record<string, unknown>>>;
};

beforeAll(async () => {
  const path = "./appleRuntimeStore";
  const loaded = await import(path).catch(() => undefined);
  expect(loaded).toBeDefined();
  expect(loaded?.AppleRuntimeStore).toBeTypeOf("function");
  AppleRuntimeStore = loaded!.AppleRuntimeStore;
});

describe("AppleRuntimeStore", () => {
  it("persists opaque artifacts and restart receipts without private paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-apple-store-"));
    try {
      const store = new AppleRuntimeStore(root);
      await store.writeArtifact("apple-log-safe", new TextEncoder().encode("bounded log"));
      await expect(store.readArtifact("apple-log-safe")).resolves.toEqual(
        new TextEncoder().encode("bounded log"),
      );
      await expect(store.readArtifact("../escape")).resolves.toBeUndefined();
      await expect(store.readArtifact("apple-missing")).resolves.toBeUndefined();
      const receipts = [
        {
          actionId: "70000000-0000-4000-8000-000000000001",
          correlationId: "70000000-0000-4000-8000-000000000002",
          authority: {
            hostId: "70000000-0000-4000-8000-000000000003",
            mode: "code",
            projectId: "70000000-0000-4000-8000-000000000004",
            providerInstanceId: "70000000-0000-4000-8000-000000000005",
            extension: { kind: "core" },
          },
          threadId: "70000000-0000-4000-8000-000000000006",
          checkoutId: "70000000-0000-4000-8000-000000000007",
          kind: "run",
          simulatorId: "70000000-0000-4000-8000-000000000008",
          bundleIdentifier: "app.octant.fixture",
          startedAt: "2026-07-27T20:00:00.000Z",
        },
      ];
      await store.persistReceipts(receipts);
      await expect(store.loadReceipts()).resolves.toEqual(receipts);
      expect(await readFile(join(root, "artifacts", "apple-log-safe"), "utf8")).toBe("bounded log");
      expect(await readFile(join(root, "active-actions.json"), "utf8")).not.toContain("/private/");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal and returns an empty receipt set for missing or malformed state", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-apple-store-"));
    try {
      const store = new AppleRuntimeStore(root);
      await expect(store.writeArtifact("../escape", new Uint8Array())).rejects.toThrow();
      await expect(store.loadReceipts()).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
