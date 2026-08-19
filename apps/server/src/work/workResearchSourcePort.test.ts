import { describe, expect, it } from "vitest";
import type { ProjectId } from "@octant/contracts/projects";
import type { WorkFilesystemPort } from "./workFilesystemPort";
import { createWorkResearchSourcePort } from "./workResearchSourcePort";

const projectId = "project-1" as ProjectId;
const root = "/approved/root";

const encoder = new TextEncoder();

/** One object the fake filesystem can hold at the single path under test. */
interface FakeObject {
  readonly bytes: Uint8Array;
  readonly inode: string;
  readonly isSymbolicLink?: boolean;
}

interface FilesystemOptions {
  readonly content?: Uint8Array;
  /**
   * A replacement performed once, the moment containment stats the path:
   * exactly the window between the containment proof and the read that follows.
   */
  readonly swapOnStat?: FakeObject;
}

function filesystem(
  overrides: Partial<WorkFilesystemPort> = {},
  options: FilesystemOptions = {},
): WorkFilesystemPort {
  let current: FakeObject = { bytes: options.content ?? encoder.encode("note"), inode: "7" };
  let pendingSwap = options.swapOnStat;
  const statOf = (object: FakeObject) => ({
    isDirectory: false,
    isFile: object.isSymbolicLink !== true,
    isSymbolicLink: object.isSymbolicLink === true,
    size: object.bytes.byteLength,
    device: "1",
    inode: object.inode,
  });
  return {
    realpath: async (path) => path,
    lstat: async () => statOf(current),
    stat: async () => {
      const measured = statOf(current);
      if (pendingSwap !== undefined) {
        current = pendingSwap;
        pendingSwap = undefined;
      }
      return measured;
    },
    readlink: async () => "/approved/root/target.md",
    // Models an `O_NOFOLLOW` open: a symlinked final component is refused, and
    // the handle keeps answering for the object it captured.
    openFile: async () => {
      const opened = current;
      if (opened.isSymbolicLink === true) throw new Error("ELOOP");
      return {
        stat: async () => ({
          isFile: true,
          size: opened.bytes.byteLength,
          device: "1",
          inode: opened.inode,
        }),
        read: async (maximumBytes: number) => opened.bytes.slice(0, Math.max(0, maximumBytes)),
        close: async () => {},
      };
    },
    readFile: async () => current.bytes,
    openWriteFile: async () => {
      throw new Error("write is not used during research source observation");
    },
    writeFile: async () => undefined,
    mkdir: async () => undefined,
    unlink: async () => undefined,
    rename: async () => undefined,
    ...overrides,
  };
}

function port(overrides: Partial<WorkFilesystemPort> = {}, options: FilesystemOptions = {}) {
  return createWorkResearchSourcePort({
    filesystem: filesystem(overrides, options),
    resolveProjectRoot: () => root,
  });
}

/** Stands in for `realpath` in the symlink tests: collapses `.` and `..` only. */
function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

function unboundPort() {
  return createWorkResearchSourcePort({
    filesystem: filesystem(),
    resolveProjectRoot: () => undefined,
  });
}

