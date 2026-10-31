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

  describe("importing cookies", () => {
    const cookie = (overrides: Record<string, unknown> = {}) =>
      ({
        domain: ".example.com",
        hostOnly: false,
        name: "sid",
        value: "v",
        path: "/app",
        secure: true,
        httpOnly: true,
        expiresAt: 1_800_000_000,
        sameSite: "lax",
        ...overrides,
      }) as never;

    function withCookies(setCookie: NonNullable<BrowserProfileSessionPort["cookies"]>["set"]) {
      const target: BrowserProfileSessionPort = { ...session(), cookies: { set: setCookie } };
      const sessionFor = vi.fn(() => target);
      const store = createBrowserProfileStore({
        partitionsDirectory: partitions(),
        sessionFor,
        closeProfilePages: async () => undefined,
      });
      return { store, sessionFor, target };
    }

    it("sets each cookie in the profile's own session, shaped the way the session expects", async () => {
      const set = vi.fn(async () => undefined);
      const { store, sessionFor } = withCookies(set);

      const result = await store.importCookies({ kind: "personal" }, [
        cookie(),
        cookie({
          domain: "app.example.com",
          hostOnly: true,
          name: "host",
          expiresAt: undefined,
          secure: false,
        }),
      ]);

      expect(result).toEqual({ imported: 2, skipped: 0 });
      expect(sessionFor).toHaveBeenCalledWith("persist:octant-profile-personal");
      expect(set).toHaveBeenNthCalledWith(1, {
        url: "https://example.com/app",
        name: "sid",
        value: "v",
        domain: ".example.com",
        path: "/app",
        secure: true,
        httpOnly: true,
        expirationDate: 1_800_000_000,
        sameSite: "lax",
      });
      // A host-only cookie names no domain, and a session cookie no expiry.
      expect(set).toHaveBeenNthCalledWith(2, {
        url: "http://app.example.com/app",
        name: "host",
        value: "v",
        path: "/app",
        secure: false,
        httpOnly: true,
        sameSite: "lax",
      });
    });

    it("counts a cookie the session refuses as skipped without naming it", async () => {
      const set = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("bad cookie SENTINEL-cookie-value-7f3a9c"))
        .mockResolvedValueOnce(undefined);
      const { store } = withCookies(set);

      const result = await store.importCookies({ kind: "personal" }, [
        cookie(),
        cookie(),
        cookie(),
      ]);

      expect(result).toEqual({ imported: 2, skipped: 1 });
    });

    it("keeps a project's cookies out of the personal session", async () => {
      const set = vi.fn(async () => undefined);
      const { store, sessionFor } = withCookies(set);

      await store.importCookies({ kind: "project", projectId: projectId as never }, [cookie()]);

      expect(sessionFor).toHaveBeenCalledWith(`persist:octant-profile-project-${projectId}`);
      expect(sessionFor).not.toHaveBeenCalledWith("persist:octant-profile-personal");
    });
  });
});
