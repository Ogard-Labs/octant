import { spawn } from "node:child_process";
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
  type SshExecutorReadReply,
  type SshExecutorReadRequest,
} from "@octant/contracts/ssh-executor-protocol";
import {
  SSH_CANARY_PROBES_BY_POSTURE,
  decideSshAdmission,
  type SshAdmissionSubject,
  type SshTargetConnection,
} from "@octant/domain/ssh-target-admission-policy";
import { childProcessEnvironment } from "../childProcessEnvironment";
import { ExecutorChannel } from "./executorChannel";
import {
  SYSTEM_SSH_CLIENT,
  sshClientEnvironment,
  sshExecutorSessionArguments,
  sshHostKeyProbeArguments,
} from "./sshClientArguments";
import type { SshTargetStore } from "./sshTargetStore";

/**
 * This host's connections to its SSH targets: one SSH session per target, the
 * executor on it, and the attestation that session's executor reported.
 * Canonical: docs/design/remote-ssh-environments.md § Transport and §
 * Confinement attestation and admission.
 *
 * The service owns every session and decides admission with the domain policy
 * from what it holds now. Evidence belongs to one connection: a session that
 * ends takes its attestation with it, and a new one starts from nothing.
 * Connection state lives in memory and is never journaled; each attestation's
 * digest and the decisions made from it are.
 */

const CONFINED_POSTURES: ReadonlyArray<SshConfinedPosture> = [
  "plan",
  "approval-gated",
  "auto-accept-edits",
];
const HELLO_TIMEOUT_MS = 60_000;
const ATTESTATION_TIMEOUT_MS = 180_000;
const READ_TIMEOUT_MS = 60_000;
const HOST_KEY_PROBE_TIMEOUT_MS = 30_000;
const PROBE_LIFETIME_MS = 10 * 60_000;
const MAX_HELD_PROBES = 32;

const decodeConnectionId = Schema.decodeUnknownSync(SshConnectionId);
const decodeTargetId = Schema.decodeUnknownSync(SshTargetId);
const decodeProbeId = Schema.decodeUnknownSync(SshHostKeyProbeId);
const decodePinnedHostKey = Schema.decodeUnknownEither(SshPinnedHostKey);

