import { describe, expect, it } from "vitest";
import type { CodeCheckoutId, CodeThreadId } from "@octant/contracts";
import type { CodeDirectoryPort, CodeDirectoryStat, CodeTestSourcePort } from "./codeDirectoryPort";
import { CodeSearchService } from "./codeSearchService";

const threadId = "11111111-1111-4111-8111-111111111111" as CodeThreadId;
const checkoutId = "22222222-2222-4222-8222-222222222222" as CodeCheckoutId;
const rootPath = "/repo";

type FakeNode =
  | { readonly kind: "dir"; readonly children: ReadonlyArray<string> }
  | { readonly kind: "file"; readonly text: string }
  | { readonly kind: "binary"; readonly bytes: Uint8Array }
  | { readonly kind: "symlink"; readonly target: string };

/**
 * In-memory checkout so confinement, symlink escape, binary refusal and the
 * search budgets all run the real service without touching the host.
 */
function fakePort(nodes: Record<string, FakeNode>): CodeDirectoryPort & CodeTestSourcePort {
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
  const bytesOf = (node: FakeNode): Uint8Array =>
    node.kind === "binary"
      ? node.bytes
      : new TextEncoder().encode(node.kind === "file" ? node.text : "");
  const statAt = (canonical: string): CodeDirectoryStat => {
    const node = nodes[canonical];
    if (node === undefined) throw new Error(`ENOENT ${canonical}`);
    return {
      isDirectory: node.kind === "dir",
      isFile: node.kind === "file" || node.kind === "binary",
      isSymbolicLink: node.kind === "symlink",
      size: node.kind === "dir" || node.kind === "symlink" ? 0 : bytesOf(node).byteLength,
      device: "1",
      inode: canonical,
    };
  };
  return {
    realpath: async (path) => resolve(path, true),
    lstat: async (path) => statAt(resolve(path, false)),
    stat: async (path) => statAt(resolve(path, true)),
    readlink: async (path) => {
      const node = nodes[resolve(path, false)];
      if (node?.kind !== "symlink") throw new Error(`EINVAL ${path}`);
      return node.target;
    },
    openDirectory: async (path) => {
      const canonical = resolve(path, false);
      const node = nodes[canonical];
      if (node === undefined) throw new Error(`ENOENT ${path}`);
      if (node.kind === "symlink") throw new Error(`ELOOP ${path}`);
      if (node.kind !== "dir") throw new Error(`ENOTDIR ${path}`);
      let offset = 0;
      return {
        stat: async () => statAt(canonical),
        read: async (maximumEntries) => {
          const batch = node.children.slice(offset, offset + Math.max(0, maximumEntries));
          offset += batch.length;
          return batch.map((name) => ({ name }));
        },
        close: async () => undefined,
      };
    },
    openFile: async (path) => {
      const canonical = resolve(path, false);
      const node = nodes[canonical];
      if (node === undefined) throw new Error(`ENOENT ${path}`);
      if (node.kind === "symlink") throw new Error(`ELOOP ${path}`);
      if (node.kind === "dir") throw new Error(`EISDIR ${path}`);
      const bytes = bytesOf(node);
      return {
        stat: async () => ({
          isFile: true,
          size: bytes.byteLength,
          device: "1",
          inode: canonical,
        }),
        read: async (maximumBytes) => bytes.subarray(0, Math.max(0, maximumBytes)),
        close: async () => undefined,
      };
    },
  };
}

function service(port: CodeDirectoryPort & CodeTestSourcePort, overrides = {}) {
  return new CodeSearchService({
    directoryPort: port,
    sourcePort: port,
    clock: () => "2026-08-14T08:00:00.000Z",
    ...overrides,
  });
}

const smallRepository = {
  "/repo": { kind: "dir", children: ["src", "README.md"] },
  "/repo/src": { kind: "dir", children: ["main.ts", "helper.ts"] },
  "/repo/src/main.ts": { kind: "file", text: "export const answer = 42;\nconsole.log(answer);\n" },
  "/repo/src/helper.ts": { kind: "file", text: "export function helper() {}\n" },
  "/repo/README.md": { kind: "file", text: "# Answer\n" },
} satisfies Record<string, FakeNode>;

