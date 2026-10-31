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

describe("browser profile store extensions", () => {
  function extensionHost() {
    let counter = 0;
    return {
      loadExtension: vi.fn(
        async (_path: string, _options?: { readonly allowFileAccess?: boolean }) => ({
          id: `electron-${String((counter += 1))}`,
        }),
      ),
      removeExtension: vi.fn(),
    };
  }
  const storeWith = (extensions: ReturnType<typeof extensionHost> | undefined) => {
    const sessions = new Map<string, BrowserProfileSessionPort>();
    return createBrowserProfileStore({
      partitionsDirectory: partitions(),
      sessionFor: (partition) => {
        const existing = sessions.get(partition);
        if (existing !== undefined) return existing;
        const created = { ...session(), ...(extensions === undefined ? {} : { extensions }) };
        sessions.set(partition, created);
        return created;
      },
      closeProfilePages: async () => undefined,
    });
  };
  const folder = (manifest: Record<string, unknown>) => {
    const root = mkdtempSync(join(tmpdir(), "octant-extension-"));
    roots.push(root);
    writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
    return root;
  };

  it("loads what is enabled once, reloads nothing unchanged, and unloads what is no longer wanted", async () => {
    const host = extensionHost();
    const profiles = storeWith(host);
    const personal = { kind: "personal" } as const;
    const path = folder({ action: { default_popup: "popup.html" } });
    const wanted = [{ id: "a".repeat(32), path, contentHash: "1".repeat(64) }];

    await profiles.syncExtensions(personal, wanted);
    await profiles.syncExtensions(personal, wanted);
    expect(host.loadExtension).toHaveBeenCalledTimes(1);
    expect(host.loadExtension).toHaveBeenCalledWith(path, { allowFileAccess: false });
    expect(profiles.extensionPage(personal, "a".repeat(32), "popup")).toBe(
      "chrome-extension://electron-1/popup.html",
    );

    await profiles.syncExtensions(personal, []);
    expect(host.removeExtension).toHaveBeenCalledWith("electron-1");
    expect(profiles.extensionPage(personal, "a".repeat(32), "popup")).toBeUndefined();
  });

  it("replaces an extension whose content changed and keeps profiles apart", async () => {
    const host = extensionHost();
    const profiles = storeWith(host);
    const path = folder({ action: { default_popup: "popup.html" } });
    const id = "b".repeat(32);

    await profiles.syncExtensions({ kind: "personal" }, [
      { id, path, contentHash: "1".repeat(64) },
    ]);
    await profiles.syncExtensions({ kind: "personal" }, [
      { id, path, contentHash: "2".repeat(64) },
    ]);

    expect(host.removeExtension).toHaveBeenCalledWith("electron-1");
    expect(host.loadExtension).toHaveBeenCalledTimes(2);
    expect(
      profiles.extensionPage({ kind: "project", projectId: projectId as never }, id, "popup"),
    ).toBeUndefined();
  });

  it("keeps loading the rest when one extension will not load, and does nothing without an extension host", async () => {
    const host = extensionHost();
    host.loadExtension.mockRejectedValueOnce(new Error("bad manifest"));
    const profiles = storeWith(host);
    const path = folder({});

    await profiles.syncExtensions({ kind: "personal" }, [
      { id: "c".repeat(32), path, contentHash: "1".repeat(64) },
      { id: "d".repeat(32), path, contentHash: "1".repeat(64) },
    ]);

    expect(profiles.extensionPage({ kind: "personal" }, "c".repeat(32), "popup")).toBeUndefined();
    expect(host.loadExtension).toHaveBeenCalledTimes(2);
    await expect(
      storeWith(undefined).syncExtensions({ kind: "personal" }, [
        { id: "e".repeat(32), path, contentHash: "1" },
      ]),
    ).resolves.toBeUndefined();
  });

  it("applies a disable that arrives while an earlier load is still pending", async () => {
    const host = extensionHost();
    let finish: (() => void) | undefined;
    host.loadExtension.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ id: "electron-slow" });
        }),
    );
    const profiles = storeWith(host);
    const personal = { kind: "personal" } as const;
    const path = folder({ action: { default_popup: "popup.html" } });
    const id = "9".repeat(32);

    const loading = profiles.syncExtensions(personal, [{ id, path, contentHash: "1".repeat(64) }]);
    const disabling = profiles.syncExtensions(personal, []);
    await vi.waitFor(() => expect(finish).toBeDefined());
    finish?.();
    await Promise.all([loading, disabling]);

    expect(host.removeExtension).toHaveBeenCalledWith("electron-slow");
    expect(profiles.extensionPage(personal, id, "popup")).toBeUndefined();
  });

  it("refuses a page path that leaves the extension's folder", async () => {
    const host = extensionHost();
    const profiles = storeWith(host);
    const path = folder({ action: { default_popup: "../escape.html" }, options_page: "/abs.html" });
    const id = "f".repeat(32);

    await profiles.syncExtensions({ kind: "personal" }, [
      { id, path, contentHash: "1".repeat(64) },
    ]);

    expect(profiles.extensionPage({ kind: "personal" }, id, "popup")).toBeUndefined();
    expect(profiles.extensionPage({ kind: "personal" }, id, "options")).toBeUndefined();
  });
});
