import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import type { PermissionPersistence, ProviderExecutionPolicy } from "@octant/contracts/providers";
import {
  SshConnectionId,
  SshHostKeyProbeId,
  SshPinnedHostKey,
  SshTargetId,
  type SshAdmissionDecision,
  type SshAttestation,
  type SshConfinedPosture,
  type SshDestination,
  type SshHostKeyFingerprint,
  type SshHostKeyProbe,
  type SshRemoteUser,
  type SshTarget,
  type SshTargetAdministrationRefusal,
  type SshTargetAdministrationRefusalReason,
  type SshTargetConnectionState,
  type SshTargetPlatform,
  type SshTargetRegisterRequest,
  type SshTargetRepinRequest,
  type SshTargetStatus,
} from "@octant/contracts/ssh-target";
import {
  SSH_EXECUTOR_PROTOCOL_VERSION,
  SshExecutorFrame,
  type SshExecutorHostFrame,
} from "@octant/contracts/ssh-executor-protocol";
import {
  SSH_CANARY_PROBES_BY_POSTURE,
  decideSshAdmission,
  type SshAdmissionSubject,
  type SshTargetConnection,
} from "@octant/domain/ssh-target-admission-policy";
import { childProcessEnvironment } from "../childProcessEnvironment";
import { encodeExecutorFrame, ExecutorFrameReader } from "./executorFrames";
import {
  SYSTEM_SSH_CLIENT,
  sshExecutorSessionArguments,
  sshHostKeyProbeArguments,
} from "./sshClientArguments";
import type { SshTargetRegistry } from "./sshTargetRegistry";

/**
 * This host's connections to its SSH targets: one SSH session per target, the
 * executor on it, and the attestation that session's executor reported.
 * Canonical: docs/design/remote-ssh-environments.md § Transport and §
 * Confinement attestation and admission.
 *
 * The service owns every session and decides admission with the domain policy
 * from what it holds now. Evidence belongs to one connection: a session that
 * ends takes its attestation with it, and a new one starts from nothing.
 * Connection state lives in memory and is never journaled.
 */

const CONFINED_POSTURES: ReadonlyArray<SshConfinedPosture> = [
  "plan",
  "approval-gated",
  "auto-accept-edits",
];
const HELLO_TIMEOUT_MS = 60_000;
const ATTESTATION_TIMEOUT_MS = 180_000;
const HOST_KEY_PROBE_TIMEOUT_MS = 30_000;
const PROBE_LIFETIME_MS = 10 * 60_000;
const MAX_HELD_PROBES = 32;
const MAX_STDERR_BYTES = 16_384;

const decodeConnectionId = Schema.decodeUnknownSync(SshConnectionId);
const decodeTargetId = Schema.decodeUnknownSync(SshTargetId);
const decodeProbeId = Schema.decodeUnknownSync(SshHostKeyProbeId);
const decodePinnedHostKey = Schema.decodeUnknownEither(SshPinnedHostKey);
const decodeExecutorFrame = Schema.decodeUnknownEither(SshExecutorFrame);

export interface SshTargetConnectionServiceOptions {
  readonly registry: SshTargetRegistry;
  /** This host's build; an executor of any other build is refused. */
  readonly buildVersion: string;
  /** The OpenSSH client to run. Defaults to the system client. */
  readonly sshExecutable?: string;
  /** The environment the client inherits, stripped of Octant's own secrets. */
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly helloTimeoutMs?: number;
  readonly attestationTimeoutMs?: number;
}

export type SshTargetAdministrationResult<T> =
  | { readonly status: "ok"; readonly value: T }
  | SshTargetAdministrationRefusal;

/** What a request on a target would run, and in which posture. */
export interface SshTargetAdmissionRequest {
  readonly posture: ProviderExecutionPolicy;
  readonly permissionPersistence: PermissionPersistence;
  readonly subject: SshAdmissionSubject;
}

