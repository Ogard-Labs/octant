import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { UtcTimestamp } from "@octant/contracts/events";
import { decodeContentSha256 } from "@octant/contracts/previews";
import type { PreviewSourceVersion } from "@octant/contracts/previews";
import { MAX_WORK_INPUT_BYTES } from "./workBudget";
import { WorkResolutionService, type WorkRootBinding } from "./workResolutionService";
import type { WorkFilesystemPort, WorkFileStat } from "./workFilesystemPort";

const observedAt = Schema.decodeUnknownSync(UtcTimestamp)("2026-07-22T08:00:00.000Z");

function knownVersionFor(byteSize: number): PreviewSourceVersion {
  const contentSha256 = decodeContentSha256(
    createHash("sha256").update(new Uint8Array(byteSize)).digest("hex"),
  );
  return { contentSha256, byteSize, observedAt };
}

type EntryKind = "file" | "directory" | "symlink";
interface EntrySpec {
  readonly kind: EntryKind;
  readonly bytes?: Uint8Array;
  readonly target?: string;
}

/**
 * A replacement performed once, the moment containment finishes a given step on
 * the named path — the window a racing process inside the Project has.
 *
 * `realpath` is the widest window the sequence has and only the open can refuse
 * what lands in it; `stat` is where the object's identity is captured, so a
 * replacement after it is refused by identity rather than by the open.
 */
interface Swap {
  readonly path: string;
  readonly after: "realpath" | "stat";
  readonly replaceWith: EntrySpec;
}

function filesystem(
  entries: ReadonlyArray<readonly [string, EntrySpec]>,
  swap?: Swap,
): WorkFilesystemPort {
  const map = new Map<string, EntrySpec>(entries);
  const inodes = new Map<EntrySpec, string>();
  let pendingSwap = swap;
  const inodeOf = (entry: EntrySpec): string => {
    const existing = inodes.get(entry);
    if (existing !== undefined) return existing;
    const assigned = String(inodes.size + 1);
    inodes.set(entry, assigned);
    return assigned;
  };
  const resolve = (path: string): string => {
    const entry = map.get(path);
    return entry?.kind === "symlink" && entry.target !== undefined ? entry.target : path;
  };
  const raceAfter = (step: Swap["after"], path: string): void => {
    if (pendingSwap?.after !== step || pendingSwap.path !== path) return;
    map.set(path, pendingSwap.replaceWith);
    pendingSwap = undefined;
  };
  const realpath = async (path: string): Promise<string> => {
    const resolved = resolve(path);
    raceAfter("realpath", path);
    return resolved;
  };
  const statFor = (path: string): WorkFileStat => {
    const entry = map.get(path);
    if (entry === undefined) throw new Error(`no entry at ${path}`);
    return {
      isDirectory: entry.kind === "directory",
      isFile: entry.kind === "file",
      isSymbolicLink: entry.kind === "symlink",
      size: entry.bytes?.byteLength ?? 0,
      device: "1",
      inode: inodeOf(entry),
    };
  };
  return {
    realpath,
    lstat: async (path) => statFor(path),
    // `stat` follows a symlink the way the host's does; only `lstat` reports the
    // link itself. What refuses a link swapped in after containment is therefore
    // the open, not a stand-in that conflates the two.
    stat: async (path) => {
      const measured = statFor(resolve(path));
      raceAfter("stat", path);
      return measured;
    },
    readlink: async (path) => {
      const entry = map.get(path);
      if (entry?.kind === "symlink" && entry.target !== undefined) return entry.target;
      throw new Error(`no symlink at ${path}`);
    },
    // Models an `O_NOFOLLOW` open: a symlinked final component is refused, and
    // the handle keeps answering for the object it captured.
    openFile: async (path) => {
      const opened = map.get(path);
      if (opened === undefined) throw new Error(`no entry at ${path}`);
      if (opened.kind === "symlink") throw new Error(`ELOOP ${path}`);
      const bytes = opened.bytes ?? new Uint8Array(0);
      return {
        stat: async () => ({
          isFile: opened.kind === "file",
          size: bytes.byteLength,
          device: "1",
          inode: inodeOf(opened),
        }),
        read: async (maximumBytes) => bytes.slice(0, Math.max(0, maximumBytes)),
        close: async () => {},
      };
    },
    openWriteFile: async () => {
      throw new Error("write is not used during resolution");
    },
    // `readFile` follows a symlink, which is exactly the escape a confined read
    // must not be able to make on the strength of a name checked earlier.
    readFile: async (path) => {
      const entry = map.get(resolve(path));
      if (entry?.kind === "file" && entry.bytes !== undefined) return entry.bytes;
      throw new Error(`no file at ${path}`);
    },
    writeFile: async () => {},
    mkdir: async () => {},
    unlink: async () => {},
    rename: async () => {},
  };
}

