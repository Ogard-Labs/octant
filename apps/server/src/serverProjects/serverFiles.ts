import { createHash } from "node:crypto";
import { posix } from "node:path";
import { classifyPathContainment } from "@octant/domain";
import {
  editedText,
  globToRegExp,
  firstSegment,
  MAX_GLOB_RESULTS,
  MAX_GREP_LINE_LENGTH,
  MAX_GREP_PATTERN_LENGTH,
  MAX_GREP_RESULT_BYTES,
  readSlice,
  SKIPPED_DIRECTORY_NAMES,
  type NativeHarnessEditResult,
  type NativeHarnessFileRefused,
  type NativeHarnessFileSystemPort,
  type NativeHarnessGlobResult,
  type NativeHarnessGrepMatch,
  type NativeHarnessGrepResult,
  type NativeHarnessReadResult,
  type NativeHarnessWriteResult,
} from "../harness/nativeHarnessFileSystem";
import type { ServerAddress, ServerCall, ServerConnection } from "./serverConnection";

/**
 * The native harness's file tools on a server Project's folder. Canonical:
 * docs/design/server-projects.md § Threads.
 *
 * Every path is resolved on the server to its real path and judged here
 * against the folder, as the local file tools judge one against a checkout.
 * A script on the server also refuses a path outside the folder before it
 * sends anything back, so a link out of the folder never carries a file's
 * bytes to this host. An edit needs a read through this instance first and
 * refuses a file whose content changed since, compared by digest because
 * file times read differently on every server.
 */

const CALL_TIMEOUT_MS = 30_000;
const MAX_LISTING_BYTES = 8 * 1024 * 1024;

/**
 * Key and credential folders and files, refused at every level as the secret
 * guard refuses them on this host. The guard's own list names this host's
 * paths, so a server's are matched by name.
 */
const SERVER_CREDENTIAL_PATH =
  /(?:^|\/)(?:\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.config\/gh)(?:\/|$)|(?:^|\/)\.(?:netrc|git-credentials|npmrc|pypirc)$|\.(?:pem|key)$/i;

export function serverCredentialPathRefusal(path: string): string | undefined {
  return SERVER_CREDENTIAL_PATH.test(path)
    ? "This path is in a key or credential location on the server, so Octant's file tools do not open it. Use the server's own credential setup instead."
    : undefined;
}

/** Resolves `$1` and refuses one outside the folder `$2` before printing anything. */
const RESOLVE_INSIDE = `exec 2>/dev/null
r=$(realpath -- "$1") || { printf 'm'; exit 0; }
case "$r" in "$2"|"$2"/*) ;; *) printf 'x'; exit 0;; esac
printf '%s\\0' "$r"`;

const READ_SCRIPT = `${RESOLVE_INSIDE}
if [ -d "$r" ]; then
  printf 'd'
  for e in "$r"/* "$r"/.[!.]* "$r"/..?*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    if [ -L "$e" ]; then t=o; elif [ -d "$e" ]; then t=d; elif [ -f "$e" ]; then t=f; else t=o; fi
    printf '%s%s\\0' "$t" "\${e##*/}"
  done
elif [ -f "$r" ]; then
  s=$(wc -c < "$r" | tr -d ' ')
  if [ "$s" -gt "$3" ]; then printf 'b'; exit 0; fi
  printf 'f'
  cat -- "$r"
else
  printf 'o'
fi`;

/** The real path a write lands on: the file's own, or its nearest existing folder's with the rest appended. */
const RESOLVE_FOR_WRITE_SCRIPT = `exec 2>/dev/null
p=$1
rest=
while [ ! -e "$p" ] && [ ! -L "$p" ]; do
  rest="/\${p##*/}$rest"
  p=$(dirname -- "$p")
done
r=$(realpath -- "$p") || { printf 'x'; exit 0; }
if [ -n "$rest" ]; then printf 'n%s%s' "$r" "$rest"
elif [ -f "$r" ]; then printf 'f%s' "$r"
else printf 'o%s' "$r"
fi`;

const PUT_SCRIPT = `exec 2>/dev/null
mkdir -p -- "$(dirname -- "$1")" || exit 3
cat > "$1" || exit 3`;

