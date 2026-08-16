import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MAX_LOCAL_SERVER_LISTENERS } from "@octant/contracts";
import type { LocalListenerOwnership } from "@octant/domain";

const run = promisify(execFile);

/** Bound on the observation subprocess so a wedged host tool cannot hang a scan. */
const LISTENER_SCAN_TIMEOUT_MS = 4_000;
const LISTENER_SCAN_MAX_BUFFER = 2 * 1024 * 1024;

/**
 * How many per-pid working-directory queries may be in flight at once.
 *
 * The panel refreshes every five seconds, so a scan that outlives its own
 * refresh interval leaves the section stuck on whatever it first loaded.
 * Resolving pids one at a time made the worst case the sum of every subprocess
 * timeout; the contract admits 200 listeners, so that is over thirteen minutes.
 *
 * Eight is a cap rather than a fan-out. A real host has a handful of listening
 * processes, which this resolves in a single wave, while a pathological one is
 * held to eight concurrent host queries instead of two hundred — bounding both
 * the wall time and the load a background poll may place on the machine.
 */
export const LISTENER_CWD_SCAN_CONCURRENCY = 8;

/**
 * How long the whole enrichment phase — every per-pid working directory plus
 * the one process-table read — may take before the scan reports what it has.
 *
 * Concurrency alone bounds how many host queries run at once, not how many run
 * in total, so a host with many slow processes still walks the pid list one
 * wave at a time. This is the ceiling on that walk.
 *
 * Three seconds sits below the `LISTENER_SCAN_TIMEOUT_MS` a single host query
 * may take, so one wedged `lsof` is cut short by this deadline rather than
 * spending the whole budget waiting for its own timeout, and it leaves the rest
 * of the panel's five-second refresh interval to the listener listing and the
 * service's classification. A normal host resolves every pid in milliseconds
 * and never reaches it.
 *
 * Passing it changes nothing about what the scan *claims*: unresolved pids
 * simply carry no working directory and no lineage, the same "no corroboration"
 * both resolvers already fail closed to, never a guessed one.
 */
export const LISTENER_ENRICHMENT_DEADLINE_MS = 3_000;

/**
 * One raw TCP listener as the host observed it, before classification.
 *
 * `pid` lives only on this side of the boundary: the service uses it to signal
 * a process it has just re-classified, and never copies it into any contract
 * the renderer or a remote client can see.
 */
export interface ObservedLocalListener {
  readonly pid: number;
  readonly port: number;
  /** Process or app name only — never a full command line. */
  readonly processName: string;
  /** Command hint, e.g. the script name, when the host could read one. */
  readonly commandName?: string;
  readonly ownership: LocalListenerOwnership;
  readonly workingDirectory?: string;
  /** Ancestor process names, nearest first. */
  readonly lineage?: ReadonlyArray<string>;
  /** Address the socket is bound to, e.g. `127.0.0.1` or `*`. */
  readonly bindAddress: string;
}

/**
 * Outcome of one host scan.
 *
 * `unavailable` is deliberately not an empty `observed` scan. "Nothing is
 * listening" and "Octant could not look" are different facts, and only the
 * first one is something the host ever established. Reporting a missing,
 * denied, or wedged `lsof` as zero listeners would put an assertion the host
 * never made in front of the user, so the failure travels as a value every
 * caller must decide about.
 */
export type LocalListenerObservation =
  | {
      readonly status: "observed";
      readonly listeners: ReadonlyArray<ObservedLocalListener>;
    }
  | {
      /** The host could not complete a scan; it says nothing about what is running. */
      readonly status: "unavailable";
    };

export interface LocalListenerPort {
  observe(signal?: AbortSignal): Promise<LocalListenerObservation>;
}

export type ListenerCommandExecutor = (
  command: string,
  args: ReadonlyArray<string>,
  signal?: AbortSignal,
) => Promise<string>;

