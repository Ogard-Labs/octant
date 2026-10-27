import { spawn, type ChildProcess } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Schema } from "effect";
import {
  SshRemoteUser,
  type SshConfinedPosture,
  type SshConfinementBackendFacts,
  type SshConfinementCanaryOutcome,
  type SshConfinementCanaryProbe,
  type SshConfinementCanaryResult,
  type SshExecutorIdentityFacts,
  type SshPostureCanaries,
} from "@octant/contracts/ssh-target";
import type {
  SshExecutorAttestRequest,
  SshExecutorAttestedReply,
} from "@octant/contracts/ssh-executor-protocol";
import {
  DEFAULT_SANDBOX_PATH,
  makeProcessConfinementLive,
  type ProcessConfinementPort,
  type ProcessConfinementPrepareInput,
} from "../process/seatbeltProfile";
import { DEFAULT_BWRAP_PATH } from "../process/linuxConfinement";
import { LINUX_EGRESS_FORWARDER_PORT } from "../process/proxiedNetworkEgress";
import { siblingSessionDirectoryName } from "./executorRuntimeDirectory";
import { runtimeLaunchGrants } from "./executorRuntimeGrants";

/**
 * The executor's side of attestation: report the facts the host's admission
 * policy asks about, and launch each canary probe through this build's own
 * ProcessConfinementPort with the posture's grants. Canonical:
 * docs/design/remote-ssh-environments.md § Confinement attestation and
 * admission.
 *
 * The executor reports and the host decides. A probe reports `refused` only
 * when the confined program itself says the forbidden action failed; a probe
 * that could not run, timed out, or tried an action that is impossible on this
 * target even unconfined reports `inconclusive`, which proves nothing.
 */

const POSIX_SHELL = "/bin/sh";
const PROBE_TIMEOUT_MS = 20_000;
const CONTROL_CONNECT_TIMEOUT_MS = 3_000;
const MAX_PROBE_OUTPUT_BYTES = 4_096;

/**
 * The grants Octant's own launches on a target run with in each confined
 * posture, apart from the network. Plan reaches no network; the writing
 * postures reach only their forwarder (`proxied`), and their canaries run
 * through one, so the probe that connects around it proves that nothing else
 * leaves the capsule.
 */
export function postureGrants(
  posture: SshConfinedPosture,
): Pick<
  ProcessConfinementPrepareInput,
  "writeBoundRoot" | "allowProcessExec" | "allowProcessFork"
> {
  if (posture === "plan") {
    return { writeBoundRoot: false, allowProcessExec: false, allowProcessFork: false };
  }
  return { writeBoundRoot: true, allowProcessExec: true, allowProcessFork: true };
}

/**
 * The confined program each probe runs, under this executor's own runtime.
 * It prints the nonce and its verdict on one line; anything else is
 * inconclusive. It reads no file's contents back to the executor.
 */
const CANARY_PROBE_SOURCE = `"use strict";
const fs = require("node:fs");
const net = require("node:net");
const childProcess = require("node:child_process");
const [probe, nonce, target, port] = process.argv.slice(2);
const report = (escaped) => process.stdout.write(nonce + " " + (escaped ? "escaped" : "refused") + "\\n");
const succeeds = (action) => { try { action(); return true; } catch { return false; } };
const ran = (command, args) => succeeds(() => {
  const result = childProcess.spawnSync(command, args, { stdio: "ignore", timeout: 5000 });
  if (result.error !== undefined || result.status !== 0) throw new Error("did not run");
});
switch (probe) {
  case "write-inside-root":
  case "write-outside-root":
  case "runtime-write-inside-root":
  case "runtime-write-read-only-account-state":
  case "runtime-write-outside-root-and-home":
    report(succeeds(() => fs.writeFileSync(target, "octant canary")));
    break;
  case "read-ssh-directory":
  case "runtime-read-ssh-directory":
    report(succeeds(() => fs.opendirSync(target).closeSync()));
    break;
  case "read-sibling-folder":
  case "read-other-session-runtime":
  case "runtime-read-other-runtime-home":
    report(succeeds(() => fs.readFileSync(target)));
    break;
  case "fork-after-start":
  case "runtime-fork-after-start":
    report(ran(process.execPath, ["-e", "0"]));
    break;
  case "exec-after-start":
  case "runtime-exec-after-start":
    report(ran(target, ["-c", "exit 0"]));
    break;
  case "open-network-socket":
  case "connect-bypassing-forwarder":
  case "runtime-connect-bypassing-proxy": {
    let settled = false;
    const settle = (escaped) => { if (!settled) { settled = true; socket.destroy(); report(escaped); } };
    const socket = net.connect({ host: target, port: Number(port) });
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    setTimeout(() => settle(false), 3000).unref();
    break;
  }
  default:
    process.exitCode = 2;
}
`;