describe("CodeSearchService", () => {
  it("finds files whose relative path matches, case-insensitively", async () => {
    const result = await service(fakePort(smallRepository)).search({
      threadId,
      checkoutId,
      rootPath,
      scope: "path",
      query: "MAIN",
    });

    expect(result.status).toBe("searched");
    if (result.status !== "searched") return;
    expect(result.search.matches).toEqual([
      expect.objectContaining({ scope: "path", path: "src/main.ts" }),
    ]);
    expect(result.search.truncated).toBe(false);
  });

  it("reports where in a file the text was found, with the line as context", async () => {
    const result = await service(fakePort(smallRepository)).search({
      threadId,
      checkoutId,
      rootPath,
      scope: "content",
      query: "answer",
    });

    expect(result.status).toBe("searched");
    if (result.status !== "searched") return;
    expect(result.search.matches).toEqual([
      expect.objectContaining({
        scope: "content",
        path: "README.md",
        line: 1,
        column: 3,
        preview: "# Answer",
      }),
      expect.objectContaining({
        scope: "content",
        path: "src/main.ts",
        line: 1,
        column: 14,
        preview: "export const answer = 42;",
      }),
      expect.objectContaining({ scope: "content", path: "src/main.ts", line: 2 }),
    ]);
  });

  it("never searches a path that escapes the checkout through a symlink", async () => {
    const result = await service(
      fakePort({
        "/repo": { kind: "dir", children: ["escape", "inside.ts"] },
        "/repo/escape": { kind: "symlink", target: "/secrets" },
        "/repo/inside.ts": { kind: "file", text: "token\n" },
        "/secrets": { kind: "dir", children: ["token.env"] },
        "/secrets/token.env": { kind: "file", text: "token\n" },
      }),
    ).search({ threadId, checkoutId, rootPath, scope: "content", query: "token" });

    expect(result.status).toBe("searched");
    if (result.status !== "searched") return;
    expect(result.search.matches.map((match) => String(match.path))).toEqual(["inside.ts"]);
  });

  it("never descends into the directories the explorer also refuses", async () => {
    const result = await service(
      fakePort({
        "/repo": { kind: "dir", children: [".git", "node_modules", "app.ts"] },
        "/repo/.git": { kind: "dir", children: ["config"] },
        "/repo/.git/config": { kind: "file", text: "needle\n" },
        "/repo/node_modules": { kind: "dir", children: ["dep.js"] },
        "/repo/node_modules/dep.js": { kind: "file", text: "needle\n" },
        "/repo/app.ts": { kind: "file", text: "needle\n" },
      }),
    ).search({ threadId, checkoutId, rootPath, scope: "content", query: "needle" });

    expect(result.status).toBe("searched");
    if (result.status !== "searched") return;
    expect(result.search.matches.map((match) => String(match.path))).toEqual(["app.ts"]);
  });

  it("skips a file that is not valid UTF-8 rather than reporting byte offsets", async () => {
    const result = await service(
      fakePort({
        "/repo": { kind: "dir", children: ["image.bin", "note.txt"] },
        "/repo/image.bin": { kind: "binary", bytes: new Uint8Array([0xff, 0xfe, 0x00, 0x41]) },
        "/repo/note.txt": { kind: "file", text: "A\n" },
      }),
    ).search({ threadId, checkoutId, rootPath, scope: "content", query: "A" });

    expect(result.status).toBe("searched");
    if (result.status !== "searched") return;
    expect(result.search.matches.map((match) => String(match.path))).toEqual(["note.txt"]);
  });

  it("says the search is truncated rather than presenting a bounded walk as everything", async () => {
    const result = await service(fakePort(smallRepository), { maxMatches: 1 }).search({
      threadId,
      checkoutId,
      rootPath,
      scope: "content",
      query: "answer",
    });

    expect(result.status).toBe("searched");
    if (result.status !== "searched") return;
    expect(result.search.matches).toHaveLength(1);
    expect(result.search.truncated).toBe(true);
  });

  it("says the search is truncated when a file is too large to read", async () => {
    const result = await service(fakePort(smallRepository), { maxFileBytes: 4 }).search({
      threadId,
      checkoutId,
      rootPath,
      scope: "content",
      query: "answer",
    });

    expect(result.status).toBe("searched");
    if (result.status !== "searched") return;
    expect(result.search.truncated).toBe(true);
  });

  it("refuses an empty query instead of walking the whole repository", async () => {
    const result = await service(fakePort(smallRepository)).search({
      threadId,
      checkoutId,
      rootPath,
      scope: "path",
      query: "   ",
    });

    expect(result).toEqual({
      status: "failed",
      failure: { category: "invalid", message: "Code search query is invalid." },
    });
  });

  it("refuses a checkout root that is not an absolute path", async () => {
    const result = await service(fakePort(smallRepository)).search({
      threadId,
      checkoutId,
      rootPath: "repo",
      scope: "path",
      query: "main",
    });

    expect(result).toMatchObject({ status: "failed", failure: { category: "invalid" } });
  });
});