export interface LiveLocalListenerPortOptions {
  /** Injected so tests drive parsing without spawning a host process. */
  readonly execute?: ListenerCommandExecutor;
  readonly currentUid?: number;
  readonly resolveWorkingDirectory?: (
    pid: number,
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
  /** One snapshot of the host process table, read once per scan. */
  readonly readProcessTable?: (signal?: AbortSignal) => Promise<ReadonlyMap<number, PsTableEntry>>;
}

/** Ancestor walk bound so a corrupt ppid table can never loop the scan. */
const MAX_LINEAGE_DEPTH = 16;

/**
 * Observation of current-user TCP listeners via `lsof`.
 *
 * Arbitrary host-process discovery is out of scope; observation is narrowed to
 * *listening sockets owned by the current user*, which is the minimum needed to
 * tell a leftover dev server from a port nobody is serving. `-a -u <uid>` keeps
 * the kernel query itself scoped to this user, so root and other-user
 * processes never enter the pipeline rather than being filtered afterwards.
 *
 * Each listener is enriched with the facts the classifier's honesty rule needs
 * before it may list a bare interpreter: the process working directory (macOS:
 * `lsof -a -p <pid> -d cwd`) and the ancestor command lineage (`ps` ppid walk).
 * Both fail closed — an error yields *no* corroboration, never a fabricated cwd
 * — which keeps an unreadable process omitted rather than guessed at.
 *
 * The enrichment is shaped by the panel's five-second refresh, which skips a
 * poll while a scan is still outstanding. One `ps` snapshot serves every pid's
 * lineage; the per-pid `lsof` queries run with bounded concurrency; only the
 * listeners the service will publish are enriched at all; and the whole phase
 * is bounded by `LISTENER_ENRICHMENT_DEADLINE_MS`. Bounding how many queries
 * run at once is not the same as bounding how many run, or how long they may
 * take, so all three limits are needed to keep a scan inside the interval.
 *
 * A scan cut short by either bound is still `observed` — it saw real listeners,
 * some with less corroboration. Only a host that could not look is
 * `unavailable`.
 */
export function createLiveLocalListenerPort(
  options: LiveLocalListenerPortOptions = {},
): LocalListenerPort {
  const execute = options.execute ?? defaultExecute;
  const uid = options.currentUid ?? process.getuid?.();
  const resolveWorkingDirectory =
    options.resolveWorkingDirectory ?? createLsofWorkingDirectoryResolver(execute);
  const readProcessTable = options.readProcessTable ?? createPsProcessTableReader(execute);

  return {
    async observe(signal) {
      // Without the current uid the query cannot be scoped to this user at all,
      // so the host has no scan to report rather than an empty one.
      if (uid === undefined) return { status: "unavailable" };
      let output: string;
      try {
        output = await execute(
          "lsof",
          ["-nP", "+c", "0", "-a", "-u", String(uid), "-iTCP", "-sTCP:LISTEN", "-FpcnLu"],
          signal,
        );
      } catch {
        // A host without `lsof`, one that refused the query, or one whose tool
        // timed out established nothing. Refusing to report a *partial* scan is
        // right, but reporting a *failed* one as zero listeners is a different
        // thing: it would tell the user no servers are running on the strength
        // of a query that never ran.
        return { status: "unavailable" };
      }
      // The service publishes at most `MAX_LOCAL_SERVER_LISTENERS` listeners,
      // so enriching past that spends host queries on rows it is about to drop.
      // Bounding the *listeners* rather than the pids keeps the two budgets the
      // same rule: these are exactly the entries the service slices. Its own
      // limit is overridable and may be smaller, which only makes this a
      // superset — never a second, larger number that could disagree.
      const parsed = parseLsofFields(output, uid).slice(0, MAX_LOCAL_SERVER_LISTENERS);
      // A process serving several ports repeats in the parse; resolve each
      // pid's facts once so one wedged listener cannot multiply host queries.
      const pids = [...new Set(parsed.map((entry) => entry.pid))];
      const { workingDirectories, processTable } = await resolveListenerFacts(
        pids,
        resolveWorkingDirectory,
        readProcessTable,
        signal,
      );

      const listeners = parsed.map((entry) => {
        const workingDirectory = workingDirectories.get(entry.pid);
        const lineage = walkLineage(processTable, entry.pid);
        return {
          ...entry,
          ...(workingDirectory === undefined ? {} : { workingDirectory }),
          ...(lineage.length === 0 ? {} : { lineage }),
        };
      });
      return { status: "observed", listeners };
    },
  };
}

/**
 * Working directory of one process via `lsof -a -p <pid> -d cwd`. This is the
 * fact that lets the classifier corroborate a bare `node`/`python` against a
 * user project root. Anything unreadable — missing tool, denied query, output
 * without an absolute cwd path — resolves to `undefined`, never a guess.
 */
export function createLsofWorkingDirectoryResolver(
  execute: ListenerCommandExecutor,
): (pid: number, signal?: AbortSignal) => Promise<string | undefined> {
  return async (pid, signal) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
    try {
      const output = await execute(
        "lsof",
        ["-nP", "-a", "-p", String(pid), "-d", "cwd", "-Fn"],
        signal,
      );
      return parseLsofCwd(output);
    } catch {
      return undefined;
    }
  };
}

/** Everything one scan could corroborate before its deadline ran out. */
interface ListenerFacts {
  readonly workingDirectories: ReadonlyMap<number, string | undefined>;
  readonly processTable: ReadonlyMap<number, PsTableEntry>;
}