export interface ExecutorAttestationEnvironment {
  readonly identity: SshExecutorIdentityFacts;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly uid: number;
  readonly username: string | undefined;
  readonly homeDirectory: string;
  /** The JavaScript runtime running this executor; probes run under it. */
  readonly runtimeExecutable: string;
  /** This session's owner-only directory, or undefined when none could be made. */
  readonly sessionDirectory: string | undefined;
  /** The per-user parent of every session directory. */
  readonly sessionParent: string | undefined;
  /**
   * The address the target's SSH server answered on, from `SSH_CONNECTION`.
   * The network probes try to reach it: the server is listening, so a probe
   * that cannot connect was stopped by its confinement.
   */
  readonly sshServerAddress: { readonly host: string; readonly port: number } | undefined;
  readonly confinement?: ProcessConfinementPort;
  readonly bwrapPath?: string;
  readonly sandboxExecPath?: string;
}

export async function attestExecutorConfinement(
  environment: ExecutorAttestationEnvironment,
  request: SshExecutorAttestRequest,
): Promise<SshExecutorAttestedReply> {
  const backend = await confinementBackendFacts(environment);
  // A root executor's children can undo their own confinement, so the host
  // refuses root before canaries; launching them would only add risk.
  const canaries = environment.uid === 0 ? [] : await runCanaries(environment, request.postures);
  const remoteUser =
    environment.username !== undefined && Schema.is(SshRemoteUser)(environment.username)
      ? environment.username
      : undefined;
  return {
    kind: "attested",
    ...(remoteUser === undefined ? {} : { remoteUser }),
    facts: {
      identity: environment.identity,
      platform: {
        operatingSystem: environment.platform,
        architecture: environment.architecture,
        uid: environment.uid,
      },
      backend,
      canaries,
    },
  };
}

/** Parses `SSH_CONNECTION` ("client-ip client-port server-ip server-port"). */
export function sshServerAddressFrom(
  value: string | undefined,
): ExecutorAttestationEnvironment["sshServerAddress"] {
  const parts = value?.trim().split(/\s+/u);
  if (parts?.length !== 4) return undefined;
  const host = parts[2];
  const port = Number(parts[3]);
  if (host === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return undefined;
  }
  return { host, port };
}

async function confinementBackendFacts(
  environment: ExecutorAttestationEnvironment,
): Promise<SshConfinementBackendFacts> {
  if (environment.platform === "darwin") {
    return {
      kind: "seatbelt",
      sandboxExecExecutable: executable(environment.sandboxExecPath ?? DEFAULT_SANDBOX_PATH),
    };
  }
  if (environment.platform !== "linux") return { kind: "none" };
  const bwrapPath = environment.bwrapPath ?? DEFAULT_BWRAP_PATH;
  const bwrapExecutable = executable(bwrapPath);
  return {
    kind: "bubblewrap",
    bwrapExecutable,
    unprivilegedUserNamespaces:
      bwrapExecutable &&
      (await exitsCleanly(bwrapPath, [
        "--unshare-user",
        "--ro-bind",
        "/",
        "/",
        "--",
        environment.runtimeExecutable,
        "-e",
        "0",
      ])),
    binShExecutable: executable(POSIX_SHELL),
  };
}

interface CanaryLayout {
  readonly probeScript: string;
  readonly probeDirectory: string;
  readonly temporaryDirectory: string;
  readonly root: string;
  readonly outsideFile: string;
  readonly siblingFile: string;
  readonly otherSessionFile: string;
  readonly otherSessionDirectory: string;
  /** A stand-in for a placed runtime's own home, and a file in another runtime's beside it. */
  readonly runtimeHome: string;
  readonly otherRuntimeHomeFile: string;
  /** A stand-in for a runtime's account state, granted read-only. */
  readonly accountState: string;
  /**
   * Where each writing posture's probe gets a forwarder directory of its own,
   * as a proxied command does. Nothing listens on its socket: no probe needs
   * the network. Probes run at once, and each launch writes its forwarder's
   * script into that directory, so a shared one could be rewritten while
   * another probe's capsule reads it.
   */
  readonly egressDirectory: string;
}

