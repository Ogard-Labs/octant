import { spawn } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeDesktopLeaseId, type DesktopHostTag, type DesktopLeaseId } from "@octant/contracts";
import type {
  DesktopDeliverResult,
  DesktopLaunchPort,
  DesktopLaunchResult,
  DesktopReleaseResult,
  DesktopVerifyGoneResult,
} from "@octant/plugin-api/desktop-provider";
import { DEFAULT_BWRAP_PATH, requireLinuxConfinement } from "../process/linuxConfinement";
import {
  persistProcessReceipt,
  readOwnedProcessReceipts,
  readProcessIdentity,
  terminateOwnedProcess,
  type OwnedProcessReceiptHandle,
} from "../process/nodeOwnedProcessReceipt";
import {
  makeProcessConfinementLive,
  type ProcessConfinementPort,
} from "../process/seatbeltProfile";

/**
 * The host's confined launch port for host-local desktops.
 *
 * Each desktop is one dedicated Bubblewrap launch through the shared
 * confinement port: its own network, PID, IPC, and user namespaces, a
 * read-only synthetic root holding only system directories, a private `/tmp`,
 * and of the host's own files only its lease directory's `home` (writable) and
 * `inbox` (read-only). No checkout, home directory, session bus, keyring, or
 * SSH agent is bound, and its environment is a fixed allowlist, so no
 * `OCTANT_*` value reaches it. Its standard streams are its only channel.
 *
 * The launch is a detached process group with an ownership receipt, so a
 * restarted host finds and reaps it. Bubblewrap's `--die-with-parent` already
 * ends the capsule when the host process dies; the receipt and the lease
 * directory are what restart reconciliation then cleans up. `gone` means the
 * process group, every process in the desktop's PID namespace, the receipt,
 * and the lease directory are all absent.
 */

export interface HostLocalDesktopLaunchOptions {
  /** The host's desktop-lease directory; desktops and receipts live beneath it. */
  readonly directory: string;
  /** This host's tag, which leftovers whose own tag was lost are listed under. */
  readonly hostTag: DesktopHostTag;
  readonly platform: NodeJS.Platform;
  /** Whether the lease service is creating this lease's desktop right now. */
  readonly provisioning: (leaseId: DesktopLeaseId) => boolean;
  readonly confinement?: ProcessConfinementPort;
  readonly bwrapPath?: string;
  /** Where programs are looked up, on the host and inside the capsule alike. */
  readonly searchPath?: ReadonlyArray<string>;
  /** How long each termination signal may take before the next. */
  readonly stopTimeoutMs?: number;
}

/** Directories every desktop capsule binds read-only, so a program found here runs inside. */
const DEFAULT_SEARCH_PATH: ReadonlyArray<string> = ["/usr/local/bin", "/usr/bin", "/bin"];
const PROGRAM_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const RECEIPT_SUPERVISOR = "desktop-lease";
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
/** How long a launch may take to show its own PID namespace before it counts as failed. */
const NAMESPACE_TIMEOUT_MS = 5_000;

interface RunningDesktop {
  readonly pid: number;
  readonly identity: string;
  readonly receipt: OwnedProcessReceiptHandle;
}

