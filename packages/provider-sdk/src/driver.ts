import type {
  ContextCompactionRefusalReason,
  ProviderDriverKind,
  ProviderExecutionPolicy,
  ProviderFailure,
  ProviderInstanceId,
  ProjectId,
  ProviderAuthenticationAttempt,
  ProviderModelId,
  ProviderModelOptionValues,
  ProviderProbeResult,
  ProviderResumeCursor,
  ProviderRuntimeEvent,
  ProviderSessionId,
  ProviderToolDefinition,
  WorkThreadId,
  ProviderToolAnswer,
  ProviderTurnInput,
} from "@octant/contracts";
import type { Effect, Scope, Stream } from "effect";
import type { ProviderContextFactsSource, ProviderLocalUsageHistorySource } from "./contextFacts";

export type {
  ProviderAttachmentInput,
  ProviderToolAnswer,
  ProviderToolDefinition,
  ProviderTurnInput,
} from "@octant/contracts";
export { ProviderOutputStopReason } from "@octant/contracts";

export interface ProviderProbeInput {
  readonly instanceId: ProviderInstanceId;
}

export interface ProviderAcquireInput {
  readonly instanceId: ProviderInstanceId;
  /**
   * The folder the runtime works in. Without a placement it is a folder on
   * this host; with a remote placement it is the bound root as the target
   * names it, and never a folder on this host.
   */
  readonly projectRoot: string;
  readonly mode?: "chat" | "work" | "code";
  /** Context used by the server-owned Work request projection subscriber. */
  readonly workRequest?: {
    readonly projectId: ProjectId;
    readonly threadId: WorkThreadId;
    readonly sessionId: ProviderSessionId;
  };
  /**
   * Where the runtime's processes run. Absent means on this host, where every
   * driver launches them today. A remote placement reaches only a driver that
   * declares `remotePlacement`, through `acquireProviderConnection`.
   */
  readonly placement?: ProviderRemoteProcessPlacement;
}

/**
 * The postures a runtime can be placed on a remote target in: the ones Octant
 * confines. Octant wraps no runtime in Full access, so none is placed there.
 */
export type ProviderRemotePlacementPosture = Exclude<ProviderExecutionPolicy, "full-access">;

/**
 * A driver's declaration that its runtime can run on a remote target the host
 * reaches, such as an SSH target. The host admits a placed runtime only in a
 * posture listed here, and only where its own admission policy admits it.
 */
export interface ProviderRemotePlacementSupport {
  /**
   * The postures in which the runtime runs under Octant's confinement. A
   * runtime that rests on its own sandbox in a posture leaves it out, because
   * a target's attestation cannot speak for a sandbox Octant did not apply.
   */
  readonly postures: ReadonlyArray<ProviderRemotePlacementPosture>;
  /**
   * How the host's app-managed tools reach the runtime. A listener on the
   * target's loopback is refused until it is reviewed for other users there.
   */
  readonly appToolTransport: "stdio" | "loopback-listener" | "none";
}

/**
 * One runtime process a driver asks to start on the target. Its working
 * directory is the bound root and its environment is built on the target, so
 * no field here can carry a folder of this host, and none is for a credential.
 */
export interface ProviderPlacedLaunch {
  /** The runtime's absolute path on the target: the placement's own `executable`. */
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  /**
   * The paths the driver's profile declares for its sign-in, at most four,
   * each relative to the target user's home (never absolute, never `..`), so
   * none can name a folder of this host. Read-only unless the runtime's own
   * local launch writes that path. A launch that names more, or a path the
   * target refuses, is refused.
   */
  readonly accountState?: ReadonlyArray<ProviderPlacedAccountState>;
  /**
   * Variables the runtime's own local launch sets to constants of the
   * driver's (a switch that turns off auto-update, telemetry, or a Project's
   * own configuration), at most 32. A value holds no `/`, so it names no
   * folder of this host; a name the target sets itself (`PATH`, `HOME`,
   * `TMPDIR`), the loader's, the proxy's, Octant's own, or one an
   * account-state path names is refused (`placedLaunchExpressible` says
   * which a target accepts), and one the target also sets (`LANG`) keeps the
   * target's value. Never a credential: provider credentials do not reach a
   * target.
   */
  readonly fixedVariables?: Readonly<Record<string, string>>;
  /**
   * Entries of the bound root, relative to it, that the runtime may neither
   * read nor write, at most 32: files and folders the runtime would load by
   * itself and that start tools without Octant's approval. Each entry that
   * exists when the runtime starts is covered in its capsule, as a local
   * launch covers it.
   */
  readonly deniedRootEntries?: ReadonlyArray<string>;
}