interface HeldProbe {
  readonly destination: SshDestination;
  readonly hostKey: SshPinnedHostKey;
  readonly fingerprint: SshHostKeyFingerprint;
  readonly expiresAt: number;
}

type LostState = Exclude<SshTargetConnectionState, "connected" | "not-connected">;

type ConnectionRecord =
  | {
      readonly state: "connecting";
      readonly connectionId: SshConnectionId;
      readonly child: ChildProcessWithoutNullStreams;
    }
  | {
      readonly state: "connected";
      readonly connectionId: SshConnectionId;
      readonly child: ChildProcessWithoutNullStreams;
      readonly attestation: SshAttestation;
      readonly remoteUser: SshRemoteUser | undefined;
      readonly platform: SshTargetPlatform | undefined;
    }
  | { readonly state: LostState };

type Establishment =
  | {
      readonly state: "connected";
      readonly attestation: SshAttestation;
      readonly remoteUser: SshRemoteUser | undefined;
    }
  | { readonly state: LostState };

function refusal(
  reason: SshTargetAdministrationRefusalReason,
  message: string,
): SshTargetAdministrationRefusal {
  return { status: "refused", reason, message };
}

/** The SHA-256 fingerprint OpenSSH prints for a key. */
export function sshHostKeyFingerprint(hostKey: SshPinnedHostKey): SshHostKeyFingerprint {
  const digest = createHash("sha256")
    .update(Buffer.from(hostKey.publicKey, "base64"))
    .digest("base64")
    .replace(/=+$/u, "");
  return `SHA256:${digest}`;
}

export class SshTargetConnectionService {
  readonly #registry: SshTargetRegistry;
  readonly #buildVersion: string;
  readonly #sshExecutable: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #now: () => number;
  readonly #helloTimeoutMs: number;
  readonly #attestationTimeoutMs: number;
  readonly #connections = new Map<string, ConnectionRecord>();
  readonly #probes = new Map<string, HeldProbe>();

  constructor(options: SshTargetConnectionServiceOptions) {
    this.#registry = options.registry;
    this.#buildVersion = options.buildVersion;
    this.#sshExecutable = options.sshExecutable ?? SYSTEM_SSH_CLIENT;
    this.#environment = childProcessEnvironment(options.environment ?? process.env);
    this.#now = options.now ?? Date.now;
    this.#helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    this.#attestationTimeoutMs = options.attestationTimeoutMs ?? ATTESTATION_TIMEOUT_MS;
  }

  list(): ReadonlyArray<SshTargetStatus> {
    return this.#registry.list().map((target) => this.#status(target));
  }

