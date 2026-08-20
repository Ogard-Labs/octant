import { describe, expect, it, vi } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import {
  FileMentionService,
  resolveMentionedFile,
  type FileMentionAuthority,
} from "./fileMentionService";
import type { FileMentionIo } from "./fileMentionIo";

const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
const threadId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const checkoutId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const rootPath = "/private/authorized-root";

function trackingIo(): FileMentionIo & {
  readonly locateCalls: unknown[];
  readonly readCalls: unknown[];
  readonly listCalls: unknown[];
} {
  const locateCalls: unknown[] = [];
  const readCalls: unknown[] = [];
  const listCalls: unknown[] = [];
  return {
    locateCalls,
    readCalls,
    listCalls,
    locate: vi.fn(async (root, relative) => {
      locateCalls.push({ root, relative });
      return { kind: "missing" as const };
    }),
    readBytes: vi.fn(async (canonical, expected, maximumBytes) => {
      readCalls.push({ canonical, expected, maximumBytes });
      return new Uint8Array();
    }),
    list: vi.fn(async (root) => {
      listCalls.push(root);
      return [];
    }),
  };
}

function authority(root = rootPath): FileMentionAuthority {
  return {
    resolveCodeRoot: vi.fn(async () => ({ kind: "ok" as const, rootPath: root })),
    resolveWorkRoot: vi.fn(async () => ({ kind: "ok" as const, rootPath: root })),
  };
}

describe("resolveMentionedFile", () => {
  it("refuses a path outside the bound root before any filesystem read", async () => {
    const io = trackingIo();

    const result = await resolveMentionedFile({
      relativePath: "../etc/passwd",
      rootPath,
      io,
    });

    expect(result).toEqual({
      kind: "unavailable",
      path: "../etc/passwd",
      reason: "out-of-root",
    });
    expect(io.locateCalls).toEqual([]);
    expect(io.readCalls).toEqual([]);
    expect(io.listCalls).toEqual([]);
    expect(io.locate).not.toHaveBeenCalled();
    expect(io.readBytes).not.toHaveBeenCalled();
  });

  it("refuses an absolute path before any filesystem read", async () => {
    const io = trackingIo();
    const result = await resolveMentionedFile({
      relativePath: "/etc/passwd",
      rootPath,
      io,
    });
    expect(result.kind).toBe("unavailable");
    if (result.kind !== "unavailable") return;
    expect(result.reason).toBe("out-of-root");
    expect(io.locate).not.toHaveBeenCalled();
    expect(io.readBytes).not.toHaveBeenCalled();
  });

  it("does not read bytes when locating the path escapes the root through a symlink", async () => {
    const io = trackingIo();
    io.locate = vi.fn(async () => ({ kind: "escapes-root" as const }));

    const result = await resolveMentionedFile({
      relativePath: "link-out",
      rootPath,
      io,
    });

    expect(result).toEqual({
      kind: "unavailable",
      path: "link-out",
      reason: "out-of-root",
    });
    expect(io.readBytes).not.toHaveBeenCalled();
  });
});

describe("FileMentionService", () => {
  it("refuses an out-of-root resolve without locating or reading the file", async () => {
    const io = trackingIo();
    const service = new FileMentionService({ authority: authority(), io });

    const result = await service.execute(
      {
        kind: "resolve-file-mentions",
        requestId,
        scope: { mode: "work", threadId },
        paths: ["../secret"],
      },
      { windowId },
    );

    expect(result).toMatchObject({
      kind: "file-mentions-resolved",
      mentions: [],
      unavailable: [{ path: "../secret", reason: "out-of-root" }],
    });
    expect(io.locate).not.toHaveBeenCalled();
    expect(io.readBytes).not.toHaveBeenCalled();
  });

  it("completes in-root paths from the confined listing", async () => {
    const io = trackingIo();
    io.list = vi.fn(async () => [
      { path: "src" as never, kind: "directory" as const },
      { path: "src/index.ts" as never, kind: "file" as const },
    ]);
    const service = new FileMentionService({ authority: authority(), io });

    const result = await service.execute(
      {
        kind: "complete-file-mentions",
        requestId,
        scope: { mode: "code", threadId, checkoutId },
        query: "ind",
      },
      { windowId },
    );

    expect(result).toMatchObject({
      kind: "file-mentions-completed",
      candidates: [{ path: "src/index.ts", kind: "file" }],
    });
  });

  it("completes a file whose name contains double dots", async () => {
    const io = trackingIo();
    io.list = vi.fn(async () => [{ path: "notes..md" as never, kind: "file" as const }]);
    const service = new FileMentionService({ authority: authority(), io });

    const result = await service.execute(
      {
        kind: "complete-file-mentions",
        requestId,
        scope: { mode: "work", threadId },
        query: "notes..",
      },
      { windowId },
    );

    expect(result).toMatchObject({
      kind: "file-mentions-completed",
      candidates: [{ path: "notes..md", kind: "file" }],
    });
    expect(io.list).toHaveBeenCalledOnce();
  });

  it("does not walk the tree when the complete query already names a parent traversal", async () => {
    const io = trackingIo();
    const service = new FileMentionService({ authority: authority(), io });

    const result = await service.execute(
      {
        kind: "complete-file-mentions",
        requestId,
        scope: { mode: "work", threadId },
        query: "../secret",
      },
      { windowId },
    );

    expect(result).toMatchObject({ kind: "file-mentions-completed", candidates: [] });
    expect(io.list).not.toHaveBeenCalled();
  });

  it("reads an in-root file after confinement locates it", async () => {
    const io = trackingIo();
    io.locate = vi.fn(async () => ({
      kind: "file" as const,
      canonicalPath: `${rootPath}/notes.md`,
      device: "1",
      inode: "2",
      size: 5,
    }));
    io.readBytes = vi.fn(async () => new TextEncoder().encode("hello"));
    const service = new FileMentionService({ authority: authority(), io });

    const result = await service.execute(
      {
        kind: "resolve-file-mentions",
        requestId,
        scope: { mode: "work", threadId },
        paths: ["notes.md"],
      },
      { windowId },
    );

    expect(result).toMatchObject({
      kind: "file-mentions-resolved",
      mentions: [{ path: "notes.md", text: "hello", truncated: false }],
      unavailable: [],
    });
    expect(io.readBytes).toHaveBeenCalledOnce();
  });

  it("returns a bounded prefix when the mentioned file is larger than the read window", async () => {
    const io = trackingIo();
    const contents = "a".repeat(40_000);
    io.locate = vi.fn(async () => ({
      kind: "file" as const,
      canonicalPath: `${rootPath}/large.md`,
      device: "1",
      inode: "2",
      size: contents.length,
    }));
    io.readBytes = vi.fn(async (_path, _expected, maximumBytes) =>
      new TextEncoder().encode(contents.slice(0, maximumBytes)),
    );
    const service = new FileMentionService({ authority: authority(), io });

    const result = await service.execute(
      {
        kind: "resolve-file-mentions",
        requestId,
        scope: { mode: "work", threadId },
        paths: ["large.md"],
      },
      { windowId },
    );

    expect(result.kind).toBe("file-mentions-resolved");
    if (result.kind !== "file-mentions-resolved") return;
    expect(result.mentions).toHaveLength(1);
    expect(result.mentions[0]?.truncated).toBe(true);
    expect(result.mentions[0]?.text.length).toBeLessThan(contents.length);
    expect(result.unavailable).toEqual([]);
  });
});