/** One home-relative path a placed runtime signs in with on the target. */
export interface ProviderPlacedAccountState {
  readonly path: string;
  readonly access: "read-only" | "read-write";
  /** The variable that points the runtime at the path; the target sets its value. */
  readonly variable?: string;
}

/**
 * How a placed process ended: it exited on the target, or the host lost the
 * session that carried it, and it ended with that session.
 */
export type ProviderPlacedProcessEnd =
  | { readonly kind: "exited"; readonly code: number | null }
  | { readonly kind: "lost" };

/** A runtime process on the target, spoken to over its standard streams. */
export interface ProviderPlacedProcess {
  /** The process's standard output, in order, until it ends. */
  readonly output: Stream.Stream<Uint8Array>;
  /** Writes to the process's standard input; fails once the process has ended. */
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, ProviderFailure>;
  /** Resolves when the process has ended. */
  readonly ended: Effect.Effect<ProviderPlacedProcessEnd>;
}

/**
 * A host-supplied place on a remote target where a driver starts its runtime.
 * The host admits each launch in the posture of that moment and confines it
 * on the target, and the process stops when the launch's scope closes. A
 * refused or lost target fails the launch; a driver never runs the runtime on
 * this host instead.
 */
export interface ProviderRemoteProcessPlacement {
  readonly kind: "remote";
  /**
   * The runtime's absolute path on the target: the path the person set for
   * this provider instance on this target. A driver launches exactly this,
   * never a path of its own, the model's, the root's, or the target's report,
   * and the host refuses a launch that names another.
   */
  readonly executable: string;
  readonly launch: (
    launch: ProviderPlacedLaunch,
  ) => Effect.Effect<ProviderPlacedProcess, ProviderFailure, Scope.Scope>;
}

export interface ProviderSessionStart {
  readonly sessionId: ProviderSessionId;
  readonly modelId: ProviderModelId;
  readonly executionPolicy: ProviderExecutionPolicy;
  /**
   * Whether the harness may answer approval prompts via its native reviewer
   * (Codex `auto_review`, Claude `permissionMode: "auto"`). The driver decides
   * whether the provider supports it and whether taint or posture make it
   * inert; absent means the driver falls back to its default permission mode.
   */
  readonly autoApprove?: boolean;
  /**
   * User-chosen values for options the model declares (`ProviderModel.options`),
   * keyed by option id. Drivers apply the ids they understand and ignore the
   * rest; absent means provider defaults.
   */
  readonly modelOptionValues?: ProviderModelOptionValues;
  /** App-managed tools made available when the provider session starts. */
  readonly tools?: ReadonlyArray<ProviderToolDefinition>;
  /**
   * The host sends this session one request and stops it, and never resumes
   * it: a hand-off, a context or compaction summary, a commit or pull-request
   * draft, an advisor review. A driver keeps nothing durable that would only
   * serve a later resume and returns no resume cursor; no thread's journal
   * names such a session, so nothing a purge follows would reach what it kept.
   */
  readonly singleUse?: boolean;
  /**
   * The thread chose to deliver documents with the runtime's own artifact
   * tool (see {@link ProviderDriver.nativeArtifactTool}) instead of a Canvas.
   * A driver offers that tool only to a session that carries this and that it
   * would name the tool for; absent never offers it.
   */
  readonly nativeArtifacts?: boolean;
}