async function runCanaries(
  environment: ExecutorAttestationEnvironment,
  postures: SshExecutorAttestRequest["postures"],
): Promise<ReadonlyArray<SshPostureCanaries>> {
  const layout = prepareCanaryLayout(environment);
  try {
    const confinement =
      environment.confinement ??
      makeProcessConfinementLive({
        platform: environment.platform,
        ...(environment.platform === "linux" && environment.bwrapPath !== undefined
          ? { sandboxPath: environment.bwrapPath }
          : {}),
        ...(environment.platform === "darwin" && environment.sandboxExecPath !== undefined
          ? { sandboxPath: environment.sandboxExecPath }
          : {}),
      });
    const networkReachable =
      environment.sshServerAddress !== undefined && (await connects(environment.sshServerAddress));
    const results: SshPostureCanaries[] = [];
    for (const entry of postures) {
      const outcomes = await Promise.all(
        entry.probes.map(
          async (probe): Promise<SshConfinementCanaryResult> => ({
            probe,
            outcome:
              layout === undefined
                ? "inconclusive"
                : await runProbe(environment, confinement, layout, entry.posture, probe, {
                    networkReachable,
                  }),
          }),
        ),
      );
      results.push({ posture: entry.posture, results: outcomes });
    }
    return results;
  } finally {
    if (layout !== undefined) {
      rmSync(layout.otherSessionDirectory, { recursive: true, force: true });
      rmSync(join(layout.probeDirectory, ".."), { recursive: true, force: true });
    }
  }
}

/**
 * A scratch root with a sibling folder, a folder outside it, and a stand-in
 * for another session's runtime directory, all inside this user's own
 * owner-only executor directory. Until a Project binds a remote root, the
 * canaries prove the posture's grants against this scratch root.
 */
function prepareCanaryLayout(
  environment: ExecutorAttestationEnvironment,
): CanaryLayout | undefined {
  const { sessionDirectory, sessionParent } = environment;
  if (sessionDirectory === undefined || sessionParent === undefined) return undefined;
  try {
    const base = join(sessionDirectory, "canary");
    const probeDirectory = join(base, "probe");
    const temporaryDirectory = join(base, "tmp");
    const root = join(base, "root");
    const outside = join(base, "outside");
    const sibling = join(base, "sibling");
    const egress = join(base, "egress");
    const runtimeHomes = join(base, "runtime-homes");
    const runtimeHome = join(runtimeHomes, "own");
    const otherRuntimeHome = join(runtimeHomes, "other");
    const accountState = join(base, "account-state");
    const otherSessionDirectory = join(sessionParent, siblingSessionDirectoryName(process.pid));
    for (const directory of [
      base,
      probeDirectory,
      temporaryDirectory,
      root,
      outside,
      sibling,
      egress,
      runtimeHomes,
      runtimeHome,
      otherRuntimeHome,
      accountState,
      otherSessionDirectory,
    ]) {
      mkdirSync(directory, { mode: 0o700 });
    }
    const probeScript = join(probeDirectory, "canary-probe.cjs");
    writeFileSync(probeScript, CANARY_PROBE_SOURCE, { mode: 0o600 });
    const siblingFile = join(sibling, "canary");
    writeFileSync(siblingFile, "octant canary", { mode: 0o600 });
    const otherSessionFile = join(otherSessionDirectory, "canary");
    writeFileSync(otherSessionFile, "octant canary", { mode: 0o600 });
    const otherRuntimeHomeFile = join(otherRuntimeHome, "canary");
    writeFileSync(otherRuntimeHomeFile, "octant canary", { mode: 0o600 });
    return {
      probeScript,
      probeDirectory,
      temporaryDirectory,
      root,
      outsideFile: join(outside, "written"),
      siblingFile,
      otherSessionFile,
      otherSessionDirectory,
      runtimeHome,
      otherRuntimeHomeFile,
      accountState,
      egressDirectory: egress,
    };
  } catch {
    return undefined;
  }
}

/**
 * What a probe tries, or undefined when the action is impossible on this
 * target even unconfined, so a refusal could not be told from a failure.
 */
