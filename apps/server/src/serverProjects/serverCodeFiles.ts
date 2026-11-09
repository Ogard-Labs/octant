import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  decodeCodeFileListing,
  MAX_CODE_FILE_LISTING_DEPTH,
  MAX_CODE_FILE_LISTING_ENTRIES,
  type CodeFileListingEntry,
  type CodeFileListingResult,
} from "@octant/contracts";
import {
  decodeCodeRelativePath,
  type CodeCheckoutId,
  type CodeRelativePath,
  type CodeThreadId,
} from "@octant/contracts/code";
import { classifyPathContainment } from "@octant/domain";
import type { CodeConfinedFileRead } from "../code/codeConfinedFileRead";
import type { CodeContentStore } from "../code/codeContentStore";
import { deriveCodeFileId } from "../code/codeFileIdentity";
import {
  MAX_EDITABLE_CODE_FILE_BYTES,
  type CodeFileMetadata,
  type CodeFileOpenResult,
  type CodeFileSaveResult,
} from "../code/codeFileService";
import type { ServerAddress, ServerCall, ServerConnection } from "./serverConnection";
import { RESOLVE_INSIDE, serverCredentialPathRefusal, withProtectedPaths } from "./serverFiles";
import { listServerDirectory } from "./serverDirectoryListing";

/**
 * The Code file browser and editor on a server Project's folder. Canonical:
 * docs/design/server-projects.md § Panels.
 *
 * Every path is resolved on the server to its real path, and one outside the
 * folder or in a key or credential location is refused there before any byte
 * travels, as the file tools refuse one. A listing names no link: `find`
 * reports only real folders and files, so nothing it names leads out of the
 * folder. A file's identity is its real path on the server, and a save is
 * refused when the file's content changed since it was opened, compared by
 * digest because file times and inode numbers mean nothing across servers.
 * A call that cannot reach the server fails; nothing is read or written on
 * this host instead.
 */

const CALL_TIMEOUT_MS = 30_000;
const SERVER_DEVICE = "server";
/** File times are not compared on a server, so every file reports the same one. */
const SERVER_MODIFIED = "0";

/** After the resolved path: `o` for not a file, or `s<size>\0` then the bytes when within `$3`. */
const OPEN_SCRIPT = `${RESOLVE_INSIDE}
[ -f "$r" ] || { printf 'o'; exit 0; }
s=$(wc -c < "$r" | tr -d ' ')
printf 's%s\\0' "$s"
[ "$s" -gt "$3" ] && exit 0
cat -- "$r"`;

/** The copy keeps the file's mode, so a save neither drops an executable bit nor widens a private file. */
const PUT_SCRIPT = `exec 2>/dev/null
t="$1.octant-save.$$"
cp -p -- "$1" "$t" || { rm -f -- "$t"; exit 3; }
cat > "$t" || { rm -f -- "$t"; exit 3; }
mv -f -- "$t" "$1" || { rm -f -- "$t"; exit 3; }`;

export interface ServerCodeFilesOptions {
  readonly connection: Pick<ServerConnection, "run">;
  /** Read each call, so a server removed from the registry refuses the next one. */
  readonly server: () => ServerAddress | undefined;
  /** The folder's real path on the server. */
  readonly root: string;
  /** Where an opened file's bytes are staged for the editor; without it nothing opens for editing. */
  readonly content?: Pick<CodeContentStore, "put">;
  readonly clock: () => string;
}

type Opened =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly byteLength: number;
      readonly bytes: Buffer | undefined;
    }
  | {
      readonly kind: "refused";
      readonly reason: "unreachable" | "outside-root" | "not-a-file" | "protected" | "missing";
    };

export class ServerCodeFiles {
  readonly #options: ServerCodeFilesOptions;
  readonly #root: string;

  constructor(options: ServerCodeFilesOptions) {
    if (!posix.isAbsolute(options.root)) throw new Error("A server folder must be absolute.");
    this.#options = options;
    this.#root = options.root.replace(/\/+$/, "");
  }

