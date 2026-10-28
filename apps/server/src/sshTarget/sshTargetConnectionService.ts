import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { Effect, Schema, Stream } from "effect";
import type {
  PermissionPersistence,
  ProviderExecutionPolicy,
  ProviderFailure,
  ProviderInstanceId,
} from "@octant/contracts/providers";
import {
  SshConnectionId,
  SshHostKeyProbeId,
  SshPinnedHostKey,
  SshRemotePath,
  SshTargetId,
  type SshAdmissionDecision,
  type SshAttestation,
  type SshConfinedPosture,
  type SshDestination,
  type SshHostKeyFingerprint,
  type SshHostKeyProbe,
  type SshPlaceableRuntime,
  type SshRemoteUser,
  type SshTarget,
  type SshTargetAdministrationRefusal,
  type SshTargetAdministrationRefusalReason,
  type SshTargetConnectionState,
  type SshTargetPlatform,
  type SshRuntimeBinarySetRequest,
  type SshTargetRegisterRequest,
  type SshTargetRepinRequest,
  type SshTargetStatus,
} from "@octant/contracts/ssh-target";
import {
  SSH_EXECUTOR_PROTOCOL_VERSION,
  SshEgressAddress,
  SshEgressHostName,
  type SshExecutorCommandRanReply,
  type SshExecutorHarnessFileReply,
  type SshExecutorHarnessFileRequest,
  type SshExecutorReadReply,
  type SshExecutorReadRequest,
  type SshExecutorRefusedReply,
  type SshExecutorTerminalUnavailableReply,
  type SshExecutorReply,
  type SshExecutorRequest,
  type SshExecutorRunCommandRequest,
  type SshExecutorCreateWorktreeRequest,
  type SshExecutorOpenTerminalRequest,
  type SshExecutorRemoveWorktreeRequest,
  type SshExecutorWorktreeCreatedReply,
  type SshExecutorWorktreeRemovedReply,
  SshDeniedRootEntries,
  SshExecutorStartProcessRequest,
  SshPlacedVariables,
} from "@octant/contracts/ssh-executor-protocol";
import {
  SSH_CANARY_PROBES_BY_POSTURE,
  SSH_RUNTIME_CANARY_PROBES_BY_POSTURE,
  decideSshAdmission,
  type SshAdmissionSubject,
  type SshTargetConnection,
} from "@octant/domain/ssh-target-admission-policy";
import {
  describeSshAdmissionRefusal,
  sshTargetRuntimePathMissing,
} from "@octant/domain/ssh-target-recovery";
import type {
  ProviderDriver,
  ProviderPlacedLaunch,
  ProviderPlacedProcess,
  ProviderRemotePlacementPosture,
  ProviderRemoteProcessPlacement,
} from "@octant/provider-sdk/driver";
import { childProcessEnvironment } from "../childProcessEnvironment";
import type { ToolEgressProxyEndpoint } from "../harness/nativeHarnessEgressProxy";
import {
  ExecutorChannel,
  type ExecutorPlacedProcess,
  type ExecutorRequestOptions,
  type ExecutorTerminal,
  type ExecutorTerminalListener,
} from "./executorChannel";
import type { ProviderRuntimeEgress } from "./providerRuntimeEgress";
import { joinToStream } from "./executorStreams";
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

/**
 * How long past a command's own timeout this host waits for its reply. The
 * executor ends a command at its timeout and answers; one that stays silent
 * past this ends the session.
 */
const COMMAND_REPLY_GRACE_MS = 60_000;

const isEgressAddress = Schema.is(SshEgressAddress);
const isEgressHostName = Schema.is(SshEgressHostName);
const decodeConnectionId = Schema.decodeUnknownSync(SshConnectionId);
const decodeTargetId = Schema.decodeUnknownSync(SshTargetId);
const decodeProbeId = Schema.decodeUnknownSync(SshHostKeyProbeId);
const decodePinnedHostKey = Schema.decodeUnknownEither(SshPinnedHostKey);
const decodeRemotePath = Schema.decodeUnknownEither(SshRemotePath);
// A launch is checked against the request's own bounds here, because a frame
// the executor cannot decode ends the session every other launch shares.
const placedFields = SshExecutorStartProcessRequest.fields;
const decodeAccountState = Schema.decodeUnknownEither(placedFields.accountState);
const decodePlacedArgs = Schema.decodeUnknownEither(placedFields.args);
const decodePlacedHome = Schema.decodeUnknownEither(placedFields.home);
const decodePlacedVariables = Schema.decodeUnknownEither(SshPlacedVariables);
const decodeDeniedRootEntries = Schema.decodeUnknownEither(SshDeniedRootEntries);