export function createHostLocalDesktopLaunch(
  options: HostLocalDesktopLaunchOptions,
): DesktopLaunchPort {
  const confinement = options.confinement ?? makeProcessConfinementLive({ platform: "linux" });
  const bwrapPath = options.bwrapPath ?? DEFAULT_BWRAP_PATH;
  const searchPath = options.searchPath ?? DEFAULT_SEARCH_PATH;
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  const receipts = {
    receiptDirectory: join(options.directory, "receipts"),
    supervisor: RECEIPT_SUPERVISOR,
  };
  const desktops = join(options.directory, "desktops");
  const running = new Map<string, RunningDesktop>();

  const leaseDirectory = (leaseId: DesktopLeaseId) => join(desktops, String(leaseId));
  // Both files sit beside the bound `home` and `inbox`, never inside them, so
  // the desktop cannot rewrite what the host later trusts to find and reap it.
  const namespaceFile = (leaseId: DesktopLeaseId) => join(leaseDirectory(leaseId), "pid-namespace");
  const tagFile = (leaseId: DesktopLeaseId) => join(leaseDirectory(leaseId), "host-tag");

  /**
   * The tag a desktop was made under. Leftovers whose tag cannot be read are
   * still in this host's data directory, so they count as this host's.
   */
  function tagOf(leaseId: DesktopLeaseId): string {
    try {
      return readFileSync(tagFile(leaseId), "utf8").trim();
    } catch {
      return String(options.hostTag);
    }
  }

  function resolveProgram(program: string): string | undefined {
    if (!PROGRAM_NAME.test(program)) return undefined;
    for (const directory of searchPath) {
      const candidate = join(directory, program);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here; try the next directory
      }
    }
    return undefined;
  }

  const readiness: DesktopLaunchPort["readiness"] = (programs) => {
    if (options.platform !== "linux") return { status: "refused", reason: "not-linux" };
    try {
      requireLinuxConfinement(bwrapPath);
    } catch {
      return { status: "refused", reason: "missing:bwrap" };
    }
    const missing = programs.filter((program) => resolveProgram(program) === undefined);
    return missing.length === 0
      ? { status: "ready" }
      : { status: "refused", reason: `missing:${missing.join(",")}` };
  };

  async function receiptsFor(leaseId: DesktopLeaseId) {
    return (await readOwnedProcessReceipts(receipts)).filter(
      (entry) => entry.receipt.ownerId === String(leaseId),
    );
  }

  const launch: DesktopLaunchPort["launch"] = async (request): Promise<DesktopLaunchResult> => {
    if (options.platform !== "linux") return { status: "refused", reason: "not-linux" };
    const executable = resolveProgram(request.program);
    if (executable === undefined) return { status: "refused", reason: "program-missing" };
    // A driver may launch only while the host is creating that lease's
    // desktop, and only once: it cannot start desktops of its own.
    if (!options.provisioning(request.leaseId))
      return { status: "refused", reason: "not-provisioning" };
    const directory = leaseDirectory(request.leaseId);
    if (running.has(String(request.leaseId)) || existsSync(directory)) {
      return { status: "refused", reason: "already-launched" };
    }
    if (request.signal.aborted) return { status: "cancelled" };

    const home = join(directory, "home");
    const inbox = join(directory, "inbox");
    let prepared;
    try {
      mkdirSync(desktops, { recursive: true, mode: 0o700 });
      mkdirSync(directory, { mode: 0o700 });
      mkdirSync(home, { mode: 0o700 });
      mkdirSync(inbox, { mode: 0o700 });
      writeFileSync(tagFile(request.leaseId), String(request.hostTag), { mode: 0o600 });
      prepared = confinement.prepare({
        executable,
        args: request.args,
        boundRoot: home,
        temporaryDirectory: "/tmp",
        networkEgress: "none",
        readRoots: [inbox],
        interpreterSearchPath: searchPath.join(":"),
      });
    } catch {
      removeLeaseDirectory(directory);
      return { status: "failed", reason: "confinement-unavailable" };
    }

    const child = spawn(prepared.command, [...prepared.args], {
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: searchPath.join(":"), HOME: home, TMPDIR: "/tmp", LANG: "C.UTF-8" },
    });
    let hasExited = false;
    const exited = new Promise<void>((resolve) => {
      const done = () => {
        hasExited = true;
        resolve();
      };
      child.once("exit", done);
      child.once("error", done);
    });
    child.stdin?.on("error", () => undefined);
    child.stdout?.on("data", (chunk: Buffer) => {
      // The listener is the driver's code; a throw from it must not escape
      // into the host's event loop.
      try {
        request.output(new Uint8Array(chunk));
      } catch {
        // dropped: what the desktop said is the driver's to interpret
      }
    });
    const pid = child.pid;
    if (pid === undefined) {
      removeLeaseDirectory(directory);
      return { status: "failed", reason: "launch-failed" };
    }

    try {
      const identity = await readProcessIdentity(pid);
      if (identity === undefined) throw new Error("The desktop exited before it was recorded.");
      const receipt = await persistProcessReceipt(receipts, String(request.leaseId), pid);
      await receipt.ready;
      running.set(String(request.leaseId), { pid, identity, receipt });
      const namespace = await ownNamespaceOf(pid, request.signal, () => hasExited);
      if (namespace === undefined) throw new Error("The desktop never entered its own namespace.");
      writeFileSync(namespaceFile(request.leaseId), formatNamespace(namespace), { mode: 0o600 });
    } catch {
      await stop(request.leaseId);
      return request.signal.aborted
        ? { status: "cancelled" }
        : { status: "failed", reason: "launch-failed" };
    }
    if (request.signal.aborted) {
      await stop(request.leaseId);
      return { status: "cancelled" };
    }

    return {
      status: "launched",
      desktop: {
        exited,
        write: (bytes) =>
          new Promise((resolve) => {
            const stdin = child.stdin;
            if (hasExited || stdin === null || stdin.destroyed) {
              resolve({ status: "closed" });
              return;
            }
            stdin.write(bytes, (error) =>
              resolve(
                error === null || error === undefined
                  ? { status: "written" }
                  : { status: "closed" },
              ),
            );
          }),
      },
    };
  };

  const stop: DesktopLaunchPort["stop"] = async (leaseId): Promise<DesktopReleaseResult> => {
    try {
      const live = running.get(String(leaseId));
      const recorded = await receiptsFor(leaseId);
      const targets =
        live === undefined
          ? recorded.map((entry) => ({
              pid: entry.receipt.pid,
              identity: entry.receipt.processIdentity,
            }))
          : [{ pid: live.pid, identity: live.identity }];
      for (const target of targets) {
        await terminateOwnedProcess(
          target.pid,
          target.identity,
          stopTimeoutMs,
          readProcessIdentity,
        );
      }
      // The capsule's PID namespace dies with its init, which Bubblewrap
      // kills with its parent, and the kernel kills everything left in it,
      // nested namespaces included. An init that outlives that is killed
      // directly, and one that survives keeps the lease unreleased.
      const namespace = readNamespace(namespaceFile(leaseId));
      if (namespace !== undefined && !(await namespaceEnds(namespace, stopTimeoutMs))) {
        if (namespaceAlive(namespace)) killQuietly(namespace.init);
        if (!(await namespaceEnds(namespace, stopTimeoutMs))) {
          return { status: "failed", reason: "still-running" };
        }
      }
      await live?.receipt.remove();
      for (const entry of recorded) await unlink(entry.path).catch(() => undefined);
      running.delete(String(leaseId));
      removeLeaseDirectory(leaseDirectory(leaseId));
      return { status: "released" };
    } catch {
      return { status: "failed", reason: "stop-failed" };
    }
  };

  const inspect: DesktopLaunchPort["inspect"] = async (
    leaseId,
  ): Promise<DesktopVerifyGoneResult> => {
    try {
      if (running.has(String(leaseId))) return { status: "present" };
      if ((await receiptsFor(leaseId)).length > 0) return { status: "present" };
      const namespace = readNamespace(namespaceFile(leaseId));
      if (namespace !== undefined && namespaceAlive(namespace)) return { status: "present" };
      if (existsSync(leaseDirectory(leaseId))) return { status: "present" };
      return { status: "gone" };
    } catch {
      return { status: "failed", reason: "inspect-failed" };
    }
  };

  /**
   * The inbox is bound read-only into the desktop, so only the host writes
   * it. The file is written whole beside `home` and `inbox` under a name the
   * desktop never sees, made read-only, then renamed into place, so the
   * desktop never sees a partial file and a second transfer under the same
   * name replaces the first in one step.
   */
  const deliver: DesktopLaunchPort["deliver"] = async (
    leaseId,
    name,
    bytes,
  ): Promise<DesktopDeliverResult> => {
    if (!isInboxName(name)) return { status: "refused", reason: "invalid-name" };
    if (!running.has(String(leaseId))) return { status: "refused", reason: "not-running" };
    const incoming = join(leaseDirectory(leaseId), `incoming-${randomUUID()}`);
    try {
      await writeFile(incoming, bytes, { flag: "wx", mode: 0o600 });
      await chmod(incoming, 0o444);
      await rename(incoming, join(leaseDirectory(leaseId), "inbox", name));
      return { status: "delivered" };
    } catch {
      await unlink(incoming).catch(() => undefined);
      return { status: "failed", reason: "write-failed" };
    }
  };

  const listOwned: DesktopLaunchPort["listOwned"] = async (hostTag) => {
    try {
      const ids = new Map<string, DesktopLeaseId>();
      const remember = (value: string) => {
        const leaseId = leaseIdOrUndefined(value);
        if (leaseId !== undefined && tagOf(leaseId) === String(hostTag)) {
          ids.set(String(leaseId), leaseId);
        }
      };
      for (const entry of await readOwnedProcessReceipts(receipts)) remember(entry.receipt.ownerId);
      if (existsSync(desktops)) for (const name of readdirSync(desktops)) remember(name);
      return { status: "listed", leaseIds: [...ids.values()] };
    } catch {
      return { status: "failed", reason: "list-failed" };
    }
  };

  return { readiness, launch, stop, inspect, deliver, listOwned };
}