const LIST_SCRIPT = `${RESOLVE_INSIDE}
if [ "$3" = 1 ]; then
  find "$r" -type f -print0
else
  find "$r" \\( -name .git -o -name node_modules \\) -prune -o -type f -print0
fi`;

const GREP_SCRIPT = `${RESOLVE_INSIDE}
printf '\\0'
if [ -n "$4" ]; then
  grep -rHnIE --null --exclude-dir=.git --exclude-dir=node_modules --include="$4" -e "$3" -- "$r"
else
  grep -rHnIE --null --exclude-dir=.git --exclude-dir=node_modules -e "$3" -- "$r"
fi
s=$?
[ "$s" -le 1 ] || exit 2`;

export interface ServerFileSystemOptions {
  readonly connection: Pick<ServerConnection, "run">;
  /** The server the folder is on, read each call so a server removed from the registry refuses. */
  readonly server: () => ServerAddress | undefined;
  /** The folder's real path on the server. */
  readonly root: string;
  readonly maxFileBytes?: number;
  readonly signal?: AbortSignal;
}

type Resolved =
  | { readonly kind: "inside"; readonly path: string; readonly rest: Buffer }
  | NativeHarnessFileRefused;

export class ServerFileSystem implements NativeHarnessFileSystemPort {
  readonly #options: ServerFileSystemOptions;
  readonly #root: string;
  readonly #maxFileBytes: number;
  readonly #readMarks = new Map<string, string>();

  constructor(options: ServerFileSystemOptions) {
    if (!posix.isAbsolute(options.root)) throw new Error("A server folder must be absolute.");
    this.#options = options;
    this.#root = options.root.replace(/\/+$/, "");
    this.#maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
  }

  get root(): string {
    return this.#root;
  }

  get extraRoots(): ReadonlyArray<string> {
    return [];
  }

