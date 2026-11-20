import { createHash } from "node:crypto";
import { ServerAttachmentThreadId } from "@octant/contracts/server-projects";
import { Schema } from "effect";
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
const DEFAULT_REMOVAL_TIMEOUT_MS = 10_000;
const decodeSafeThreadId = Schema.decodeUnknownOption(ServerAttachmentThreadId);

/**
 * Whether `threadId` is a single safe path segment under
 * `<home>/.octant/thread-attachments/<threadId>` that cannot escape that
 * folder or carry shell syntax.
 */
export function isSafeServerAttachmentThreadId(threadId: string): boolean {
  return decodeSafeThreadId(threadId)._tag === "Some";
}

/**
 * Removes one or more thread attachment folders under
 * `$HOME/.octant/thread-attachments/<threadId>`.
 *
 * Every argument is validated again on the server before touching the
 * filesystem. A symlink at the base folder is refused (exit 4); a symlink at
 * a thread slot is unlinked without following its target; and a real directory
 * is removed only once `realpath` proves it sits directly inside the resolved
 * attachments folder.
 */
const REMOVE_ATTACHMENTS_SCRIPT = `exec 2>/dev/null
[ -n "$HOME" ] || exit 4
for t in "$@"; do
  case "$t" in
    ""|"."|".."|-*|.*|*..*|*/*|*[!A-Za-z0-9._-]*) exit 4 ;;
  esac
done
base="$HOME/${SERVER_THREAD_ATTACHMENTS}"
if [ ! -e "$base" ] && [ ! -L "$base" ]; then
  exit 0
fi
if [ -L "$base" ]; then
  exit 4
fi
real_base=$(realpath -- "$base") || exit 4
for t in "$@"; do
  target="$base/$t"
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    continue
  fi
  if [ -L "$target" ]; then
    rm -f -- "$target" || exit 3
    continue
  fi
  real_target=$(realpath -- "$target") || exit 4
  case "$real_target" in
    "$real_base/$t") ;;
    *) exit 4 ;;
  esac
  # BSD chmod rejects \`--\` after the mode; real_target is an absolute realpath.
  chmod -R u+rwX "$real_target" 2>/dev/null || true
  rm -rf -- "$real_target" || exit 3
done`;

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
if [ -e "$f" ] || [ -L "$f" ]; then chmod u+w "$f"; rm -f -- "$f" || exit 3; fi
cat > "$f" || exit 3
chmod 0400 "$f" || exit 3
r=$(realpath -- "$f") || exit 3
s=$(sha256sum -- "$f" 2>/dev/null || shasum -a 256 -- "$f") || exit 3
printf '%s\\0%s' "$r" "\${s%% *}"`;

export const SERVER_ATTACHMENT_TRANSFER_REFUSAL =
  "A file attached to this turn could not be copied to the server, so nothing was sent. Check that the server is reachable and has room, then send again.";

export type ServerAttachmentTransfer =
  | { readonly status: "transferred"; readonly files: ReadonlyArray<AttachedFileByPath> }
  | { readonly status: "refused"; readonly message: string };

/**
 * Coordinates an attachment upload with any pending remote cleanup for the
 * same `(server, threadId)`, draining and settling owed removals before new
 * files are written and serializing concurrent cleanups against the upload.
 */
export type ServerAttachmentTransferGuard = <T>(input: {
  readonly server: ServerAddress;
  readonly threadId: string;
  readonly signal?: AbortSignal;
  readonly transfer: () => Promise<T>;
  readonly refused: () => T;
}) => Promise<T>;

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
  readonly guard?: ServerAttachmentTransferGuard;
}): Promise<ServerAttachmentTransfer> {
  if (input.server === undefined || !isSafeServerAttachmentThreadId(input.threadId))
    return { status: "refused", message: SERVER_ATTACHMENT_TRANSFER_REFUSAL };
  const server = input.server;
  const runTransfer = async (): Promise<ServerAttachmentTransfer> => {
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
      const call = await input.connection.run(server, {
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
  };
  if (input.guard === undefined) return runTransfer();
  return input.guard({
    server,
    threadId: input.threadId,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    transfer: runTransfer,
    refused: () => ({ status: "refused", message: SERVER_ATTACHMENT_TRANSFER_REFUSAL }),
  });
}

export type ServerAttachmentRemoval =
  | { readonly status: "removed" }
  | { readonly status: "unreachable"; readonly message: string }
  | { readonly status: "refused"; readonly reason: "unsafe-thread-id" | "unsafe-path" };

/**
 * Removes `~/.octant/thread-attachments/<threadId>/` on the server for each
 * given thread ID. Refuses any unsafe thread ID before touching SSH.
 */
export async function removeServerThreadAttachments(input: {
  readonly connection: Pick<ServerConnection, "run">;
  readonly server: ServerAddress | undefined;
  readonly threadIds: ReadonlyArray<string>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<ServerAttachmentRemoval> {
  if (input.threadIds.some((threadId) => !isSafeServerAttachmentThreadId(threadId))) {
    return { status: "refused", reason: "unsafe-thread-id" };
  }
  if (input.threadIds.length === 0) return { status: "removed" };
  if (input.server === undefined) {
    return { status: "unreachable", message: "The server is no longer registered." };
  }
  const call = await input.connection.run(input.server, {
    script: REMOVE_ATTACHMENTS_SCRIPT,
    args: input.threadIds,
    timeoutMs: input.timeoutMs ?? DEFAULT_REMOVAL_TIMEOUT_MS,
    maxOutputBytes: 4_096,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (call.status === "ran") {
    if (call.exitCode === 0) return { status: "removed" };
    if (call.exitCode === 4) return { status: "refused", reason: "unsafe-path" };
    return {
      status: "unreachable",
      message: "The server could not finish removing the thread's attached files.",
    };
  }
  return {
    status: "unreachable",
    message:
      call.status === "unreachable"
        ? call.message
        : "Removing attached files on the server did not finish in time.",
  };
}

/**
 * Read-only reachability check used when removing a whole server Project that
 * has no live threads or pending removals on record. Deletes nothing.
 */
export async function checkServerAttachmentReachable(input: {
  readonly connection: Pick<ServerConnection, "run">;
  readonly server: ServerAddress | undefined;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  if (input.server === undefined) return false;
  const call = await input.connection.run(input.server, {
    script: "true",
    timeoutMs: input.timeoutMs ?? DEFAULT_REMOVAL_TIMEOUT_MS,
    maxOutputBytes: 256,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  return call.status === "ran" && call.exitCode === 0;
}
