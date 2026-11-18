import { createHash } from "node:crypto";
import type { AttachedFileByPath } from "../attachments/attachedFiles";
import { sanitizeManagedAttachmentDisplayName } from "../attachments/managedAttachmentStore";
import type { ServerAddress, ServerConnection } from "./serverConnection";
import { SERVER_THREAD_ATTACHMENTS } from "./serverFiles";

/**
 * Copies the files a server Project's turn names by path to the thread's
 * attachments folder on the server. Canonical: docs/design/server-projects.md
 * § Threads.
 *
 * A server thread's agent works with the server's own file tools, so a file
 * named by its path on this host is a path it cannot open. The file goes over
 * the Project's own SSH connection, the one its file tools and shell already
 * use, into `<home>/.octant/thread-attachments/<thread>/<attachment>/<name>`,
 * outside every Project folder. It is made read-only there, and the file tools
 * read that thread's folder and write nowhere in it. The server prints the
 * file's SHA-256 back, and a copy whose digest differs from the journaled one
 * is refused, so the agent is never pointed at bytes the person did not attach.
 */

const TRANSFER_TIMEOUT_MS = 120_000;

/**
 * `$1` thread, `$2` attachment, `$3` name, the bytes on standard input. A name
 * already there (a retried turn) is replaced, a link in its place included,
 * never followed. Prints the file's real path, a NUL, and its SHA-256.
 */
const TRANSFER_SCRIPT = `exec 2>/dev/null
umask 077
d="$HOME/${SERVER_THREAD_ATTACHMENTS}/$1/$2"
mkdir -p -- "$d" || exit 3
f="$d/$3"
if [ -e "$f" ] || [ -L "$f" ]; then chmod u+w -- "$f"; rm -f -- "$f" || exit 3; fi
cat > "$f" || exit 3
chmod 0400 -- "$f" || exit 3
r=$(realpath -- "$f") || exit 3
s=$(sha256sum -- "$f" 2>/dev/null || shasum -a 256 -- "$f") || exit 3
printf '%s\\0%s' "$r" "\${s%% *}"`;

export const SERVER_ATTACHMENT_TRANSFER_REFUSAL =
  "A file attached to this turn could not be copied to the server, so nothing was sent. Check that the server is reachable and has room, then send again.";

export type ServerAttachmentTransfer =
  | { readonly status: "transferred"; readonly files: ReadonlyArray<AttachedFileByPath> }
  | { readonly status: "refused"; readonly message: string };

export async function transferServerAttachments(input: {
  readonly connection: Pick<ServerConnection, "run">;
  /** The server the thread's Project is on, read now; absent refuses. */
  readonly server: ServerAddress | undefined;
  readonly threadId: string;
  readonly files: ReadonlyArray<{
    readonly attachmentId: string;
    readonly displayName: string;
    readonly mediaType: string;
    readonly bytes: Uint8Array;
  }>;
  readonly signal?: AbortSignal;
}): Promise<ServerAttachmentTransfer> {
  if (input.server === undefined)
    return { status: "refused", message: SERVER_ATTACHMENT_TRANSFER_REFUSAL };
  const transferred: AttachedFileByPath[] = [];
  for (const file of input.files) {
    let name: string;
    try {
      name = sanitizeManagedAttachmentDisplayName(
        file.displayName,
        (message) => new Error(message),
      );
    } catch {
      name = "attachment";
    }
    if (name === ".") name = "attachment";
    const call = await input.connection.run(input.server, {
      script: TRANSFER_SCRIPT,
      args: [input.threadId, file.attachmentId, name],
      stdin: Buffer.from(file.bytes),
      timeoutMs: TRANSFER_TIMEOUT_MS,
      maxOutputBytes: 8_192,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (call.status !== "ran" || call.exitCode !== 0)
      return { status: "refused", message: SERVER_ATTACHMENT_TRANSFER_REFUSAL };
    const output = call.output.toString("utf8");
    const nul = output.indexOf("\0");
    const path = output.slice(0, nul);
    const digest = output.slice(nul + 1).trim();
    if (
      nul <= 0 ||
      !path.startsWith("/") ||
      !path.includes(`/${SERVER_THREAD_ATTACHMENTS}/${input.threadId}/`) ||
      digest !== createHash("sha256").update(file.bytes).digest("hex")
    )
      return { status: "refused", message: SERVER_ATTACHMENT_TRANSFER_REFUSAL };
    transferred.push({
      displayName: file.displayName,
      mediaType: file.mediaType,
      byteLength: file.bytes.byteLength,
      path,
    });
  }
  return { status: "transferred", files: transferred };
}