  async read(input: {
    readonly path: string;
    readonly offset?: number | undefined;
    readonly limit?: number | undefined;
  }): Promise<NativeHarnessReadResult> {
    const lexical = this.#lexical(input.path);
    const guarded = guard(lexical);
    if (guarded !== undefined) return guarded;
    const resolved = await this.#resolve(READ_SCRIPT, [
      lexical,
      this.#root,
      String(this.#maxFileBytes),
    ]);
    if (resolved.kind === "refused") return resolved;
    const guardedReal = guard(resolved.path);
    if (guardedReal !== undefined) return guardedReal;
    const kind = String.fromCharCode(resolved.rest[0] ?? 0);
    const payload = resolved.rest.subarray(1);
    const display = this.#display(resolved.path);
    if (kind === "d") {
      const entries = payload
        .toString("utf8")
        .split("\0")
        .filter((entry) => entry.length > 1)
        .map((entry) => ({
          name: entry.slice(1),
          kind:
            entry[0] === "d"
              ? ("directory" as const)
              : entry[0] === "f"
                ? ("file" as const)
                : ("other" as const),
        }))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, MAX_GLOB_RESULTS);
      return { kind: "directory", path: display, entries };
    }
    if (kind === "b") return refusedWith("file-too-large");
    if (kind !== "f") return refusedWith("not-a-file");
    const content = payload.toString("utf8");
    this.#readMarks.set(resolved.path, digest(content));
    return readSlice(display, content, input);
  }

  async write(input: {
    readonly path: string;
    readonly content: string;
  }): Promise<NativeHarnessWriteResult> {
    const lexical = this.#lexical(input.path);
    const guarded = guard(lexical);
    if (guarded !== undefined) return guarded;
    const target = await this.#call(RESOLVE_FOR_WRITE_SCRIPT, [lexical], undefined, 4_096);
    if (target.status !== "ran") return unreachable(target);
    const answer = target.output.toString("utf8");
    const kind = answer[0];
    const path = answer.slice(1);
    if (kind === "x" || !this.#inside(path)) return refusedWith("path-escapes-root");
    const guardedReal = guard(path);
    if (guardedReal !== undefined) return guardedReal;
    if (kind === "o") return refusedWith("not-a-file");
    const put = await this.#call(PUT_SCRIPT, [path], Buffer.from(input.content, "utf8"), 1_024);
    if (put.status !== "ran") return unreachable(put);
    if (put.exitCode !== 0) return refusedWith("not-a-file");
    this.#readMarks.set(path, digest(input.content));
    return {
      kind: "written",
      path: this.#display(path),
      bytes: Buffer.byteLength(input.content, "utf8"),
      created: kind === "n",
    };
  }

  async edit(input: {
    readonly path: string;
    readonly oldText: string;
    readonly newText: string;
    readonly replaceAll?: boolean | undefined;
  }): Promise<NativeHarnessEditResult> {
    const lexical = this.#lexical(input.path);
    const guarded = guard(lexical);
    if (guarded !== undefined) return guarded;
    const resolved = await this.#resolve(READ_SCRIPT, [
      lexical,
      this.#root,
      String(this.#maxFileBytes),
    ]);
    if (resolved.kind === "refused") return resolved;
    const guardedReal = guard(resolved.path);
    if (guardedReal !== undefined) return guardedReal;
    const mark = this.#readMarks.get(resolved.path);
    if (mark === undefined) return refusedWith("not-read-first");
    const kind = String.fromCharCode(resolved.rest[0] ?? 0);
    if (kind === "b") return refusedWith("file-too-large");
    if (kind !== "f") return refusedWith("not-a-file");
    const content = resolved.rest.subarray(1).toString("utf8");
    if (digest(content) !== mark) return refusedWith("file-changed-since-read");
    const edited = editedText(content, input);
    if (edited.kind === "refused") return edited;
    const put = await this.#call(
      PUT_SCRIPT,
      [resolved.path],
      Buffer.from(edited.text, "utf8"),
      1_024,
    );
    if (put.status !== "ran") return unreachable(put);
    if (put.exitCode !== 0) return refusedWith("not-a-file");
    this.#readMarks.set(resolved.path, digest(edited.text));
    return {
      kind: "edited",
      path: this.#display(resolved.path),
      replacements: edited.count,
      fuzzy: edited.fuzzy,
    };
  }

  async glob(input: {
    readonly pattern: string;
    readonly path?: string | undefined;
  }): Promise<NativeHarnessGlobResult> {
    let matcher: RegExp;
    try {
      matcher = globToRegExp(input.pattern);
    } catch {
      return refusedWith("pattern-invalid");
    }
    const descend = SKIPPED_DIRECTORY_NAMES.has(firstSegment(input.pattern)) ? "1" : "0";
    const resolved = await this.#resolve(
      LIST_SCRIPT,
      [this.#lexical(input.path ?? "."), this.#root, descend],
      MAX_LISTING_BYTES,
    );
    if (resolved.kind === "refused") return resolved;
    const base = resolved.path;
    const paths: string[] = [];
    let truncated = resolved.truncated;
    for (const path of resolved.rest.toString("utf8").split("\0")) {
      if (path === "" || !this.#inside(path)) continue;
      if (!matcher.test(posix.relative(base, path))) continue;
      if (paths.length >= MAX_GLOB_RESULTS) {
        truncated = true;
        break;
      }
      paths.push(this.#display(path));
    }
    paths.sort();
    return { kind: "paths", paths, truncated };
  }

  async grep(input: {
    readonly pattern: string;
    readonly path?: string | undefined;
    readonly include?: string | undefined;
    readonly maxMatches?: number | undefined;
  }): Promise<NativeHarnessGrepResult> {
    if (input.pattern.length > MAX_GREP_PATTERN_LENGTH) return refusedWith("pattern-invalid");
    const lexical = this.#lexical(input.path ?? ".");
    const guarded = guard(lexical);
    if (guarded !== undefined) return guarded;
    const resolved = await this.#resolve(
      GREP_SCRIPT,
      [lexical, this.#root, input.pattern, input.include ?? ""],
      MAX_LISTING_BYTES,
    );
    if (resolved.kind === "refused") return resolved;
    if (resolved.exitCode === 2) return refusedWith("pattern-invalid");
    const maxMatches = input.maxMatches ?? 200;
    const matches: NativeHarnessGrepMatch[] = [];
    const files = new Set<string>();
    let returnedBytes = 0;
    let truncated = resolved.truncated;
    // Each match is `path\0line:text\n`; the leading `\0` ends the resolved folder.
    const text = resolved.rest.subarray(1).toString("utf8");
    let at = 0;
    while (at < text.length) {
      const nul = text.indexOf("\0", at);
      if (nul === -1) break;
      const newline = text.indexOf("\n", nul);
      const end = newline === -1 ? text.length : newline;
      const path = text.slice(at, nul);
      const rest = text.slice(nul + 1, end);
      at = end + 1;
      const colon = rest.indexOf(":");
      const line = Number(rest.slice(0, colon));
      if (colon === -1 || !Number.isInteger(line) || !this.#inside(path)) continue;
      // A search across a folder passes over a credential file without
      // returning it, as a local search does.
      if (guard(path) !== undefined) continue;
      files.add(path);
      const found = rest.slice(colon + 1);
      const shown =
        found.length > MAX_GREP_LINE_LENGTH ? `${found.slice(0, MAX_GREP_LINE_LENGTH)}…` : found;
      const bytes = Buffer.byteLength(shown, "utf8") + 32;
      if (matches.length >= maxMatches || returnedBytes + bytes > MAX_GREP_RESULT_BYTES) {
        truncated = true;
        break;
      }
      matches.push({ path: this.#display(path), line, text: shown });
      returnedBytes += bytes;
    }
    return {
      kind: "matches",
      matches,
      filesScanned: files.size,
      bounds: truncated
        ? { truncated, returnedBytes, omittedBytes: 1, nextOffset: matches.length }
        : { truncated, returnedBytes },
    };
  }

  async #resolve(
    script: string,
    args: ReadonlyArray<string>,
    maxOutputBytes = this.#maxFileBytes + 4_096,
  ): Promise<
    | (Extract<Resolved, { readonly kind: "inside" }> & {
        readonly truncated: boolean;
        readonly exitCode: number;
      })
    | NativeHarnessFileRefused
  > {
    const call = await this.#call(script, args, undefined, maxOutputBytes);
    if (call.status !== "ran") return unreachable(call);
    const first = call.output[0];
    if (first === undefined || first === 0x6d /* m */) return refusedWith("path-not-found");
    if (first === 0x78 /* x */) return refusedWith("path-escapes-root");
    const nul = call.output.indexOf(0);
    if (nul === -1) return refusedWith("path-not-found");
    const path = call.output.subarray(0, nul).toString("utf8");
    if (!this.#inside(path)) return refusedWith("path-escapes-root");
    return {
      kind: "inside",
      path,
      rest: call.output.subarray(nul + 1),
      truncated: call.truncated,
      exitCode: call.exitCode,
    };
  }

  #call(
    script: string,
    args: ReadonlyArray<string>,
    stdin: Buffer | undefined,
    maxOutputBytes: number,
  ): Promise<ServerCall> {
    const server = this.#options.server();
    if (server === undefined) {
      return Promise.resolve({
        status: "unreachable",
        message: "The server is no longer registered.",
      });
    }
    return this.#options.connection.run(server, {
      script,
      args,
      ...(stdin === undefined ? {} : { stdin }),
      timeoutMs: CALL_TIMEOUT_MS,
      maxOutputBytes,
      ...(this.#options.signal === undefined ? {} : { signal: this.#options.signal }),
    });
  }

  #lexical(candidate: string): string {
    return posix.isAbsolute(candidate)
      ? posix.normalize(candidate)
      : posix.resolve(this.#root, candidate);
  }

  #inside(path: string): boolean {
    return classifyPathContainment(this.#root, path) === "contained";
  }

  #display(path: string): string {
    const relative = posix.relative(this.#root, path);
    return relative === "" ? "." : relative;
  }
}

function digest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function guard(path: string): NativeHarnessFileRefused | undefined {
  const message = serverCredentialPathRefusal(path);
  return message === undefined ? undefined : { kind: "refused", reason: "protected-file", message };
}

function refusedWith(reason: NativeHarnessFileRefused["reason"]): NativeHarnessFileRefused {
  return { kind: "refused", reason };
}

/** Nothing reached the files; the call says why, and nothing ran on this host instead. */
function unreachable(
  call: Exclude<ServerCall, { readonly status: "ran" }>,
): NativeHarnessFileRefused {
  return {
    kind: "refused",
    reason: "target-unavailable",
    message:
      call.status === "unreachable"
        ? `The server could not be reached (${call.message}). Nothing was read or changed.`
        : "The call to the server did not finish. Nothing was read or changed.",
  };
}