/** How long a stopped runtime has to end on the target before this host stops waiting. */
const PLACED_STOP_WAIT_MS = 10_000;

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
  /**
   * The proxy a placed runtime's network goes through on this host. Without
   * it no runtime is placed in any posture; nothing falls back to the
   * target's own network or runs offline.
   */
  readonly runtimeEgress?: ProviderRuntimeEgress;
  /**
   * The agents a remote-bound Project's turn could place on a target, as its
   * status reports them to a window (`placeableRuntimesOn`). Absent, a status
   * lists none, and a window offers none.
   */
  readonly placeableRuntimes?: (targetId: SshTargetId) => ReadonlyArray<SshPlaceableRuntime>;
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

/**
 * A call on a target: refused by admission, lost with its session (or asked
 * on a session that is no longer the target's), or answered.
 */
export type SshTargetCallOutcome<Reply> =
  | {
      readonly status: "refused";
      readonly decision: Extract<SshAdmissionDecision, { readonly status: "refused" }>;
    }
  | { readonly status: "unavailable" }
  | { readonly status: "replied"; readonly reply: Reply };

/** A read on a target: refused by admission, lost with its session, or answered. */
export type SshTargetReadOutcome = SshTargetCallOutcome<SshExecutorReadReply>;

/**
 * A managed worktree's creation or removal: refused, lost, or answered on the
 * named session, whose id the journal records as the change's provenance.
 */
export type SshTargetWorktreeOutcome =
  | Exclude<SshTargetCallOutcome<never>, { readonly status: "replied" }>
  | {
      readonly status: "replied";
      readonly reply:
        | SshExecutorWorktreeCreatedReply
        | SshExecutorWorktreeRemovedReply
        | SshExecutorRefusedReply;
      readonly connectionId: SshConnectionId;
    };

/**
 * A terminal's opening: refused, lost, refused or declined by the executor
 * (it holds its most terminals or cannot open one), or open on a session.
 */
export type SshTargetTerminalOpening =
  | Exclude<SshTargetCallOutcome<never>, { readonly status: "replied" }>
  | {
      readonly status: "replied";
      readonly reply: SshExecutorRefusedReply | SshExecutorTerminalUnavailableReply;
    }
  | {
      readonly status: "opened";
      readonly terminal: ExecutorTerminal;
      readonly session: SshTargetSession;
    };

/**
 * Where a provider runtime is placed: on a session of a target, in a bound
 * root, for one thread and provider instance, in one confined posture.
 */
export interface SshTargetPlacementInput {
  readonly session: Pick<SshTargetSession, "targetId" | "connectionId">;
  readonly driver: Pick<ProviderDriver, "remotePlacement">;
  /** The bound root, or a managed worktree of it, as the target names it. */
  readonly root: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly providerInstanceId: ProviderInstanceId;
  /** The posture every launch of this placement runs in. */
  readonly posture: ProviderRemotePlacementPosture;
  readonly permissionPersistence: PermissionPersistence;
  /**
   * The thread's posture now. A launch, and every write to a placed runtime,
   * reads it; another posture than the placement's ends the runtime, whose
   * grants were chosen for the posture it started in.
   */
  readonly currentPosture: () => ProviderExecutionPolicy | undefined;
}

/**
 * A provider runtime's place on a target, or why there is none: a runtime is
 * placed only at the path the person set for its provider instance there.
 */
export type SshTargetPlacement =
  | { readonly status: "placed"; readonly placement: ProviderRemoteProcessPlacement }
  | { readonly status: "refused"; readonly failure: ProviderFailure };

