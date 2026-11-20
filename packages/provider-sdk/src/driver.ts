import type { SandboxPolicySelection } from "@octant/contracts/sandbox-policy";
import type {
  ProviderApprovalCall,
  ContextCompactionRefusalReason,
  ProviderDriverKind,
  ProviderExecutionPolicy,
  ProviderFailure,
  ProviderInstanceId,
  ProjectId,
  ProviderAuthenticationAttempt,
  ProviderModelId,
  ProviderModelOptionValues,
  ProviderNativeSetup,
  ProviderProbeResult,
  ProviderResumeCursor,
  ProviderRuntimeEvent,
  ProviderSessionId,
  ProviderToolDefinition,
  ShieldDecision,
  WorkThreadId,
  ProviderToolAnswer,
  ProviderTurnInput,
  ProviderFileReviewRead,
} from "@octant/contracts";
import type { Effect, Scope, Stream } from "effect";
import type { ProviderContextFactsSource, ProviderLocalUsageHistorySource } from "./contextFacts";
import type { CloudSessionDriver } from "./cloudSessions";

export type {
  ProviderAttachmentInput,
  ProviderToolAnswer,
  ProviderToolDefinition,
  ProviderTurnInput,
  ProviderFileReviewRead,
} from "@octant/contracts";
export { ProviderOutputStopReason } from "@octant/contracts";

export interface ProviderProbeInput {
  readonly instanceId: ProviderInstanceId;
}

export interface ProviderAcquireInput {
  /** Immutable host-admitted sandbox authority; included in every process reuse key. */
  readonly sandboxPolicy?: SandboxPolicySelection;
  readonly instanceId: ProviderInstanceId;
  /**
   * The folder the runtime works in, a folder on this host.
   */
  readonly projectRoot: string;
  /**
   * The Project's extra folders: absolute canonical paths outside
   * `projectRoot` that the runtime gets exactly the access `projectRoot` gets
   * at this session's level, in its own sandbox and in any profile the host
   * wraps it in. Commands still start in `projectRoot`. Absent means none.
   */
  readonly extraFolders?: ReadonlyArray<string>;
  /**
   * The Octant-owned folder that holds the files the person attached to this
   * thread, under the host's data directory and never inside the Project. The
   * runtime reads it at every level, Plan and Chat included, in its own
   * sandbox and in any profile the host wraps it in, and never writes it.
   * Absent means the thread has none.
   */
  readonly attachmentsFolder?: string;
  readonly mode?: "chat" | "work" | "code";
  /** Context used by the server-owned Work request projection subscriber. */
  readonly workRequest?: {
    readonly projectId: ProjectId;
    readonly threadId: WorkThreadId;
    readonly sessionId: ProviderSessionId;
    /**
     * Stops a review that waits on a model when the turn is cancelled. Read
     * whenever a review starts: a connection the host keeps past its turn is
     * held by later turns, each with its own stop.
     */
    readonly signal?: AbortSignal | undefined;
    /**
     * Told when Octant Shield answered or declined one of this session's
     * approvals, so the turn's transcript can show the decision.
     */
    readonly onApprovalReviewed?: (review: {
      readonly requestId: string;
      readonly toolName: string;
      readonly summary: string;
      readonly decision: ShieldDecision;
    }) => void;
  };
}

/**
 * Where the person asked a session to compact itself: once its context window
 * holds `tokens` of the model's `contextWindow`. A driver that reports the
 * `compactionPoint` capability hands it to its runtime for this session only
 * (never to the person's own configuration files); any other driver ignores
 * it, and the host's between-turn rule still applies.
 */
