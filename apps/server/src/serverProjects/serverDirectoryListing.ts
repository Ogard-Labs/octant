import { posix } from "node:path";
import { classifyPathContainment } from "@octant/domain";
import { RESOLVE_INSIDE, serverCredentialPathRefusal, withProtectedPaths } from "./serverFiles";
import type { ServerAddress, ServerConnection } from "./serverConnection";

export type ServerDirectoryEntry =
  | { readonly kind: "directory"; readonly path: string }
  | { readonly kind: "file"; readonly path: string; readonly byteLength: number };

export type ServerDirectoryListing =
  | {
      readonly status: "listed";
      readonly entries: ReadonlyArray<ServerDirectoryEntry>;
      readonly truncated: boolean;
    }
  | {
      readonly status: "failed";
      readonly category: "unavailable" | "not-found";
      readonly message: string;
    };

// Resolve and protect every entry on the server before returning its name or
// size, using the same remote root and protected-path rules as file reads.
const BROWSE_SCRIPT = `${RESOLVE_INSIDE}
[ -d "$r" ] || { printf 'o'; exit 0; }
printf 'd'
cd -- "$r" || exit 3
find . -mindepth 1 -maxdepth "$3" \\( -name .git -o -name node_modules \\) -type d -prune \\
  -o \\( -type d -o -type f \\) -exec sh -c '
root=$1; protected=$2; shift 2
for entry; do
  [ ! -L "$entry" ] || continue
  resolved=$(realpath -- "$entry") || continue
  case "$resolved" in "$root"/*) ;; *) continue;; esac
  printf "%s\\n" "$resolved" | grep -Eiq -e "$protected"
  [ "$?" -eq 1 ] || continue
  relative=\${resolved#"$root"/}
  if [ -d "$resolved" ]; then
    printf "d%s\\0" "$relative"
  elif [ -f "$resolved" ]; then
    size=$(stat -c %s -- "$resolved" 2>/dev/null || stat -f %z -- "$resolved" 2>/dev/null) || { printf "x\\0"; continue; }
    printf "f%s:%s\\0" "$size" "$relative"
  fi
done
' sh "$2" "$protected" {} +`;

/** Bounded metadata only, shared by Code and Work without either mode's ids. */
export async function listServerDirectory(
  options: {
    readonly connection: Pick<ServerConnection, "run">;
    readonly server: () => ServerAddress | undefined;
    readonly root: string;
    readonly maxDepth: number;
    readonly maxEntries: number;
  },
  input: { readonly directory?: string | undefined; readonly signal?: AbortSignal | undefined },
): Promise<ServerDirectoryListing> {
  const server = options.server();
  if (server === undefined || input.signal?.aborted)
    return {
      status: "failed",
      category: "unavailable",
      message: "This server folder is unavailable.",
    };
  const root = posix.normalize(options.root);
  const start = posix.resolve(root, input.directory ?? ".");
  if (!posix.isAbsolute(root) || classifyPathContainment(root, start) !== "contained")
    return {
      status: "failed",
      category: "not-found",
      message: "That folder is not inside this Project on the server.",
    };
  const call = await options.connection.run(server, {
    script: withProtectedPaths(BROWSE_SCRIPT),
    args: [start, root, String(options.maxDepth + 1)],
    timeoutMs: 30_000,
    maxOutputBytes: 8 * 1024 * 1024,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  if (call.status !== "ran" || call.exitCode !== 0 || input.signal?.aborted)
    return {
      status: "failed",
      category: "unavailable",
      message: "The server folder could not be listed. Refresh to try again.",
    };
  // A changed registry or binding must not release the old host's names.
  const current = options.server();
  if (current === undefined || current.alias !== server.alias || current.user !== server.user)
    return {
      status: "failed",
      category: "unavailable",
      message: "This server folder changed while it was being read.",
    };
  const nul = call.output.indexOf(0);
  const resolved = nul < 0 ? "" : call.output.subarray(0, nul).toString("utf8");
  if (
    nul < 0 ||
    classifyPathContainment(root, resolved) !== "contained" ||
    call.output[nul + 1] !== 0x64
  )
    return {
      status: "failed",
      category: "not-found",
      message: "That folder is not inside this Project on the server.",
    };
  let records = call.output.subarray(nul + 2);
  let truncated = call.truncated;
  // Boundaries are bytes: an output limit can cut a UTF-8 character in half.
  // Decode only complete NUL-terminated records, retaining earlier names.
  if (records.length > 0 && records[records.length - 1] !== 0) {
    truncated = true;
    records = records.subarray(0, records.lastIndexOf(0) + 1);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(records);
  } catch {
    return {
      status: "failed",
      category: "unavailable",
      message: "The server returned an unreadable file listing.",
    };
  }
  const found: ServerDirectoryEntry[] = [];
  for (const record of text.split("\0")) {
    if (record === "") continue;
    const kind = record[0];
    const colon = kind === "f" ? record.indexOf(":") : -1;
    const path = kind === "d" ? record.slice(1) : colon < 0 ? "" : record.slice(colon + 1);
    if (
      path === "" ||
      posix.isAbsolute(path) ||
      posix.normalize(path) !== path ||
      classifyPathContainment(root, posix.join(root, path)) !== "contained" ||
      serverCredentialPathRefusal(posix.join(root, path)) !== undefined
    ) {
      truncated = true;
      continue;
    }
    const candidate = posix.join(root, path);
    if (classifyPathContainment(resolved, candidate) !== "contained") {
      truncated = true;
      continue;
    }
    if (posix.relative(resolved, candidate).split("/").length > options.maxDepth) {
      truncated = true;
      continue;
    }
    if (kind === "d") found.push({ kind: "directory", path });
    else if (kind === "f") {
      const size = record.slice(1, colon);
      const byteLength = Number(size);
      if (/^\d+$/.test(size) && Number.isSafeInteger(byteLength) && byteLength >= 0)
        found.push({ kind: "file", path, byteLength });
      else truncated = true;
    } else truncated = true;
  }
  found.sort(
    (a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path),
  );
  return {
    status: "listed",
    entries: found.slice(0, options.maxEntries),
    truncated: truncated || found.length > options.maxEntries,
  };
}