const file = (bytes: number): EntrySpec => ({ kind: "file", bytes: new Uint8Array(bytes) });
const symlink = (target: string): EntrySpec => ({ kind: "symlink", target });

const availableBinding: WorkRootBinding = {
  canonicalRoot: "/work",
  knownCanonicalRoot: "/work",
  availability: "available",
  bindingSuperseded: false,
};

describe("WorkResolutionService", () => {
  it("resolves a contained relative path to a canonical absolute path", async () => {
    const service = new WorkResolutionService(filesystem([["/work/notes.md", file(12)]]));
    const result = await service.resolve({
      binding: availableBinding,
      relativePath: "notes.md",
      knownVersion: knownVersionFor(12),
    });
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.absolutePath).toBe("/work/notes.md");
    expect(result.relativePath).toBe("notes.md");
    expect(result.currentSourceVersion.byteSize).toBe(12);
  });

  it("resolves a nested contained relative path", async () => {
    const service = new WorkResolutionService(filesystem([["/work/reports/q1.md", file(8)]]));
    const result = await service.resolve({
      binding: availableBinding,
      relativePath: "reports/q1.md",
      knownVersion: knownVersionFor(8),
    });
    expect(result.status).toBe("resolved");
  });

  it("fails closed as revoked-root when the binding is unavailable", async () => {
    const service = new WorkResolutionService(filesystem([]));
    const result = await service.resolve({
      binding: { ...availableBinding, availability: "unavailable" },
      relativePath: "notes.md",
      knownVersion: knownVersionFor(12),
    });
    expect(result).toEqual({ status: "revoked-root" });
  });

  it("fails closed as revoked-root when the binding is unverified", async () => {
    const service = new WorkResolutionService(filesystem([]));
    const result = await service.resolve({
      binding: { ...availableBinding, availability: "unverified" },
      relativePath: "notes.md",
      knownVersion: knownVersionFor(12),
    });
    expect(result).toEqual({ status: "revoked-root" });
  });

  it("fails closed as revoked-root when the binding has been superseded", async () => {
    const service = new WorkResolutionService(filesystem([]));
    const result = await service.resolve({
      binding: { ...availableBinding, bindingSuperseded: true },
      relativePath: "notes.md",
      knownVersion: knownVersionFor(12),
    });
    expect(result).toEqual({ status: "revoked-root" });
  });

  it("fails closed as moved-root when the canonical root changed since the ref was minted", async () => {
    const service = new WorkResolutionService(filesystem([]));
    const result = await service.resolve({
      binding: { ...availableBinding, canonicalRoot: "/work-moved" },
      relativePath: "notes.md",
      knownVersion: knownVersionFor(12),
    });
    expect(result).toEqual({ status: "moved-root" });
  });

  it("fails closed as escapes-root when the canonicalized path escapes the root", async () => {
    const service = new WorkResolutionService(filesystem([]));
    const result = await service.resolve({
      binding: availableBinding,
      relativePath: "../secret/notes.md",
      knownVersion: knownVersionFor(12),
    });
    expect(result).toEqual({ status: "escapes-root" });
  });

  it("fails closed as symlink-escape when a symlink target resolves outside the root", async () => {
    const service = new WorkResolutionService(
      filesystem([["/work/link.md", symlink("/secret/notes.md")]]),
    );
    const result = await service.resolve({
      binding: availableBinding,
      relativePath: "link.md",
      knownVersion: knownVersionFor(12),
    });
    expect(result).toEqual({ status: "symlink-escape" });
  });

  it("resolves a relative symlink against the link's own directory", async () => {
    // `readlink` answers relative to the link's parent. Canonicalizing that raw
    // asked about the server's working directory instead, so an artifact safely
    // inside the root was refused as an escape.
    const service = new WorkResolutionService(
      filesystem([
        ["/work/notes/latest.md", symlink("releases/v1.md")],
        ["/work/notes/releases/v1.md", file(15)],
      ]),
    );

    const result = await service.resolve({
      binding: availableBinding,
      relativePath: "notes/latest.md",
      knownVersion: knownVersionFor(15),
    });

    expect(result.status).not.toBe("symlink-escape");
  });

  it("still refuses a relative symlink that climbs out of the approved root", async () => {
    const service = new WorkResolutionService(
      filesystem([["/work/notes/latest.md", symlink("../../secret/notes.md")]]),
    );

    const result = await service.resolve({
      binding: availableBinding,
      relativePath: "notes/latest.md",
      knownVersion: knownVersionFor(12),
    });

    // Refused either way: this harness's `realpath` stand-in does not collapse
    // `..`, so the canonical re-check catches it rather than the symlink check.
    // Which guard fires is an artifact of the fake; that it is refused is not.
    expect(["symlink-escape", "escapes-root"]).toContain(result.status);
  });

  it("resolves a symlink whose target is inside the root", async () => {
    const service = new WorkResolutionService(
      filesystem([
        ["/work/link.md", symlink("/work/notes.md")],
        ["/work/notes.md", file(12)],
      ]),
    );
    const result = await service.resolve({
      binding: availableBinding,
      relativePath: "link.md",
      knownVersion: knownVersionFor(12),
    });
    expect(result.status).toBe("resolved");
  });

  it("fails closed as unavailable when the source file is missing", async () => {
    const service = new WorkResolutionService(filesystem([]));
    const result = await service.resolve({
      binding: availableBinding,
      relativePath: "missing.md",
      knownVersion: knownVersionFor(12),
    });
    expect(result).toEqual({ status: "unavailable" });
  });

  it("fails closed as stale when the source content changed since the ref was minted", async () => {
    const service = new WorkResolutionService(filesystem([["/work/notes.md", file(99)]]));
    const known = knownVersionFor(12);
    const result = await service.resolve({
      binding: availableBinding,
      relativePath: "notes.md",
      knownVersion: known,
    });
    expect(result).toEqual({ status: "stale", knownVersion: known });
  });

  it("refuses a source swapped for an escaping symlink after containment resolved it", async () => {
    // Containment proves the name is a contained regular file; a process inside
    // the Project then makes that name a link out of the root. The outside file
    // is chosen to hash to the recorded version, so nothing downstream notices —
    // the read is the only thing that can refuse.
    const service = new WorkResolutionService(
      filesystem(
        [
          ["/work/notes.md", file(12)],
          ["/secret/outside.md", file(12)],
        ],
        {
          path: "/work/notes.md",
          after: "realpath",
          replaceWith: symlink("/secret/outside.md"),
        },
      ),
    );

    const result = await service.resolve({
      binding: availableBinding,
      relativePath: "notes.md",
      knownVersion: knownVersionFor(12),
    });

    expect(result).toEqual({ status: "unavailable" });
  });

  it("refuses a source swapped for a different object after it measured one", async () => {
    // Same byte count and same content hash, so nothing but the object's
    // identity distinguishes the file this resolution measured from this one.
    const service = new WorkResolutionService(
      filesystem([["/work/notes.md", file(12)]], {
        path: "/work/notes.md",
        after: "stat",
        replaceWith: file(12),
      }),
    );

    const result = await service.resolve({
      binding: availableBinding,
      relativePath: "notes.md",
      knownVersion: knownVersionFor(12),
    });

    expect(result).toEqual({ status: "unavailable" });
  });

  it("refuses a source larger than the confined read ceiling", async () => {
    const service = new WorkResolutionService(
      filesystem([["/work/huge.md", file(MAX_WORK_INPUT_BYTES + 1)]]),
    );

    const result = await service.resolve({
      binding: availableBinding,
      relativePath: "huge.md",
      knownVersion: knownVersionFor(12),
    });

    expect(result).toEqual({ status: "unavailable" });
  });

  it("reports the identity of the object it read so a later read can prove it", async () => {
    const service = new WorkResolutionService(filesystem([["/work/notes.md", file(12)]]));

    const result = await service.resolve({
      binding: availableBinding,
      relativePath: "notes.md",
      knownVersion: knownVersionFor(12),
    });

    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") return;
    expect(result.sourceIdentity).toEqual({ device: "1", inode: "1" });
  });

  it("skips stale detection for a create (no known version)", async () => {
    const service = new WorkResolutionService(filesystem([]));
    const result = await service.resolveForCreate({
      binding: availableBinding,
      relativePath: "new.md",
    });
    expect(result.status).toBe("resolved-for-create");
    if (result.status !== "resolved-for-create") return;
    expect(result.absolutePath).toBe("/work/new.md");
  });

  it("fails closed as escapes-root for a create with a traversal path", async () => {
    const service = new WorkResolutionService(filesystem([]));
    const result = await service.resolveForCreate({
      binding: availableBinding,
      relativePath: "../secret.md",
    });
    expect(result).toEqual({ status: "escapes-root" });
  });
});