export interface ProviderCompactionPoint {
  readonly tokens: number;
  readonly contextWindow: number;
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
   * The thread opted into the sandbox at Full access: with `executionPolicy`
   * `full-access` and this set, the session runs with no approval prompts but
   * inside the confinement the guarded levels have. A driver either keeps
   * that confinement or refuses the session; it never runs such a session
   * open. The host already refuses before start for runtimes it knows cannot
   * keep it. Absent means Full access runs open, as it always did.
   */
  readonly fullAccessSandbox?: boolean;
  /**
   * Whether Strict is on for this launch, as the host resolved it from the
   * thread, its Project and Settings. Strict keeps every protection Octant
   * adds beside the provider's own: the fixed launch environment, the
   * provider's channels (telemetry, error reports, feedback, marketplace
   * installs) off, and the provider's own tools refused Octant's protected
   * files. `false` lets the provider's own settings decide those. Absent is
   * Strict, so a caller that never resolved it keeps today's launch and
   * never loosens one.
   */
  readonly strict?: boolean;
  /**
   * Tools the person blocked for this provider in Settings, by the name its
   * runtime gives them, or `server__tool` for a tool of the provider's own
   * MCP server. A driver keeps each one from the session at every level, in
   * and out of Strict, through its runtime's own deny configuration or its
   * own gate, and fails the start rather than run a session in which a
   * blocked tool would still run. Absent or empty blocks nothing.
   */
  readonly blockedTools?: ReadonlyArray<string>;
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
  /**
   * What the runtime may load of its own in this session, as the host
   * resolved it from the thread's level and mode, the account's switch, and
   * the Project's trust. A driver turns on only the fields it reports
   * supported in its `nativeSetup` capability and keeps every other one off;
   * absent keeps all of them off.
   */
  readonly nativeSetup?: ProviderNativeSetup;
  /** The person's compaction point for this session; absent leaves the runtime its own. */
  readonly compactionPoint?: ProviderCompactionPoint;
  /** The host's schedule for this session's thread; see {@link ProviderWakeupSchedule}. */
  readonly wakeups?: ProviderWakeupSchedule;
  /**
   * The host keeps this session past its turn while the runtime runs
   * background work (see {@link ProviderConnection.backgroundWork}): a turn
   * completes when the model's reply is done, and a turn the runtime starts
   * by itself afterwards waits for the host to open one for it with
   * {@link ProviderConnection.attachRuntimeTurn}. Absent, a driver that holds
   * background work keeps the turn that started it open until the work ends.
   */
  readonly outlivesTurn?: boolean;
  /**
   * The host answers the runtime's own asks to change the thread's level
   * (`approval-request` with `levelChange`): when the person approves it
   * changes the level, in place through {@link ProviderConnection.changeLevelInPlace}
   * where the driver offers that change, and otherwise from the next session,
   * ending the turn. A driver offers
   * its runtime's plan-mode tools only to a session that carries this, and
   * never lets the runtime switch its own mode.
   */
  readonly levelChanges?: boolean;
}

/** One background task a session's runtime still runs, as the person may see it. */
export interface ProviderBackgroundTask {
  readonly taskId: string;
  readonly description?: string;
}

/**
 * What a session the host keeps past its turn is doing between turns. A
 * driver reports a new value whenever one of these changes.
 */
export interface ProviderBackgroundWork {
  readonly tasks: ReadonlyArray<ProviderBackgroundTask>;
  /** The runtime is running a turn: one the host sent, or one it started itself. */
  readonly turnRunning: boolean;
  /**
   * The runtime started a turn by itself while no host turn was open; its
   * events wait, unread, until the host attaches a turn to it.
   */
  readonly runtimeTurnWaiting: boolean;
  /** The session ended; no later value follows. */
  readonly ended: boolean;
}

/**
 * A wake-up as the host holds it for a session's thread, in the words a
 * driver hands back to its runtime.
 */
export interface ProviderWakeup {
  readonly id: string;
  readonly schedule:
    | { readonly kind: "delay" }
    | { readonly kind: "cron"; readonly cron: string; readonly recurring: boolean };
  readonly prompt: string;
  readonly humanSchedule: string;
  /** ISO time of the next fire, or of the fire that was missed. */
  readonly nextFireAt: string;
  readonly status: "pending" | "missed";
}