/**
 * Corroborate the budgeted pids: each one's working directory, plus the single
 * process table every lineage is walked from, within
 * `LISTENER_ENRICHMENT_DEADLINE_MS`.
 *
 * The deadline and the caller's abort share one controller, so either ends the
 * phase, both stop the workers issuing further host queries, and both cancel
 * the host queries already running. Whatever resolved by then is kept; the rest
 * is simply absent, which reads downstream as no corroboration.
 *
 * The timer and the caller's abort listener are released on every exit, so a
 * scan that finishes early leaves nothing pending behind it.
 */
async function resolveListenerFacts(
  pids: ReadonlyArray<number>,
  resolveWorkingDirectory: (pid: number, signal?: AbortSignal) => Promise<string | undefined>,
  readProcessTable: (signal?: AbortSignal) => Promise<ReadonlyMap<number, PsTableEntry>>,
  signal?: AbortSignal,
): Promise<ListenerFacts> {
  const deadline = new AbortController();
  const stop = () => deadline.abort();
  const timer = setTimeout(stop, LISTENER_ENRICHMENT_DEADLINE_MS);
  signal?.addEventListener("abort", stop, { once: true });

  const workingDirectories = new Map<number, string | undefined>();
  let processTable: ReadonlyMap<number, PsTableEntry> = new Map();
  try {
    if (signal?.aborted !== true) {
      // One `ps` snapshot answers every pid's lineage, and it overlaps the cwd
      // queries rather than waiting behind them.
      const table = readProcessTable(deadline.signal).then((read) => {
        processTable = read;
      });
      const cwds = resolveWorkingDirectories(
        pids,
        resolveWorkingDirectory,
        workingDirectories,
        deadline.signal,
      );
      await Promise.race([Promise.all([table, cwds]), aborted(deadline.signal)]);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
  return { workingDirectories, processTable };
}

/** Resolves — never rejects — the moment `signal` aborts. */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Resolve every pid's working directory into `resolved` with at most
 * `LISTENER_CWD_SCAN_CONCURRENCY` host queries in flight.
 *
 * Each pid appears once, so a process serving several ports is still queried
 * once. An abandoned scan has no reader, so an abort stops the workers from
 * starting further host queries rather than draining the whole pid list. The
 * map is filled as it goes so the facts already gathered survive a deadline
 * that lands mid-walk.
 */
async function resolveWorkingDirectories(
  pids: ReadonlyArray<number>,
  resolve: (pid: number, signal?: AbortSignal) => Promise<string | undefined>,
  resolved: Map<number, string | undefined>,
  signal: AbortSignal,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(LISTENER_CWD_SCAN_CONCURRENCY, pids.length) },
    async () => {
      while (next < pids.length) {
        if (signal.aborted) return;
        const pid = pids[next++]!;
        resolved.set(pid, await resolve(pid, signal));
      }
    },
  );
  await Promise.all(workers);
}

/**
 * One snapshot of the host process table, from which every listener's ancestor
 * lineage is walked. The names feed the classifier's editor/agent lineage rule
 * (Octant, VS Code, Claude, Codex, …). Any failure resolves to an empty table —
 * "no corroboration" for every pid — rather than an invented ancestry.
 *
 * Reading it once per scan rather than once per pid is what keeps a host with
 * many listeners from spending a full `ps` on each of them.
 */
export function createPsProcessTableReader(
  execute: ListenerCommandExecutor,
): (signal?: AbortSignal) => Promise<ReadonlyMap<number, PsTableEntry>> {
  return async (signal) => {
    try {
      return parsePsTable(await execute("ps", ["-axo", "pid=,ppid=,comm="], signal));
    } catch {
      return new Map();
    }
  };
}

async function defaultExecute(
  command: string,
  args: ReadonlyArray<string>,
  signal?: AbortSignal,
): Promise<string> {
  const { stdout } = await run(command, [...args], {
    timeout: LISTENER_SCAN_TIMEOUT_MS,
    maxBuffer: LISTENER_SCAN_MAX_BUFFER,
    ...(signal === undefined ? {} : { signal }),
  });
  return stdout;
}

/**
 * Parse `lsof -F` field output. Each record starts with `p<pid>`; `c` carries
 * the command name, `u` the owning uid, and `n` the bound address. Anything the
 * parser cannot read completely is dropped rather than guessed.
 *
 * The scan passes `+c 0`, so `c` is the untruncated command title — e.g.
 * `next-server (v15.1.0)`. When that title has more than one word, its first
 * word becomes `commandName`, the argv-style hint the classifier matches
 * against known framework commands.
 */
