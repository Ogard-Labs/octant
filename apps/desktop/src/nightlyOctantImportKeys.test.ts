import { describe, expect, it } from "vitest";
import { CredentialStoreFailure, type CredentialStore } from "@octant/host-runtime";
import {
  COPIED_KEY_NAMESPACES,
  copyOctantKeys,
  decodeCredentialReferences,
  type CopiedKeyNamespace,
  type KeyStoreFactory,
} from "./nightlyOctantImportKeys";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function memoryStores(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  const writes: string[] = [];
  const factory: KeyStoreFactory = (namespace) =>
    ({
      has: async (key) => items.has(`${namespace}:${key}`),
      resolve: async (key) => {
        const value = items.get(`${namespace}:${key}`);
        if (value === undefined) throw new CredentialStoreFailure("missing");
        return value;
      },
      set: async (key, value) => {
        writes.push(`${namespace}:${key}`);
        items.set(`${namespace}:${key}`, value);
      },
      delete: async () => undefined,
    }) satisfies CredentialStore;
  return { factory, items, writes };
}

describe("copying Octant's keys", () => {
  it("copies only the allowed namespaces and never host identity or share secrets", async () => {
    expect(COPIED_KEY_NAMESPACES).not.toContain("replica-device-key");
    expect(COPIED_KEY_NAMESPACES).not.toContain("replica-store-credential");
    expect(COPIED_KEY_NAMESPACES).not.toContain("push-platform-credential");
    expect(COPIED_KEY_NAMESPACES).not.toContain("canvas-public-share-secret");
    const octant = memoryStores({
      [`provider:${id(1)}`]: "sk-provider",
      [`canvas-public-share-secret:${id(2)}`]: "share",
      [`replica-device-key:${id(3)}`]: "device",
    });
    const nightly = memoryStores();
    const outcome = await copyOctantKeys({
      references: [
        { namespace: "provider", id: id(1) },
        { namespace: "canvas-public-share-secret", id: id(2) },
        { namespace: "replica-device-key", id: id(3) },
      ],
      octantStores: octant.factory,
      nightlyStores: nightly.factory,
    });
    expect(outcome).toEqual({ status: "copied", copied: 1, existing: 0, failed: 0 });
    expect(nightly.writes).toEqual([`provider:${id(1)}`]);
  });

  it("never replaces an item Nightly already has, and counts it", async () => {
    const octant = memoryStores({ [`ssh-key:${id(1)}`]: "from-octant" });
    const nightly = memoryStores({ [`ssh-key:${id(1)}`]: "nightlys-own" });
    const outcome = await copyOctantKeys({
      references: [{ namespace: "ssh-key", id: id(1) }],
      octantStores: octant.factory,
      nightlyStores: nightly.factory,
    });
    expect(outcome).toEqual({ status: "copied", copied: 0, existing: 1, failed: 0 });
    expect(nightly.items.get(`ssh-key:${id(1)}`)).toBe("nightlys-own");
  });

  it("counts a failed write, skips an item Octant never held, and copies each item once", async () => {
    const octant = memoryStores({
      [`mcp-server-credential:${id(1)}`]: "a",
      [`web-search-credential:${id(2)}`]: "b",
    });
    const nightly = memoryStores();
    const failing: KeyStoreFactory = (namespace: CopiedKeyNamespace) => {
      const store = nightly.factory(namespace);
      return namespace === "web-search-credential"
        ? {
            ...store,
            set: async () => Promise.reject(new CredentialStoreFailure("locked" as never)),
          }
        : store;
    };
    const outcome = await copyOctantKeys({
      references: [
        { namespace: "mcp-server-credential", id: id(1) },
        { namespace: "mcp-server-credential", id: id(1) },
        { namespace: "web-search-credential", id: id(2) },
        { namespace: "thread-secret-credential", id: id(9) },
        { namespace: "provider", id: "not-an-id" },
      ],
      octantStores: octant.factory,
      nightlyStores: failing,
    });
    expect(outcome).toEqual({ status: "copied", copied: 1, existing: 0, failed: 1 });
  });

  it("says so when the items cannot be listed or the platform has no store", async () => {
    const stores = memoryStores();
    await expect(
      copyOctantKeys({
        references: undefined,
        octantStores: stores.factory,
        nightlyStores: stores.factory,
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "cannot-list" });
    await expect(
      copyOctantKeys({ references: [], octantStores: undefined, nightlyStores: undefined }),
    ).resolves.toEqual({ status: "unavailable", reason: "unsupported-platform" });
  });

  it("reads the references only from a successful, well-formed report", () => {
    const report = JSON.stringify({ references: [{ namespace: "provider", id: id(1) }] });
    expect(decodeCredentialReferences(0, report)).toEqual([{ namespace: "provider", id: id(1) }]);
    expect(decodeCredentialReferences(2, report)).toBeUndefined();
    expect(decodeCredentialReferences(0, "usage")).toBeUndefined();
    expect(
      decodeCredentialReferences(0, JSON.stringify({ references: [{ id: 1 }] })),
    ).toBeUndefined();
  });
});
