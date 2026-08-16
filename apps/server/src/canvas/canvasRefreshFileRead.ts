import { createHash } from "node:crypto";
import { readConfinedWorkFile } from "../work/workConfinedRead";
import type { WorkFilesystemPort } from "../work/workFilesystemPort";
import type {
  CanvasRefreshFileContent,
  CanvasRefreshFileIdentity,
  CanvasRefreshResolvedFile,
} from "./canvasRefreshSourceResolver";

/**
 * Complete a resolved Canvas refresh source with the identity of the object
 * containment just approved.
 *
 * Containment proves a fact about a name, and a name can be made to mean
 * something else the moment after it is proved. Capturing device and inode here
 * — while the containment sequence's own resolution is still the truth — is what
 * lets the read below prove it read that object and not whatever a racing
 * checkout has since pointed the name, or one of its ancestors, at.
 *
 * `undefined` means refuse: a missing source, a symlinked name, or anything that
 * is not a regular file never becomes a refreshable source.
 */
export async function resolveCanvasRefreshFile(
  filesystem: WorkFilesystemPort,
  file: Omit<CanvasRefreshResolvedFile, "identity">,
): Promise<CanvasRefreshResolvedFile | undefined> {
  let identity: CanvasRefreshFileIdentity;
  try {
    const observed = await filesystem.lstat(file.absolutePath);
    if (!observed.isFile || observed.isSymbolicLink) return undefined;
    identity = { device: observed.device, inode: observed.inode, byteLength: observed.size };
  } catch {
    return undefined;
  }
  return { ...file, identity };
}

/**
 * The size and digest of the one object containment approved, both taken from a
 * single handle.
 *
 * The path is opened once and never resolved again: the handle refuses a
 * symlinked final component, its own `fstat` decides whether this is still the
 * resolved object, and the bytes that produce both facts come from that same
 * handle. A source measured as one object can therefore never be digested as
 * another, and a source that outgrows the ceiling after it was measured is
 * refused rather than read, because the bound is applied to the handle.
 *
 * The containment-time size only separates "already too large to refresh" from
 * "could not be read", so the user sees the honest reason; it never bounds the
 * read.
 */
export async function readCanvasRefreshFile(input: {
  readonly filesystem: WorkFilesystemPort;
  readonly file: CanvasRefreshResolvedFile;
  readonly maxBytes: number;
}): Promise<CanvasRefreshFileContent> {
  if (input.file.identity.byteLength > input.maxBytes) return { kind: "oversized" };
  const bytes = await readConfinedWorkFile({
    filesystem: input.filesystem,
    canonicalPath: input.file.absolutePath,
    expected: input.file.identity,
    maximumBytes: input.maxBytes,
  });
  if (bytes === undefined) return { kind: "unreadable" };
  return {
    kind: "content",
    byteLength: bytes.byteLength,
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