  async list(request: {
    readonly threadId: CodeThreadId;
    readonly checkoutId: CodeCheckoutId;
    readonly directory?: CodeRelativePath | undefined;
    readonly signal?: AbortSignal | undefined;
  }): Promise<CodeFileListingResult> {
    const listed = await listServerDirectory(
      {
        ...this.#options,
        root: this.#root,
        maxDepth: MAX_CODE_FILE_LISTING_DEPTH,
        maxEntries: MAX_CODE_FILE_LISTING_ENTRIES,
      },
      request,
    );
    if (listed.status === "failed") return failedListing(listed.category, listed.message);
    const entries: CodeFileListingEntry[] = [];
    for (const entry of listed.entries) {
      let path: CodeRelativePath;
      try {
        path = decodeCodeRelativePath(entry.path);
      } catch {
        continue;
      }
      if (entry.kind === "directory") {
        entries.push({ kind: "directory", path });
        continue;
      }
      entries.push({
        kind: "file",
        fileId: deriveCodeFileId(String(request.threadId), String(request.checkoutId), path),
        path,
        byteLength: entry.byteLength,
        availability:
          entry.byteLength > MAX_EDITABLE_CODE_FILE_BYTES
            ? { status: "read-only", reason: "oversized" }
            : { status: "available" },
      });
    }
    return {
      status: "listed",
      listing: decodeCodeFileListing({
        kind: "code-file-listing",
        threadId: request.threadId,
        checkoutId: request.checkoutId,
        ...(request.directory === undefined ? {} : { directory: request.directory }),
        entries,
        truncated: listed.truncated,
        observedAt: this.#options.clock(),
      }),
    };
  }

  async open(input: {
    readonly path: CodeRelativePath;
    readonly signal?: AbortSignal | undefined;
  }): Promise<CodeFileOpenResult> {
    const opened = await this.#open(input.path, MAX_EDITABLE_CODE_FILE_BYTES, input.signal);
    if (opened.kind === "refused") {
      return {
        status: "failed",
        failure:
          opened.reason === "unreachable"
            ? { category: "unavailable", code: "server-unreachable" }
            : { category: "failed", code: opened.reason },
      };
    }
    if (opened.bytes === undefined) {
      return { status: "read-only", metadata: metadata(opened, undefined), reason: "too-large" };
    }
    const meta = metadata(opened, opened.bytes);
    if (!isUtf8(opened.bytes)) return { status: "read-only", metadata: meta, reason: "binary" };
    const store = this.#options.content;
    if (store === undefined) {
      return {
        status: "failed",
        failure: { category: "unavailable", code: "content-unavailable" },
      };
    }
    return { status: "editable", metadata: meta, content: store.put(opened.bytes) };
  }

  async read(input: {
    /** Relative to the folder, or absolute on the server. */
    readonly path: string;
    readonly maximumBytes: number;
  }): Promise<CodeConfinedFileRead> {
    const opened = await this.#open(input.path, input.maximumBytes, undefined);
    if (opened.kind === "refused") {
      return {
        status: "refused",
        reason:
          opened.reason === "not-a-file"
            ? "not-a-file"
            : opened.reason === "outside-root" || opened.reason === "protected"
              ? "outside-root"
              : "unreadable",
      };
    }
    return opened.bytes === undefined
      ? { status: "refused", reason: "too-large" }
      : { status: "read", bytes: new Uint8Array(opened.bytes) };
  }

  /** The text of a file in the folder, or undefined for any refusal, for test discovery. */
  async readText(path: string, maximumBytes: number): Promise<string | undefined> {
    const opened = await this.#open(path, maximumBytes, undefined);
    return opened.kind === "file" && opened.bytes !== undefined && isUtf8(opened.bytes)
      ? opened.bytes.toString("utf8")
      : undefined;
  }

