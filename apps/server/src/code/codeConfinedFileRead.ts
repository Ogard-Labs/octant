import type { CodeRelativePath } from "@octant/contracts";
import type { CodeOpenFile, CodeTestSourcePort } from "./codeDirectoryPort";
import { joinCodePath, resolveContainedPath } from "./codePathConfinement";

/**
 * The bytes of one file inside a bound checkout, or why they were refused.
 * `too-large` is kept apart from `unreadable` so a caller can say the file
 * exists but is past its bound, rather than that it could not be read.
 */
export type CodeConfinedFileRead =
  | { readonly status: "read"; readonly bytes: Uint8Array }
  | {
      readonly status: "refused";
      readonly reason: "outside-root" | "not-a-file" | "too-large" | "unreadable";
    };

/**
 * Read one file of a checkout without the file helper.
 *
 * The editor's open goes through the file helper process because the same
 * port also writes; a host without the helper (every `octant web` host) then
 * answers every open with `helper-unavailable`, even for a file its own
 * listing just returned. A read needs none of that. This runs the confinement
 * sequence the listing and search already use, then reads from one handle that
 * must be the object containment resolved, capped at `maximumBytes`, so a
 * symlink or a swapped name cannot make it read outside the checkout.
 */
export async function readConfinedCodeFile(input: {
  readonly port: CodeTestSourcePort;
  readonly canonicalRoot: string;
  readonly relativePath: CodeRelativePath;
  readonly maximumBytes: number;
}): Promise<CodeConfinedFileRead> {
  const resolved = await resolveContainedPath(
    input.port,
    input.canonicalRoot,
    joinCodePath(input.canonicalRoot, input.relativePath),
  );
  if (resolved === undefined) return { status: "refused", reason: "outside-root" };
  if (!resolved.stat.isFile) return { status: "refused", reason: "not-a-file" };
  if (resolved.stat.size > input.maximumBytes) return { status: "refused", reason: "too-large" };
  let file: CodeOpenFile;
  try {
    file = await input.port.openFile(resolved.canonical);
  } catch {
    return { status: "refused", reason: "unreadable" };
  }
  try {
    const opened = await file.stat();
    if (
      !opened.isFile ||
      opened.device !== resolved.stat.device ||
      opened.inode !== resolved.stat.inode
    ) {
      return { status: "refused", reason: "unreadable" };
    }
    if (opened.size > input.maximumBytes) return { status: "refused", reason: "too-large" };
    const bytes = await file.read(opened.size + 1);
    // A file that changed length between the stat and the read is not the file
    // that was measured; refusing beats returning a torn read.
    if (bytes.byteLength !== opened.size) return { status: "refused", reason: "unreadable" };
    return { status: "read", bytes };
  } catch {
    return { status: "refused", reason: "unreadable" };
  } finally {
    await file.close().catch(() => undefined);
  }
}
