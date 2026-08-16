import { describe, expect, it } from "vitest";
import type { CodeDirectoryStat, CodeTestSourcePort } from "./codeDirectoryPort";
import {
  MAX_TEST_SOURCE_BYTES,
  RepositoryTestDiscoveryService,
  codeRepositoryTestDefinitionsMatch,
} from "./repositoryTestDiscoveryService";

const checkoutId = "22222222-2222-4222-8222-222222222222";
const rootPath = "/repo";

type FakeNode =
  | { readonly kind: "dir" }
  | { readonly kind: "file"; readonly text: string }
  | { readonly kind: "symlink"; readonly target: string };

/**
 * A swap performed once, the moment the confinement sequence stats the named
 * path: exactly the window between "this is a contained regular file" and the
 * read that follows.
 */
interface FakeSwap {
  readonly whenStatting: string;
  readonly replaceWith: FakeNode;
}

/**
 * In-memory filesystem so the confinement sequence runs for real — including a
 * symlinked parent directory, which only `realpath` can catch — without
 * touching the host.
 *
 * `openFile` models a real handle: it refuses a symlinked final component the
 * way `O_NOFOLLOW` does, and it captures the object it opened, so a later swap
 * of that name cannot change what the handle reports or reads.
 */
function fakePort(
  initialNodes: Readonly<Record<string, FakeNode>>,
  swap?: FakeSwap,
): CodeTestSourcePort {
  const nodes: Record<string, FakeNode> = { ...initialNodes };
  const inodes = new Map<FakeNode, string>();
  let pendingSwap = swap;
  const nodeAt = (path: string): FakeNode => {
    const node = nodes[path];
    if (node === undefined) throw new Error(`ENOENT ${path}`);
    return node;
  };
  const resolve = (path: string): string => {
    let current = "";
    for (const segment of path.split("/").filter((value) => value !== "")) {
      current = `${current}/${segment}`;
      const node = nodeAt(current);
      if (node.kind === "symlink") current = resolve(node.target);
    }
    return current;
  };
  const parentOf = (path: string) => {
    const index = path.lastIndexOf("/");
    return { directory: index <= 0 ? "/" : path.slice(0, index), name: path.slice(index + 1) };
  };
  const linkNodeAt = (path: string): FakeNode => {
    const { directory, name } = parentOf(path);
    return nodeAt(`${resolve(directory)}/${name}`);
  };
  const inodeOf = (node: FakeNode): string => {
    const existing = inodes.get(node);
    if (existing !== undefined) return existing;
    const assigned = String(inodes.size + 1);
    inodes.set(node, assigned);
    return assigned;
  };
  const sizeOf = (node: FakeNode) =>
    node.kind === "file" ? Buffer.byteLength(node.text, "utf8") : 0;
  const toStat = (node: FakeNode): CodeDirectoryStat => ({
    isDirectory: node.kind === "dir",
    isFile: node.kind === "file",
    isSymbolicLink: node.kind === "symlink",
    size: sizeOf(node),
    device: "1",
    inode: inodeOf(node),
  });
  return {
    realpath: async (path) => resolve(path),
    stat: async (path) => {
      const resolved = resolve(path);
      const observed = toStat(nodeAt(resolved));
      if (pendingSwap?.whenStatting === resolved) {
        nodes[resolved] = pendingSwap.replaceWith;
        pendingSwap = undefined;
      }
      return observed;
    },
    lstat: async (path) => toStat(linkNodeAt(path)),
    readlink: async (path) => {
      const node = nodeAt(path);
      if (node.kind !== "symlink") throw new Error(`EINVAL ${path}`);
      return node.target;
    },
    openFile: async (path) => {
      const opened = linkNodeAt(path);
      if (opened.kind === "symlink") throw new Error(`ELOOP ${path}`);
      return {
        stat: async () => ({
          isFile: opened.kind === "file",
          size: sizeOf(opened),
          device: "1",
          inode: inodeOf(opened),
        }),
        read: async (maximumBytes) => {
          if (opened.kind !== "file") throw new Error(`EISDIR ${path}`);
          return new Uint8Array(Buffer.from(opened.text, "utf8").subarray(0, maximumBytes));
        },
        close: async () => {},
      };
    },
  };
}