export type ProviderWakeupRequest =
  | {
      readonly kind: "delay";
      readonly providerToolName: string;
      readonly delaySeconds: unknown;
      readonly prompt: string;
      readonly reason?: string;
    }
  | {
      readonly kind: "cron";
      readonly providerToolName: string;
      readonly cron: string;
      readonly recurring: boolean;
      readonly prompt: string;
    };

/**
 * The host's schedule for one session's thread. A runtime that can wake its
 * model later keeps no schedule of its own: its driver hands each wake-up
 * here, and the host journals it, shows it in the thread, lets the person
 * cancel it, and starts the thread's turn when it comes due. A wake-up that
 * comes due while the host is down is shown as missed and never fired late.
 * Absent on a session the host starts no such turns for (Chat, Plan, a
 * single-use session); a driver then offers its runtime no wake-up tool.
 */
export interface ProviderWakeupSchedule {
  readonly schedule: (request: ProviderWakeupRequest) => Promise<
    | {
        readonly status: "scheduled";
        readonly wakeup: ProviderWakeup;
        readonly clampedDelaySeconds?: number;
        readonly wasClamped?: boolean;
      }
    | { readonly status: "refused"; readonly reason: string }
  >;
  /** The thread's waiting wake-ups, soonest first. */
  readonly list: () => Promise<ReadonlyArray<ProviderWakeup>>;
  /** Cancels one of this thread's wake-ups at the agent's request. */
  readonly cancel: (
    id: string,
  ) => Promise<
    { readonly status: "cancelled" } | { readonly status: "refused"; readonly reason: string }
  >;
  /** Cancels every delayed wake-up of this thread; answers how many. */
  readonly cancelDelayed: () => Promise<number>;
}

export interface ProviderSessionHandle {
  readonly sessionId: ProviderSessionId;
  readonly resumeCursor?: ProviderResumeCursor;
}

export interface ProviderSessionResume {
  /** Current host admission for a short-lived read; never persisted in the cursor. */
  readonly current?: () => boolean;
  /**
   * Current allowed catalogue. Mutable runtimes reattach it without changing
   * native history; a fixed-catalogue driver refuses new or changed definitions
   * and exposes `toolCatalogContinuation` for the host's explicit text handoff.
   */
  readonly tools?: ReadonlyArray<ProviderToolDefinition>;
  readonly sessionId: ProviderSessionId;
  readonly resumeCursor: ProviderResumeCursor;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly autoApprove?: boolean;
  /** Same meaning as in {@link ProviderSessionStart.fullAccessSandbox}. */
  readonly fullAccessSandbox?: boolean;
  /** Same meaning as in {@link ProviderSessionStart.strict}. */
  readonly strict?: boolean;
  /** As on {@link ProviderSessionStart}; restated on every resume. */
  readonly blockedTools?: ReadonlyArray<string>;
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
  /** As on {@link ProviderSessionStart}; a resume states it again for the session it resumes. */
  readonly nativeSetup?: ProviderNativeSetup;
  /** As on {@link ProviderSessionStart}; restated on every resume. */
  readonly compactionPoint?: ProviderCompactionPoint;
  /** As on {@link ProviderSessionStart}; restated on every resume. */
  readonly wakeups?: ProviderWakeupSchedule;
  /** As on {@link ProviderSessionStart}; restated on every resume. */
  readonly outlivesTurn?: boolean;
  /** As on {@link ProviderSessionStart}; restated on every resume. */
  readonly levelChanges?: boolean;
}

/**
 * How an in-place level change ended. `applied`: the runtime switched its
 * mode inside the running turn and the driver's gate holds every later call
 * of that session to the new level. `refused`: the driver did not try (no
 * running turn, or a session it cannot hold to the new level). `failed`: the
 * runtime did not accept the switch; the gate still holds the session to the
 * new level, and the host ends the turn.
 */