/** One connected session of a target, which work bound to it names on every call. */
export interface SshTargetSession {
  readonly targetId: SshTargetId;
  readonly connectionId: SshConnectionId;
  /** Called once when the session ends; the returned function stops listening. */
  readonly onEnd: (listener: () => void) => () => void;
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
  readonly #runtimeEgress: ProviderRuntimeEgress | undefined;
  readonly #placeableRuntimes: SshTargetConnectionServiceOptions["placeableRuntimes"];
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
    this.#runtimeEgress = options.runtimeEgress;
    this.#placeableRuntimes = options.placeableRuntimes;
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
   * Whether a driver's runtime may be placed on the target in this posture
   * now. Its declaration is all this host reads of the driver: one without
   * it, or without this posture, or whose app tools would listen on the
   * target's loopback, is refused `runtime-not-attestable` before anything
   * about the connection is asked.
   */
  admitProviderRuntime(
    targetId: SshTargetId,
    driver: Pick<ProviderDriver, "remotePlacement">,
    admission: Omit<SshTargetAdmissionRequest, "subject">,
  ): SshAdmissionDecision {
    const support = driver.remotePlacement;
    return this.admit(targetId, {
      ...admission,
      subject: {
        kind: "provider-runtime",
        // On a target the executor's port wraps every placed launch, so the
        // runtime is Octant-wrapped exactly in the postures its driver
        // declares; the others are where it rests on its own sandbox.
        octantWrapsInPosture:
          support?.postures.some((posture) => posture === admission.posture) === true,
        remotePlacement: support === undefined ? "undeclared" : "declared",
        appToolTransportListensOnLoopback: support?.appToolTransport === "loopback-listener",
      },
    });
  }

  /**
   * The remote placement a provider driver launches its runtime through.
   * Each launch is admitted in the placement's posture at that moment, from
   * the driver's declaration and this connection's runtime canaries, and
   * travels only on the session the placement names. In every posture, Plan
   * included, the runtime reaches the network only through a proxy of its
   * own on this host. The runtime stops when the launch's scope
   * closes, ends with its session, and is stopped when the thread's posture
   * moves. A refused or lost target fails the launch; nothing runs here
   * instead. The runtime is the one the person set for the provider instance
   * on this target: without one there is no placement, and a launch of any
   * other path, or after the person changed it, is refused.
   */
  placement(input: SshTargetPlacementInput): SshTargetPlacement {
    const executable = this.#runtimeBinary(input);
    if (executable === undefined) {
      return {
        status: "refused",
        failure: {
          category: "invalid-configuration",
          message: sshTargetRuntimePathMissing(
            String(input.session.targetId),
            String(input.providerInstanceId),
          ),
        },
      };
    }
    return {
      status: "placed",
      placement: {
        kind: "remote",
        executable,
        launch: (launch) =>
          Effect.acquireRelease(
            Effect.flatMap(
              Effect.promise(() => this.#startPlaced(input, executable, launch)),
              (started) =>
                started.status === "started"
                  ? Effect.succeed(started)
                  : Effect.fail(started.failure),
            ),
            (started) => Effect.promise(() => started.stop()),
          ).pipe(Effect.map((started) => placedProcess(input, started.process))),
      },
    };
  }

  /** The runtime path the person set for this placement's provider instance on its target. */
  #runtimeBinary(input: SshTargetPlacementInput): string | undefined {
    return this.#store
      .runtimeBinaries(input.session.targetId)
      .find((binary) => String(binary.providerInstanceId) === String(input.providerInstanceId))
      ?.path;
  }