  /**
   * Writes the editor's text when the file still holds what was opened: the
   * same real path and the same digest. The check and the write are two
   * calls, so a change made on the server between them is overwritten; the
   * write itself replaces the file whole, so a reader there never sees half.
   */
  async save(input: {
    readonly path: CodeRelativePath;
    readonly text: string;
    readonly expectedIdentity: { readonly device: string; readonly inode: string };
    readonly expectedDigest: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<CodeFileSaveResult> {
    const bytes = Buffer.from(input.text, "utf8");
    if (bytes.byteLength > MAX_EDITABLE_CODE_FILE_BYTES) {
      return { status: "failed", failure: { category: "invalid", code: "invalid-content" } };
    }
    const current = await this.#open(input.path, MAX_EDITABLE_CODE_FILE_BYTES, input.signal);
    if (current.kind === "refused") {
      return current.reason === "unreachable"
        ? { status: "failed", failure: { category: "unavailable", code: "server-unreachable" } }
        : { status: "failed", failure: { category: "failed", code: current.reason } };
    }
    if (
      current.bytes === undefined ||
      input.expectedIdentity.device !== SERVER_DEVICE ||
      input.expectedIdentity.inode !== identityOf(current.path) ||
      digest(current.bytes) !== input.expectedDigest
    ) {
      return { status: "conflict", failure: { category: "conflict", code: "digest-mismatch" } };
    }
    const put = await this.#call(PUT_SCRIPT, [current.path], bytes, 1_024, input.signal);
    if (put.status !== "ran") return { status: "interrupted", rescanRequired: true };
    if (put.exitCode !== 0) {
      return { status: "failed", failure: { category: "failed", code: "write-failed" } };
    }
    return {
      status: "completed",
      metadata: metadata({ path: current.path, byteLength: bytes.byteLength }, bytes),
    };
  }

  async #open(
    path: string,
    maximumBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<Opened> {
    const lexical = posix.isAbsolute(path) ? posix.normalize(path) : posix.join(this.#root, path);
    if (serverCredentialPathRefusal(lexical) !== undefined) {
      return { kind: "refused", reason: "protected" };
    }
    const call = await this.#call(
      OPEN_SCRIPT,
      [lexical, this.#root, String(maximumBytes)],
      undefined,
      maximumBytes + 4_096,
      signal,
    );
    if (call.status !== "ran") return { kind: "refused", reason: "unreachable" };
    const first = call.output[0];
    if (first === 0x78 /* x */) return { kind: "refused", reason: "outside-root" };
    if (first === 0x6b /* k */) return { kind: "refused", reason: "protected" };
    const resolved = this.#resolved(call.output);
    if (resolved === undefined) return { kind: "refused", reason: "missing" };
    if (serverCredentialPathRefusal(resolved.path) !== undefined) {
      return { kind: "refused", reason: "protected" };
    }
    if (resolved.rest[0] !== 0x73 /* s */) return { kind: "refused", reason: "not-a-file" };
    const end = resolved.rest.indexOf(0);
    const byteLength = Number(resolved.rest.subarray(1, end).toString("utf8"));
    if (end === -1 || !Number.isSafeInteger(byteLength) || byteLength < 0) {
      return { kind: "refused", reason: "missing" };
    }
    if (byteLength > maximumBytes) {
      return { kind: "file", path: resolved.path, byteLength, bytes: undefined };
    }
    const bytes = resolved.rest.subarray(end + 1);
    // A file that changed size while it was read is not the one measured.
    if (call.truncated || bytes.byteLength !== byteLength) {
      return { kind: "refused", reason: "missing" };
    }
    return { kind: "file", path: resolved.path, byteLength, bytes: Buffer.from(bytes) };
  }

  /** The real path a script resolved, judged inside the folder here too, and what followed it. */
  #resolved(output: Buffer): { readonly path: string; readonly rest: Buffer } | undefined {
    const first = output[0];
    if (first === undefined || first === 0x6d || first === 0x78 || first === 0x6b) return undefined;
    const nul = output.indexOf(0);
    if (nul === -1) return undefined;
    const path = output.subarray(0, nul).toString("utf8");
    if (classifyPathContainment(this.#root, path) !== "contained") return undefined;
    return { path, rest: output.subarray(nul + 1) };
  }

  #call(
    script: string,
    args: ReadonlyArray<string>,
    stdin: Buffer | undefined,
    maxOutputBytes: number,
    signal: AbortSignal | undefined,
  ): Promise<ServerCall> {
    const server = this.#options.server();
    if (server === undefined) {
      return Promise.resolve({
        status: "unreachable",
        message: "The server is no longer registered.",
      });
    }
    return this.#options.connection.run(server, {
      script: withProtectedPaths(script),
      args,
      ...(stdin === undefined ? {} : { stdin }),
      timeoutMs: CALL_TIMEOUT_MS,
      maxOutputBytes,
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

function metadata(
  file: { readonly path: string; readonly byteLength: number },
  bytes: Buffer | undefined,
): CodeFileMetadata {
  return {
    identity: { device: SERVER_DEVICE, inode: identityOf(file.path) },
    byteLength: file.byteLength,
    modifiedNanoseconds: SERVER_MODIFIED,
    // An unread file still needs a digest; this one matches no content.
    digest: bytes === undefined ? digest(Buffer.from(`unread\0${file.path}`)) : digest(bytes),
  };
}

function identityOf(realPath: string): string {
  return createHash("sha256").update(realPath).digest("hex").slice(0, 32);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function failedListing(
  category: "unavailable" | "not-found",
  message: string,
): CodeFileListingResult {
  return { status: "failed", failure: { category, message } };
}