export interface ProviderSessionHandle {
  readonly sessionId: ProviderSessionId;
  readonly resumeCursor?: ProviderResumeCursor;
}

export interface ProviderSessionResume {
  /** Current allowed catalogue, reattached without changing native history. */
  readonly tools?: ReadonlyArray<ProviderToolDefinition>;
  readonly sessionId: ProviderSessionId;
  readonly resumeCursor: ProviderResumeCursor;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly autoApprove?: boolean;
  /**
   * The thread's current model. A driver that reports `modelSwitch` as
   * supported runs the resumed session on it; any other driver keeps the model
   * its session was opened with, and the host refuses a turn that would need
   * a different one.
   */
  readonly modelId?: ProviderModelId;
  readonly modelOptionValues?: ProviderModelOptionValues;
  /**
   * The thread chose to deliver documents with the runtime's own artifact
   * tool (see {@link ProviderDriver.nativeArtifactTool}) instead of a Canvas.
   * A driver offers that tool only to a session that carries this and that it
   * would name the tool for; absent never offers it.
   */
  readonly nativeArtifacts?: boolean;
}

export interface ProviderSessionCompactionRequest {
  readonly sessionId: ProviderSessionId;
  /** The host's id for this compaction. */
  readonly compactionId: string;
}

/**
 * How a requested compaction ended. A refusal changed nothing. A failure says
 * `sessionMayHaveChanged: false` only when the adapter can attest it; an
 * adapter that cannot tell says `true`.
 */
export type ProviderSessionCompaction =
  | {
      readonly kind: "compacted";
      /** The window's occupancy before and after, when the runtime reported it. */
      readonly tokensBefore?: number;
      readonly tokensAfter?: number;
    }
  | {
      readonly kind: "refused";
      readonly reason: Extract<
        ContextCompactionRefusalReason,
        "runtime-version-unsupported" | "no-session" | "turn-running" | "nothing-to-compact"
      >;
    }
  | {
      readonly kind: "failed";
      readonly message: string;
      readonly sessionMayHaveChanged: boolean;
    };

export interface ProviderApprovalAnswer {
  readonly sessionId: ProviderSessionId;
  readonly requestId: string;
  readonly approved: boolean;
}

export interface ProviderUserInputAnswer {
  readonly sessionId: ProviderSessionId;
  readonly requestId: string;
  readonly answer: string;
}

export interface ProviderDriver {
  /**
   * Provider-owned conversations must resume; host-owned APIs receive planned
   * history. `host-resumable` is host-owned, but the runtime keeps each
   * session durably: a follow-up on the same instance and model may resume the
   * earlier session and send only the new message, so its prompt cache and its
   * own tool state survive, and the host rebuilds the history in a fresh
   * session whenever that session cannot be taken up as it stands.
   */
  readonly conversationOwnership?: "provider" | "host" | "host-resumable";
  readonly kind: ProviderDriverKind;
  /**
   * Present only on a driver whose runtime can run on a remote target. A
   * driver without it reports remote placement unsupported, and the host
   * never hands it a remote placement.
   */
  readonly remotePlacement?: ProviderRemotePlacementSupport;
  readonly contextFacts?: ProviderContextFactsSource;
  /** Optional read-only local history reader owned by the configured driver. */
  readonly localUsageHistory?: ProviderLocalUsageHistorySource;
  /**
   * The name of the runtime's own tool that publishes a document to the
   * person's account with the model's provider, when a thread in this mode
   * and posture may choose it: the driver reports `nativeArtifacts` supported
   * there. Undefined otherwise. Only a thread that chose it starts its session
   * with `nativeArtifacts` and is asked to deliver documents with that tool
   * instead of a Canvas. Naming the tool grants nothing: the driver's own gate
   * still decides every call.
   */
  readonly nativeArtifactTool?: (input: {
    readonly mode: "chat" | "work" | "code";
    readonly executionPolicy: ProviderExecutionPolicy;
  }) => string | undefined;
  readonly probe: (
    input: ProviderProbeInput,
  ) => Effect.Effect<ProviderProbeResult, ProviderFailure, Scope.Scope>;
  /**
   * Optional per-model tool-capability verification. Used by drivers whose
   * Connection Check is non-generating (the direct-endpoint profiles) so a
   * separate, explicitly-requested generating probe can prove one model calls
   * a tool before Octant offers it any.
   */
  readonly verifyToolCapability?: (
    input: ProviderToolVerificationInput,
  ) => Effect.Effect<ProviderToolVerificationResult, ProviderFailure, Scope.Scope>;
  readonly acquire: (
    input: ProviderAcquireInput,
  ) => Effect.Effect<ProviderConnection, ProviderFailure, Scope.Scope>;
  readonly beginAuthentication?: (
    input: ProviderProbeInput,
  ) => Effect.Effect<ProviderAuthenticationAttempt, ProviderFailure, Scope.Scope>;
  readonly completeAuthentication?: (
    input: ProviderProbeInput & { readonly attemptId: string },
  ) => Effect.Effect<void, ProviderFailure, Scope.Scope>;
}