  async #startPlaced(
    input: SshTargetPlacementInput,
    executablePath: string,
    launch: ProviderPlacedLaunch,
  ): Promise<
    | {
        readonly status: "started";
        readonly process: ExecutorPlacedProcess;
        readonly stop: () => Promise<void>;
      }
    | { readonly status: "refused"; readonly failure: ProviderFailure }
  > {
    const refusedWith = (failure: ProviderFailure) => ({ status: "refused" as const, failure });
    const { session } = input;
    const admitted = (): ProviderFailure | undefined => {
      if (input.currentPosture() !== input.posture) {
        return {
          category: "interrupted",
          message: "The thread's posture changed; the runtime starts again in the new one.",
        };
      }
      if (this.#runtimeBinary(input) !== executablePath) {
        return {
          category: "interrupted",
          message: "The runtime's path on the target changed; the runtime starts again there.",
        };
      }
      const decision = this.admitProviderRuntime(session.targetId, input.driver, {
        posture: input.posture,
        permissionPersistence: input.permissionPersistence,
      });
      if (decision.status === "refused") {
        return {
          category: decision.reason === "runtime-not-attestable" ? "unsupported" : "unavailable",
          message: describeSshAdmissionRefusal(decision),
        };
      }
      return this.#channelOf(session) === undefined
        ? { category: "unavailable", message: "The session to the SSH target ended." }
        : undefined;
    };
    // A driver launches the person's path and no other: one from the model,
    // the remote root, or the target's own report never reaches the executor.
    if (launch.executable !== executablePath) {
      return refusedWith({
        category: "invalid-configuration",
        message: "A runtime on an SSH target runs only from the path set for it there.",
      });
    }
    const first = admitted();
    if (first !== undefined) return refusedWith(first);
    const root = decodeRemotePath(input.root);
    const executable = decodeRemotePath(launch.executable);
    const accountState = decodeAccountState(launch.accountState ?? []);
    const args = decodePlacedArgs(launch.args);
    const home = decodePlacedHome({ project: input.projectId, instance: input.providerInstanceId });
    const fixedVariables = decodePlacedVariables(
      Object.entries(launch.fixedVariables ?? {}).map(([name, value]) => ({ name, value })),
    );
    const deniedRootEntries = decodeDeniedRootEntries(launch.deniedRootEntries ?? []);
    if (
      root._tag === "Left" ||
      executable._tag === "Left" ||
      accountState._tag === "Left" ||
      args._tag === "Left" ||
      home._tag === "Left" ||
      fixedVariables._tag === "Left" ||
      deniedRootEntries._tag === "Left" ||
      // The target sets an account-state path's variable itself.
      fixedVariables.right.some((variable) =>
        accountState.right.some((state) => state.variable === variable.name),
      )
    ) {
      return refusedWith({
        category: "invalid-configuration",
        message:
          "The runtime's path, arguments, variables, denied entries, or account state cannot be placed on a target.",
      });
    }
    const egress =
      this.#runtimeEgress === undefined
        ? undefined
        : await this.#runtimeEgress.start({
            threadId: input.threadId,
            projectId: input.projectId,
            providerInstanceId: input.providerInstanceId,
            targetId: session.targetId,
            connectionId: session.connectionId,
            resolveAll: (host) => this.resolveOnTarget(session, host),
            connect: (destination) => this.dialFromTarget(session, destination),
          });
    if (egress?.status !== "listening") {
      return refusedWith({
        category: "unavailable",
        message: "This host could not start the runtime's network proxy.",
      });
    }
    const closeEgress = () => egress.close();
    // The proxy's start waited; the decision is made again with the request,
    // on the session it admitted.
    const second = admitted();
    const channel = this.#channelOf(session);
    if (second !== undefined || channel === undefined) {
      await closeEgress();
      return refusedWith(
        second ?? { category: "unavailable", message: "The session to the SSH target ended." },
      );
    }
    const opened = await channel.startProcess(
      {
        kind: "start-process",
        root: root.right,
        posture: input.posture,
        network: "proxied",
        egressToken: egress.token,
        executable: executable.right,
        args: args.right,
        accountState: accountState.right,
        ...(fixedVariables.right.length === 0 ? {} : { fixedVariables: fixedVariables.right }),
        ...(deniedRootEntries.right.length === 0
          ? {}
          : { deniedRootEntries: deniedRootEntries.right }),
        home: home.right,
      },
      { onStream: (stream) => joinToStream(connectToProxy(egress.endpoint), stream) },
      this.#readTimeoutMs,
    );
    if (opened.status !== "started") {
      await closeEgress();
      const reason =
        opened.status === "replied" &&
        (opened.reply.kind === "process-refused" || opened.reply.kind === "refused")
          ? opened.reply.reason
          : undefined;
      return refusedWith({
        category: reason === "busy" ? "rate-limited" : "unavailable",
        message:
          reason === undefined
            ? "The SSH target did not start the runtime."
            : `The SSH target refused to start the runtime (${reason}).`,
      });
    }
    const placed = opened.process;
    return {
      status: "started",
      process: placed,
      stop: async () => {
        placed.stop();
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          placed.ended,
          new Promise((resolve) => {
            timer = setTimeout(resolve, PLACED_STOP_WAIT_MS);
          }),
        ]);
        clearTimeout(timer);
        placed.stream.abandon();
        await closeEgress();
      },
    };
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
    const outcome = await this.#call(targetId, undefined, admission, request, this.#readTimeoutMs);
    if (outcome.status !== "replied") return outcome;
    const { reply } = outcome;
    switch (reply.kind) {
      case "root-resolved":
      case "directory-listed":
      case "file-read":
      case "git-status":
      case "git-diff":
      case "refused":
        return { status: "replied", reply };
      default:
        return { status: "unavailable" };
    }
  }

  /**
   * The session the target holds now, for work that must stay on it: a
   * remote turn's tools name it on every call, and its end ends the turn.
   * Undefined when no session is connected.
   */
  session(targetId: SshTargetId): SshTargetSession | undefined {
    const record = this.#connections.get(String(targetId));
    if (record?.state !== "connected") return undefined;
    const { channel, connectionId } = record;
    return { targetId, connectionId, onEnd: (listener) => channel.onEnd(listener) };
  }

  /**
   * One native-harness file tool on the bound root, admitted in the turn's
   * posture and sent only on the session the turn holds.
   */
  async harnessFile(
    session: Pick<SshTargetSession, "targetId" | "connectionId">,
    admission: SshTargetAdmissionRequest,
    request: SshExecutorHarnessFileRequest,
  ): Promise<SshTargetCallOutcome<SshExecutorHarnessFileReply | SshExecutorRefusedReply>> {
    const outcome = await this.#call(
      session.targetId,
      session.connectionId,
      admission,
      request,
      this.#readTimeoutMs,
    );
    if (outcome.status !== "replied") return outcome;
    const { reply } = outcome;
    return reply.kind === "harness-file" || reply.kind === "refused"
      ? { status: "replied", reply }
      : { status: "unavailable" };
  }

  /**
   * One harness command, admitted as one of Octant's own launches in the
   * turn's posture and sent only on the session the turn holds. A proxied
   * command names this host's egress proxy for its launch: each connection
   * the command makes on the target is joined to it here, where its egress is
   * decided and journaled. Aborting `signal` asks the executor to stop it.
   */
  async runCommand(
    session: Pick<SshTargetSession, "targetId" | "connectionId">,
    admission: SshTargetAdmissionRequest,
    request: SshExecutorRunCommandRequest,
    options: {
      readonly signal?: AbortSignal | undefined;
      readonly egressProxy?: ToolEgressProxyEndpoint | undefined;
    } = {},
  ): Promise<SshTargetCallOutcome<SshExecutorCommandRanReply | SshExecutorRefusedReply>> {
    const proxy = options.egressProxy;
    if ((request.network === "proxied") !== (proxy !== undefined)) return { status: "unavailable" };
    const outcome = await this.#call(
      session.targetId,
      session.connectionId,
      admission,
      request,
      request.timeoutMs + COMMAND_REPLY_GRACE_MS,
      {
        signal: options.signal,
        egress:
          proxy === undefined
            ? undefined
            : { onStream: (stream) => joinToStream(connectToProxy(proxy), stream) },
      },
    );
    if (outcome.status !== "replied") return outcome;
    const { reply } = outcome;
    return reply.kind === "command-ran" || reply.kind === "refused"
      ? { status: "replied", reply }
      : { status: "unavailable" };
  }

  /**
   * Opens a person's terminal in a bound root (or a managed worktree of it),
   * admitted as one of Octant's own launches in its posture. The decision and
   * the request are made in one step on the session that was admitted, and
   * the terminal belongs to that session: it ends when the session does.
   */
  async openTerminal(
    targetId: SshTargetId,
    admission: SshTargetAdmissionRequest,
    request: Omit<SshExecutorOpenTerminalRequest, "terminal">,
    listener: ExecutorTerminalListener,
  ): Promise<SshTargetTerminalOpening> {
    const decision = this.admit(targetId, admission);
    if (decision.status !== "admitted") return { status: "refused", decision };
    const record = this.#connections.get(String(targetId));
    if (record?.state !== "connected") return { status: "unavailable" };
    const opening = await record.channel.openTerminal(request, listener, this.#readTimeoutMs);
    if (opening.status === "lost") return { status: "unavailable" };
    if (opening.status === "replied") {
      return opening.reply.kind === "refused" || opening.reply.kind === "terminal-unavailable"
        ? { status: "replied", reply: opening.reply }
        : { status: "unavailable" };
    }
    const { channel, connectionId } = record;
    return {
      status: "opened",
      terminal: opening.terminal,
      session: { targetId, connectionId, onEnd: (end) => channel.onEnd(end) },
    };
  }

  /**
   * Creates or removes a managed worktree of a bound root, admitted as one
   * of Octant's own launches in its posture and sent only on the session
   * that admitted it.
   */
  async worktree(
    targetId: SshTargetId,
    admission: SshTargetAdmissionRequest,
    request: SshExecutorCreateWorktreeRequest | SshExecutorRemoveWorktreeRequest,
  ): Promise<SshTargetWorktreeOutcome> {
    const decision = this.admit(targetId, admission);
    if (decision.status !== "admitted") return { status: "refused", decision };
    const record = this.#connections.get(String(targetId));
    if (record?.state !== "connected") return { status: "unavailable" };
    const { connectionId } = record;
    const outcome = await this.#call(
      targetId,
      connectionId,
      admission,
      request,
      this.#readTimeoutMs,
    );
    if (outcome.status !== "replied") return outcome;
    const { reply } = outcome;
    switch (reply.kind) {
      case "refused":
        return { status: "replied", reply, connectionId };
      case "worktree-created":
        return request.kind === "create-worktree"
          ? { status: "replied", reply, connectionId }
          : { status: "unavailable" };
      case "worktree-removed":
        return request.kind === "remove-worktree"
          ? { status: "replied", reply, connectionId }
          : { status: "unavailable" };
      default:
        return { status: "unavailable" };
    }
  }

  /**
   * The target's addresses for a name, for this host's egress proxy while a
   * proxied command of the session runs. It rejects when none came, which
   * the proxy reads as a name that did not resolve.
   */
  async resolveOnTarget(
    session: Pick<SshTargetSession, "targetId" | "connectionId">,
    host: string,
  ): Promise<ReadonlyArray<string>> {
    const channel = this.#channelOf(session);
    if (channel === undefined || !isEgressHostName(host)) {
      throw new Error("The target cannot resolve that name now.");
    }
    const addresses = await channel.resolve(host);
    if (addresses === undefined) throw new Error("The target did not resolve that name.");
    return addresses;
  }

  /**
   * A connection from the target to an address this host's egress proxy
   * checked, for that proxy while a proxied command of the session runs. It
   * throws when none can be asked for, which the proxy reads as a failed
   * connection.
   */
  dialFromTarget(
    session: Pick<SshTargetSession, "targetId" | "connectionId">,
    destination: { readonly address: string; readonly port: number },
  ): Duplex {
    const channel = this.#channelOf(session);
    const stream =
      channel === undefined || !isEgressAddress(destination.address)
        ? undefined
        : channel.dial(destination.address, destination.port);
    if (stream === undefined) throw new Error("The target cannot open that connection now.");
    return stream;
  }

  async #call(
    targetId: SshTargetId,
    connectionId: SshConnectionId | undefined,
    admission: SshTargetAdmissionRequest,
    request: SshExecutorRequest,
    timeoutMs: number,
    options?: ExecutorRequestOptions,
  ): Promise<SshTargetCallOutcome<SshExecutorReply>> {
    const decision = this.admit(targetId, admission);
    if (decision.status !== "admitted") return { status: "refused", decision };
    const record = this.#connections.get(String(targetId));
    if (record?.state !== "connected") return { status: "unavailable" };
    // Work bound to one session never travels on a later one: the turn that
    // held it ended with it, and nothing is carried to the next.
    if (connectionId !== undefined && String(record.connectionId) !== String(connectionId)) {
      return { status: "unavailable" };
    }
    const outcome = await record.channel.request(request, timeoutMs, options);
    if (outcome.status !== "replied") return { status: "unavailable" };
    const { reply } = outcome;
    if (reply.kind === "attested" || reply.kind === "busy") return { status: "unavailable" };
    return { status: "replied", reply };
  }

  #channelOf(
    session: Pick<SshTargetSession, "targetId" | "connectionId">,
  ): ExecutorChannel | undefined {
    const record = this.#connections.get(String(session.targetId));
    return record?.state === "connected" &&
      String(record.connectionId) === String(session.connectionId)
      ? record.channel
      : undefined;
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

  /**
   * Records where one provider instance's runtime is on a target, as the
   * person set it from this machine. It is a path, not a check: the executor
   * checks the file it names before every launch, on whichever session asks.
   */
  setRuntimeBinary(
    request: SshRuntimeBinarySetRequest,
  ): SshTargetAdministrationResult<SshTargetStatus> {
    const target = this.#store.get(request.targetId);
    if (target === undefined) return refusal("unknown-target", "No such SSH target.");
    const written = this.#store.setRuntimeBinary(
      target.id,
      request.providerInstanceId,
      request.path,
    );
    if (written === "too-many") {
      return refusal(
        "too-many-runtime-binaries",
        "This target already holds a runtime path for as many providers as it may.",
      );
    }
    journaled(written);
    return { status: "ok", value: this.#status(target) };
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
      runtimeBinaries: this.#store.runtimeBinaries(target.id),
      placeableRuntimes: this.#placeableRuntimes?.(target.id) ?? [],
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
          probes: [
            ...SSH_CANARY_PROBES_BY_POSTURE[posture],
            ...SSH_RUNTIME_CANARY_PROBES_BY_POSTURE[posture],
          ],
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

/**
 * A placed runtime as its driver speaks to it: its output, its input while
 * the thread keeps the placement's posture, and its end.
 */
function placedProcess(
  input: SshTargetPlacementInput,
  placed: ExecutorPlacedProcess,
): ProviderPlacedProcess {
  const { stream } = placed;
  let over = false;
  void placed.ended.then(() => {
    over = true;
  });
  return {
    output: Stream.fromAsyncIterable(stream as AsyncIterable<Buffer>, () => undefined).pipe(
      Stream.map((chunk) => new Uint8Array(chunk)),
      Stream.catchAll(() => Stream.empty),
    ),
    write: (bytes) =>
      Effect.async<void, ProviderFailure>((resume) => {
        if (input.currentPosture() !== input.posture) {
          // Its grants were chosen for the posture it started in.
          placed.stop();
          resume(
            Effect.fail({
              category: "interrupted",
              message: "The thread's posture changed; the runtime starts again in the new one.",
            }),
          );
          return;
        }
        if (over || stream.destroyed || stream.writableEnded) {
          resume(Effect.fail({ category: "unavailable", message: "The runtime has ended." }));
          return;
        }
        stream.write(Buffer.from(bytes), (error) =>
          resume(
            error === null || error === undefined
              ? Effect.void
              : Effect.fail({ category: "unavailable", message: "The runtime has ended." }),
          ),
        );
      }),
    ended: Effect.promise(() =>
      placed.ended.then((end) =>
        end.kind === "exited"
          ? { kind: "exited" as const, code: end.exitCode ?? null }
          : { kind: "lost" as const },
      ),
    ),
  };
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

/**
 * A connection to this host's egress proxy for one launch, carrying one
 * connection the command made on the target. The proxy reads it exactly as
 * it reads a local command's, so every decision and record is its own.
 */
function connectToProxy(endpoint: ToolEgressProxyEndpoint): Socket {
  const socket =
    endpoint.kind === "unix-socket"
      ? netConnect({ path: endpoint.path, allowHalfOpen: true })
      : netConnect({ host: endpoint.host, port: endpoint.port, allowHalfOpen: true });
  socket.on("error", () => socket.destroy());
  return socket;
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
