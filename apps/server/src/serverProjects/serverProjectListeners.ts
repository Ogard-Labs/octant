import type { ServerAddress, ServerConnection } from "./serverConnection";

/** A TCP port a process of the login serves from inside a server Project's folder. */
export interface ServerProjectListener {
  readonly port: number;
  /** The process's short name, never its command line. */
  readonly processName: string;
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
 * Project folder (`$1`). Only the port and the process's short name leave the
 * server; never a command line or another login's process.
 */
export const SERVER_LISTENERS_SCRIPT = `folder="$1"
tab="$(printf '\\t')"
if command -v lsof >/dev/null 2>&1; then
  lsof -nP -a -u "$(id -u)" -iTCP -sTCP:LISTEN -Fpcn 2>/dev/null | awk '
    /^p/ { pid = substr($0, 2) }
    /^c/ { cmd = substr($0, 2) }
    /^n/ { n = split(substr($0, 2), parts, ":"); print pid "\\t" cmd "\\t" parts[n] }'
elif command -v ss >/dev/null 2>&1; then
  ss -Htlnp 2>/dev/null | awk '{
    n = split($4, a, ":"); port = a[n]; s = $0
    while (match(s, /\\("[^"]*",pid=[0-9]+/)) {
      m = substr(s, RSTART, RLENGTH); s = substr(s, RSTART + RLENGTH)
      split(m, b, "\\""); pid = m; sub(/.*pid=/, "", pid)
      print pid "\\t" b[2] "\\t" port
    }
  }'
else
  exit ${String(NO_LISTING_TOOL)}
fi | while IFS="$tab" read -r pid cmd port; do
  cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null)"
  if [ -z "$cwd" ] && command -v lsof >/dev/null 2>&1; then
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  fi
  case "$cwd/" in "$folder"/*) printf '%s\\t%s\\n' "$port" "$cmd" ;; esac
done`;

/** Reads the script's lines: a valid port and a name, each port once, at most 64. */
export function parseServerListeners(output: string): ReadonlyArray<ServerProjectListener> {
  const byPort = new Map<number, ServerProjectListener>();
  for (const line of output.split("\n")) {
    const [portText, name] = line.split("\t");
    if (portText === undefined || name === undefined || !/^\d{1,5}$/.test(portText)) continue;
    const port = Number(portText);
    const processName = name.trim().slice(0, MAX_PROCESS_NAME);
    if (port < 1 || port > 65_535 || processName === "" || byPort.has(port)) continue;
    byPort.set(port, { port, processName });
    if (byPort.size >= MAX_LISTENERS) break;
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