export interface ProviderToolVerificationInput {
  readonly instanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
}

export interface ProviderToolVerificationResult {
  readonly instanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly appManagedTools: "supported" | "unsupported";
}

export interface ProviderConnection {
  /** A transport may cancel one app tool while its session remains alive. */
  readonly toolRequestSignal?: (input: {
    readonly sessionId: ProviderSessionId;
    readonly requestId: string;
  }) => AbortSignal;
  /**
   * Establishes a subscription to this connection's runtime events and returns
   * the stream reading from it. Each subscriber gets its own, and it lasts as
   * long as the scope it was taken in.
   *
   * Subscribing is the effect, not the reading: a provider that answers
   * immediately publishes from inside `send`, before the turn's consumer fiber
   * has run, so a caller must be able to subscribe first and read afterwards.
   * A stream that only subscribes when it is first pulled cannot offer that —
   * it drops the turn's opening text, or the terminal event the caller is
   * waiting for, depending on how the scheduler interleaved the two.
   */
  readonly subscribe: Effect.Effect<
    Stream.Stream<ProviderRuntimeEvent, ProviderFailure>,
    never,
    Scope.Scope
  >;
  readonly start: (
    input: ProviderSessionStart,
  ) => Effect.Effect<ProviderSessionHandle, ProviderFailure>;
  readonly resume: (
    input: ProviderSessionResume,
  ) => Effect.Effect<ProviderSessionHandle, ProviderFailure>;
  readonly send: (input: ProviderTurnInput) => Effect.Effect<void, ProviderFailure>;
  /** Delivers a person-authored note to the current turn without starting another turn. */
  readonly steer?: (input: {
    readonly sessionId: ProviderSessionId;
    readonly message: string;
  }) => Effect.Effect<"steered" | "unsupported", ProviderFailure>;
  /**
   * Asks the runtime to compact a session it holds, outside any turn. Present
   * only on a connection whose mode's sessions the runtime can compact; a
   * connection without it cannot compact. It resolves once the runtime
   * reports the compaction ended, after the `context-compacted` event with
   * trigger `requested` when it compacted, and leaves the session resumable.
   */
  readonly compact?: (
    input: ProviderSessionCompactionRequest,
  ) => Effect.Effect<ProviderSessionCompaction, ProviderFailure>;
  readonly interrupt: (sessionId: ProviderSessionId) => Effect.Effect<void, ProviderFailure>;
  readonly stop: (sessionId: ProviderSessionId) => Effect.Effect<void, ProviderFailure>;
  readonly answerApproval: (input: ProviderApprovalAnswer) => Effect.Effect<void, ProviderFailure>;
  readonly answerUserInput: (
    input: ProviderUserInputAnswer,
  ) => Effect.Effect<void, ProviderFailure>;
  readonly answerTool: (input: ProviderToolAnswer) => Effect.Effect<void, ProviderFailure>;
}