/** One file name that stays in the inbox: no separator, no NUL, not `.` or `..`. */
function isInboxName(name: string): boolean {
  return (
    name.length > 0 &&
    Buffer.byteLength(name) <= 255 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\0")
  );
}

function leaseIdOrUndefined(value: string): DesktopLeaseId | undefined {
  try {
    return decodeDesktopLeaseId(value);
  } catch {
    return undefined;
  }
}

/**
 * A desktop may leave directories it made unwritable; they are opened up
 * first so removing its home cannot fail on its own permissions. Links are
 * never followed.
 */
function removeLeaseDirectory(directory: string): void {
  const openUp = (path: string) => {
    const stats = lstatSync(path, { throwIfNoEntry: false });
    if (stats === undefined || !stats.isDirectory()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) openUp(join(path, name));
  };
  openUp(directory);
  rmSync(directory, { recursive: true, force: true });
}

/**
 * A desktop's PID namespace, named by its init process. Namespace numbers are
 * reused once freed (measured: the same `pid:[N]` recurred many times over 300
 * Bubblewrap launches, and every boot restarts them), so the number alone can
 * name another program's namespace after the desktop is gone. Its init's start
 * time and the boot it started in say whether the namespace is still the
 * desktop's: a PID namespace lives exactly as long as its init.
 */
