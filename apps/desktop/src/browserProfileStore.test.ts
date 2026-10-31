import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserProfileStore, type BrowserProfileSessionPort } from "./browserProfileStore";

const projectId = "40000000-0000-4000-8000-000000000001";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function partitions(): string {
  const root = mkdtempSync(join(tmpdir(), "octant-profile-store-"));
  roots.push(root);
  const write = (folder: string, name: string, size: number) => {
    mkdirSync(join(root, folder, "Local Storage"), { recursive: true });
    writeFileSync(join(root, folder, name), Buffer.alloc(size));
  };
  write("octant-profile-personal", "Cookies", 100);
  writeFileSync(
    join(root, "octant-profile-personal", "Local Storage", "leveldb"),
    Buffer.alloc(50),
  );
  write(`octant-profile-project-${projectId}`, "Cookies", 10);
  write("octant-browser-60000000-0000-4000-8000-000000000001", "Cookies", 999);
  write("unrelated", "file", 999);
  return root;
}

function session(): BrowserProfileSessionPort & {
  readonly clearStorageData: ReturnType<typeof vi.fn>;
  readonly clearCache: ReturnType<typeof vi.fn>;
} {
  return {
    clearStorageData: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    flushStorageData: vi.fn(),
  };
}

describe("browser profile store", () => {
  it("lists only Octant's profile stores, each with the space it occupies and never its contents", async () => {
    const store = createBrowserProfileStore({
      partitionsDirectory: partitions(),
      sessionFor: () => session(),
      closeProfilePages: async () => undefined,
    });

    const listed = await store.list();

    expect(listed).toEqual(
      expect.arrayContaining([
        { profile: { kind: "personal" }, sizeBytes: 150 },
        { profile: { kind: "project", projectId }, sizeBytes: 10 },
      ]),
    );
    expect(listed).toHaveLength(2);
  });

  it("lists nothing when no profile was ever used", async () => {
    const store = createBrowserProfileStore({
      partitionsDirectory: join(tmpdir(), "octant-profile-store-does-not-exist"),
      sessionFor: () => session(),
      closeProfilePages: async () => undefined,
    });

    expect(await store.list()).toEqual([]);
  });

  it("closes the profile's pages before it clears everything in that profile's own session", async () => {
    const order: string[] = [];
    const personal = session();
    personal.clearStorageData.mockImplementation(async () => void order.push("storage"));
    personal.clearCache.mockImplementation(async () => void order.push("cache"));
    const sessionFor = vi.fn(() => personal);
    const store = createBrowserProfileStore({
      partitionsDirectory: partitions(),
      sessionFor,
      closeProfilePages: async () => void order.push("pages"),
    });

    await store.clear({ kind: "personal" }, "all");

    expect(sessionFor).toHaveBeenCalledWith("persist:octant-profile-personal");
    expect(order).toEqual(["pages", "storage", "cache"]);
    expect(personal.clearStorageData).toHaveBeenCalledWith(undefined);
  });

  it("clears only the cookies when asked, in the Project's own session", async () => {
    const target = session();
    const sessionFor = vi.fn(() => target);
    const store = createBrowserProfileStore({
      partitionsDirectory: partitions(),
      sessionFor,
      closeProfilePages: async () => undefined,
    });

    await store.clear({ kind: "project", projectId: projectId as never }, "cookies");

    expect(sessionFor).toHaveBeenCalledWith(`persist:octant-profile-project-${projectId}`);
    expect(target.clearStorageData).toHaveBeenCalledWith({ storages: ["cookies"] });
    expect(target.clearCache).not.toHaveBeenCalled();
  });
});
