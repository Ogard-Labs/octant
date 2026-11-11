import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { openConfinedPath, statConfinedPath } from "../confinedPathOpen";
import {
  MAX_PREVIEW_EDITOR_BYTES,
  type PreviewTextReply,
  type PreviewTextRequest,
} from "@octant/contracts/previews";

// One host serves all windows and Project aliases. Include reads so they cannot
// observe an in-progress save; paths alone would not identify the shared file.
const fileEdits = new Map<string, Promise<void>>();

/** The same proved descriptor supplies the baseline, comparison and human write. */
export async function editPreviewText(input: {
  readonly path: string;
  readonly root: string;
  readonly request: PreviewTextRequest;
  readonly current: () => Promise<boolean>;
}): Promise<PreviewTextReply> {
  const writable = input.request.change !== undefined;
  try {
    const rootIdentity = await statConfinedPath(input.root);
    const fileKey = createHash("sha256")
      .update(
        JSON.stringify([
          input.root,
          String(rootIdentity.dev),
          String(rootIdentity.ino),
          input.path,
        ]),
      )
      .digest("hex");
    const file = await openConfinedPath(
      input.path,
      (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NONBLOCK,
    );
    let release: (() => void) | undefined;
    try {
      const identity = await file.stat({ bigint: true });
      const physicalFile = `${identity.dev}:${identity.ino}`;
      const previous = fileEdits.get(physicalFile);
      const next = Promise.withResolvers<void>();
      fileEdits.set(physicalFile, next.promise);
      release = () => {
        next.resolve();
        if (fileEdits.get(physicalFile) === next.promise) fileEdits.delete(physicalFile);
      };
      await previous;
      // Read both metadata and bytes after the previous operation completes.
      const stat = await file.stat({ bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n) return { kind: "unsupported" };
      if (stat.size > BigInt(MAX_PREVIEW_EDITOR_BYTES)) return { kind: "too-large" };
      const buffer = Buffer.alloc(MAX_PREVIEW_EDITOR_BYTES + 1);
      let count = 0;
      while (count < buffer.length) {
        const next = await file.read(buffer, count, buffer.length - count, count);
        if (next.bytesRead === 0) break;
        count += next.bytesRead;
      }
      if (count > MAX_PREVIEW_EDITOR_BYTES) return { kind: "too-large" };
      const bytes = buffer.subarray(0, count);
      if (bytes.includes(0)) return { kind: "unsupported" };
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        return { kind: "unsupported" };
      }
      const stillAtPath = async () => {
        const currentRoot = await statConfinedPath(input.root);
        const currentFile = await statConfinedPath(input.path);
        return (
          currentRoot.dev === rootIdentity.dev &&
          currentRoot.ino === rootIdentity.ino &&
          currentFile.dev === stat.dev &&
          currentFile.ino === stat.ino &&
          currentFile.nlink === 1n
        );
      };
      const revision = (content: Uint8Array) =>
        createHash("sha256")
          .update(JSON.stringify([fileKey, String(stat.dev), String(stat.ino)]))
          .update(content)
          .digest("hex");
      if (!(await input.current()) || !(await stillAtPath())) return { kind: "unauthorized" };
      const change = input.request.change;
      if (change === undefined) return { kind: "ready", fileKey, text, revision: revision(bytes) };
      if (revision(bytes) !== change.revision) return { kind: "conflict" };
      const replacement = Buffer.from(change.text, "utf8");
      if (replacement.length > MAX_PREVIEW_EDITOR_BYTES) return { kind: "too-large" };
      if (replacement.includes(0) || replacement.toString("utf8") !== change.text)
        return { kind: "unsupported" };
      // Recheck the opened object's revision after authorization's awaited work.
      const latest = await file.stat({ bigint: true });
      if (
        latest.mtimeNs !== stat.mtimeNs ||
        latest.ctimeNs !== stat.ctimeNs ||
        latest.size !== stat.size
      )
        return { kind: "conflict" };
      let offset = 0;
      while (offset < replacement.length) {
        const part = await file.write(replacement, offset, replacement.length - offset, offset);
        if (part.bytesWritten === 0) return { kind: "failed" };
        offset += part.bytesWritten;
      }
      await file.truncate(replacement.length);
      await file.sync();
      return { kind: "saved", fileKey, text: change.text, revision: revision(replacement) };
    } finally {
      release?.();
      await file.close();
    }
  } catch {
    return { kind: "unavailable" };
  }
}