export type ProviderInPlaceLevelChange =
  | { readonly status: "applied" }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

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
  /**
   * `once`: the answer covers this one call. A driver neither remembers it for
   * the session or the Project nor asks the runtime to, whatever the person's
   * persistence setting says. Every automatic reviewer's answer (Octant
   * Shield) and every answer on a child run's behalf carries it, so one
   * automatic allow never authorizes a later call that nobody reviewed.
   * Absent, the driver applies the person's persistence setting as before.
   */
  readonly scope?: "once";
}

export interface ProviderUserInputAnswer {
  readonly sessionId: ProviderSessionId;
  readonly requestId: string;
  readonly answer: string;
}

/** A session the runtime keeps for this account and folder, begun outside Octant. */
export interface ProviderNativeSession {
  readonly nativeSessionId: string;
  /** The runtime's own title for it: a name the person gave it, or its summary. */
  readonly title?: string;
  /** When the runtime last wrote it, in milliseconds since the epoch. */
  readonly lastModified: number;
  readonly gitBranch?: string;
}

/**
 * The runtime's own sessions a thread may be started from. `list` names the
 * sessions of the instance's account in one folder, newest first, leaving out
 * any an Octant thread already holds. `adopt` records that an Octant session
 * resumes one of them and answers the cursor that resumes it; it refuses a
 * session another Octant thread holds, or one in another folder.
 */
export interface ProviderNativeSessions {
  readonly list: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly projectRoot: string;
  }) => Effect.Effect<ReadonlyArray<ProviderNativeSession>, ProviderFailure>;
  readonly adopt: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly projectRoot: string;
    readonly mode: "chat" | "work" | "code";
    readonly sessionId: ProviderSessionId;
    readonly nativeSessionId: string;
    readonly modelId: ProviderModelId;
  }) => Effect.Effect<ProviderResumeCursor, ProviderFailure>;
  /**
   * Withdraws an adoption the host could not record (the thread changed
   * before it committed): removes the record `adopt` wrote for that Octant
   * session, so the runtime's session is offered and adoptable again. A
   * session another Octant session now holds is left as it is. Absent, a
   * driver has nothing to withdraw.
   */
  readonly release?: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly nativeSessionId: string;
    readonly sessionId: ProviderSessionId;
  }) => Effect.Effect<void, ProviderFailure>;
  /**
   * Brings one of the runtime's own sessions over from another account of the
   * same provider, so this instance can then `adopt` it: a thread moved
   * between the two accounts keeps its session instead of a text handoff.
   * `refused` means the session cannot come and the host hands over as text;
   * `discard` takes back what was brought, for a move whose adoption then
   * refuses. Absent, a driver carries none.
   */
  readonly carry?: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly fromInstanceId: ProviderInstanceId;
    readonly projectRoot: string;
    readonly nativeSessionId: string;
  }) => Effect.Effect<ProviderNativeSessionCarry, ProviderFailure>;
}

/**
 * Which of a runtime's own sessions an Octant thread holds, as the host
 * records them: any session a journaled resume cursor of this driver kind
 * names, for every instance of the kind, since instances of one runtime may
 * share its session store. A driver that offers `nativeSessions` leaves a
 * held session out of its list and refuses to adopt it, so two threads never
 * drive one session. The host hands the same port to every driver, first-party
 * or not.
 */
export interface ProviderSessionOwnership {
  readonly held: (driverKind: ProviderDriverKind) => ReadonlySet<string>;
}

export type ProviderNativeSessionCarry =
  | { readonly status: "carried"; readonly discard: () => Effect.Effect<void> }
  | { readonly status: "refused" };