export function parseLsofFields(
  output: string,
  currentUid: number,
): ReadonlyArray<Omit<ObservedLocalListener, "workingDirectory" | "lineage">> {
  const listeners: Array<Omit<ObservedLocalListener, "workingDirectory" | "lineage">> = [];
  let pid: number | undefined;
  let processName: string | undefined;
  let commandName: string | undefined;
  let owner: number | undefined;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      pid = toPositiveInteger(value);
      processName = undefined;
      commandName = undefined;
      owner = undefined;
      continue;
    }
    if (tag === "c") {
      processName = value.trim() === "" ? undefined : value.trim();
      const firstWord = processName?.split(/\s+/, 1)[0];
      commandName = firstWord !== undefined && firstWord !== processName ? firstWord : undefined;
      continue;
    }
    if (tag === "u") {
      owner = toPositiveInteger(value) ?? (value === "0" ? 0 : undefined);
      continue;
    }
    if (tag !== "n") continue;

    const address = parseListenAddress(value);
    if (pid === undefined || processName === undefined || address === undefined) continue;
    listeners.push({
      pid,
      port: address.port,
      processName,
      ...(commandName === undefined ? {} : { commandName }),
      ownership: resolveOwnership(owner, currentUid),
      bindAddress: address.host,
    });
  }
  return listeners;
}

/**
 * Extract the cwd path from `lsof -a -p <pid> -d cwd -Fn` output: an `fcwd`
 * field followed by its `n` path. Only an absolute path counts; anything else
 * is treated as unreadable.
 */
export function parseLsofCwd(output: string): string | undefined {
  let inCwdRecord = false;
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "") continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "f") {
      inCwdRecord = value === "cwd";
      continue;
    }
    if (tag === "n" && inCwdRecord && value.startsWith("/")) return value;
  }
  return undefined;
}

/** One `pid ppid comm` row from a `ps -axo pid=,ppid=,comm=` snapshot. */
export interface PsTableEntry {
  readonly parentPid: number;
  readonly commandName: string;
}

/**
 * Parse a `ps -axo pid=,ppid=,comm=` snapshot into a pid-keyed table. Rows the
 * parser cannot read completely are dropped rather than guessed.
 */
export function parsePsTable(output: string): ReadonlyMap<number, PsTableEntry> {
  const table = new Map<number, PsTableEntry>();
  for (const rawLine of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(rawLine);
    if (match === null) continue;
    const pid = toPositiveInteger(match[1]!);
    const parentPid = Number(match[2]);
    const commandName = match[3]!;
    if (pid === undefined || !Number.isSafeInteger(parentPid) || commandName === "") continue;
    table.set(pid, { parentPid, commandName });
  }
  return table;
}

/**
 * Ancestor command names for `pid`, nearest first, excluding the process
 * itself. Stops at init/launchd, an unknown parent, or the depth bound, so a
 * corrupt table yields a short honest lineage instead of a loop.
 */
export function walkLineage(
  table: ReadonlyMap<number, PsTableEntry>,
  pid: number,
): ReadonlyArray<string> {
  const lineage: string[] = [];
  const visited = new Set<number>([pid]);
  let current = table.get(pid)?.parentPid;
  while (
    current !== undefined &&
    current > 1 &&
    !visited.has(current) &&
    lineage.length < MAX_LINEAGE_DEPTH
  ) {
    const entry = table.get(current);
    if (entry === undefined) break;
    lineage.push(entry.commandName);
    visited.add(current);
    current = entry.parentPid;
  }
  return lineage;
}

function resolveOwnership(owner: number | undefined, currentUid: number): LocalListenerOwnership {
  if (owner === undefined) return "other-user";
  if (owner === 0) return "root";
  return owner === currentUid ? "current-user" : "other-user";
}

/**
 * Extract host and port from an `lsof` name field such as `127.0.0.1:5173`,
 * `*:3000`, or `[::1]:8080`. A field without a numeric port is not a listener
 * this surface can reason about and is dropped.
 */
export function parseListenAddress(
  value: string,
): { readonly host: string; readonly port: number } | undefined {
  const name = value.split("->")[0]?.trim() ?? "";
  const separator = name.lastIndexOf(":");
  if (separator <= 0) return undefined;
  const port = toPositiveInteger(name.slice(separator + 1));
  if (port === undefined || port > 65_535) return undefined;
  const host = name.slice(0, separator).replace(/^\[|\]$/g, "");
  return host === "" ? undefined : { host, port };
}

function toPositiveInteger(value: string): number | undefined {
  if (!/^\d+$/.test(value.trim())) return undefined;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