  /**
   * Whether a request in this posture may act on the target now. Every launch
   * on a target and every file operation on its remote root asks this first.
   */
  admit(targetId: SshTargetId, request: SshTargetAdmissionRequest): SshAdmissionDecision {
    const registered = this.#registry.get(targetId) !== undefined;
    const record = this.#connections.get(String(targetId));
    return decideSshAdmission({
      host: { buildVersion: this.#buildVersion, protocolVersion: SSH_EXECUTOR_PROTOCOL_VERSION },
      target: registered ? "registered" : "removed",
      connection: domainConnection(record),
      ...(record?.state === "connected" ? { attestation: record.attestation } : {}),
      posture: request.posture,
      permissionPersistence: request.permissionPersistence,
      subject: request.subject,
    });
  }

  /**
   * Connects once to read the key `destination` presents. The key is held for
   * the person to confirm and trusted by nothing until they do.
   */
  async probeHostKey(
    destination: SshDestination,
  ): Promise<SshTargetAdministrationResult<SshHostKeyProbe>> {
    const probeName = randomUUID();
    const directory = this.#registry.probeDirectory(probeName);
    const knownHostsFile = join(directory, "known_hosts");
    try {
      const child = spawn(
        this.#sshExecutable,
        [...sshHostKeyProbeArguments({ destination, knownHostsFile })],
        { env: this.#environment, stdio: ["ignore", "ignore", "ignore"] },
      );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => child.kill("SIGKILL"), HOST_KEY_PROBE_TIMEOUT_MS);
        child.once("error", () => {
          clearTimeout(timer);
          resolve();
        });
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      const hostKey = presentedHostKey(knownHostsFile);
      if (hostKey === undefined) {
        return refusal(
          "host-key-unavailable",
          "The destination could not be reached, or presented no host key Octant can read.",
        );
      }
      this.#pruneProbes();
      const probeId = decodeProbeId(randomUUID());
      const fingerprint = sshHostKeyFingerprint(hostKey);
      this.#probes.set(String(probeId), {
        destination,
        hostKey,
        fingerprint,
        expiresAt: this.#now() + PROBE_LIFETIME_MS,
      });
      return { status: "ok", value: { probeId, destination, hostKey, fingerprint } };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  /** Pins the confirmed key, registers the target, and connects to attest it. */
  async register(
    request: SshTargetRegisterRequest,
  ): Promise<SshTargetAdministrationResult<SshTargetStatus>> {
    const probe = this.#takeProbe(request.probeId, request.fingerprint);
    if (probe.status !== "ok") return probe;
    const target: SshTarget = {
      id: decodeTargetId(randomUUID()),
      destination: probe.value.destination,
      hostKey: probe.value.hostKey,
      executorPath: request.executorPath,
    };
    this.#registry.save(target);
    return this.connect(target.id);
  }

  /** Replaces a target's pin with a key the person confirmed for the same destination. */
  async repin(
    request: SshTargetRepinRequest,
  ): Promise<SshTargetAdministrationResult<SshTargetStatus>> {
    const target = this.#registry.get(request.targetId);
    if (target === undefined) return refusal("unknown-target", "No such SSH target.");
    const held = this.#probes.get(String(request.probeId));
    if (held !== undefined && held.destination !== target.destination) {
      this.#probes.delete(String(request.probeId));
      return refusal(
        "destination-mismatch",
        "That host key was read from another destination than this target's.",
      );
    }
    const probe = this.#takeProbe(request.probeId, request.fingerprint);
    if (probe.status !== "ok") return probe;
    this.#disconnect(target.id);
    this.#registry.save({ ...target, hostKey: probe.value.hostKey });
    return this.connect(target.id);
  }

  /** Ends any session to the target and its attestation, then connects and attests anew. */
  async connect(targetId: SshTargetId): Promise<SshTargetAdministrationResult<SshTargetStatus>> {
    const target = this.#registry.get(targetId);
    if (target === undefined) return refusal("unknown-target", "No such SSH target.");
    this.#disconnect(targetId);
    const connectionId = decodeConnectionId(randomUUID());
    const child = spawn(
      this.#sshExecutable,
      [
        ...sshExecutorSessionArguments({
          destination: target.destination,
          knownHostsFile: this.#registry.knownHostsFile(target.id),
          executorPath: target.executorPath,
        }),
      ],
      { env: this.#environment, stdio: ["pipe", "pipe", "pipe"] },
    );
    const key = String(targetId);
    this.#connections.set(key, { state: "connecting", connectionId, child });
    const established = await this.#establish(child, connectionId);
    const current = this.#connections.get(key);
    // A later connect or a removal replaced this session while it attested.
    if (current?.state !== "connecting" || current.connectionId !== connectionId) {
      child.kill("SIGKILL");
      return { status: "ok", value: this.#status(target) };
    }
    if (established.state !== "connected") {
      child.kill("SIGKILL");
      this.#connections.set(key, { state: established.state });
      return { status: "ok", value: this.#status(target) };
    }
    // The session can end in the moment between the reply and this line.
    if (child.exitCode !== null || child.signalCode !== null) {
      this.#connections.set(key, { state: "unreachable" });
      return { status: "ok", value: this.#status(target) };
    }
    this.#connections.set(key, {
      state: "connected",
      connectionId,
      child,
      attestation: established.attestation,
      remoteUser: established.remoteUser,
      platform: supportedPlatform(established.attestation.facts.platform.operatingSystem),
    });
    child.once("close", () => {
      const latest = this.#connections.get(key);
      if (latest?.state === "connected" && latest.connectionId === connectionId) {
        this.#connections.set(key, { state: "unreachable" });
      }
    });
    return { status: "ok", value: this.#status(target) };
  }

  remove(targetId: SshTargetId): SshTargetAdministrationResult<null> {
    if (this.#registry.get(targetId) === undefined) {
      return refusal("unknown-target", "No such SSH target.");
    }
    this.#disconnect(targetId);
    this.#connections.delete(String(targetId));
    this.#registry.remove(targetId);
    return { status: "ok", value: null };
  }

  /** Ends every session; each executor exits when its input closes. */
  close(): void {
    for (const key of this.#connections.keys()) this.#disconnect(decodeTargetId(key));
  }

  #status(target: SshTarget): SshTargetStatus {
    const record = this.#connections.get(String(target.id));
    const connected = record?.state === "connected" ? record : undefined;
    return {
      target,
      fingerprint: sshHostKeyFingerprint(target.hostKey),
      connection:
        record === undefined
          ? "not-connected"
          : record.state === "connecting"
            ? "not-connected"
            : record.state,
      ...(connected?.remoteUser === undefined ? {} : { remoteUser: connected.remoteUser }),
      ...(connected?.platform === undefined ? {} : { platform: connected.platform }),
      admission: CONFINED_POSTURES.map((posture) => ({
        posture,
        decision: this.admit(target.id, {
          posture,
          permissionPersistence: "current-session",
          subject: { kind: "octant-launch" },
        }),
      })),
    };
  }

  #disconnect(targetId: SshTargetId): void {
    const key = String(targetId);
    const record = this.#connections.get(key);
    if (record === undefined) return;
    if (record.state === "connecting" || record.state === "connected") {
      record.child.stdin.end();
      record.child.kill("SIGTERM");
    }
    this.#connections.set(key, { state: "unreachable" });
  }

  #takeProbe(
    probeId: SshHostKeyProbeId,
    fingerprint: SshHostKeyFingerprint,
  ): SshTargetAdministrationResult<HeldProbe> {
    this.#pruneProbes();
    const probe = this.#probes.get(String(probeId));
    // A probe is used once, whether or not the confirmation matched.
    this.#probes.delete(String(probeId));
    if (probe === undefined) {
      return refusal("unknown-probe", "Read the host key again; that one is no longer held.");
    }
    if (probe.fingerprint !== fingerprint) {
      return refusal(
        "fingerprint-not-confirmed",
        "The confirmed fingerprint is not the one the destination presented.",
      );
    }
    return { status: "ok", value: probe };
  }

  #pruneProbes(): void {
    const now = this.#now();
    for (const [id, probe] of this.#probes) {
      if (probe.expiresAt <= now) this.#probes.delete(id);
    }
    while (this.#probes.size >= MAX_HELD_PROBES) {
      const oldest = this.#probes.keys().next();
      if (oldest.done === true) break;
      this.#probes.delete(oldest.value);
    }
  }

  /**
   * Waits for the executor's introduction, refuses any other build without
   * asking it anything, then asks for the attestation of every confined
   * posture with the probes the admission policy requires.
   */
  #establish(
    child: ChildProcessWithoutNullStreams,
    connectionId: SshConnectionId,
  ): Promise<Establishment> {
    return new Promise((resolve) => {
      const reader = new ExecutorFrameReader({ expectPreamble: true });
      const requestId = 1;
      let introduced = false;
      let stderr = "";
      let settled = false;
      const finish = (outcome: Establishment) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.removeListener("data", onData);
        resolve(outcome);
      };
      let timer = setTimeout(() => finish({ state: "unreachable" }), this.#helloTimeoutMs);

      const onFrame = (value: unknown) => {
        const decoded = decodeExecutorFrame(value);
        if (decoded._tag === "Left") return finish({ state: "executor-version-mismatch" });
        const frame = decoded.right;
        if (!introduced) {
          if (frame.type !== "hello") return finish({ state: "executor-version-mismatch" });
          const { identity } = frame;
          if (
            identity.buildVersion !== this.#buildVersion ||
            identity.protocolVersion !== SSH_EXECUTOR_PROTOCOL_VERSION ||
            !identity.installVerified
          ) {
            return finish({ state: "executor-version-mismatch" });
          }
          introduced = true;
          clearTimeout(timer);
          timer = setTimeout(() => finish({ state: "unreachable" }), this.#attestationTimeoutMs);
          const request: SshExecutorHostFrame = {
            type: "request",
            id: requestId,
            request: {
              kind: "attest",
              postures: CONFINED_POSTURES.map((posture) => ({
                posture,
                probes: SSH_CANARY_PROBES_BY_POSTURE[posture],
              })),
            },
          };
          const encoded = encodeExecutorFrame(request);
          if (encoded.status !== "encoded") return finish({ state: "unreachable" });
          child.stdin.write(encoded.bytes);
          return;
        }
        if (frame.type !== "reply" || frame.id !== requestId) {
          return finish({ state: "executor-version-mismatch" });
        }
        if (frame.reply.kind !== "attested") return finish({ state: "unreachable" });
        return finish({
          state: "connected",
          attestation: { connectionId, facts: frame.reply.facts },
          remoteUser: frame.reply.remoteUser,
        });
      };
      const onData = (chunk: Buffer) => {
        const reading = reader.push(chunk);
        if (reading.status === "violated") return finish({ state: "executor-version-mismatch" });
        for (const value of reading.frames) {
          onFrame(value);
          if (settled) return;
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_STDERR_BYTES) stderr += chunk.toString("utf8");
      });
      child.stdin.on("error", () => undefined);
      child.once("error", () => finish({ state: "unreachable" }));
      // Once a matching executor has introduced itself, the key held and the
      // program is the right one, so an exit before its reply is a lost
      // session, not a reason to reinstall.
      child.once("close", (code) =>
        finish({ state: introduced ? "unreachable" : lostStateFromExit(code, stderr) }),
      );
    });
  }
}