export interface ProviderDriver {
  /** Starting a thread from the runtime's own sessions; absent, a driver offers none. */
  readonly nativeSessions?: ProviderNativeSessions;
  /** A verified read adapter exists; acquiring still checks the exact runtime version. */
  readonly fileReviewReads?: true;
  readonly cloudSessions?: CloudSessionDriver;
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
  /** A fixed native catalogue needs a disclosed text handoff before it can change. */
  readonly toolCatalogContinuation?: (input: {
    readonly resumeCursor: ProviderResumeCursor;
    readonly tools: ReadonlyArray<ProviderToolDefinition>;
  }) => "unchanged" | "handoff-required";
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
  /**
   * Copies a session this driver opened into a new one that ends at a turn's
   * native anchor (as its `completed` event reported it), for a fork or a
   * rewind, and returns the cursor that resumes the copy under `sessionId`.
   * The source is never changed. Undefined when the copy cannot be exact
   * (another folder, mode or sign-in than the source's), so the host falls
   * back to a text handoff. Present only on a driver whose runtime makes the
   * copy itself.
   */
  readonly forkSession?: (
    input: ProviderSessionForkRequest,
  ) => Effect.Effect<ProviderResumeCursor | undefined, ProviderFailure>;
  readonly beginAuthentication?: (
    input: ProviderProbeInput,
  ) => Effect.Effect<ProviderAuthenticationAttempt, ProviderFailure, Scope.Scope>;
  /**
   * Pending while the person has not finished signing in yet; the caller asks
   * again. `code` is a code the sign-in page showed, passed to the provider's
   * own sign-in.
   */
  readonly completeAuthentication?: (
    input: ProviderProbeInput & { readonly attemptId: string; readonly code?: string },
  ) => Effect.Effect<ProviderAuthenticationProgress, ProviderFailure, Scope.Scope>;
}

export type ProviderAuthenticationProgress = "completed" | "pending";