interface DesktopNamespace {
  readonly namespace: string;
  readonly init: number;
  readonly started: string;
  readonly boot: string;
}

function formatNamespace(namespace: DesktopNamespace): string {
  return `${namespace.namespace} ${namespace.init} ${namespace.started} ${namespace.boot}\n`;
}

function readNamespace(path: string): DesktopNamespace | undefined {
  let value: string;
  try {
    value = readFileSync(path, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const match = /^(pid:\[[0-9]+\]) ([0-9]+) ([0-9]+) ([0-9a-f-]{36})$/.exec(value);
  if (match === null) return undefined;
  const [, namespace = "", init = "", started = "", boot = ""] = match;
  return { namespace, init: Number(init), started, boot };
}

function bootId(): string {
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

/** A process's `/proc` stat fields after its command name, or undefined once it is reaped. */
function statFields(pid: number | string): ReadonlyArray<string> | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ESRCH") return undefined;
    throw error;
  }
}

/**
 * Whether a process of the desktop's namespace still runs. The kernel kills
 * every other process in it before its init exits, so an init that is gone or
 * a zombie means none does. A zombie waits on whichever process adopted it,
 * which on a host whose init never reaps would otherwise hold every release.
 */
function namespaceAlive(namespace: DesktopNamespace): boolean {
  if (namespace.boot !== bootId()) return false;
  const fields = statFields(namespace.init);
  if (fields === undefined || fields[0] === "Z" || fields[0] === "X") return false;
  return fields[19] === namespace.started;
}

async function namespaceEnds(namespace: DesktopNamespace, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (namespaceAlive(namespace)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

/**
 * The PID namespace of the launch's capsule: Bubblewrap's child, which is the
 * namespace's init. A launch whose child shares the host's namespace never
 * entered a capsule, and counts as failed. Once the launch has exited its PID
 * may be reused, so the search stops there rather than adopt a stranger's child.
 */
async function ownNamespaceOf(
  pid: number,
  signal: AbortSignal,
  hasExited: () => boolean,
): Promise<DesktopNamespace | undefined> {
  const host = readlinkSync("/proc/self/ns/pid");
  const boot = bootId();
  const deadline = Date.now() + NAMESPACE_TIMEOUT_MS;
  while (Date.now() < deadline && !signal.aborted && !hasExited()) {
    for (const name of readdirSync("/proc").filter((entry) => /^[0-9]+$/.test(entry))) {
      try {
        const fields = statFields(name);
        if (fields?.[1] !== String(pid)) continue;
        const started = fields[19];
        const namespace = readlinkSync(`/proc/${name}/ns/pid`);
        if (namespace === host || started === undefined) return undefined;
        return { namespace, init: Number(name), started, boot };
      } catch {
        // exited while being read
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return undefined;
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}