export interface SshTargetConnectionServiceOptions {
  readonly store: SshTargetStore;
  /** This host's build; an executor of any other build is refused. */
  readonly buildVersion: string;
  /** The OpenSSH client to run. Defaults to the system client. */
  readonly sshExecutable?: string;
  /**
   * The environment the client inherits, stripped of Octant's own secrets.
   * Defaults to the minimal client environment, never the whole server one.
   */
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly helloTimeoutMs?: number;
  readonly attestationTimeoutMs?: number;
  readonly readTimeoutMs?: number;
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

/** A read on a target: refused by admission, lost with its session, or answered. */
export type SshTargetReadOutcome =
  | {
      readonly status: "refused";
      readonly decision: Extract<SshAdmissionDecision, { readonly status: "refused" }>;
    }
  | { readonly status: "unavailable" }
  | { readonly status: "replied"; readonly reply: SshExecutorReadReply };

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
      readonly channel: ExecutorChannel;
    }
  | {
      readonly state: "connected";
      readonly connectionId: SshConnectionId;
      readonly channel: ExecutorChannel;
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
  readonly #store: SshTargetStore;
  readonly #buildVersion: string;
  readonly #sshExecutable: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #now: () => number;
  readonly #helloTimeoutMs: number;
  readonly #attestationTimeoutMs: number;
  readonly #readTimeoutMs: number;
  readonly #connections = new Map<string, ConnectionRecord>();
  readonly #probes = new Map<string, HeldProbe>();

  constructor(options: SshTargetConnectionServiceOptions) {
    this.#store = options.store;
    this.#buildVersion = options.buildVersion;
    this.#sshExecutable = options.sshExecutable ?? SYSTEM_SSH_CLIENT;
    this.#environment = childProcessEnvironment(
      options.environment ?? sshClientEnvironment(process.env),
    );
    this.#now = options.now ?? Date.now;
    this.#helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    this.#attestationTimeoutMs = options.attestationTimeoutMs ?? ATTESTATION_TIMEOUT_MS;
    this.#readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS;
  }

  list(): ReadonlyArray<SshTargetStatus> {
    return this.#store.list().map((target) => this.#status(target));
  }

  /**
   * Whether a request in this posture may act on the target now. Every launch
   * on a target and every file operation on its remote root asks this first.
   */
  admit(targetId: SshTargetId, request: SshTargetAdmissionRequest): SshAdmissionDecision {
    const registered = this.#store.get(targetId) !== undefined;
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
   * Asks the target's executor for one read, after the admission policy
   * admitted it on the current connection. The decision and the request are
   * made in one step, so the request travels only on the session whose
   * attestation admitted it; a session that ends before it answers takes the
   * request with it.
   */
  async read(
    targetId: SshTargetId,
    admission: SshTargetAdmissionRequest,
    request: SshExecutorReadRequest,
  ): Promise<SshTargetReadOutcome> {
    const decision = this.admit(targetId, admission);
    if (decision.status !== "admitted") return { status: "refused", decision };
    const record = this.#connections.get(String(targetId));
    if (record?.state !== "connected") return { status: "unavailable" };
    const outcome = await record.channel.request(request, this.#readTimeoutMs);
    if (outcome.status !== "replied") return { status: "unavailable" };
    const { reply } = outcome;
    if (reply.kind === "attested" || reply.kind === "busy") return { status: "unavailable" };
    return { status: "replied", reply };
  }

  /**
   * Connects once to read the key `destination` presents. The key is held for
   * the person to confirm and trusted by nothing until they do.
   */
  async probeHostKey(
    destination: SshDestination,
  ): Promise<SshTargetAdministrationResult<SshHostKeyProbe>> {
    const probeName = randomUUID();
    const directory = this.#store.probeDirectory(probeName);
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
    journaled(this.#store.register(target));
    return this.connect(target.id);
  }

  /** Replaces a target's pin with a key the person confirmed for the same destination. */
  async repin(
    request: SshTargetRepinRequest,
  ): Promise<SshTargetAdministrationResult<SshTargetStatus>> {
    const target = this.#store.get(request.targetId);
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
    journaled(this.#store.repin(target.id, probe.value.hostKey));
    return this.connect(target.id);
  }

  /** Ends any session to the target and its attestation, then connects and attests anew. */
  async connect(targetId: SshTargetId): Promise<SshTargetAdministrationResult<SshTargetStatus>> {
    const target = this.#store.get(targetId);
    if (target === undefined) return refusal("unknown-target", "No such SSH target.");
    this.#disconnect(targetId);
    const connectionId = decodeConnectionId(randomUUID());
    // The pin is written from the journal each time, so the client trusts
    // exactly the key the person confirmed, whatever the file held before.
    const knownHostsFile = this.#store.writePin(target);
    const child = spawn(
      this.#sshExecutable,
      [
        ...sshExecutorSessionArguments({
          destination: target.destination,
          knownHostsFile,
          executorPath: target.executorPath,
        }),
      ],
      { env: this.#environment, stdio: ["pipe", "pipe", "pipe"] },
    );
    const channel = new ExecutorChannel(child, { helloTimeoutMs: this.#helloTimeoutMs });
    const key = String(targetId);
    this.#connections.set(key, { state: "connecting", connectionId, channel });
    const established = await this.#establish(channel, connectionId);
    const current = this.#connections.get(key);
    // A later connect or a removal replaced this session while it attested.
    if (current?.state !== "connecting" || current.connectionId !== connectionId) {
      channel.close();
      return { status: "ok", value: this.#status(target) };
    }
    if (established.state !== "connected") {
      channel.close();
      this.#connections.set(key, { state: established.state });
      return { status: "ok", value: this.#status(target) };
    }
    // The session can end in the moment between the reply and this line.
    if (channel.ended) {
      this.#connections.set(key, { state: "unreachable" });
      return { status: "ok", value: this.#status(target) };
    }
    this.#connections.set(key, {
      state: "connected",
      connectionId,
      channel,
      attestation: established.attestation,
      remoteUser: established.remoteUser,
      platform: supportedPlatform(established.attestation.facts.platform.operatingSystem),
    });
    channel.onEnd(() => {
      const latest = this.#connections.get(key);
      if (latest?.state === "connected" && latest.connectionId === connectionId) {
        this.#connections.set(key, { state: "unreachable" });
      }
    });
    const status = this.#status(target);
    // The digest and the decisions are journaled so a refusal can be
    // explained after the connection is gone; they never admit anything.
    journaled(this.#store.recordAttestation(target.id, established.attestation, status.admission));
    return { status: "ok", value: status };
  }

  remove(targetId: SshTargetId): SshTargetAdministrationResult<null> {
    if (this.#store.get(targetId) === undefined) {
      return refusal("unknown-target", "No such SSH target.");
    }
    this.#disconnect(targetId);
    this.#connections.delete(String(targetId));
    journaled(this.#store.remove(targetId));
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
    if (record.state === "connecting" || record.state === "connected") record.channel.close();
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
  async #establish(
    channel: ExecutorChannel,
    connectionId: SshConnectionId,
  ): Promise<Establishment> {
    const introduction = await channel.introduction();
    if (introduction.status === "timed-out") return { state: "unreachable" };
    if (introduction.status === "violated") return { state: "executor-version-mismatch" };
    if (introduction.status === "ended") {
      return { state: lostStateFromExit(introduction.code, introduction.stderr) };
    }
    const { identity } = introduction.hello;
    if (
      identity.buildVersion !== this.#buildVersion ||
      identity.protocolVersion !== SSH_EXECUTOR_PROTOCOL_VERSION ||
      !identity.installVerified
    ) {
      return { state: "executor-version-mismatch" };
    }
    const outcome = await channel.request(
      {
        kind: "attest",
        postures: CONFINED_POSTURES.map((posture) => ({
          posture,
          probes: SSH_CANARY_PROBES_BY_POSTURE[posture],
        })),
      },
      this.#attestationTimeoutMs,
    );
    // Once a matching executor has introduced itself, the key held and the
    // program is the right one, so a session lost before its reply is not a
    // reason to reinstall; a reply that breaks the protocol is.
    if (outcome.status === "lost") {
      return {
        state: outcome.cause === "violated" ? "executor-version-mismatch" : "unreachable",
      };
    }
    if (outcome.reply.kind !== "attested") return { state: "unreachable" };
    return {
      state: "connected",
      attestation: { connectionId, facts: outcome.reply.facts },
      remoteUser: outcome.reply.remoteUser,
    };
  }
}

/** The store refuses only a record whose own payload did not decode: a broken invariant. */
function journaled(write: "recorded" | "refused"): void {
  if (write === "refused") throw new Error("The SSH target journal refused a decoded record.");
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