function probeTarget(
  environment: ExecutorAttestationEnvironment,
  layout: CanaryLayout,
  probe: SshConfinementCanaryProbe,
  networkReachable: boolean,
): ReadonlyArray<string> | undefined {
  switch (probe) {
    case "write-inside-root":
    case "runtime-write-inside-root":
      return writable(layout.root) ? [join(layout.root, "written")] : undefined;
    case "write-outside-root":
    case "runtime-write-outside-root-and-home":
      return writable(join(layout.outsideFile, "..")) ? [layout.outsideFile] : undefined;
    case "runtime-write-read-only-account-state":
      return writable(layout.accountState) ? [join(layout.accountState, "written")] : undefined;
    case "read-ssh-directory":
    case "runtime-read-ssh-directory": {
      const directory = join(environment.homeDirectory, ".ssh");
      return readableDirectory(directory) ? [directory] : undefined;
    }
    case "read-sibling-folder":
      return [layout.siblingFile];
    case "read-other-session-runtime":
      return [layout.otherSessionFile];
    case "runtime-read-other-runtime-home":
      return [layout.otherRuntimeHomeFile];
    case "exec-after-start":
    case "runtime-exec-after-start":
      return executable(POSIX_SHELL) ? [POSIX_SHELL] : undefined;
    case "fork-after-start":
    case "runtime-fork-after-start":
      return [""];
    case "open-network-socket":
    case "connect-bypassing-forwarder":
    case "runtime-connect-bypassing-proxy":
      // Inside a proxied capsule the forwarder itself answers on its loopback
      // port, so a server on that port could not tell an escape from it.
      return networkReachable &&
        environment.sshServerAddress !== undefined &&
        environment.sshServerAddress.port !== LINUX_EGRESS_FORWARDER_PORT
        ? [environment.sshServerAddress.host, String(environment.sshServerAddress.port)]
        : undefined;
  }
}

async function runProbe(
  environment: ExecutorAttestationEnvironment,
  confinement: ProcessConfinementPort,
  layout: CanaryLayout,
  posture: SshConfinedPosture,
  probe: SshConfinementCanaryProbe,
  context: { readonly networkReachable: boolean },
): Promise<SshConfinementCanaryOutcome> {
  const target = probeTarget(environment, layout, probe, context.networkReachable);
  if (target === undefined) return "inconclusive";
  const runtimeProbe = probe.startsWith("runtime-");
  // Runtimes are placed on Linux targets only, so nothing else can show a
  // runtime's grants hold.
  if (runtimeProbe && environment.platform !== "linux") return "inconclusive";
  const nonce = randomBytes(16).toString("hex");
  let launch: ReturnType<ProcessConfinementPort["prepare"]>;
  try {
    const egressSocket = join(mkdtempSync(join(layout.egressDirectory, "p-")), "s");
    // The writing postures' commands and runtimes run proxied, so their
    // probes do too; a capsule that only Plan's probes saw would prove
    // nothing about them.
    const networkEgress =
      posture === "plan"
        ? ("none" as const)
        : {
            kind: "proxied" as const,
            endpoint: { kind: "unix-socket" as const, path: egressSocket },
          };
    const args = [layout.probeScript, probe, nonce, ...target];
    launch = runtimeProbe
      ? confinement.prepare({
          executable: environment.runtimeExecutable,
          args,
          // A placed runtime's own grant shape, against a scratch home and a
          // scratch account state granted read-only.
          ...runtimeLaunchGrants({
            posture,
            root: layout.root,
            home: layout.runtimeHome,
            temporaryDirectory: layout.temporaryDirectory,
            binaryFolders: [layout.probeDirectory],
            accountState: { readPaths: [layout.accountState], writePaths: [] },
            networkEgress,
          }),
        })
      : confinement.prepare({
          executable: environment.runtimeExecutable,
          args,
          boundRoot: layout.root,
          temporaryDirectory: layout.temporaryDirectory,
          readRoots: [layout.probeDirectory],
          privateHomeAllowPaths: [layout.root, layout.temporaryDirectory, layout.probeDirectory],
          ...postureGrants(posture),
          networkEgress,
        });
  } catch {
    return "inconclusive";
  }
  const output = await runCollectingOutput(launch.command, launch.args, {
    cwd: layout.root,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: environment.homeDirectory,
      TMPDIR: layout.temporaryDirectory,
    },
  });
  const verdict = output?.trim();
  if (verdict === `${nonce} refused`) return "refused";
  if (verdict === `${nonce} escaped`) return "escaped";
  return "inconclusive";
}

function runCollectingOutput(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, PROBE_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > MAX_PROBE_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(undefined);
      }
    });
    child.once("error", () => finish(undefined));
    child.once("close", (code) => finish(code === 0 ? output : undefined));
  });
}

function exitsCleanly(command: string, args: ReadonlyArray<string>): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(false);
    }, PROBE_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function connects(address: { readonly host: string; readonly port: number }): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: address.host, port: address.port });
    const settle = (reached: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(reached);
    };
    const timer = setTimeout(() => settle(false), CONTROL_CONNECT_TIMEOUT_MS);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function writable(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function readableDirectory(directory: string): boolean {
  try {
    accessSync(directory, constants.R_OK | constants.X_OK);
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}
