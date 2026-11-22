import type { ServerAddress, ServerConnection } from "./serverConnection";

/** A TCP port a process of the login serves from inside a server Project's folder. */
export interface ServerProjectListener {
  readonly port: number;
  /** The process's short name, never its command line. */
  readonly processName: string;
  /**
   * Whether the socket answers on `127.0.0.1`, where the preview's SSH forward
   * connects. A socket bound only to `[::1]` or a LAN address shares the port
   * number but not the connection, so it is listed without a Preview.
   */
  readonly loopbackReachable: boolean;
}

export type ServerProjectListenerRead =
  | { readonly status: "listed"; readonly listeners: ReadonlyArray<ServerProjectListener> }
  | { readonly status: "unavailable"; readonly message: string };

const MAX_LISTENERS = 64;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_PROCESS_NAME = 64;
/** Exit status the script gives when the server has neither `lsof` nor `ss`. */
const NO_LISTING_TOOL = 3;

/**
 * Lists the login's own listening TCP sockets with `lsof` (macOS and most
 * Linux) or `ss` (Linux), then keeps those whose process works inside the
 * Project folder (`$1`). Only the port, the bound address and the process's
 * short name leave the server; never a command line or another login's
 * process.
 *
 * The tool is chosen before the pipeline: an `exit` inside a pipeline's left
 * side ends only that subshell, and the empty loop then reported success, so a
 * server with neither tool read as serving nothing. `ss -p` shows every
 * account's processes to a privileged login, so each process must also be
 * owned by the login (`-O` on its `/proc` entry); `lsof -u` already restricts
 * to the login.
 */
export const SERVER_LISTENERS_SCRIPT = `folder="$1"
tab="$(printf '\\t')"
if command -v lsof >/dev/null 2>&1; then tool=lsof
elif command -v ss >/dev/null 2>&1; then tool=ss
else exit ${String(NO_LISTING_TOOL)}
fi
if [ "$tool" = lsof ]; then
  lsof -nP -a -u "$(id -u)" -iTCP -sTCP:LISTEN -Fpcn 2>/dev/null | awk '
    /^p/ { pid = substr($0, 2) }
    /^c/ { cmd = substr($0, 2) }
    /^n/ {
      a = substr($0, 2); n = split(a, parts, ":")
      print pid "\\t" cmd "\\t" parts[n] "\\t" substr(a, 1, length(a) - length(parts[n]) - 1)
    }'
else
  ss -Htlnp 2>/dev/null | awk '{
    n = split($4, a, ":"); port = a[n]; host = substr($4, 1, length($4) - length(port) - 1); s = $0
    while (match(s, /\\("[^"]*",pid=[0-9]+/)) {
      m = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH)
      split(m, b, "\\""); pid = m; sub(/.*pid=/, "", pid)
      print pid "\\t" b[2] "\\t" port "\\t" host
    }
  }'
fi | while IFS="$tab" read -r pid cmd port host; do
  if [ -d "/proc/$pid" ] && [ ! -O "/proc/$pid" ]; then continue; fi
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)"
  if [ -z "$cwd" ] && [ "$tool" = lsof ]; then
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  fi
  case "$cwd/" in "$folder"/*) printf '%s\\t%s\\t%s\\n' "$port" "$cmd" "$host" ;; esac
done`;

/**
 * Bound addresses a connection to `127.0.0.1` reaches: IPv4 loopback and the
 * wildcards the tools write as `*` or `0.0.0.0`. `ss` writes a dual-stack IPv6
 * wildcard as `*` and keeps `[::]` (older `ss`: `::`) for a socket that is
 * IPv6-only, which no IPv4 dial reaches, so a port held only there is listed
 * without a Preview. `lsof` writes every wildcard as `*` and cannot tell an
 * IPv6-only one apart; that case keeps its Preview. `ss` adds an optional
 * `%interface`.
 */
function answersOnIpv4Loopback(host: string): boolean {
  // An IPv4-mapped address (`[::ffff:127.0.0.1]` from `ss`) is that IPv4 endpoint.
  const bare = host
    .trim()
    .replace(/%.*$/, "")
    .replace(/^\[::ffff:([0-9.]+)\]$/i, "$1");
  return ["127.0.0.1", "0.0.0.0", "*"].includes(bare);
}

/**
 * Reads the script's lines: a valid port and a name, each port once, at most
 * 64. A port held on several addresses is previewable when any of them answers
 * on `127.0.0.1`.
 */
export function parseServerListeners(output: string): ReadonlyArray<ServerProjectListener> {
  const byPort = new Map<number, ServerProjectListener>();
  for (const line of output.split("\n")) {
    const [portText, name, host = ""] = line.split("\t");
    if (portText === undefined || name === undefined || !/^\d{1,5}$/.test(portText)) continue;
    const port = Number(portText);
    const processName = name.trim().slice(0, MAX_PROCESS_NAME);
    if (port < 1 || port > 65_535 || processName === "") continue;
    const loopbackReachable = answersOnIpv4Loopback(host);
    const known = byPort.get(port);
    if (known !== undefined) {
      if (loopbackReachable && !known.loopbackReachable) {
        byPort.set(port, { ...known, loopbackReachable });
      }
      continue;
    }
    if (byPort.size >= MAX_LISTENERS) continue;
    byPort.set(port, { port, processName, loopbackReachable });
  }
  return [...byPort.values()].sort((left, right) => left.port - right.port);
}

/** The TCP ports the login serves from the Project folder on its server, read over the pinned connection. */
export async function listServerProjectListeners(input: {
  readonly connection: Pick<ServerConnection, "run">;
  readonly server: ServerAddress;
  readonly folder: string;
}): Promise<ServerProjectListenerRead> {
  const call = await input.connection.run(input.server, {
    script: SERVER_LISTENERS_SCRIPT,
    args: [input.folder.replace(/\/+$/, "")],
    timeoutMs: 15_000,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  if (call.status === "unreachable") return { status: "unavailable", message: call.message };
  if (call.status !== "ran") {
    return { status: "unavailable", message: "The server did not answer in time." };
  }
  if (call.exitCode === NO_LISTING_TOOL) {
    return {
      status: "unavailable",
      message: "The server has neither lsof nor ss, so Octant can't see what it serves.",
    };
  }
  return { status: "listed", listeners: parseServerListeners(call.output.toString("utf8")) };
}