export interface ProviderSessionForkRequest {
  readonly instanceId: ProviderInstanceId;
  /** The Octant session the copy is resumed under. */
  readonly sessionId: ProviderSessionId;
  /** The source session, as its turn's `provider-session-ready` recorded it. */
  readonly source: ProviderResumeCursor;
  readonly anchor: string;
  readonly projectRoot: string;
  readonly mode: "work" | "code";
  readonly modelId: ProviderModelId;
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
  /** Supplementary provider checkpoints, with no approve/revert or Git authority. */
  readonly readFileReview?: (input: {
    readonly sessionId: ProviderSessionId;
    readonly path: string;
    readonly scopeId?: string;
    readonly signal?: AbortSignal;
    readonly current: () => boolean;
  }) => Effect.Effect<ProviderFileReviewRead, ProviderFailure>;
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
  /**
   * Delivers a note to the current turn without starting another turn. The
   * note is person-authored unless `source` says it is a finished subagent's
   * result the host relays; a driver that frames the two differently reads
   * it, and one that does not delivers both as text. `unsupported` when no
   * turn is running or the note does not fit what the runtime takes.
   */
  readonly steer?: (input: {
    readonly sessionId: ProviderSessionId;
    readonly message: string;
    readonly source?: "person" | "agent-result";
  }) => Effect.Effect<"steered" | "unsupported", ProviderFailure>;
  /**
   * Stops one subagent the runtime itself started in this session, by the
   * `childAgentId` its `child-agent-activity` events carry, and leaves the
   * turn that started it running. Present only on a connection whose runtime
   * can stop one child alone. `stopped` means the stop was asked for; the
   * child is shown stopped only once the runtime reports a terminal child
   * event. `not-found` when the session holds no running child of that id.
   */
  readonly stopChildAgent?: (input: {
    readonly sessionId: ProviderSessionId;
    readonly childAgentId: string;
  }) => Effect.Effect<"stopped" | "unsupported" | "not-found", ProviderFailure>;
  /**
   * Sends one running subagent the runtime started in this session to the
   * background, by the `childAgentId` its `child-agent-activity` events
   * carry: the call that started it returns at once and the turn goes on
   * while the subagent keeps running. Present only on a connection whose
   * runtime can background one child alone. `not-found` when the session
   * holds no foreground child of that id.
   */
  readonly backgroundChildAgent?: (input: {
    readonly sessionId: ProviderSessionId;
    readonly childAgentId: string;
  }) => Effect.Effect<"backgrounded" | "unsupported" | "not-found", ProviderFailure>;
  /**
   * Queues a person's message for one running subagent, delivered with its
   * next tool call. `queued` means it waits for that call; a subagent that
   * makes none before it finishes never reads it. `not-found` when the
   * session holds no running child of that id, and `unsupported` when the
   * queue for it is full.
   */
  readonly messageChildAgent?: (input: {
    readonly sessionId: ProviderSessionId;
    readonly childAgentId: string;
    readonly message: string;
  }) => Effect.Effect<"queued" | "unsupported" | "not-found", ProviderFailure>;
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
  /**
   * Moves a session to a narrower level inside its running turn, so an
   * approved level change need not end the turn. Present only on a connection
   * whose runtime can switch its mode in a running session and whose gate can
   * hold that session to the new level's rules without launching it again,
   * though the session keeps the tools and sandbox it launched with. The only
   * change is `enter-plan`: leaving Plan widens what a session may do, which
   * no session can be given in place. Absent, or anything but `applied`, and
   * the host ends the turn and launches the next one at the new level.
   */
  readonly changeLevelInPlace?: (input: {
    readonly sessionId: ProviderSessionId;
    readonly change: "enter-plan";
  }) => Effect.Effect<ProviderInPlaceLevelChange>;
  readonly interrupt: (sessionId: ProviderSessionId) => Effect.Effect<void, ProviderFailure>;
  readonly stop: (sessionId: ProviderSessionId) => Effect.Effect<void, ProviderFailure>;
  /**
   * Kills the runtime process this one session runs in, without asking it to
   * stop first, for a turn that ignored `interrupt`. Present only on a
   * connection whose sessions each own a process, so killing it cannot end
   * another thread's turn; a connection that shares a process across sessions
   * omits it and a host fails closed.
   */
  readonly forceStop?: (sessionId: ProviderSessionId) => Effect.Effect<void, ProviderFailure>;
  readonly answerApproval: (input: ProviderApprovalAnswer) => Effect.Effect<void, ProviderFailure>;
  /**
   * The pending call behind an approval request this connection raised and
   * has not had answered, for an automatic reviewer on the host: its tool, the
   * argument fields a reviewer judges with credentials redacted, and where it
   * runs. Never put on an event, journaled, or shown. Absent, or answering
   * nothing, when the runtime cannot say. Optional ownerAction carries complete
   * file-operation facts only: no truncation, redaction, unknown fields or secret
   * content. Hosts expose those facts only after a fresh owner unlock and never
   * journal them; a separate fresh exact proof answers once. The reviewer judges by the
   * request's description alone.
   */
  readonly approvalCall?: (input: {
    readonly sessionId: ProviderSessionId;
    readonly requestId: string;
  }) => ProviderApprovalCall | undefined;
  readonly answerUserInput: (
    input: ProviderUserInputAnswer,
  ) => Effect.Effect<void, ProviderFailure>;
  readonly answerTool: (input: ProviderToolAnswer) => Effect.Effect<void, ProviderFailure>;
  /**
   * What a session started with `outlivesTurn` runs between turns, and a way
   * to hear each change. Present only on a connection whose runtime can keep
   * background work past a turn; undefined for a session it does not hold.
   * `watch` answers a function that stops listening.
   */
  readonly backgroundWork?: (sessionId: ProviderSessionId) =>
    | {
        readonly current: () => ProviderBackgroundWork;
        readonly watch: (listener: (work: ProviderBackgroundWork) => void) => () => void;
      }
    | undefined;
  /**
   * Opens the host's turn on a turn the runtime started by itself
   * (`runtimeTurnWaiting`): the events it held go out on this connection's
   * subscription, opened by `runtime-turn-started`, and the turn then runs
   * and ends like one the host sent. Fails when no such turn waits.
   */
  readonly attachRuntimeTurn?: (
    sessionId: ProviderSessionId,
  ) => Effect.Effect<void, ProviderFailure>;
}
