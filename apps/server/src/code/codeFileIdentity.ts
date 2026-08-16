import { createHash } from "node:crypto";
import { decodeCodeFileId, type CodeFileId } from "@octant/contracts";

/**
 * Derive the stable `CodeFileId` for one file inside one checkout of one Code
 * thread.
 *
 * The id is a pure function of thread, checkout, and relative path so a file
 * listed by the explorer, opened by the editor, and saved through the file
 * root authority all name the same aggregate. Keeping the derivation in one
 * shared module means a listing can never mint an id the save path would not
 * recognize.
 */
export function deriveCodeFileId(
  threadId: string,
  checkoutId: string,
  relativePath: string,
): CodeFileId {
  const digest = createHash("sha256")
    .update("octant.code-file.v1\0")
    .update(threadId)
    .update("\0")
    .update(checkoutId)
    .update("\0")
    .update(relativePath)
    .digest("hex")
    .slice(0, 32);
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`;
  return decodeCodeFileId(uuid);
}
