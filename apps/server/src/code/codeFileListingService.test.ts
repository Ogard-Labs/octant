import { describe, expect, it } from "vitest";
import type { CodeCheckoutId, CodeRelativePath, CodeThreadId } from "@octant/contracts";
import type { CodeDirectoryPort, CodeDirectoryStat } from "./codeDirectoryPort";
import { CodeFileListingService } from "./codeFileListingService";
import { MAX_EDITABLE_CODE_FILE_BYTES } from "./codeFileService";

const threadId = "11111111-1111-4111-8111-111111111111" as CodeThreadId;
const checkoutId = "22222222-2222-4222-8222-222222222222" as CodeCheckoutId;
const rootPath = "/repo";

type FakeNode =
  | { readonly kind: "dir"; readonly children: ReadonlyArray<string>; readonly inode?: string }
  | { readonly kind: "file"; readonly size: number }
  | { readonly kind: "symlink"; readonly target: string }
  | { readonly kind: "socket" };

interface FakeHooks {
  /**
   * Runs when a directory is opened for enumeration, so a test can race the
   * host exactly as another checkout process would: between the moment
   * containment resolved a directory and the moment it is enumerated.
   */
  readonly onOpenDirectory?: (path: string) => void;
}

interface FakePort extends CodeDirectoryPort {
  /** Canonical directories whose entries were actually handed out. */
  readonly enumerated: ReadonlyArray<string>;
  /** Every entry name this port materialized for the listing. */
  readonly handedOut: ReadonlyArray<string>;
}

/**
 * In-memory filesystem so confinement, symlink escape, and budget paths run the
 * real listing logic without touching the host.
 *
 * Every component of a path is resolved, not just its last one, so a symlinked
 * ancestor redirects its children the way a real filesystem does — which is the
 * only way a swapped directory can be modelled honestly.
 */
function fakePort(nodes: Record<string, FakeNode>, hooks?: FakeHooks): FakePort {
  const enumerated: string[] = [];
  const handedOut: string[] = [];
  const resolve = (path: string, followFinal: boolean, depth = 0): string => {
    if (depth > 16) throw new Error(`ELOOP ${path}`);
    const segments = path.split("/").filter((segment) => segment.length > 0);
    let current = "";
    for (const [index, segment] of segments.entries()) {
      const candidate = `${current}/${segment}`;
      const node = nodes[candidate];
      if (node === undefined) throw new Error(`ENOENT ${path}`);
      if (node.kind === "symlink" && (followFinal || index < segments.length - 1)) {
        const target = node.target.startsWith("/") ? node.target : `${current}/${node.target}`;
        current = resolve(target, true, depth + 1);
        continue;
      }
      current = candidate;
    }
    return current === "" ? "/" : current;
  };
  const statAt = (canonical: string): CodeDirectoryStat => {
    const node = nodes[canonical];
    if (node === undefined) throw new Error(`ENOENT ${canonical}`);
    return {
      isDirectory: node.kind === "dir",
      isFile: node.kind === "file",
      isSymbolicLink: node.kind === "symlink",
      size: node.kind === "file" ? node.size : 0,
      device: "1",
      inode: (node.kind === "dir" ? node.inode : undefined) ?? canonical,
    };
  };
  return {
    enumerated,
    handedOut,
    realpath: async (path) => resolve(path, true),
    lstat: async (path) => statAt(resolve(path, false)),
    stat: async (path) => statAt(resolve(path, true)),
    readlink: async (path) => {
      const node = nodes[resolve(path, false)];
      if (node?.kind !== "symlink") throw new Error(`EINVAL ${path}`);
      return node.target;
    },
    openDirectory: async (path) => {
      hooks?.onOpenDirectory?.(path);
      // O_NOFOLLOW: the final component is never followed, so a name swapped
      // for a symlink is an error rather than a redirect.
      const canonical = resolve(path, false);
      const node = nodes[canonical];
      if (node === undefined) throw new Error(`ENOENT ${path}`);
      if (node.kind === "symlink") throw new Error(`ELOOP ${path}`);
      if (node.kind !== "dir") throw new Error(`ENOTDIR ${path}`);
      let offset = 0;
      return {
        stat: async () => statAt(canonical),
        read: async (maximumEntries) => {
          if (offset === 0) enumerated.push(canonical);
          const batch = node.children.slice(offset, offset + Math.max(0, maximumEntries));
          offset += batch.length;
          handedOut.push(...batch);
          return batch.map((name) => ({ name }));
        },
        close: async () => undefined,
      };
    },
  };
}

function service(port: CodeDirectoryPort, overrides = {}) {
  return new CodeFileListingService({
    directoryPort: port,
    clock: () => "2026-08-14T08:00:00.000Z",
    ...overrides,
  });
}