describe("createWorkResearchSourcePort", () => {
  it("observes a confined file source and reports its content version", async () => {
    const observed = await port().observeSourceVersion({
      projectId,
      sourceKind: "file",
      sourceRef: "notes/brief.md",
    });

    expect(observed?.sourceVersion.byteSize).toBe(4);
    expect(String(observed?.sourceVersion.contentSha256)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(["web", "mail-export", "user-reference"] as const)(
    "reports %s sources unobservable because Work grants no egress",
    async (sourceKind) => {
      const observed = await port().observeSourceVersion({
        projectId,
        sourceKind,
        sourceRef: "https://example.test/doc",
      });

      expect(observed).toBeUndefined();
    },
  );

  it("rejects a traversal reference instead of reading outside the root", async () => {
    const observed = await port().observeSourceVersion({
      projectId,
      sourceKind: "file",
      sourceRef: "../outside.md",
    });

    expect(observed).toBeUndefined();
  });

  it("rejects a symlink whose target escapes the approved root", async () => {
    const escaping = port({
      lstat: async () => ({
        isDirectory: false,
        isFile: false,
        isSymbolicLink: true,
        size: 4,
        device: "1",
        inode: "7",
      }),
      realpath: async () => "/elsewhere/secret.md",
    });

    const observed = await escaping.observeSourceVersion({
      projectId,
      sourceKind: "file",
      sourceRef: "link.md",
    });

    expect(observed).toBeUndefined();
  });

  it("observes a relative symlink resolved against the link's own directory", async () => {
    const relative = port({
      lstat: async () => ({
        isDirectory: false,
        isFile: false,
        isSymbolicLink: true,
        size: 4,
        device: "1",
        inode: "7",
      }),
      readlink: async () => "../releases/v1.md",
      realpath: async (path) => normalizePath(path),
    });

    const observed = await relative.observeSourceVersion({
      projectId,
      sourceKind: "file",
      sourceRef: "notes/latest.md",
    });

    expect(observed?.sourceVersion.byteSize).toBe(4);
  });

  it("still rejects a relative symlink that climbs out of the approved root", async () => {
    const escaping = port({
      lstat: async () => ({
        isDirectory: false,
        isFile: false,
        isSymbolicLink: true,
        size: 4,
        device: "1",
        inode: "7",
      }),
      readlink: async () => "../../../etc/secret.md",
      realpath: async (path) => normalizePath(path),
    });

    const observed = await escaping.observeSourceVersion({
      projectId,
      sourceKind: "file",
      sourceRef: "notes/latest.md",
    });

    expect(observed).toBeUndefined();
  });

  it("rejects a path whose canonical location escapes the approved root", async () => {
    const escaping = port({ realpath: async () => "/elsewhere/secret.md" });

    const observed = await escaping.observeSourceVersion({
      projectId,
      sourceKind: "file",
      sourceRef: "inside.md",
    });

    expect(observed).toBeUndefined();
  });

  it("reports an unbound Project unobservable rather than reading any path", async () => {
    const observed = await unboundPort().observeSourceVersion({
      projectId,
      sourceKind: "file",
      sourceRef: "notes/brief.md",
    });

    expect(observed).toBeUndefined();
  });

  it("refuses a source larger than the read budget", async () => {
    const oversize = createWorkResearchSourcePort({
      filesystem: filesystem(),
      resolveProjectRoot: () => root,
      maxSourceBytes: 2,
    });

    const observed = await oversize.observeSourceVersion({
      projectId,
      sourceKind: "file",
      sourceRef: "notes/brief.md",
    });

    expect(observed).toBeUndefined();
  });

  it("refuses a source swapped for an escaping symlink after containment measured it", async () => {
    // Containment proves the named path is a contained regular file; a process
    // inside the Project then makes that name a link out of the root before the
    // read. Following the name a second time reads whatever it means by then.
    const swapped = port(
      {},
      {
        swapOnStat: {
          bytes: encoder.encode("credentials from outside the root"),
          inode: "9",
          isSymbolicLink: true,
        },
      },
    );

    const observed = await swapped.observeSourceVersion({
      projectId,
      sourceKind: "file",
      sourceRef: "notes/brief.md",
    });

    expect(observed).toBeUndefined();
  });

  it("refuses a source swapped for a different object of the same size", async () => {
    // Same byte count, so no ceiling notices; only the object's identity does.
    const swapped = port({}, { swapOnStat: { bytes: encoder.encode("evil"), inode: "9" } });

    const observed = await swapped.observeSourceVersion({
      projectId,
      sourceKind: "file",
      sourceRef: "notes/brief.md",
    });

    expect(observed).toBeUndefined();
  });

  it("never materializes more of a swapped-in source than the ceiling allows", async () => {
    // Rejecting oversized bytes after reading them still spends the host memory
    // the ceiling exists to protect, so the read itself must stay bounded.
    let largestRequest = 0;
    const racing = filesystem({}, { swapOnStat: { bytes: new Uint8Array(4096), inode: "9" } });
    const watched: WorkFilesystemPort = {
      ...racing,
      readFile: async (path) => {
        largestRequest = Number.POSITIVE_INFINITY;
        return racing.readFile(path);
      },
      openFile: async (path) => {
        const file = await racing.openFile(path);
        return {
          ...file,
          read: async (maximumBytes) => {
            largestRequest = Math.max(largestRequest, maximumBytes);
            return file.read(maximumBytes);
          },
        };
      },
    };
    const bounded = createWorkResearchSourcePort({
      filesystem: watched,
      resolveProjectRoot: () => root,
      maxSourceBytes: 8,
    });

    const observed = await bounded.observeSourceVersion({
      projectId,
      sourceKind: "file",
      sourceRef: "notes/brief.md",
    });

    expect(observed).toBeUndefined();
    expect(largestRequest).toBeLessThanOrEqual(9);
  });

  it("verifies an excerpt and its version against a single read of the source", async () => {
    // The excerpt answer and the freshness hash have to describe the same bytes;
    // a second read could observe a different file and make them disagree.
    let opens = 0;
    const counted = filesystem(
      {},
      { content: encoder.encode("Local-first software owns user data.\n") },
    );
    const watched: WorkFilesystemPort = {
      ...counted,
      openFile: async (path) => {
        opens += 1;
        return counted.openFile(path);
      },
    };
    const document = createWorkResearchSourcePort({
      filesystem: watched,
      resolveProjectRoot: () => root,
    });

    const verified = await document.verifySourceExcerpt({
      projectId,
      sourceKind: "file",
      sourceRef: "notes/brief.md",
      excerpt: "Local-first software owns user data.",
    });

    expect(verified.outcome).toBe("excerpt-present");
    expect(opens).toBe(1);
  });

  it("supports an excerpt the confined file states across a line break", async () => {
    const document = port(
      {},
      { content: encoder.encode("Local-first software owns user data\nand keeps agency local.\n") },
    );

    const verified = await document.verifySourceExcerpt({
      projectId,
      sourceKind: "file",
      sourceRef: "notes/brief.md",
      excerpt: "Local-first software owns user data and keeps agency local.",
    });

    expect(verified.outcome).toBe("excerpt-present");
    if (verified.outcome !== "excerpt-present") return;
    expect(String(verified.sourceVersion.contentSha256)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports an excerpt the confined file never states as absent", async () => {
    const document = port(
      {},
      { content: encoder.encode("Local-first software owns user data.\n") },
    );

    const verified = await document.verifySourceExcerpt({
      projectId,
      sourceKind: "file",
      sourceRef: "notes/brief.md",
      excerpt: "Local-first software eliminates every cloud outage.",
    });

    expect(verified.outcome).toBe("excerpt-absent");
  });

  it("refuses to verify an excerpt against bytes it cannot decode as text", async () => {
    const binary = port(
      {},
      { content: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]) },
    );

    const verified = await binary.verifySourceExcerpt({
      projectId,
      sourceKind: "file",
      sourceRef: "notes/scan.png",
      excerpt: "Local-first software owns user data.",
    });

    expect(verified.outcome).toBe("unverifiable");
  });

  it("refuses to verify an excerpt through a reference that escapes the approved root", async () => {
    const verified = await port().verifySourceExcerpt({
      projectId,
      sourceKind: "file",
      sourceRef: "../outside.md",
      excerpt: "note",
    });

    expect(verified.outcome).toBe("unverifiable");
  });

  it("treats an unreadable source as unobservable rather than fresh", async () => {
    const unreadable = port({
      openFile: async () => {
        throw new Error("EACCES");
      },
      readFile: async () => {
        throw new Error("EACCES");
      },
    });

    const observed = await unreadable.observeSourceVersion({
      projectId,
      sourceKind: "file",
      sourceRef: "notes/brief.md",
    });

    expect(observed).toBeUndefined();
  });
});
