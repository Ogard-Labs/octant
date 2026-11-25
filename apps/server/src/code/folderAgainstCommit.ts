import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { runHostGit } from "./hostGitReads";

export type FolderAgainstCommit =
  | Readonly<{ status: "observed"; matches: boolean }>
  | Readonly<{ status: "failed" }>;

/** Entries one comparison reads before it gives up and keeps the folder. */
const MAX_ENTRIES = 200_000;

interface TreeEntry {
  readonly mode: string;
  readonly oid: string;
}

/**
 * Whether every file in a folder is exactly the commit's file at that path, so
 * nothing in it can be a person's work. It compares object ids computed here, so
 * no clean filter or other program the repository configured runs. A folder
 * holding a file the commit lacks, a file that differs, an empty folder the
 * commit has no path under, or a submodule is not a match, and neither is one
 * too large to compare: the caller keeps it and says so. The folder's own
 * `.git` pointer file is the one thing it does not compare.
 */
export async function readFolderAgainstCommit(
  repositoryRoot: string,
  folder: string,
  head: string,
  signal: AbortSignal,
): Promise<FolderAgainstCommit> {
  const listed = await runHostGit(
    ["-C", repositoryRoot, "ls-tree", "-r", "-z", "--full-tree", head],
    signal,
    60_000,
  );
  if (listed.exitCode !== 0) return { status: "failed" };
  const tree = new Map<string, TreeEntry>();
  const directories = new Set<string>();
  for (const record of listed.stdout.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode, kind, oid] = record.slice(0, tab).split(" ");
    if (tab === -1 || mode === undefined || oid === undefined) return { status: "failed" };
    // A submodule is a folder Git manages; it cannot be compared file by file.
    if (kind !== "blob") return { status: "observed", matches: false };
    const path = record.slice(tab + 1);
    tree.set(path, { mode, oid });
    const parts = path.split("/");
    for (let length = 1; length < parts.length; length += 1) {
      directories.add(parts.slice(0, length).join("/"));
    }
  }
  const algorithm = [...tree.values()][0]?.oid.length === 64 ? "sha256" : "sha1";

  let entries = 0;
  const pending: string[] = [""];
  while (pending.length > 0) {
    signal.throwIfAborted();
    const relative = pending.pop();
    if (relative === undefined) break;
    let names: ReadonlyArray<string>;
    try {
      names = await readdir(join(folder, relative));
    } catch {
      return { status: "failed" };
    }
    for (const name of names) {
      entries += 1;
      if (entries > MAX_ENTRIES) return { status: "observed", matches: false };
      if (relative === "" && name === ".git") continue;
      const path = relative === "" ? name : `${relative}/${name}`;
      let status: Awaited<ReturnType<typeof lstat>>;
      try {
        status = await lstat(join(folder, path));
      } catch {
        return { status: "failed" };
      }
      if (status.isDirectory()) {
        if (!directories.has(path)) return { status: "observed", matches: false };
        pending.push(path);
        continue;
      }
      const recorded = tree.get(path);
      if (recorded === undefined) return { status: "observed", matches: false };
      try {
        if (status.isSymbolicLink()) {
          if (recorded.mode !== "120000") return { status: "observed", matches: false };
          const target = Buffer.from(await readlink(join(folder, path)), "utf8");
          if (blobId(algorithm, target.length, [target]) !== recorded.oid) {
            return { status: "observed", matches: false };
          }
        } else if (status.isFile()) {
          if (recorded.mode === "120000") return { status: "observed", matches: false };
          const id = await fileBlobId(algorithm, join(folder, path), status.size);
          if (id !== recorded.oid) return { status: "observed", matches: false };
        } else {
          return { status: "observed", matches: false };
        }
      } catch {
        return { status: "failed" };
      }
    }
  }
  return { status: "observed", matches: true };
}

function blobId(
  algorithm: "sha1" | "sha256",
  size: number,
  chunks: ReadonlyArray<Buffer>,
): string {
  const hash = createHash(algorithm).update(`blob ${size}\0`);
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
}

async function fileBlobId(
  algorithm: "sha1" | "sha256",
  path: string,
  size: number,
): Promise<string> {
  if (size < 1_000_000) return blobId(algorithm, size, [await readFile(path)]);
  const hash = createHash(algorithm).update(`blob ${size}\0`);
  let read = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    read += bytes.length;
    hash.update(bytes);
  }
  // A file that changed while it was read is not the commit's.
  return read === size ? hash.digest("hex") : "";
}