describe("CodeFileListingService", () => {
  it("lists files and directories relative to the checkout root", async () => {
    const result = await service(
      fakePort({
        "/repo": { kind: "dir", children: ["src", "README.md"] },
        "/repo/src": { kind: "dir", children: ["main.ts"] },
        "/repo/src/main.ts": { kind: "file", size: 120 },
        "/repo/README.md": { kind: "file", size: 40 },
      }),
    ).list({ threadId, checkoutId, rootPath });

    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    expect(result.listing.entries.map((entry) => entry.path)).toEqual([
      "README.md",
      "src",
      "src/main.ts",
    ]);
    expect(result.listing.truncated).toBe(false);
    expect(JSON.stringify(result.listing)).not.toContain("/repo");
  });

  it("skips a symlink whose target escapes the checkout root", async () => {
    const result = await service(
      fakePort({
        "/repo": { kind: "dir", children: ["escape", "inside"] },
        "/repo/escape": { kind: "symlink", target: "/etc/passwd" },
        "/etc/passwd": { kind: "file", size: 10 },
        "/repo/inside": { kind: "file", size: 10 },
      }),
    ).list({ threadId, checkoutId, rootPath });

    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    expect(result.listing.entries.map((entry) => entry.path)).toEqual(["inside"]);
  });

  it("follows a symlink that stays inside the root", async () => {
    const result = await service(
      fakePort({
        "/repo": { kind: "dir", children: ["link", "real.ts"] },
        "/repo/link": { kind: "symlink", target: "/repo/real.ts" },
        "/repo/real.ts": { kind: "file", size: 8 },
      }),
    ).list({ threadId, checkoutId, rootPath });

    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    expect(result.listing.entries.map((entry) => entry.path)).toEqual(["link", "real.ts"]);
  });

  it("enumerates a canonical directory once when a symlink points back into the walk", async () => {
    const result = await service(
      fakePort({
        "/repo": { kind: "dir", children: ["loop", "src"] },
        // A directory symlink to the checkout root: its canonical target is a
        // directory the walk is already inside.
        "/repo/loop": { kind: "symlink", target: "/repo" },
        "/repo/src": { kind: "dir", children: ["main.ts"] },
        "/repo/src/main.ts": { kind: "file", size: 4 },
      }),
    ).list({ threadId, checkoutId, rootPath });

    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    expect(result.listing.entries.map((entry) => entry.path)).toEqual([
      "loop",
      "src",
      "src/main.ts",
    ]);
    expect(result.listing.truncated).toBe(false);
  });

  it("marks an oversized file read-only and omits non-regular entries", async () => {
    const result = await service(
      fakePort({
        "/repo": { kind: "dir", children: ["big.bin", "app.sock", "small.ts"] },
        "/repo/big.bin": { kind: "file", size: MAX_EDITABLE_CODE_FILE_BYTES + 1 },
        "/repo/app.sock": { kind: "socket" },
        "/repo/small.ts": { kind: "file", size: 2 },
      }),
    ).list({ threadId, checkoutId, rootPath });

    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    const availability = result.listing.entries.map((entry) =>
      entry.kind === "file" ? entry.availability : undefined,
    );
    expect(result.listing.entries.map((entry) => entry.path)).toEqual(["big.bin", "small.ts"]);
    expect(availability[0]).toEqual({ status: "read-only", reason: "oversized" });
    expect(availability[1]).toEqual({ status: "available" });
  });

  it("never descends into .git or node_modules", async () => {
    const result = await service(
      fakePort({
        "/repo": { kind: "dir", children: [".git", "node_modules", "src"] },
        "/repo/.git": { kind: "dir", children: ["HEAD"] },
        "/repo/.git/HEAD": { kind: "file", size: 4 },
        "/repo/node_modules": { kind: "dir", children: ["left-pad"] },
        "/repo/node_modules/left-pad": { kind: "file", size: 4 },
        "/repo/src": { kind: "dir", children: [] },
      }),
    ).list({ threadId, checkoutId, rootPath });

    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    expect(result.listing.entries.map((entry) => entry.path)).toEqual(["src"]);
  });

  it("reports truncation once the entry budget is spent", async () => {
    const names = ["a.ts", "b.ts", "c.ts"];
    const nodes: Record<string, FakeNode> = { "/repo": { kind: "dir", children: names } };
    for (const name of names) nodes[`/repo/${name}`] = { kind: "file", size: 1 };

    const result = await service(fakePort(nodes), { maxEntries: 2 }).list({
      threadId,
      checkoutId,
      rootPath,
    });

    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    expect(result.listing.entries).toHaveLength(2);
    expect(result.listing.truncated).toBe(true);
  });

  it("refuses a directory swapped for an escaping symlink before enumeration", async () => {
    const nodes: Record<string, FakeNode> = {
      "/repo": { kind: "dir", children: ["README.md", "src"] },
      "/repo/README.md": { kind: "file", size: 4 },
      "/repo/src": { kind: "dir", children: ["main.ts"] },
      "/repo/src/main.ts": { kind: "file", size: 3 },
      "/host": { kind: "dir", children: ["passwd", "shadowcopy"] },
      "/host/passwd": { kind: "file", size: 9 },
      // A host entry linking back into the checkout, so an escaped enumeration
      // is observable in the listing and not only in the calls it made.
      "/host/shadowcopy": { kind: "symlink", target: "/repo/README.md" },
    };
    const port = fakePort(nodes, {
      onOpenDirectory: (path) => {
        // Another checkout process replaces the directory containment already
        // resolved, in the window before its entries are read.
        if (path === "/repo/src") nodes["/repo/src"] = { kind: "symlink", target: "/host" };
      },
    });

    const result = await service(port).list({ threadId, checkoutId, rootPath });

    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    // The directory itself was proved contained before the swap, so it is still
    // listed; what must not happen is enumerating whatever replaced it.
    expect(result.listing.entries.map((entry) => entry.path)).toEqual(["README.md", "src"]);
    expect(port.enumerated).not.toContain("/host");
  });

  it("refuses a directory whose identity changed after containment resolved it", async () => {
    const nodes: Record<string, FakeNode> = {
      "/repo": { kind: "dir", children: ["src"] },
      "/repo/src": { kind: "dir", children: ["main.ts"] },
      "/repo/src/main.ts": { kind: "file", size: 3 },
    };
    const port = fakePort(nodes, {
      onOpenDirectory: (path) => {
        if (path !== "/repo/src") return;
        // The same name, a different object: the ancestor swap a no-follow open
        // cannot see on its own, and that only identity equality catches.
        nodes["/repo/src"] = { kind: "dir", children: ["stolen.ts"], inode: "elsewhere" };
        nodes["/repo/src/stolen.ts"] = { kind: "file", size: 1 };
      },
    });

    const result = await service(port).list({ threadId, checkoutId, rootPath });

    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    expect(result.listing.entries.map((entry) => entry.path)).toEqual(["src"]);
    expect(port.handedOut).not.toContain("stolen.ts");
  });

  it("never materializes a directory larger than the entry budget", async () => {
    const names = Array.from({ length: 5_000 }, (_, index) => `f${String(index).padStart(5, "0")}`);
    const nodes: Record<string, FakeNode> = { "/repo": { kind: "dir", children: names } };
    for (const name of names) nodes[`/repo/${name}`] = { kind: "file", size: 1 };
    const port = fakePort(nodes);

    const result = await service(port, { maxEntries: 5 }).list({ threadId, checkoutId, rootPath });

    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    expect(result.listing.entries).toHaveLength(5);
    expect(result.listing.truncated).toBe(true);
    // The budget applies while reading, so the listing holds one name past it
    // — enough to know it is incomplete — and never the whole directory.
    expect(port.handedOut).toHaveLength(6);
  });

  it("lists a subdirectory and rejects one that is not inside the checkout", async () => {
    const port = fakePort({
      "/repo": { kind: "dir", children: ["src"] },
      "/repo/src": { kind: "dir", children: ["main.ts"] },
      "/repo/src/main.ts": { kind: "file", size: 3 },
    });
    const listed = await service(port).list({
      threadId,
      checkoutId,
      rootPath,
      directory: "src" as CodeRelativePath,
    });
    expect(listed.status).toBe("listed");
    if (listed.status === "listed") {
      expect(listed.listing.entries.map((entry) => entry.path)).toEqual(["src/main.ts"]);
      expect(listed.listing.directory).toBe("src");
    }

    const missing = await service(port).list({
      threadId,
      checkoutId,
      rootPath,
      directory: "elsewhere" as CodeRelativePath,
    });
    expect(missing).toEqual({
      status: "failed",
      failure: {
        category: "not-found",
        message: "Code directory is unavailable inside this checkout.",
      },
    });
  });

  it("fails closed for a relative or missing checkout root", async () => {
    const port = fakePort({ "/repo": { kind: "dir", children: [] } });
    expect(await service(port).list({ threadId, checkoutId, rootPath: "repo" })).toMatchObject({
      status: "failed",
      failure: { category: "invalid" },
    });
    expect(await service(port).list({ threadId, checkoutId, rootPath: "/gone" })).toMatchObject({
      status: "failed",
      failure: { category: "unavailable" },
    });
  });

  it("refuses a filesystem-root checkout because it would confine nothing", async () => {
    const result = await service(fakePort({ "/": { kind: "dir", children: [] } })).list({
      threadId,
      checkoutId,
      rootPath: "/",
    });
    expect(result).toMatchObject({ status: "failed", failure: { category: "invalid" } });
  });

  it("stops walking when the request is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await service(
      fakePort({
        "/repo": { kind: "dir", children: ["a.ts"] },
        "/repo/a.ts": { kind: "file", size: 1 },
      }),
    ).list({ threadId, checkoutId, rootPath, signal: controller.signal });

    expect(result.status).toBe("listed");
    if (result.status !== "listed") return;
    expect(result.listing.entries).toHaveLength(0);
    expect(result.listing.truncated).toBe(true);
  });
});