function discover(nodes: Readonly<Record<string, FakeNode>>, id = checkoutId, swap?: FakeSwap) {
  return new RepositoryTestDiscoveryService({ sourcePort: fakePort(nodes, swap) }).discover({
    checkoutId: id,
    rootPath,
  });
}

const packageJson = (value: unknown) => ({ kind: "file" as const, text: JSON.stringify(value) });

const octantFile = packageJson({
  version: 1,
  tests: [
    {
      id: "integration",
      name: "Integration suite",
      argv: ["bun", "run", "test:integration"],
      cwd: "apps/server",
      environmentRefs: ["OCTANT_TEST_TOKEN"],
      timeoutMs: 120_000,
      artifactPaths: ["coverage/report.json"],
    },
  ],
});

describe("RepositoryTestDiscoveryService", () => {
  it("offers the checkout's test scripts and Octant-file definitions", async () => {
    const definitions = await discover({
      "/repo": { kind: "dir" },
      "/repo/package.json": packageJson({
        packageManager: "bun@1.2.0",
        scripts: { build: "tsc", dev: "vite", test: "vitest run", "test:e2e": "playwright test" },
      }),
      "/repo/.octant": { kind: "dir" },
      "/repo/.octant/tests.json": octantFile,
    });

    expect(
      definitions.map((definition) => ({
        name: definition.name,
        argv: definition.argv,
        cwd: definition.cwd,
        source: definition.source,
      })),
    ).toEqual([
      {
        name: "test",
        argv: ["bun", "run", "test"],
        cwd: ".",
        source: {
          kind: "package-script",
          packagePath: "package.json",
          packageManager: "bun",
          script: "test",
        },
      },
      {
        name: "test:e2e",
        argv: ["bun", "run", "test:e2e"],
        cwd: ".",
        source: {
          kind: "package-script",
          packagePath: "package.json",
          packageManager: "bun",
          script: "test:e2e",
        },
      },
      {
        name: "Integration suite",
        argv: ["bun", "run", "test:integration"],
        cwd: "apps/server",
        source: {
          kind: "octant-file",
          path: ".octant/tests.json",
          selectedId: "integration",
        },
      },
    ]);
  });

  it("keeps every definition id stable across a re-list and distinct per checkout", async () => {
    const nodes = {
      "/repo": { kind: "dir" as const },
      "/repo/package.json": packageJson({ scripts: { test: "vitest run" } }),
    };

    const first = await discover(nodes);
    const again = await discover(nodes);
    const otherCheckout = await discover(nodes, "33333333-3333-4333-8333-333333333333");

    expect(first[0]?.id).toBe(again[0]?.id);
    expect(first[0]?.id).not.toBe(otherCheckout[0]?.id);
    expect(codeRepositoryTestDefinitionsMatch(first[0]!, again[0]!)).toBe(true);
    expect(codeRepositoryTestDefinitionsMatch(first[0]!, otherCheckout[0]!)).toBe(false);
    // Package scripts declare no manager here, so the definition names the one
    // every Node checkout has rather than guessing.
    expect(first[0]?.argv).toEqual(["npm", "run", "test"]);
  });

  it("keeps the workspace usable when .octant/tests.json is invalid", async () => {
    const definitions = await discover({
      "/repo": { kind: "dir" },
      "/repo/package.json": packageJson({ scripts: { test: "vitest run" } }),
      "/repo/.octant": { kind: "dir" },
      "/repo/.octant/tests.json": { kind: "file", text: "{ not json" },
    });

    expect(definitions.map((definition) => definition.name)).toEqual(["test"]);
  });

  it("refuses to read a definition source that resolves outside the checkout", async () => {
    const definitions = await discover({
      "/repo": { kind: "dir" },
      "/repo/package.json": { kind: "symlink", target: "/outside/package.json" },
      "/repo/.octant": { kind: "symlink", target: "/outside/.octant" },
      "/outside": { kind: "dir" },
      "/outside/package.json": packageJson({ scripts: { test: "curl evil.example" } }),
      "/outside/.octant": { kind: "dir" },
      "/outside/.octant/tests.json": octantFile,
    });

    expect(definitions).toEqual([]);
  });

  it("reads a definition source that a contained symlink points at", async () => {
    const definitions = await discover({
      "/repo": { kind: "dir" },
      "/repo/package.json": { kind: "symlink", target: "/repo/tools/package.json" },
      "/repo/tools": { kind: "dir" },
      "/repo/tools/package.json": packageJson({ scripts: { test: "vitest run" } }),
    });

    expect(definitions.map((definition) => definition.name)).toEqual(["test"]);
  });

  it("refuses a definition source swapped for an escaping symlink after resolution", async () => {
    const definitions = await discover(
      {
        "/repo": { kind: "dir" },
        "/repo/package.json": packageJson({ scripts: { test: "vitest run" } }),
        "/outside": { kind: "dir" },
        "/outside/package.json": packageJson({ scripts: { "test:stolen": "curl evil.example" } }),
      },
      checkoutId,
      {
        whenStatting: "/repo/package.json",
        replaceWith: { kind: "symlink", target: "/outside/package.json" },
      },
    );

    // Reading by path again would follow the planted link and offer the host's
    // definitions; reading the handle confinement opened cannot.
    expect(definitions).toEqual([]);
  });

  it("refuses a definition source swapped for an oversized file after resolution", async () => {
    const oversized = JSON.stringify({
      scripts: { "test:oversized": "vitest run" },
      padding: "x".repeat(MAX_TEST_SOURCE_BYTES),
    });
    const definitions = await discover(
      {
        "/repo": { kind: "dir" },
        "/repo/package.json": packageJson({ scripts: { test: "vitest run" } }),
      },
      checkoutId,
      {
        whenStatting: "/repo/package.json",
        replaceWith: { kind: "file", text: oversized },
      },
    );

    // The ceiling belongs to the object actually opened, not to the small file
    // the size check happened to see.
    expect(definitions).toEqual([]);
  });

  it("refuses a definition source that grew after the handle measured it", async () => {
    const measured = fakePort({
      "/repo": { kind: "dir" },
      "/repo/package.json": packageJson({ scripts: { "test:grown": "vitest run" } }),
    });
    // The object gains bytes after the handle measured it, so the read returns
    // more than the length the ceiling was granted for. Only exactly what was
    // measured may be accepted; more is a source that changed under the check.
    const sourcePort: CodeTestSourcePort = {
      ...measured,
      openFile: async (path) => {
        const file = await measured.openFile(path);
        return {
          ...file,
          stat: async () => ({ ...(await file.stat()), size: 1 }),
          read: async () => await file.read(MAX_TEST_SOURCE_BYTES),
        };
      },
    };

    const definitions = await new RepositoryTestDiscoveryService({ sourcePort }).discover({
      checkoutId,
      rootPath,
    });

    expect(definitions).toEqual([]);
  });

  it("refuses a definition source replaced by a different file after resolution", async () => {
    const definitions = await discover(
      {
        "/repo": { kind: "dir" },
        "/repo/package.json": packageJson({ scripts: { test: "vitest run" } }),
      },
      checkoutId,
      {
        whenStatting: "/repo/package.json",
        replaceWith: packageJson({ scripts: { "test:substituted": "vitest run" } }),
      },
    );

    expect(definitions).toEqual([]);
  });

  it("offers nothing when the checkout root is unusable", async () => {
    const nodes = { "/repo": { kind: "file" as const, text: "not a directory" } };
    expect(await discover(nodes)).toEqual([]);
    expect(await discover({})).toEqual([]);
    expect(
      await new RepositoryTestDiscoveryService({
        sourcePort: fakePort({ "/": { kind: "dir" } }),
      }).discover({ checkoutId, rootPath: "/" }),
    ).toEqual([]);
  });
});