/**
 * Why a session ended before its executor attested. The client's own message
 * is the only evidence of a refused host key; the remote shell's exit status
 * says the executor path held no program.
 */
function lostStateFromExit(code: number | null, stderr: string): LostState {
  if (/host key verification failed|remote host identification has changed/iu.test(stderr)) {
    return "host-key-changed";
  }
  if (code === 126 || code === 127) return "executor-missing";
  if (code === null || code === 255) return "unreachable";
  // The remote command ran and exited without introducing itself as an
  // executor: it is not one this host can speak to.
  return "executor-version-mismatch";
}

function domainConnection(record: ConnectionRecord | undefined): SshTargetConnection {
  if (record === undefined || record.state === "connecting") return { state: "unreachable" };
  if (record.state === "connected") {
    return { state: "connected", connectionId: record.connectionId };
  }
  return { state: record.state };
}

function supportedPlatform(operatingSystem: string): SshTargetPlatform | undefined {
  if (operatingSystem === "linux") return "linux";
  if (operatingSystem === "darwin") return "macos";
  return undefined;
}

/** The first key line the probe's known-hosts file holds. */
function presentedHostKey(knownHostsFile: string): SshPinnedHostKey | undefined {
  let text: string;
  try {
    text = readFileSync(knownHostsFile, "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 3 || fields[0]?.startsWith("#") === true) continue;
    const decoded = decodePinnedHostKey({ algorithm: fields[1], publicKey: fields[2] });
    if (decoded._tag === "Right") return decoded.right;
  }
  return undefined;
}
