import type { PreparedProductFeedbackTurn } from "../browser/productFeedbackTurnPort";
import type { ConversationInputReceipt } from "@octant/contracts/conversation-inputs";
import { THREAD_MOVING_REFUSAL } from "../hub/threadMoveHolds";
import type { ConversationInputTransfer } from "../attachments/conversationInputTransfer";
import { conversationInputReceiptBlock } from "../attachments/conversationInputs";
import { SIDE_CHAT_RETURN_UNAVAILABLE, type SideChatReturnResolver } from "../chat/sideChatReturn";
import { recordProviderChildObservation } from "@octant/provider-sdk/child-observations";
import { approvedWorkingFolderRoot } from "../approvedWorkingFolders";
import {
  coveredAgentResultDeliveryMembers,
  validateAgentResultDelivery,
} from "../agentRun/agentResultDeliveryBatch";
import {
  contextSourceKey,
  reusableContextSummaryIds,
  type ContextHarnessService,
  type SessionConversationMessage,
} from "../context/contextHarnessService";
import type { AutomaticCompactionSighting } from "../context/automaticCompaction";
import { observeWorkContext } from "./workContextInspection";
import type { AgentRunParentContextSelection } from "../agentRun/agentRunParentContext";
import {
  conversationHandoffRefusalMessage,
  providerSwitchHandoffRecord,
  withHandoverSummary,
  restartHandoffRecord,
  selectionBelongsToThread,
  type ConversationHandoffRefusal,
} from "../agentRun/conversationHandoff";
import { unsupportedModelOptionValues } from "@octant/domain/chat-policy";
import type { SelectedExtensionResolver } from "../extensions/selectedExtensions";
import {
  ActorId,
  type AutomationRunReference,
  CorrelationId,
  EventId,
  MAX_WORK_TRANSCRIPT_TURNS,
  ProviderSessionId,
  UtcTimestamp,
  DEFAULT_WORK_ACCESS,
  decodeCancelWorkTurnCommand,
  decodeContextSubjectRef,
  decodeWorkThreadTranscript,
  decodeWorkThreadTranscriptWindow,
  decodeWorkTurnCancelResult,
  decodeWorkTurnFailure,
  decodeWorkTurnLookupResult,
  decodeWorkTurnRequestId,
  decodeWorkTurnState,
  decodeStartWorkThreadTurnCommand,
  decodeRewindWorkThreadCommand,
  MAX_WORK_REWOUND_TURNS,
  decodeWorkThreadRewindResult,
  type WorkThreadRewindResult,
  type WorkTurnHandoff,
  type ContextCompactionSettledRecord,
  type ContextInspectorSnapshot,
  type MentionableThreadId,
  type TurnUsage,
  type WorkAttachmentId,
  type WorkAttachmentMediaType,
  type WorkAttachmentReference,
  type WorkAccess,
  type WorkThread,
  type WorkThreadId,
  type WorkThreadTranscript,
  type WorkThreadTranscriptWindow,
  type WorkThreadTranscriptWindowRequest,
  type WorkTurnCancelResult,
  type WorkTurnFailure,
  type WorkTurnLookupResult,
  type WorkTurnRequestId,
  type WorkTurnState,
  type StartWorkThreadTurnCommand,
  type AgentRun,
  type AgentRunId,
  type WorkTurnStreamFrame,
  type HarnessRetryNotice,
  type Project,
  type ProjectId,
  type ProjectMemoryView,
  type ProviderAttachmentInput,
  type ProviderContextBlock,
  type ProviderResumeCursor,
  type ProviderInstance,
  type ProviderModel,
  type ThreadTaskProgressList,
  type ThreadWorkingDirectory,
  type WindowId,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { isBrowserUseSelection } from "@octant/plugin-host/browser-use";
import { isComputerUseSelection } from "@octant/plugin-host/computer-use";
import type { ProviderDriver, ProviderSessionHandle } from "@octant/provider-sdk/driver";
import { combineAppManagedToolSets, type AppManagedToolSet } from "../providers/appManagedToolSet";
import { nativeSetupOption, sessionNativeSetup } from "../providers/providerNativeSetup";
import type {
  NativeHarnessTurnAdmission,
  NativeHarnessTurnScope,
} from "../harness/nativeHarnessTurnObserver";
import { withPromptDigest, type TurnEndSummary } from "../metrics/turnEnd";
import type { LiveTurnRegistry } from "../liveTurn/liveTurnRegistry";
import {
  accumulateTurnUsage,
  decideConversationSession,
  decideWorkTurnAuthority,
  assertProviderAllowedByProjectPolicy,
  ProjectProviderPolicyRejected,
  FILE_MENTION_UNREADABLE_CONTEXT,
  THREAD_MENTION_UNREADABLE_CONTEXT,
  workProjectKeepsStatusFile,
  clampWorkAccess,
  workThreadAccessOf,
  workTurnCapabilityFacts,
  projectExtraFolderRoots,
  projectExtraFoldersInstructions,
  type ThreadToolSteps,
} from "@octant/domain";
import {
  planWorkTurnContext,
  includeWorkToolDefinitions,
  type WorkTurnContextPlan,
  WORK_TURN_SAFE_INPUT_TOKENS,
  type WorkTurnContextContribution,
} from "./workTurnContext";
import type { WorkTurnWrittenFiles } from "@octant/contracts/work-turns";
import { decodeSpendCeilingReservationId, type SpendCeilingService } from "../spendCeilingService";
import { Effect, Schema } from "effect";
import {
  ConcurrencyConflict,
  JournalWriteFailed,
  persistenceFailureMessage,
} from "../persistence/journalErrors";
import { ProjectionApplicationFailed } from "../persistence/projection";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import type { WorkTurnFileObserver } from "./workTurnFileObserver";
import type { WorkProjectStatusFiles } from "./workProjectStatusFiles";
import { designSystemFolders, type DesignSystemFiles } from "../designSystems/designSystemFiles";
import { designSystemTurnContext } from "../designSystems/designSystemContext";
import {
  DEFAULT_WORK_STATUS_STALE_AFTER_DAYS,
  WORK_STATUS_FILE_NAME,
  decideWorkResumeBrief,
  isWorkStatusDate,
  parseWorkStatus,
  type WorkResumeBriefReason,
} from "@octant/domain/work-project-status-policy";
import {
  WorkAttachmentInvalid,
  WorkAttachmentTooLarge,
  type WorkAttachmentStore,
} from "./workAttachmentStore";
import type { FramedExternalContent } from "../context/externalContentFraming";
import type { RuntimeOutsideContentMarking } from "../context/runtimeOutsideContentMark";
import type { RuntimeForgeChangeObserver } from "../shield/runtimeForgeChanges";
import type { WorkTurnCutOffByRestart, WorkTurnProjection } from "./workTurnProjection";
import type { RestartContinuationReadiness } from "../harness/threadRestartContinuation";
import {
  WorkTurnRuntime,
  type WorkTurnRuntimeOutcome,
  type WorkTurnRuntimePort,
} from "./workTurnRuntime";
import { workExternalInputReceipt, sameWorkExternalInput } from "./workExternalInput";
import type { WorkExternalInputReceipt } from "@octant/contracts/work-turns";
import { WorkTurnLiveStore } from "./workTurnLiveStore";
import { WorkTurnUsageStore } from "./workTurnUsageStore";
import { isRoutineHostScope } from "../routineHostScope";

const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeCorrelationId = Schema.decodeUnknownSync(CorrelationId);
const decodeEventId = Schema.decodeUnknownSync(EventId);
const decodeProviderSessionId = Schema.decodeUnknownSync(ProviderSessionId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

/**
 * The standing rule for every turn in a Work Project that keeps a status
 * file. Says what to do with `STATUS.md`, never what the status is; the file
 * itself is in the context beside it. Its text never changes, so a session
 * holds it once and a provider's cached prompt prefix is never invalidated by
 * it.
 */
const STATUS_UPKEEP_INSTRUCTION = `This Project keeps its current state in ${WORK_STATUS_FILE_NAME} at the top of the folder; it is in your context. When this turn changes where the work stands, update ${WORK_STATUS_FILE_NAME} before you finish: revise "Current status", add or resolve dated lines under "Follow-ups" and "Deadlines" (one per line, "- YYYY-MM-DD what"), and set the "Last updated:" line to today. Leave it unchanged for questions and conversation.`;

/** Identifies the status file's block, so a newer version replaces the one a session holds. */
const STATUS_FILE_CONTEXT_KEY = "work-status-file";

/**
 * Asks a task that opens on a quiet or dated status to take stock first.
 *
 * A one-turn instruction, not part of the standing rule: folded into it, the
 * rule's text changed whenever the status crossed a staleness or date
 * threshold, which withdrew the held rule and sent the whole standing context
 * again.
 */
function takeStockInstruction(reasons: ReadonlyArray<WorkResumeBriefReason>): string | undefined {
  if (reasons.length === 0) return undefined;
  const why = [
    reasons.includes("stale") ? "the status has not been updated for a while" : undefined,
    reasons.includes("overdue") ? "at least one deadline or follow-up date has passed" : undefined,
    reasons.includes("due-soon") ? "a deadline or follow-up is due within days" : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(", and ");
  return `Take stock first: ${why}. Before starting the request, briefly summarize where this work stands from ${WORK_STATUS_FILE_NAME} — current status, open follow-ups, and deadlines with their dates — then ask the person what has happened since and what they need to follow up on. Update ${WORK_STATUS_FILE_NAME} with their answer before continuing with the request. When the request is a greeting or unrelated to this work, answer it first and offer the update at the end instead.`;
}

/**
 * How many bytes of encoded turns one transcript window may carry before it
 * stops adding turns. A Work turn can hold a 200 000-character prompt, its
 * reply twice (as `response` and in `transcript`), a task list, and child
 * observations, so a page of the maximum 64 turns could otherwise pass the
 * 8 MiB a paired device's response is cut at and fail to decode there.
 */
export const WORK_TRANSCRIPT_WINDOW_BYTES = 2 * 1024 * 1024;

/** Why the host refuses a turn on a Work thread a person marked Done. */
const WORK_REWIND_WHILE_TURN_RUNS =
  "A turn is running in this thread. Wait for it to finish or stop it, then rewind.";
export const WORK_THREAD_MARKED_DONE_TURN_REFUSAL =
  "This task is marked Done. Archive and reactivate it before sending more.";

export class WorkTurnServiceError extends Error {
  override readonly name = "WorkTurnServiceError";
  constructor(readonly failure: WorkTurnFailure) {
    super(failure.message);
  }
}

/** What the turn's latest usage report said about the window and model time. */
interface WorkUsageFacts {
  readonly contextTokens?: number | undefined;
  readonly contextWindow?: number | undefined;
  readonly providerExecutionDurationMs?: number | undefined;
}

export interface WorkTurnStartOptions {
  /** Required framed data from an owned host workflow, never a wire-supplied instruction. */
  readonly externalData?: { readonly content: FramedExternalContent; readonly referenceId: string };
  /**
   * The most this turn may run at, for a caller whose own authority may be
   * narrower than the thread's (a goal-loop round, a routine, a delegation):
   * the turn runs at the thread's level clamped to it (`clampWorkAccess`).
   */
  readonly accessCeiling?: WorkAccess;
  /**
   * Set by the host's own usage-limit recovery when it dispatches the
   * authorized continuation: the send is not the person re-engaging, so it
   * must not wake a snooze or reopen a completion. Host-only: the wire
   * command cannot carry it.
   */
  readonly limitRecovery?: boolean;
  /** Host-only revocation check; never grants authority or travels on the wire. */
  readonly admissionCurrent?: () => boolean;
  /**
   * Set by the routine dispatcher for the turn it starts for a run, and only
   * there: the turn may report that run's result. Host-only: the wire command
   * cannot carry it.
   */
  readonly routineRun?: AutomationRunReference;
}

/**
 * Work threads in a Project on a registered server. Canonical:
 * docs/design/server-projects.md § Work Projects. The Project is in its own
 * catalog, so `readProject` never names it; its turn runs on the Octant
 * Harness with every tool on the server, or not at all.
 */
export interface ServerWorkTurns {
  /** Whether the thread runs in a server Work Project, on the binding that Project derives. */
  readonly holds: (thread: WorkThread) => boolean;
  /** The turn's folder on the server and its tools there, or why it cannot run. */
  readonly bind: (
    thread: WorkThread,
  ) =>
    | { readonly status: "bound"; readonly folder: string; readonly tools: AppManagedToolSet }
    | { readonly status: "refused"; readonly message: string };
}

export interface WorkTurnServiceDependencies {
  /** Whether a move holds a thread; a held thread starts no turn. */
  readonly moveHold?: (threadId: string) => boolean;
  readonly resolveSideChatReturns?: SideChatReturnResolver;
  readonly resolveSelectedExtensions?: SelectedExtensionResolver;
  /** The plugins pinned to a Project, offered on every turn there without a per-send selection. */
  readonly pinnedExtensionIds?: (projectId: string) => ReadonlyArray<string>;
  readonly persistence: {
    readonly status: () => { readonly state: string; readonly integrity: string };
    readonly readProject: (projectId: ProjectId) => Project | undefined;
    /** The Project's memory, whose active entries every turn in it carries. */
    readonly readProjectMemory?: (projectId: ProjectId) => ProjectMemoryView;
    readonly readProviderInstance: (
      instanceId: WorkThread["providerInstanceId"],
    ) => ProviderInstance | undefined;
    readonly readProviderModel?: (
      instanceId: WorkThread["providerInstanceId"],
      modelId: WorkThread["modelId"],
    ) => ProviderModel | undefined;
    readonly journal: {
      append: (request: {
        readonly aggregate: {
          readonly aggregateType: string;
          readonly aggregateId: string;
        };
        readonly expectedVersion: number;
        readonly events: ReadonlyArray<{
          readonly eventId: string;
          readonly eventName: string;
          readonly eventVersion: 1;
          readonly correlationId: string;
          readonly actor: { readonly kind: "local-user" | "system"; readonly actorId: string };
          readonly occurredAt: string;
          readonly payload: unknown;
        }>;
      }) => void;
    };
  };
  readonly threads: {
    readonly bootstrap: (windowId: WindowId) => Promise<{
      readonly threads: ReadonlyArray<WorkThread>;
    }>;
    readonly read: (windowId: WindowId, threadId: WorkThreadId) => Promise<WorkThread | undefined>;
  };
  readonly projects: {
    readonly bootstrap: (windowId: WindowId) => Promise<{
      readonly active: ReadonlyArray<{
        readonly id: ProjectId;
        readonly type: string;
        readonly lifecycle: string;
      }>;
    }>;
  };
  readonly projection: WorkTurnProjection;
  readonly workingDirectories: {
    readonly current?: (root: string, directory: string) => () => boolean;
    readonly resolve: (
      authoritativeRoot: string,
      workingDirectory: ThreadWorkingDirectory,
    ) => Promise<string>;
  };
  readonly resolveDriver: (
    providerInstanceId: WorkThread["providerInstanceId"],
  ) => ProviderDriver | undefined;
  readonly attachments?: WorkAttachmentStore;
  /**
   * Whether a provider can carry its native session on to another of its
   * models. Absent or false keeps refusing a follow-up whose model differs
   * from the session's.
   */
  readonly supportsModelSwitch?: (providerInstanceId: WorkThread["providerInstanceId"]) => boolean;
  /**
   * Selects the thread's own earlier conversation for a turn that moves it to
   * a provider keeping its history in a session of its own. Absent on a host
   * that cannot hand a conversation over, which then refuses such a switch.
   */
  readonly selectConversationHandoff?: (
    thread: WorkThread,
    /** Why the turn starts a new session; the receiving model is told which. */
    purpose: "provider-switch" | "rewind" | "fork",
  ) => AgentRunParentContextSelection;
  /**
   * Whether the selected provider and model honestly accept images. The host
   * refuses a turn that names attachments when this is false, rather than
   * sending the prompt with its pictures quietly removed.
   */
  readonly conversationInputTransfer?: Pick<ConversationInputTransfer, "prepare">;
  readonly supportsAttachments?: (input: {
    readonly providerInstanceId: WorkThread["providerInstanceId"];
    readonly modelId: WorkThread["modelId"];
  }) => boolean;
  readonly turnRuntime?: WorkTurnRuntimePort;
  readonly prepareProductFeedbackForTurn?: (input: {
    readonly windowId: WindowId;
    readonly threadId: string;
    readonly operationId: string;
    readonly supportsImages: boolean;
    readonly current: () => boolean;
  }) => PreparedProductFeedbackTurn | undefined;
  /**
   * Records that the runtime's own web search, page fetch, or hosted tool put
   * outside content in front of the model. Without it such a call stops the
   * turn.
   */
  readonly outsideContentMarks?: RuntimeOutsideContentMarking;
  /** Journals the pushes and pull-request changes a runtime's own shell starts. */
  readonly forgeChanges?: RuntimeForgeChangeObserver;
  readonly onRequestSettled?: (
    input: { readonly providerSessionId: ProviderSessionId; readonly providerCallbackId: string },
    release: () => void,
  ) => () => void;
  /**
   * The app-managed tools a Work turn may offer its provider. Absent on a host
   * that composes none, which sends the turn with no tools rather than
   * pretending a provider can reach the folder.
   */
  readonly resolveAppManagedTools?: (input: {
    readonly thread: WorkThread;
    readonly projectRoot: string;
    /** The Project's extra folders, which file tools treat as the root. */
    readonly extraFolders?: ReadonlyArray<string>;
    readonly windowId: WindowId;
    /** The turn the tools serve. */
    readonly turnId: StartWorkThreadTurnCommand["turnId"];
    /** The routine run this turn was started for, from the dispatcher only. */
    readonly routineRun?: AutomationRunReference;
  }) => AppManagedToolSet | undefined;
  /** Work threads in a Project on a registered server, whose turns act there. */
  readonly serverProjects?: ServerWorkTurns;
  /** The harness around a turn: stable instructions in front, the reply observed after. */
  /**
   * A person asked the thread for a turn. Fires once the thread and its
   * Project are known to be reachable from this window and before the turn
   * starts, so a completed or snoozed thread comes back the moment it is
   * spoken to. A throw refuses the turn: a thread left completed or snoozed
   * while its turn ran would be a half-applied state.
   */
  readonly onTurnRequested?: (threadId: WorkThreadId) => void;
  /**
   * A person stopped the thread's running turn. Fires once the turn is
   * recorded as cancelled, never for a turn that had already ended. A throw is
   * ignored: the stop has happened and must not report as failed.
   */
  readonly onTurnCancelled?: (threadId: WorkThreadId) => void;
  readonly spendCeiling?: {
    readonly admit: SpendCeilingService["admit"];
    readonly settle: SpendCeilingService["settle"];
  };
  /**
   * The person-memory block for this thread's turn, or undefined when the
   * turn gets none (memory off, the thread or its Project kept out, or a
   * principal other than a window on this host).
   */
  readonly personMemoryBlock?: (input: {
    readonly thread: WorkThread;
    readonly windowId: WindowId;
  }) => string | undefined;
  readonly nativeHarness?: {
    readonly contextFor: (scope: NativeHarnessTurnScope) => ReadonlyArray<ProviderContextBlock>;
    /** Octant Shield's record of the remote commands a runtime runs with its own shell tool. */
    readonly observeRemoteCommand?: (
      threadId: string,
      projectId: string | undefined,
      event: ProviderRuntimeEvent,
    ) => void;
    /** Absent means every turn is admitted. */
    readonly admitTurn?: (scope: NativeHarnessTurnScope) => NativeHarnessTurnAdmission;
    readonly turnStarted: (scope: NativeHarnessTurnScope) => void;
    /** Every turn's end, whatever its outcome, with what the turn cost and how it ran. */
    readonly turnEnded?: (scope: NativeHarnessTurnScope, turn?: TurnEndSummary) => void;
    /** The host's keyed prompt digest; absent when the host has no key. */
    readonly promptDigest?: (text: string) => string;
    readonly turnCompleted: (
      input: NativeHarnessTurnScope & {
        readonly text: string;
        readonly toolCalls: number;
        readonly turn?: TurnEndSummary;
      },
    ) => Promise<void>;
    readonly noteRetry?: (scope: NativeHarnessTurnScope, notice: HarnessRetryNotice) => void;
    readonly clearRetry?: (scope: NativeHarnessTurnScope) => void;
  };
  /**
   * Watches the bound folder for the length of a turn. Absent on a host that
   * cannot watch, which records no written files rather than guessing at them.
   */
  readonly turnFileObserver?: WorkTurnFileObserver;
  /**
   * The Project's `AGENTS.md` and `STATUS.md`. Absent
   * on a host that keeps no brief files, which sends the turn with only its
   * own transcript as before.
   */
  readonly projectStatusFiles?: WorkProjectStatusFiles;
  /**
   * The Project's design systems (`DESIGN.md`). Absent on a host that reads
   * none, which sends the turn without design-system context.
   */
  readonly designSystemFiles?: Pick<DesignSystemFiles, "primary">;
  /** Days before a status counts as stale and a new task opens by taking stock. */
  readonly statusStaleAfterDays?: number;
  /**
   * Resolves the `#thread` mentions a Work turn names. Absent on a host that
   * cannot re-derive Open authority, which reports every mention unread rather
   * than inventing transcript.
   */
  readonly resolveThreadMentionContext?: (input: {
    readonly threadMentionIds: ReadonlyArray<MentionableThreadId>;
    /** The thread whose turn names the mentions; a marked mention marks it. */
    readonly readerThreadId: string;
    readonly windowId: WindowId;
  }) => Promise<ReadonlyArray<ProviderContextBlock>>;
  /**
   * Resolves the `@file` mentions a Work turn names against the bound Project
   * root. Out-of-root paths are refused before any read.
   */
  readonly resolveFileMentionContext?: (input: {
    readonly fileMentionPaths: ReadonlyArray<string>;
    readonly windowId: WindowId;
    readonly threadId: WorkThreadId;
  }) => Promise<ReadonlyArray<ProviderContextBlock>>;
  readonly takeIssueContextFramed?: (threadId: string) => FramedExternalContent | undefined;
  readonly peekIssueContextFramed?: (threadId: string) => FramedExternalContent | undefined;
  readonly consumeIssueContextFramed?: (threadId: string) => void;
  readonly uuid: () => string;
  readonly clock: () => string;
  readonly expectedHostId?: string;
  /**
   * Token budget the Work turn planner uses. Tests inject a tight budget to
   * prove oversized file mentions refuse; production uses the conservative
   * default until this thread's model reports a window.
   */
  readonly contextHarness?: ContextHarnessService;
  readonly safeInputBudgetTokens?: number;
  readonly liveUpdates?: WorkTurnLiveStore;
  /**
   * Process-local per-request token figures, recorded on every usage event a
   * provider reports. The durable turn contract carries no tokens; a caller
   * waiting on the turn (the goal loop) reads its figures from here.
   */
  readonly usageStore?: WorkTurnUsageStore;
  /** Where a running turn's start time and latest step are kept for the navigation read. */
  readonly liveTurns?: LiveTurnRegistry;
  /**
   * Read access to journaled subagent runs. A turn that claims to carry a
   * finished run's result is verified here — parent thread, terminal
   * status, and a delivery not already settled — so a caller cannot mark a
   * turn as a delivery the journal does not record. Absent means delivery
   * claims are refused.
   */
  readonly agentRuns?: {
    readonly getById: (runId: AgentRunId) => AgentRun | undefined;
  };
  /**
   * Where the service records the access each running turn holds. The host
   * passes one it built before the native harness, which reads it; absent,
   * the service keeps its own.
   */
  readonly runningAccess?: RunningWorkTurnAccess;
}

/** The access each running Work turn holds, by thread, as the turn service records it. */
export type RunningWorkTurnAccess = Map<
  string,
  {
    readonly requestId: string;
    readonly access: WorkAccess;
    /** The sandbox choice the turn started with; a later change waits for the next turn. */
    readonly fullAccessSandbox?: boolean;
  }
>;

export class WorkTurnService {
  /** Turns being prepared, per thread, until they are accepted or refused. */
  readonly #startingTurns = new Map<string, number>();
  /**
   * The access each running turn holds, by thread. The native harness checks
   * edits against this rather than the thread's own access, so a goal-loop
   * round held ask-first stays ask-first for every provider.
   */
  readonly #runningAccess: RunningWorkTurnAccess;
  readonly #resolveSelectedExtensions: SelectedExtensionResolver | undefined;
  readonly #pinnedExtensionIds: WorkTurnServiceDependencies["pinnedExtensionIds"];
  readonly #persistence: WorkTurnServiceDependencies["persistence"];
  readonly #threads: WorkTurnServiceDependencies["threads"];
  readonly #projects: WorkTurnServiceDependencies["projects"];
  readonly #projection: WorkTurnProjection;
  readonly #workingDirectories: WorkTurnServiceDependencies["workingDirectories"];
  readonly #resolveDriver: WorkTurnServiceDependencies["resolveDriver"];
  readonly #attachments: WorkAttachmentStore | undefined;
  readonly #conversationInputTransfer: WorkTurnServiceDependencies["conversationInputTransfer"];
  readonly #supportsAttachments: WorkTurnServiceDependencies["supportsAttachments"];
  readonly #supportsModelSwitch: WorkTurnServiceDependencies["supportsModelSwitch"];
  readonly #selectConversationHandoffContext: WorkTurnServiceDependencies["selectConversationHandoff"];
  readonly #turnRuntime: WorkTurnRuntimePort;
  readonly #prepareProductFeedbackForTurn: WorkTurnServiceDependencies["prepareProductFeedbackForTurn"];
  readonly #outsideContentMarks: RuntimeOutsideContentMarking | undefined;
  readonly #forgeChanges: RuntimeForgeChangeObserver | undefined;
  readonly #onRequestSettled: WorkTurnServiceDependencies["onRequestSettled"];
  readonly #resolveAppManagedTools: WorkTurnServiceDependencies["resolveAppManagedTools"];
  readonly #serverProjects: ServerWorkTurns | undefined;
  readonly #nativeHarness: WorkTurnServiceDependencies["nativeHarness"];
  readonly #personMemoryBlock: WorkTurnServiceDependencies["personMemoryBlock"];
  readonly #spendCeiling: WorkTurnServiceDependencies["spendCeiling"];
  readonly #spendReservations = new Map<
    string,
    ReturnType<typeof decodeSpendCeilingReservationId>
  >();
  readonly #onTurnRequested: WorkTurnServiceDependencies["onTurnRequested"];
  readonly #onTurnCancelled: WorkTurnServiceDependencies["onTurnCancelled"];
  readonly #turnFileObserver: WorkTurnFileObserver | undefined;
  readonly #projectStatusFiles: WorkProjectStatusFiles | undefined;
  readonly #designSystemFiles: Pick<DesignSystemFiles, "primary"> | undefined;
  readonly #statusStaleAfterDays: number;
  readonly #resolveSideChatReturns: SideChatReturnResolver | undefined;
  readonly #resolveThreadMentionContext: WorkTurnServiceDependencies["resolveThreadMentionContext"];
  readonly #resolveFileMentionContext: WorkTurnServiceDependencies["resolveFileMentionContext"];
  readonly #takeIssueContextFramed: WorkTurnServiceDependencies["takeIssueContextFramed"];
  readonly #peekIssueContextFramed: WorkTurnServiceDependencies["peekIssueContextFramed"];
  readonly #consumeIssueContextFramed: WorkTurnServiceDependencies["consumeIssueContextFramed"];
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #expectedHostId: string;
  readonly #contextHarness: ContextHarnessService | undefined;
  readonly #safeInputBudgetTokens: number;
  readonly #liveUpdates: WorkTurnLiveStore;
  readonly #usageStore: WorkTurnUsageStore | undefined;
  readonly #liveTurns: LiveTurnRegistry | undefined;
  readonly #agentRuns: WorkTurnServiceDependencies["agentRuns"];
  readonly #controllers = new Map<string, AbortController>();
  readonly #inflight = new Map<string, Promise<void>>();
  readonly #liveResponses = new Map<string, string>();
  readonly #liveTasks = new Map<string, ThreadTaskProgressList>();
  readonly #liveToolSteps = new Map<string, ThreadToolSteps>();

  readonly #moveHold: ((threadId: string) => boolean) | undefined;

  constructor(dependencies: WorkTurnServiceDependencies) {
    this.#moveHold = dependencies.moveHold;
    this.#runningAccess = dependencies.runningAccess ?? new Map();
    this.#contextHarness = dependencies.contextHarness;
    this.#resolveSelectedExtensions = dependencies.resolveSelectedExtensions;
    this.#pinnedExtensionIds = dependencies.pinnedExtensionIds;
    this.#persistence = dependencies.persistence;
    this.#threads = dependencies.threads;
    this.#projects = dependencies.projects;
    this.#projection = dependencies.projection;
    this.#workingDirectories = dependencies.workingDirectories;
    this.#resolveDriver = dependencies.resolveDriver;
    this.#attachments = dependencies.attachments;
    this.#conversationInputTransfer = dependencies.conversationInputTransfer;
    this.#supportsAttachments = dependencies.supportsAttachments;
    this.#supportsModelSwitch = dependencies.supportsModelSwitch;
    this.#selectConversationHandoffContext = dependencies.selectConversationHandoff;
    this.#turnRuntime = dependencies.turnRuntime ?? new WorkTurnRuntime();
    this.#prepareProductFeedbackForTurn = dependencies.prepareProductFeedbackForTurn;
    this.#outsideContentMarks = dependencies.outsideContentMarks;
    this.#forgeChanges = dependencies.forgeChanges;
    this.#onRequestSettled = dependencies.onRequestSettled;
    this.#resolveAppManagedTools = dependencies.resolveAppManagedTools;
    this.#serverProjects = dependencies.serverProjects;
    this.#nativeHarness = dependencies.nativeHarness;
    this.#personMemoryBlock = dependencies.personMemoryBlock;
    this.#spendCeiling = dependencies.spendCeiling;
    this.#onTurnRequested = dependencies.onTurnRequested;
    this.#onTurnCancelled = dependencies.onTurnCancelled;
    this.#turnFileObserver = dependencies.turnFileObserver;
    this.#projectStatusFiles = dependencies.projectStatusFiles;
    this.#designSystemFiles = dependencies.designSystemFiles;
    this.#statusStaleAfterDays =
      dependencies.statusStaleAfterDays ?? DEFAULT_WORK_STATUS_STALE_AFTER_DAYS;
    this.#resolveThreadMentionContext = dependencies.resolveThreadMentionContext;
    this.#resolveSideChatReturns = dependencies.resolveSideChatReturns;
    this.#resolveFileMentionContext = dependencies.resolveFileMentionContext;
    if (dependencies.takeIssueContextFramed !== undefined) {
      this.#takeIssueContextFramed = dependencies.takeIssueContextFramed;
    }
    if (dependencies.peekIssueContextFramed !== undefined) {
      this.#peekIssueContextFramed = dependencies.peekIssueContextFramed;
    }
    if (dependencies.consumeIssueContextFramed !== undefined) {
      this.#consumeIssueContextFramed = dependencies.consumeIssueContextFramed;
    }
    this.#uuid = dependencies.uuid;
    this.#clock = dependencies.clock;
    this.#expectedHostId = dependencies.expectedHostId ?? "local";
    this.#safeInputBudgetTokens = dependencies.safeInputBudgetTokens ?? WORK_TURN_SAFE_INPUT_TOKENS;
    this.#liveUpdates = dependencies.liveUpdates ?? new WorkTurnLiveStore();
    this.#usageStore = dependencies.usageStore;
    this.#liveTurns = dependencies.liveTurns;
    this.#agentRuns = dependencies.agentRuns;
  }

  /**
   * The earlier conversation a turn hands to the new provider session it
   * starts, with the record the turn's acceptance journals. A conversation
   * that cannot be handed over refuses the turn with the reason: the new
   * provider is never started as if it had seen a conversation it was not
   * given.
   */
  #selectConversationHandoff(
    thread: WorkThread,
    previous: WorkTurnState,
    reason: "provider-switch" | "branch" | "rewind",
  ): {
    readonly blocks: ReadonlyArray<ProviderContextBlock>;
    readonly record: WorkTurnHandoff;
    readonly selection: Extract<AgentRunParentContextSelection, { readonly status: "available" }>;
  } {
    const refuse = (refusal: ConversationHandoffRefusal): never => {
      throw this.#failure(
        "unavailable",
        conversationHandoffRefusalMessage(refusal, {
          thread: "Work task",
          cause: reason === "branch" ? "branch" : "switch",
        }),
      );
    };
    const select = this.#selectConversationHandoffContext;
    if (select === undefined) return refuse("unsupported");
    let selection: AgentRunParentContextSelection;
    try {
      selection = select(thread, reason === "branch" ? "fork" : reason);
    } catch {
      return refuse("source-unavailable");
    }
    if (selection.status === "unavailable") return refuse(selection.reason);
    const owned = selectionBelongsToThread(selection, {
      mode: "work",
      id: String(thread.id),
      projectId: String(thread.projectId),
    });
    if (owned !== "ok") return refuse(owned);
    if (reason !== "provider-switch")
      return {
        blocks: selection.blocks,
        selection,
        record: restartHandoffRecord(selection, reason === "branch" ? "fork" : "rewind"),
      };
    const switched = withHandoverSummary(
      selection,
      this.#handoverSummary("work-thread", thread.id),
    );
    return {
      blocks: switched.blocks,
      selection: switched,
      record: providerSwitchHandoffRecord(
        switched,
        // A handoff that never completed is made again from the provider the
        // conversation came from, not the one that may not have received it.
        previous.handoff?.reason === "provider-switch" && previous.status !== "completed"
          ? {
              providerInstanceId: previous.handoff.previousProviderInstanceId,
              modelId: previous.handoff.previousModelId,
            }
          : {
              providerInstanceId: previous.authority.providerInstanceId,
              modelId: previous.authority.modelId,
            },
      ),
    };
  }

  /** The limit rule's summary for the thread, if one is waiting for a move. */
  #handoverSummary(
    aggregateType: "work-thread",
    threadId: WorkThreadId,
  ): { readonly content: string; readonly completedAt: string } | undefined {
    try {
      return this.#contextHarness?.handoverSummary(
        decodeContextSubjectRef({ aggregateType, aggregateId: String(threadId) }),
        () => this.sessionCompactionConversation(threadId),
      );
    } catch {
      // A ledger that cannot be read hands over the raw selection, as before.
      return undefined;
    }
  }

  #agentResultDelivery(command: StartWorkThreadTurnCommand): WorkTurnLookupResult | undefined {
    if (command.delivery === undefined) return undefined;
    const requested = command.delivery;
    const validation = validateAgentResultDelivery({
      delivery: requested,
      threadId: String(command.threadId),
      mode: "work",
      getById: (id) => this.#agentRuns?.getById(id),
    });
    if (validation.kind === "invalid") throw this.#failure("invalid", validation.detail);
    const existing = this.#projection.lookup(command.requestId);
    if (existing !== undefined) return this.#lookupMatching(command, existing);
    const turns = this.#projection.listForThread(command.threadId);
    const covered = new Set(
      coveredAgentResultDeliveryMembers(
        requested,
        turns.flatMap((turn) => (turn.delivery === undefined ? [] : [turn.delivery])),
      ).map((member) => String(member.runId)),
    );
    if (
      validation.runs.some(
        (run) => run.resultDelivery !== undefined && !covered.has(String(run.id)),
      )
    )
      throw this.#failure("invalid", "A named subagent run's result delivery already settled.");
    const delivered = turns.find(
      (turn) =>
        turn.delivery !== undefined &&
        coveredAgentResultDeliveryMembers(requested, [turn.delivery]).length > 0,
    );
    if (delivered !== undefined)
      return decodeWorkTurnLookupResult({ kind: "accepted", turn: delivered });
    if (
      turns.some(
        (turn) =>
          turn.status === "accepted" || turn.status === "running" || turn.status === "waiting",
      )
    )
      throw this.#failure("stale", "The Work parent already has an active turn.");
    return undefined;
  }

  async startFirstTurn(
    authenticatedWindowId: WindowId,
    input: unknown,
    options?: WorkTurnStartOptions,
  ): Promise<WorkTurnLookupResult> {
    if (process.platform === "win32")
      throw this.#failure("unavailable", "Work execution requires Windows host confinement.");
    this.#assertReady();
    const command = decodeStartWorkThreadTurnCommand(input);
    const existing = this.#projection.lookup(command.requestId);
    if (existing !== undefined && command.delivery === undefined) {
      return this.#lookupMatching(
        command,
        existing,
        options?.externalData === undefined
          ? undefined
          : workExternalInputReceipt(options.externalData),
      );
    }
    // The turn reads the conversation it plans from while it is prepared, so
    // no compaction may be under way when it starts, and none may start until
    // it is accepted: a summary committed in between would be planned over.
    if (
      this.#contextHarness?.compactionRunning(
        decodeContextSubjectRef({
          aggregateType: "work-thread",
          aggregateId: String(command.threadId),
        }),
      ) === true
    ) {
      throw this.#failure("stale", "This session is being compacted. Send again when it finishes.");
    }
    const key = String(command.threadId);
    this.#startingTurns.set(key, (this.#startingTurns.get(key) ?? 0) + 1);
    try {
      return await this.#admitTurn(authenticatedWindowId, command, options);
    } finally {
      const remaining = (this.#startingTurns.get(key) ?? 1) - 1;
      if (remaining === 0) this.#startingTurns.delete(key);
      else this.#startingTurns.set(key, remaining);
    }
  }

  /**
   * Why a turn on this thread would be refused for its own standing, judged by
   * the decision every Work turn passes. The authority is the one a window
   * showing the thread now would send: the thread's last turn, on the Project's
   * current binding, with the thread's own folder, provider and model. A thread
   * with no turn has nothing to judge here.
   */
  turnStandingRefusal(thread: WorkThread): "project-unavailable" | "binding-changed" | undefined {
    const last = this.#projection.latestForThread(thread.id)?.authority;
    if (last === undefined) return undefined;
    // A server thread's binding is the one its Project derives; it stands
    // while the Project is in the catalog, which `holds` reads.
    if (this.#serverProjects?.holds(thread) === true) return undefined;
    const project = this.#persistence.readProject(thread.projectId);
    const currentBinding = project?.type === "work" ? project.bindingHistory.at(-1) : undefined;
    const decision = decideWorkTurnAuthority({
      authority: {
        ...last,
        projectId: thread.projectId,
        bindingRevisionId: currentBinding?.revisionId ?? last.bindingRevisionId,
        workingDirectory: thread.workingDirectory ?? last.workingDirectory,
        ...(thread.workingFolderId === undefined
          ? {}
          : { workingFolderId: thread.workingFolderId }),
        providerInstanceId: thread.providerInstanceId,
        modelId: thread.modelId,
      },
      expectedHostId: this.#expectedHostId,
      project: workTurnProjectFacts(project),
      thread: workTurnThreadFacts(thread),
    });
    if (decision.kind === "allow") return undefined;
    return decision.category === "stale" ? "binding-changed" : "project-unavailable";
  }

  /**
   * Whether the turn a restart cut off is still owed a continuation, and
   * whether its provider can take up the session it ran in. Only the
   * thread's latest turn is owed one; a newer turn means the person moved
   * on. A turn that was still only accepted never started its provider, so
   * its message never reached it; a provider that keeps its own conversation
   * resumes only from the cursor the turn carries. The continuation itself
   * goes through ordinary admission, which takes up that session again.
   */
  restartContinuationReadiness(
    thread: WorkThread | undefined,
    cut: Pick<WorkTurnCutOffByRestart, "requestId" | "reachedRuntime">,
  ): RestartContinuationReadiness {
    if (thread === undefined || thread.lifecycle !== "active") return { kind: "settled" };
    const latest = this.#projection.latestForThread(thread.id);
    if (
      latest === undefined ||
      String(latest.requestId) !== String(cut.requestId) ||
      latest.status !== "failed" ||
      latest.failure?.category !== "interrupted"
    )
      return { kind: "settled" };
    const owed = {
      kind: "owed" as const,
      continuationOf: String(latest.requestId),
      optedOut: thread.restartContinuationOff === true,
    };
    if (!cut.reachedRuntime)
      return {
        ...owed,
        cannotResume:
          "The turn stopped before it reached its provider, so its message was never sent. Send it again.",
      };
    const driver = this.#resolveDriver(latest.authority.providerInstanceId);
    if (driver === undefined)
      return { ...owed, cannotResume: "This thread's provider is unavailable." };
    if (driver.conversationOwnership === "provider" && latest.resumeCursor === undefined)
      return {
        ...owed,
        cannotResume: "This thread's provider cannot resume the session the turn ran in.",
      };
    return owed;
  }

  /** Whether a turn on this thread is being prepared and not yet accepted. */
  isTurnStarting(threadId: WorkThreadId): boolean {
    return this.#startingTurns.has(String(threadId));
  }

  async #admitTurn(
    authenticatedWindowId: WindowId,
    command: StartWorkThreadTurnCommand,
    options: WorkTurnStartOptions | undefined,
  ): Promise<WorkTurnLookupResult> {
    const externalData =
      options?.externalData === undefined
        ? undefined
        : {
            referenceId: options.externalData.referenceId,
            content: { ...options.externalData.content },
          };
    const externalInput =
      externalData === undefined ? undefined : workExternalInputReceipt(externalData);
    if (options?.admissionCurrent?.() === false) {
      throw this.#failure("unauthorized", "Work turn admission is no longer current.");
    }
    if (this.#moveHold?.(String(command.threadId)) === true) {
      throw this.#failure("stale", THREAD_MOVING_REFUSAL);
    }
    const thread = await this.#threads.read(authenticatedWindowId, command.threadId);
    // The level this turn runs at, fixed at admission: the thread's own,
    // clamped to the caller's ceiling. It is journaled with the turn and is
    // what the provider session starts with.
    const turnAccess =
      options?.accessCeiling === undefined
        ? (thread?.access ?? DEFAULT_WORK_ACCESS)
        : clampWorkAccess(thread?.access ?? DEFAULT_WORK_ACCESS, options.accessCeiling);
    const projectBootstrap = await this.#projects.bootstrap(authenticatedWindowId);
    // A thread in a server Work Project binds its turn here, before anything
    // starts: the harness's tools on the server, or why it cannot run there.
    const server =
      thread === undefined || this.#serverProjects?.holds(thread) !== true
        ? undefined
        : this.#serverProjects.bind(thread);
    const accessible =
      server !== undefined
        ? String(thread?.projectId) === String(command.authority.projectId)
        : projectBootstrap.active.some(
            (project) =>
              project.type === "work" &&
              project.lifecycle === "active" &&
              String(project.id) === String(command.authority.projectId),
          );
    if (!accessible) {
      throw this.#failure("unauthorized", "Work Project is unavailable for this window.");
    }
    if (server?.status === "refused") throw this.#failure("unavailable", server.message);
    // A person's Done mark locks the thread for every turn: a typed message,
    // a queued follow-up, a usage-limit continuation, a child's result, a
    // routine or goal round. The window's lock alone let all of these
    // through. Checked before the turn request, so a refused turn never
    // wakes a snooze or reopens a put-away thread.
    if (thread?.completionConfirmed === true) {
      throw this.#failure("invalid", WORK_THREAD_MARKED_DONE_TURN_REFUSAL);
    }
    if (thread !== undefined) {
      const model = this.#persistence.readProviderModel?.(
        thread.providerInstanceId,
        thread.modelId,
      );
      if (unsupportedModelOptionValues(thread.modelOptionValues, model?.options ?? []).length > 0) {
        throw this.#failure(
          "invalid",
          "Selected Work model no longer offers the saved model options. Choose a supported level or Default.",
        );
      }
      const policyProject = this.#persistence.readProject(thread.projectId);
      const policyProvider = this.#persistence.readProviderInstance(thread.providerInstanceId);
      if (policyProject?.type === "work" && policyProvider !== undefined) {
        try {
          assertProviderAllowedByProjectPolicy(
            policyProject,
            policyProvider,
            this.#persistence.readProviderModel?.(thread.providerInstanceId, thread.modelId),
          );
        } catch (error) {
          if (error instanceof ProjectProviderPolicyRejected) {
            throw this.#failure("unauthorized", error.message);
          }
          throw error;
        }
      }
    }
    const admission =
      thread === undefined
        ? undefined
        : this.#nativeHarness?.admitTurn?.({
            threadId: String(thread.id),
            mode: "work",
            providerInstanceId: thread.providerInstanceId,
            modelId: thread.modelId,
            projectId: thread.projectId,
          });
    if (admission?.kind === "paused") {
      throw this.#failure(
        "unavailable",
        `${admission.status === "paused-by-advisor" ? "The advisor paused this thread" : "This thread is paused"}: ${admission.detail} Resume the harness session to continue.`,
      );
    }
    // The host's own limit-recovery dispatch is not the person re-engaging,
    // so it must not wake a snooze or reopen a completion the way their turn
    // would; the spent limit-owned snooze goes in the settle instead.
    if (thread !== undefined && options?.limitRecovery !== true) this.#onTurnRequested?.(thread.id);
    const localProject =
      server === undefined ? this.#persistence.readProject(command.authority.projectId) : undefined;
    const decision = decideWorkTurnAuthority({
      authority: command.authority,
      expectedHostId: this.#expectedHostId,
      // A server Project's facts are its derived binding and its folder there,
      // which the decision compares and never opens.
      project:
        server === undefined
          ? workTurnProjectFacts(localProject)
          : {
              type: "work",
              lifecycle: "active",
              bindingHistory:
                thread?.bindingRevisionId === undefined
                  ? []
                  : [{ revisionId: String(thread.bindingRevisionId) }],
              binding: { canonicalRoot: server.folder },
            },
      thread: workTurnThreadFacts(thread),
    });
    if (decision.kind === "deny") {
      throw this.#failure(decision.category, decision.message);
    }
    const project = localProject?.type === "work" ? localProject : undefined;
    if (server === undefined && project === undefined) {
      throw this.#failure("unauthorized", "Work Project is unavailable for this turn.");
    }

    const delivered = this.#agentResultDelivery(command);
    if (delivered !== undefined) return delivered;

    let projectRoot: string;
    if (server !== undefined) {
      // The folder as the server names it; nothing on this host opens it.
      if (String(command.authority.workingDirectory) !== ".") {
        throw this.#failure("invalid", "Work working directory is unavailable.");
      }
      projectRoot = server.folder;
    } else {
      try {
        const root =
          project === undefined
            ? undefined
            : approvedWorkingFolderRoot(project, command.authority.workingFolderId);
        if (root === undefined) throw new Error("Working folder is unavailable");
        projectRoot = await this.#workingDirectories.resolve(
          root,
          command.authority.workingDirectory,
        );
      } catch {
        throw this.#failure("invalid", "Work working directory is unavailable.");
      }
    }

    const extraFolders =
      project === undefined
        ? []
        : [
            ...new Set([
              ...(command.authority.workingFolderId !== undefined &&
              projectRoot !== project.binding.canonicalRoot
                ? [project.binding.canonicalRoot]
                : []),
              ...projectExtraFolderRoots(project),
            ]),
          ].filter((folder) => folder !== projectRoot);

    const provider = this.#persistence.readProviderInstance(command.authority.providerInstanceId);
    if (provider === undefined || !provider.enabled) {
      throw this.#failure("unavailable", "Selected Work provider is unavailable.");
    }
    try {
      if (project !== undefined) {
        assertProviderAllowedByProjectPolicy(
          project,
          provider,
          this.#persistence.readProviderModel?.(
            command.authority.providerInstanceId,
            command.authority.modelId,
          ),
        );
      }
    } catch (error) {
      if (error instanceof ProjectProviderPolicyRejected) {
        throw this.#failure("unauthorized", error.message);
      }
      throw error;
    }
    const driver = this.#resolveDriver(command.authority.providerInstanceId);
    if (driver === undefined) {
      throw this.#failure("unavailable", "Selected provider cannot start a Work turn.");
    }

    const starting = this.#startingAttachments(command.threadId, command.attachmentIds);
    if (starting.status === "unknown") {
      throw this.#failure("invalid", "An image attached to this turn is no longer staged.");
    }
    if (starting.attachments.length > 0 && !this.#modelReadsImages(command.authority)) {
      throw this.#failure(
        "unsupported",
        "The selected model does not support images. Choose a vision model, or remove the attachments.",
      );
    }
    let attachmentInputs = await this.#attachmentInputs(command.threadId, starting.attachments);
    if (attachmentInputs === undefined) {
      throw this.#failure("unavailable", "An image attached to this turn is unavailable.");
    }

    const selections =
      command.extensionSelections?.filter(
        (selection) => !isBrowserUseSelection(selection) && !isComputerUseSelection(selection),
      ) ?? [];
    const pinnedExtensionIds =
      thread === undefined ? [] : (this.#pinnedExtensionIds?.(String(thread.projectId)) ?? []);
    let skillContext: ReadonlyArray<ProviderContextBlock> = [];
    let extensionTools: AppManagedToolSet | undefined;
    if (server !== undefined && (selections.length > 0 || pinnedExtensionIds.length > 0)) {
      throw this.#failure(
        "unsupported",
        "Extensions act on this computer, so a thread in a Project on a server does not use them.",
      );
    }
    if (selections.length > 0 || pinnedExtensionIds.length > 0) {
      const resolved =
        thread === undefined
          ? undefined
          : await this.#resolveSelectedExtensions?.({
              mode: "work",
              thread,
              selections,
              pinnedExtensionIds,
              windowId: authenticatedWindowId,
            }).catch(() => undefined);
      if (resolved === undefined || resolved.kind === "unavailable") {
        throw this.#failure(
          "unavailable",
          resolved?.message ?? "Selected extension is unavailable for Work on this host.",
        );
      }
      skillContext = resolved.context;
      extensionTools = resolved.tools;
    }
    const hostTools =
      server !== undefined
        ? server.tools
        : thread === undefined
          ? undefined
          : this.#resolveAppManagedTools?.({
              thread,
              projectRoot,
              ...(extraFolders.length === 0 ? {} : { extraFolders }),
              windowId: authenticatedWindowId,
              turnId: command.turnId,
              ...(options?.routineRun === undefined ? {} : { routineRun: options.routineRun }),
            });
    const preparedTools =
      extensionTools === undefined
        ? hostTools
        : combineAppManagedToolSets(hostTools, extensionTools);
    let toolsLaunched = false;
    try {
      const acceptedAt = decodeTimestamp(this.#clock());
      const nativeConversation = driver.conversationOwnership === "provider";
      const resumableHost = driver.conversationOwnership === "host-resumable";
      const previous = this.#projection.latestForThread(command.threadId);
      const catalogChanged =
        previous?.resumeCursor !== undefined &&
        String(previous.authority.providerInstanceId) ===
          String(command.authority.providerInstanceId) &&
        driver.toolCatalogContinuation?.({
          resumeCursor: previous.resumeCursor,
          tools: preparedTools?.definitions ?? [],
        }) === "handoff-required";
      if (catalogChanged && command.toolCatalogHandoff !== true) {
        throw this.#failure(
          "tools-changed",
          "The saved session has different tools. Choose Continue with updated tools to start a fresh session with the conversation handed over as text. Your draft and saved conversation are preserved.",
        );
      }
      if (command.toolCatalogHandoff === true && isRoutineHostScope(authenticatedWindowId)) {
        throw this.#failure(
          "unauthorized",
          "Only a person can choose to replace a native session's tools.",
        );
      }
      const sessionDecision = decideConversationSession({
        recipient: {
          providerInstanceId: String(command.authority.providerInstanceId),
          owner: nativeConversation ? "runtime" : resumableHost ? "host-resumable" : "host",
        },
        ...(previous === undefined
          ? {}
          : {
              previous: {
                ...(command.toolCatalogHandoff === true &&
                driver.toolCatalogContinuation !== undefined &&
                previous.authority.bindingRevisionId === command.authority.bindingRevisionId &&
                previous.authority.workingDirectory === command.authority.workingDirectory
                  ? { toolCatalogHandoff: true }
                  : {}),
                providerInstanceId: String(previous.authority.providerInstanceId),
                continuable:
                  previous.providerSessionId !== undefined &&
                  previous.resumeCursor !== undefined &&
                  (resumableHost
                    ? // A harness session resumes on the model it was opened
                      // with, and is taken up only as it stands: after a turn
                      // that ended cleanly, was cancelled, or was cut off by a
                      // restart, and before any host compaction it would not read.
                      previous.authority.modelId === command.authority.modelId &&
                      (previous.status === "completed" ||
                        previous.status === "cancelled" ||
                        (previous.status === "failed" &&
                          previous.failure?.category === "interrupted")) &&
                      this.#contextHarness?.hostCompactedSince(
                        decodeContextSubjectRef({
                          aggregateType: "work-thread",
                          aggregateId: String(command.threadId),
                        }),
                        previous.updatedAt,
                      ) !== true
                    : previous.authority.modelId === command.authority.modelId ||
                      this.#supportsModelSwitch?.(command.authority.providerInstanceId) === true) &&
                  previous.authority.bindingRevisionId === command.authority.bindingRevisionId &&
                  previous.authority.workingDirectory === command.authority.workingDirectory,
                ...(this.#projection.rewoundSinceLatest(command.threadId) ? { rewound: true } : {}),
                // A same-provider model swap the provider cannot carry on starts
                // a fresh session with a handoff instead of refusing the turn.
                ...(previous.authority.modelId !== command.authority.modelId &&
                this.#supportsModelSwitch?.(command.authority.providerInstanceId) !== true
                  ? { modelSwitchHandoff: true }
                  : {}),
                // The session cursor is recorded when the session starts, before
                // the provider is sent anything, so a turn that carried a
                // handoff and did not complete may never have delivered it.
                ...(previous.handoff !== undefined && previous.status !== "completed"
                  ? {
                      undeliveredHandoff:
                        previous.handoff.reason === "fork" ? "branch" : previous.handoff.reason,
                    }
                  : // A restart that cut the turn off before its session recorded a
                    // cursor left no session of the provider's to resume, so the
                    // conversation goes to a fresh one as text.
                    previous.failure?.category === "interrupted" &&
                      previous.resumeCursor === undefined
                    ? { undeliveredHandoff: "provider-switch" as const }
                    : {}),
              },
            }),
        // A fork whose turns are all carried copies has no session of its own:
        // those turns ran in the source.
        ...(previous?.carriedFrom !== undefined ? { branchWithoutSession: true } : {}),
        handoff: "allowed",
      });
      if (sessionDecision.kind === "refuse") {
        throw this.#failure(
          "unavailable",
          "This Work task's native session cannot be recovered under the current provider, model, and folder. Its history has been preserved.",
        );
      }
      let continuing = sessionDecision.kind === "continue-session" ? previous : undefined;
      if (sessionDecision.kind === "new-session-with-handoff" && thread === undefined) {
        // Without the thread there is no conversation to read, and a session
        // started anyway would answer as if it had never been given one.
        throw this.#failure(
          "unavailable",
          conversationHandoffRefusalMessage("thread-unavailable", {
            thread: "Work task",
            cause: "switch",
          }),
        );
      }
      let handoff =
        sessionDecision.kind === "new-session-with-handoff" &&
        previous !== undefined &&
        thread !== undefined
          ? this.#selectConversationHandoff(thread, previous, sessionDecision.reason)
          : undefined;
      const inputHandoff =
        handoff ??
        (sessionDecision.kind === "host-rebuild" &&
        this.#projection
          .listForThread(command.threadId)
          .some((turn) => (turn.attachments?.length ?? 0) > 0) &&
        previous !== undefined &&
        thread !== undefined &&
        (previous.authority.providerInstanceId !== command.authority.providerInstanceId ||
          previous.authority.modelId !== command.authority.modelId ||
          previous.carriedFrom !== undefined ||
          this.#projection.rewoundSinceLatest(command.threadId))
          ? this.#selectConversationHandoff(
              thread,
              previous,
              previous.carriedFrom !== undefined
                ? "branch"
                : this.#projection.rewoundSinceLatest(command.threadId)
                  ? "rewind"
                  : "provider-switch",
            )
          : undefined);
      let inputReceipt: ConversationInputReceipt | undefined;
      let inputsCurrent: (() => boolean) | undefined;
      const inputOnlyBlocks: ProviderContextBlock[] = [];
      if (inputHandoff !== undefined) {
        const transfer = this.#conversationInputTransfer;
        const previousReceipt =
          previous?.carriedFrom === undefined &&
          previous?.status !== "completed" &&
          previous?.inputReceipt?.purpose === inputHandoff.record.reason
            ? previous.inputReceipt
            : undefined;
        if (
          transfer === undefined &&
          ((inputHandoff.selection.inputs?.length ?? 0) > 0 ||
            inputHandoff.selection.inputUnavailable === true ||
            previousReceipt !== undefined)
        )
          throw this.#failure(
            "unavailable",
            "Original source inputs cannot be transferred on this host. Nothing was sent.",
          );
        const prepared = await transfer?.prepare({
          owner: {
            mode: "work",
            threadId: String(command.threadId),
            projectId: String(command.authority.projectId),
          },
          purpose: inputHandoff.record.reason,
          selection: inputHandoff.selection,
          ...(previousReceipt === undefined ? {} : { previous: previousReceipt }),
          ...(command.contextInputPolicy === undefined
            ? {}
            : { policy: command.contextInputPolicy }),
          target: {
            providerInstanceId: String(command.authority.providerInstanceId),
            modelId: String(command.authority.modelId),
          },
          current: () => options?.admissionCurrent?.() !== false,
        });
        if (prepared?.status === "refused") throw this.#failure("unavailable", prepared.message);
        if (prepared?.status === "ready" && prepared.receipt !== undefined) {
          inputsCurrent = prepared.inputsCurrent;
          attachmentInputs = [...attachmentInputs, ...prepared.attachments];
          inputReceipt = prepared.receipt;
          if (handoff === undefined)
            inputOnlyBlocks.push(conversationInputReceiptBlock(prepared.manifest));
          else
            handoff = {
              ...handoff,
              blocks: [...handoff.blocks, conversationInputReceiptBlock(prepared.manifest)],
              record: {
                ...handoff.record,
                inputReceipt: prepared.receipt,
                omissions: {
                  ...handoff.record.omissions,
                  attachments: Math.max(
                    0,
                    handoff.record.omissions.attachments - prepared.receipt.included,
                  ),
                },
              },
            };
        }
      }

      const harnessContext =
        thread === undefined
          ? []
          : (this.#nativeHarness?.contextFor({
              threadId: String(thread.id),
              mode: "work",
              providerInstanceId: thread.providerInstanceId,
              modelId: thread.modelId,
              projectId: thread.projectId,
            }) ?? []);
      // A continued harness session already holds the earlier turns, but they
      // are still planned: the plan is what a requested compaction summarizes
      // from and what decides whether the conversation still fits. Only the
      // send leaves them out (see `sessionHolds`).
      const preparedFeedback =
        thread === undefined ||
        server !== undefined ||
        command.delivery !== undefined ||
        options?.limitRecovery === true ||
        options?.accessCeiling !== undefined
          ? undefined
          : this.#prepareProductFeedbackForTurn?.({
              windowId: authenticatedWindowId,
              threadId: String(command.threadId),
              operationId: String(command.turnId),
              supportsImages: this.#modelReadsImages(command.authority),
              current: options?.admissionCurrent ?? (() => true),
            });
      const priorTranscript = nativeConversation
        ? []
        : this.#priorTranscriptContributions(command.threadId);
      const planned = planWorkTurnContext({
        threadId: command.threadId,
        providerInstanceId: command.authority.providerInstanceId,
        modelId: command.authority.modelId,
        uuid: this.#uuid,
        createdAt: this.#clock(),
        safeInputBudget: this.#safeInputBudgetTokens,
        leading: harnessContext.map(
          (block, index): WorkTurnContextContribution => ({
            text: block.text,
            sourceKind: "instruction",
            referenceId: `native-harness:${index}`,
            category: "octant-policy",
            posture: "required",
            block,
          }),
        ),
        contributions: [
          ...(preparedFeedback?.context === undefined
            ? []
            : [
                {
                  text: preparedFeedback.context,
                  sourceKind: "message" as const,
                  referenceId: `product-feedback:${command.turnId}`,
                  category: "workspace-context" as const,
                  posture: "required" as const,
                  block: { kind: "user-message" as const, text: preparedFeedback.context },
                },
              ]),
          ...skillContext.map(
            (block, index): WorkTurnContextContribution => ({
              text: block.text,
              sourceKind: "instruction",
              referenceId: `selected-skill:${index}`,
              category: "workspace-context",
              posture: "required",
              block,
            }),
          ),
          ...personMemoryContributions(
            thread === undefined
              ? undefined
              : this.#personMemoryBlock?.({ thread, windowId: authenticatedWindowId }),
          ),
          ...(project === undefined
            ? []
            : projectMemoryContributions(this.#persistence.readProjectMemory?.(project.id))),
          ...(project === undefined ? [] : extraFolderContributions(project)),
          ...(project === undefined
            ? []
            : await this.#projectBriefContributions(
                project,
                command.threadId,
                previous === undefined,
              )),
          // A server Project's folder is on another machine; its runtime reads it there.
          ...(project === undefined ||
          (thread !== undefined && this.#serverProjects?.holds(thread) === true)
            ? []
            : await this.#designSystemContributions(project, command.threadId)),
          ...priorTranscript,
          ...(handoff === undefined
            ? []
            : handoff.blocks.map(
                (block, index): WorkTurnContextContribution => ({
                  text: block.text,
                  sourceKind: "message",
                  referenceId: `conversation-handoff:${command.threadId}:${index}`,
                  category: "conversation",
                  posture: "required",
                  block,
                }),
              )),
          ...inputOnlyBlocks.map(
            (block, index): WorkTurnContextContribution => ({
              text: block.text,
              sourceKind: "message",
              referenceId: `conversation-inputs:${command.threadId}:${index}`,
              category: "conversation",
              posture: "required",
              block,
            }),
          ),

          ...(await this.#sideChatReturnContributions(
            command.threadId,
            command.sideChatReturns,
            authenticatedWindowId,
          )),
          ...(await this.#threadMentionContributions(
            command.threadId,
            command.threadMentionIds,
            authenticatedWindowId,
          )),
          ...(await this.#fileMentionContributions(
            command.fileMentionPaths,
            authenticatedWindowId,
            command.threadId,
          )),
          ...this.#issueContextContribution(command.threadId),
          ...(externalData === undefined
            ? []
            : [
                {
                  text: externalData.content.text,
                  sourceKind: "message" as const,
                  referenceId: externalData.referenceId,
                  category: "workspace-context" as const,
                  posture: "required" as const,
                  block: { kind: "user-message" as const, text: externalData.content.text },
                },
              ]),
          {
            text: command.prompt,
            sourceKind: "message",
            referenceId: `prompt:${command.turnId}`,
            category: "current-request",
            posture: "required",
            block: { kind: "user-message", text: command.prompt },
          },
        ],
      });
      if (planned.kind === "blocked") {
        throw this.#failure("invalid", planned.message);
      }
      // A plan that leaves earlier turns out to fit cannot be met by the
      // continued session, which would carry them all and drop older exchanges
      // on its own. The host rebuilds the history in a fresh session instead,
      // so what the model reads is what the plan journals.
      if (
        resumableHost &&
        continuing !== undefined &&
        planned.manifest.entries.some(
          (entry) =>
            entry.category === "conversation" &&
            (entry.state === "omitted" || entry.state === "truncated"),
        )
      ) {
        continuing = undefined;
      }
      const resumeCursor = continuing?.resumeCursor;
      const providerSessionId =
        continuing?.providerSessionId ?? decodeProviderSessionId(this.#uuid());
      // Blocks of the earlier turns the continued session already holds; sending
      // them again would duplicate every earlier message inside the session.
      const sessionHolds = new Set<ProviderContextBlock>(
        resumableHost && continuing !== undefined ? priorTranscript.map((item) => item.block) : [],
      );

      // The turn journals on its own aggregate, so a Done mark committed while
      // the turn was prepared raises no version conflict. Reread the thread
      // last: nothing after this awaits before the acceptance is journaled.
      const markedWhilePreparing =
        thread !== undefined &&
        (await this.#threads.read(authenticatedWindowId, command.threadId))?.completionConfirmed ===
          true;

      // Preparation awaits filesystem and provider context; recheck the journal before admission.
      const afterPreparation = this.#agentResultDelivery(command);
      if (afterPreparation !== undefined) return afterPreparation;

      // A move may have frozen the thread while its context was prepared; the
      // turn is refused here, before anything is accepted, so no message
      // lands outside the conversation the move carries.
      if (this.#moveHold?.(String(command.threadId)) === true) {
        throw this.#failure("stale", THREAD_MOVING_REFUSAL);
      }

      // Context and attachment reads can outlive the host's queue admission.
      if (markedWhilePreparing || options?.admissionCurrent?.() === false) {
        if (markedWhilePreparing) {
          throw this.#failure("invalid", WORK_THREAD_MARKED_DONE_TURN_REFUSAL);
        }
        throw this.#failure("unauthorized", "Work turn admission is no longer current.");
      }

      const spendReservationId = decodeSpendCeilingReservationId(this.#uuid());
      const spendAdmission = this.#spendCeiling?.admit({
        reservationId: spendReservationId,
        threadId: String(command.threadId),
        threadType: "work-thread",
        projectId: String(command.authority.projectId),
        turnUpperBoundTokens: this.#safeInputBudgetTokens,
      });
      if (spendAdmission?.status === "refused") {
        throw this.#failure("unavailable", spendAdmission.refusal.message);
      }
      if (spendAdmission !== undefined) {
        this.#spendReservations.set(String(command.requestId), spendReservationId);
      }

      try {
        this.#append(
          command.requestId,
          0,
          "work.turn-accepted@1",
          {
            kind: "turn-accepted",
            ...(command.toolCatalogHandoff === undefined
              ? {}
              : { toolCatalogHandoff: command.toolCatalogHandoff }),
            requestId: command.requestId,
            threadId: command.threadId,
            turnId: command.turnId,
            projectId: command.authority.projectId,
            authority: command.authority,
            providerSessionId,
            ...(resumeCursor === undefined ? {} : { resumeCursor }),
            ...(handoff === undefined ? {} : { handoff: handoff.record }),
            ...(inputReceipt === undefined ? {} : { inputReceipt }),
            ...(externalInput === undefined ? {} : { externalInput }),
            prompt: command.prompt,
            ...(command.sideChatReturns === undefined
              ? {}
              : { sideChatReturns: command.sideChatReturns }),
            ...(starting.attachments.length === 0 ? {} : { attachments: starting.attachments }),
            ...(command.extensionSelections === undefined ||
            command.extensionSelections.length === 0
              ? {}
              : { extensionSelections: command.extensionSelections }),
            capabilities: workTurnCapabilityFacts(turnAccess),
            ...(command.delivery === undefined ? {} : { delivery: command.delivery }),
            acceptedAt,
          },
          isRoutineHostScope(authenticatedWindowId) ? "system" : "local-user",
        );
      } catch (error) {
        this.#settleSpendReservation(command.requestId);
        if (error instanceof ConcurrencyConflict) {
          const duplicate = this.#projection.lookup(command.requestId);
          if (duplicate !== undefined)
            return this.#lookupMatching(command, duplicate, externalInput);
          throw this.#failure("stale", "Work turn already exists.");
        }
        throw this.#mapFailure(error);
      }
      this.#consumeIssueContextFramed?.(String(command.threadId));

      const accepted = this.#projection.lookup(command.requestId);
      if (accepted === undefined) {
        this.#settleSpendReservation(command.requestId);
        throw this.#failure("unavailable", "Work turn acceptance could not be projected.");
      }
      if (starting.attachments.length > 0) {
        this.#attachments?.release(
          command.threadId,
          starting.attachments.map((attachment) => attachment.attachmentId),
        );
      }

      const controller = new AbortController();
      this.#controllers.set(String(command.requestId), controller);
      const selectedRoot =
        project === undefined
          ? undefined
          : approvedWorkingFolderRoot(project, command.authority.workingFolderId);
      const physicalCurrent =
        selectedRoot === undefined
          ? undefined
          : this.#workingDirectories.current?.(selectedRoot, projectRoot);
      const folderCurrent = () => {
        try {
          if (command.authority.workingFolderId === undefined || project === undefined) return true;
          const latest = this.#persistence.readProject(project.id);
          return (
            latest?.type === "work" &&
            latest.lifecycle === "active" &&
            approvedWorkingFolderRoot(latest, command.authority.workingFolderId) === selectedRoot &&
            physicalCurrent?.() !== false
          );
        } catch {
          return false;
        }
      };
      const folderWatch =
        command.authority.workingFolderId === undefined
          ? undefined
          : setInterval(() => {
              if (!folderCurrent())
                controller.abort("Working folder is unavailable; nothing is redirected.");
            }, 250);
      const launch = this.#runTurn({
        command,
        ...(thread === undefined ? {} : { thread }),
        ...(thread === undefined ? {} : { access: turnAccess }),
        ...(thread?.fullAccessSandbox === true ? { fullAccessSandbox: true } : {}),
        windowId: authenticatedWindowId,
        providerSessionId,
        ...(resumeCursor === undefined ? {} : { resumeCursor }),
        projectRoot,
        projectCanonicalRoot: project?.binding.canonicalRoot ?? projectRoot,
        extraFolders,
        ...(server === undefined ? {} : { serverTools: server.tools }),
        driver,
        ...(preparedTools === undefined ? {} : { preparedTools }),
        attachments: attachmentInputs,
        ...(preparedFeedback === undefined ? {} : { preparedProductFeedback: preparedFeedback }),
        contextPlan: planned,
        sessionHolds,
        admissionCurrent: () =>
          folderCurrent() && options?.admissionCurrent?.() !== false && inputsCurrent?.() !== false,
        ...(options?.routineRun === undefined ? {} : { routineRun: options.routineRun }),
        signal: controller.signal,
      }).finally(() => {
        clearInterval(folderWatch);
        if (
          this.#runningAccess.get(String(command.threadId))?.requestId === String(command.requestId)
        ) {
          this.#runningAccess.delete(String(command.threadId));
        }
        this.#settleSpendReservation(command.requestId);
        this.#controllers.delete(String(command.requestId));
        this.#inflight.delete(String(command.requestId));
        this.#liveResponses.delete(String(command.requestId));
        this.#liveTasks.delete(String(command.requestId));
        this.#liveToolSteps.delete(String(command.requestId));
      });
      this.#inflight.set(String(command.requestId), launch);
      toolsLaunched = true;
      return decodeWorkTurnLookupResult({ kind: "accepted", turn: this.#withLive(accepted) });
    } finally {
      if (!toolsLaunched)
        await Effect.runPromise(
          Effect.promise(async () => {
            await preparedTools?.close?.();
          }).pipe(
            Effect.timeout("2 seconds"),
            Effect.catchAllCause(() => Effect.logWarning("Prepared Work tool cleanup failed.")),
          ),
        );
    }
  }

  /**
   * Rewind the thread in place to just before one of its turns. Work takes no
   * file checkpoints, so only the conversation goes back; files stay as they
   * are. The removal is journaled before anything else, so the transcript, a
   * replay after a restart, and every later turn read the same kept turns,
   * and the next turn never takes up the session that held the removed ones.
   * The first removed turn's prompt comes back for the composer.
   */
  async rewindThread(
    authenticatedWindowId: WindowId,
    input: unknown,
  ): Promise<WorkThreadRewindResult> {
    this.#assertReady();
    const command = decodeRewindWorkThreadCommand(input);
    const thread = await this.#threads.read(authenticatedWindowId, command.threadId);
    if (thread === undefined) {
      throw this.#failure("unauthorized", "Work thread is unavailable for this window.");
    }
    const journaled = this.#projection.rewind(String(command.rewindId));
    if (journaled !== undefined) return this.#rewindResult(command, journaled.removedRequestIds);
    // A rewind changes the conversation a move is carrying.
    if (this.#moveHold?.(String(command.threadId)) === true) {
      throw this.#failure("stale", THREAD_MOVING_REFUSAL);
    }
    if (this.#startingTurns.has(String(command.threadId)) || this.isTurnActive(command.threadId)) {
      throw this.#failure("stale", WORK_REWIND_WHILE_TURN_RUNS);
    }
    const turns = this.#projection.listForThread(command.threadId);
    const from = turns.findIndex(
      (turn) => String(turn.requestId) === String(command.fromRequestId),
    );
    if (from === -1) {
      throw this.#failure(
        "invalid",
        "That message is no longer part of this thread's conversation.",
      );
    }
    const removed = turns.slice(from).map((turn) => turn.requestId);
    const [first, ...rest] = removed;
    if (first === undefined) {
      throw this.#failure(
        "invalid",
        "That message is no longer part of this thread's conversation.",
      );
    }
    if (removed.length > MAX_WORK_REWOUND_TURNS) {
      throw this.#failure(
        "invalid",
        "Rewinding this far removes more turns than one rewind can. Rewind to a later message.",
      );
    }
    try {
      this.#append(command.rewindId, 0, "work.thread-rewound@1", {
        kind: "thread-rewound",
        rewindId: command.rewindId,
        threadId: command.threadId,
        fromRequestId: command.fromRequestId,
        removedRequestIds: [first, ...rest],
        rewoundAt: decodeTimestamp(this.#clock()),
      });
    } catch (error) {
      const retried = this.#projection.rewind(String(command.rewindId));
      if (error instanceof ConcurrencyConflict && retried !== undefined)
        return this.#rewindResult(command, retried.removedRequestIds);
      throw this.#mapFailure(error);
    }
    // Other panes and clients on this thread hold the removed turns until
    // they read the transcript again.
    this.#liveUpdates.invalidate(command.threadId);
    return this.#rewindResult(command, removed);
  }

  #rewindResult(
    command: ReturnType<typeof decodeRewindWorkThreadCommand>,
    removed: ReadonlyArray<WorkTurnRequestId>,
  ): WorkThreadRewindResult {
    const prompt = this.#projection.lookup(command.fromRequestId)?.prompt;
    if (prompt === undefined)
      throw this.#failure("unavailable", "The rewound turn could not be read.");
    return decodeWorkThreadRewindResult({
      kind: "thread-rewound",
      threadId: command.threadId,
      fromRequestId: command.fromRequestId,
      removedTurns: removed.length,
      prompt,
    });
  }

  async lookupFirstTurn(
    authenticatedWindowId: WindowId,
    requestIdInput: string,
  ): Promise<WorkTurnLookupResult> {
    this.#assertReady();
    const requestId = decodeWorkTurnRequestId(requestIdInput);
    const turn = this.#projection.lookup(requestId);
    if (turn === undefined) {
      return decodeWorkTurnLookupResult({
        kind: "not-created",
        requestId,
        message: "Work turn was not created.",
      });
    }
    await this.#assertThreadAccess(authenticatedWindowId, turn.threadId, turn.projectId);
    return decodeWorkTurnLookupResult({ kind: "accepted", turn: this.#withLive(turn) });
  }

  async cancelFirstTurn(
    authenticatedWindowId: WindowId,
    input: unknown,
  ): Promise<WorkTurnCancelResult> {
    this.#assertReady();
    const command = decodeCancelWorkTurnCommand(input);
    const turn = this.#projection.lookup(command.requestId);
    if (turn === undefined) {
      throw this.#failure("invalid", "Work turn was not found.");
    }
    await this.#assertThreadAccess(authenticatedWindowId, turn.threadId, turn.projectId);
    if (
      String(turn.threadId) !== String(command.threadId) ||
      String(turn.turnId) !== String(command.turnId)
    ) {
      throw this.#failure("invalid", "Work turn identity does not match.");
    }
    if (turn.status === "completed" || turn.status === "cancelled" || turn.status === "failed") {
      return decodeWorkTurnCancelResult({
        kind: "turn-already-terminal",
        requestId: turn.requestId,
        threadId: turn.threadId,
        turnId: turn.turnId,
        status: turn.status,
      });
    }
    const requestKey = String(command.requestId);
    const controller = this.#controllers.get(requestKey);
    if (command.kind === "force-stop-work-turn") {
      if (
        controller === undefined ||
        !controller.signal.aborted ||
        this.#turnRuntime.canForceStop?.(requestKey) !== true ||
        this.#turnRuntime.forceStop === undefined
      )
        throw this.#failure(
          "invalid",
          "Only the exact stopped attempt of a supported runtime can be force-stopped.",
        );
      if (!(await this.#turnRuntime.forceStop(requestKey)))
        throw this.#failure("unavailable", "The owned runtime process could not be force-stopped.");
      const current = this.#projection.lookup(command.requestId);
      if (
        current !== undefined &&
        (current.status === "completed" ||
          current.status === "failed" ||
          current.status === "cancelled")
      )
        return decodeWorkTurnCancelResult({
          kind: "turn-already-terminal",
          requestId: current.requestId,
          threadId: current.threadId,
          turnId: current.turnId,
          status: current.status,
        });
    } else if (controller !== undefined && this.#turnRuntime.canForceStop?.(requestKey) === true) {
      controller.abort();
      return decodeWorkTurnCancelResult({
        kind: "stop-requested",
        requestId: turn.requestId,
        threadId: turn.threadId,
        turnId: turn.turnId,
        status: turn.status,
      });
    }
    this.#controllers.get(String(command.requestId))?.abort();
    this.#settleSpendReservation(command.requestId);
    this.#persistUpdate(turn, {
      status: "cancelled",
      ...(turn.response === undefined ? {} : { response: turn.response }),
    });
    const cancelled = this.#projection.lookup(turn.requestId);
    if (cancelled !== undefined) this.#liveUpdates.settle(turn.threadId, cancelled);
    try {
      this.#onTurnCancelled?.(turn.threadId);
    } catch {
      // The turn is already recorded as cancelled; a listener's failure is its own.
    }
    return decodeWorkTurnCancelResult({
      kind: "turn-cancelled",
      requestId: turn.requestId,
      threadId: turn.threadId,
      turnId: turn.turnId,
      status: "cancelled",
    });
  }

  async transcript(
    authenticatedWindowId: WindowId,
    threadId: WorkThreadId,
  ): Promise<WorkThreadTranscript> {
    this.#assertReady();
    const thread = await this.#threads.read(authenticatedWindowId, threadId);
    if (thread === undefined) {
      throw this.#failure("unauthorized", "Work thread is unavailable for this window.");
    }
    return decodeWorkThreadTranscript({
      threadId,
      turns: this.#projection
        .listForThread(threadId)
        .slice(-MAX_WORK_TRANSCRIPT_TURNS)
        .map((turn) => this.#withLive(turn)),
      liveCursor: this.#liveUpdates.head(threadId),
    });
  }

  /**
   * One page of the thread for a client that opens on its newest turns and
   * loads earlier ones on request. The page walks back from the newest turn,
   * or from just before `before`, until it holds `limit` turns or its encoded
   * turns would pass `WORK_TRANSCRIPT_WINDOW_BYTES`; it
   * always holds at least one turn when the thread has one. A `before` the
   * thread does not hold is `stale`: the client re-reads the newest page.
   */
  async transcriptWindow(
    authenticatedWindowId: WindowId,
    threadId: WorkThreadId,
    request: WorkThreadTranscriptWindowRequest,
  ): Promise<WorkThreadTranscriptWindow> {
    this.#assertReady();
    const thread = await this.#threads.read(authenticatedWindowId, threadId);
    if (thread === undefined) {
      throw this.#failure("unauthorized", "Work thread is unavailable for this window.");
    }
    const all = this.#projection.listForThread(threadId);
    let end = all.length;
    if (request.before !== undefined) {
      const before = String(request.before);
      end = all.findIndex((turn) => String(turn.requestId) === before);
      if (end === -1) {
        throw this.#failure("stale", "That Work turn is no longer in this thread.");
      }
    }
    const turns: WorkTurnState[] = [];
    let bytes = 0;
    let start = end;
    while (start > 0 && turns.length < request.limit) {
      const candidate = all[start - 1];
      if (candidate === undefined) break;
      const turn = this.#withLive(candidate);
      const size = Buffer.byteLength(JSON.stringify(turn), "utf8");
      if (turns.length > 0 && bytes + size > WORK_TRANSCRIPT_WINDOW_BYTES) break;
      bytes += size;
      turns.unshift(turn);
      start -= 1;
    }
    return decodeWorkThreadTranscriptWindow({
      version: 1,
      threadId,
      turns,
      liveCursor: this.#liveUpdates.head(threadId),
      hasEarlier: start > 0,
      hasLater: end < all.length,
    });
  }

  /**
   * Every turn of the thread, oldest first, for host-side readers such as
   * export and mentions that must not stop at the transcript route's window.
   * It is not a route; it applies the same authority check as `transcript`.
   */
  async turns(
    authenticatedWindowId: WindowId,
    threadId: WorkThreadId,
  ): Promise<ReadonlyArray<WorkTurnState>> {
    this.#assertReady();
    const thread = await this.#threads.read(authenticatedWindowId, threadId);
    if (thread === undefined) {
      throw this.#failure("unauthorized", "Work thread is unavailable for this window.");
    }
    return this.#projection.listForThread(threadId).map((turn) => this.#withLive(turn));
  }

  async *subscribe(
    authenticatedWindowId: WindowId,
    threadId: WorkThreadId,
    afterSequence: number,
    signal: AbortSignal,
  ): AsyncGenerator<WorkTurnStreamFrame> {
    this.#assertReady();
    const thread = await this.#threads.read(authenticatedWindowId, threadId);
    if (thread === undefined) {
      throw this.#failure("unauthorized", "Work thread is unavailable for this window.");
    }
    yield* this.#liveUpdates.subscribe({ threadId, afterSequence, signal });
  }

  closeLiveUpdates(): void {
    this.#liveUpdates.close();
  }

  /**
   * Octant Shield's decision on an approval a Work thread's own tools asked
   * for (the Octant Harness's), shown as a review row on its running turn.
   */
  recordShieldReview(
    review: Parameters<NonNullable<WorkTurnRuntimePort["recordShieldReview"]>>[0],
  ): void {
    this.#turnRuntime.recordShieldReview?.(review);
  }

  /**
   * A compaction of the thread's session ended. The thread's live feed carries
   * its receipt, or its failure, so a window waiting on it need not poll.
   */
  compactionSettled(threadId: WorkThreadId, compaction: ContextCompactionSettledRecord): void {
    this.#liveUpdates.settleCompaction(threadId, compaction);
  }

  /** The live feed cursor for a thread; subscribe from here to read from now. */
  liveCursor(threadId: WorkThreadId): number {
    return this.#liveUpdates.head(threadId);
  }

  #withLive(turn: WorkTurnState): WorkTurnState {
    if (turn.status === "completed" || turn.status === "cancelled") return turn;
    // The live steps live only in this process until the turn settles; a window
    // that opens or reconnects mid-turn would otherwise miss the frame that
    // carried them, which no later frame replays.
    const liveStepsHeld = this.#liveToolSteps.get(String(turn.requestId));
    const liveSteps =
      liveStepsHeld === undefined ? undefined : withoutPublishedSnapshots(liveStepsHeld);
    const withSteps =
      liveSteps === undefined || liveSteps.steps.length === 0
        ? turn
        : decodeWorkTurnState({
            ...turn,
            toolSteps: liveSteps.steps,
            ...(liveSteps.truncated ? { toolStepsTruncated: true } : {}),
          });
    const live = this.#liveResponses.get(String(turn.requestId));
    if (live === undefined) return withSteps;
    return decodeWorkTurnState({
      ...withSteps,
      status: turn.status === "accepted" ? "running" : turn.status,
      response: live,
      transcript: [
        { role: "user", text: turn.prompt },
        { role: "assistant", text: live, status: "running" },
      ],
    });
  }

  /** The access the thread's running turn holds; undefined when none runs. */
  runningTurnAccess(threadId: string): WorkAccess | undefined {
    return this.#runningAccess.get(threadId)?.access;
  }

  async #runTurn(input: {
    readonly command: ReturnType<typeof decodeStartWorkThreadTurnCommand>;
    readonly thread?: WorkThread;
    /** The thread's access, narrowed to ask-first when its caller held it. */
    readonly access?: WorkAccess;
    /** The thread's sandbox choice at Full access when the turn starts. */
    readonly fullAccessSandbox?: boolean;
    readonly windowId: WindowId;
    readonly providerSessionId: ProviderSessionId;
    readonly resumeCursor?: ProviderResumeCursor;
    readonly projectRoot: string;
    /** The Project's bound root, where `STATUS.md` lives; the turn may run in a subfolder. */
    readonly projectCanonicalRoot: string;
    /** The Project's extra folders, granted what the bound root is granted. */
    readonly extraFolders: ReadonlyArray<string>;
    /**
     * A server Work thread's tools, all acting on the server. Its folder is a
     * path there, so nothing watches it here and no host tool is offered.
     */
    readonly serverTools?: AppManagedToolSet;
    readonly driver: ProviderDriver;
    readonly preparedTools?: AppManagedToolSet;
    readonly attachments: ReadonlyArray<ProviderAttachmentInput>;
    readonly preparedProductFeedback?: PreparedProductFeedbackTurn;
    readonly contextPlan: Extract<WorkTurnContextPlan, { readonly kind: "ok" }>;
    /**
     * Planned blocks a continued session already holds. They stay in the plan,
     * so the context meter, a requested compaction and the plan's own fit see
     * the whole conversation, and are left out of what is sent. Matched by
     * identity: every planning stage passes a contribution's block through
     * unchanged, and the context it sends names no entries.
     */
    readonly sessionHolds: ReadonlySet<ProviderContextBlock>;
    readonly admissionCurrent?: () => boolean;
    readonly routineRun?: AutomationRunReference;
    readonly signal: AbortSignal;
  }): Promise<void> {
    const current = this.#projection.lookup(input.command.requestId);
    if (current === undefined) return;
    this.#persistUpdate(current, { status: "running" });

    // Watching starts before the provider does, so a file written in the first
    // moments of the turn is seen. The provider writes with its own tools
    // inside the bound folder and never calls the mutation service, so this is
    // the only way the host learns what a turn produced.
    const observation =
      input.serverTools === undefined
        ? this.#turnFileObserver?.observe(input.projectRoot, input.extraFolders)
        : undefined;

    const appManagedTools = input.preparedTools;
    // Only a thread whose person chose the runtime's artifact tool is offered
    // it; every other thread of the account keeps Canvas and its launch keeps
    // every guard. A Work turn never runs in Plan: it runs at its thread's
    // level.
    const artifactToolName =
      input.thread?.documentDelivery === "native-artifacts"
        ? input.driver.nativeArtifactTool?.({
            mode: "work",
            executionPolicy: workThreadAccessOf(input.access ?? DEFAULT_WORK_ACCESS)
              .executionPolicy,
          })
        : undefined;
    const finalPlan = includeWorkToolDefinitions({
      plan: input.contextPlan,
      tools: appManagedTools?.definitions ?? [],
      ...(artifactToolName === undefined ? {} : { artifactToolName }),
      uuid: this.#uuid,
      safeInputBudget: this.#safeInputBudgetTokens,
    });
    if (finalPlan.kind === "blocked") {
      observation?.finish();
      await Effect.runPromise(
        Effect.promise(async () => {
          await appManagedTools?.close?.();
        }).pipe(
          Effect.timeout("2 seconds"),
          Effect.catchAllCause(() => Effect.logWarning("Prepared Work tool cleanup failed.")),
        ),
      );
      this.#refuseTurn(input.command, {
        category: "invalid",
        message: finalPlan.message,
      });
      return;
    }
    const published =
      this.#contextHarness === undefined
        ? undefined
        : await observeWorkContext({
            service: this.#contextHarness,
            plan: finalPlan,
            driver: input.driver,
            model: this.#persistence.readProviderModel?.(
              finalPlan.manifest.providerInstanceId,
              finalPlan.manifest.modelId,
            ),
            displayLabel: input.thread?.title ?? "Work task",
            signal: input.signal,
          });
    const admissionRevoked = input.admissionCurrent?.() === false;
    if (input.signal.aborted || published?.snapshot.next.plan.blocked || admissionRevoked) {
      observation?.finish();
      await Effect.runPromise(
        Effect.promise(async () => {
          await appManagedTools?.close?.();
        }).pipe(
          Effect.timeout("2 seconds"),
          Effect.catchAllCause(() => Effect.logWarning("Prepared Work tool cleanup failed.")),
        ),
      );
      if (!input.signal.aborted)
        this.#refuseTurn(input.command, {
          category: admissionRevoked ? "unauthorized" : "invalid",
          message: admissionRevoked
            ? "Work turn admission is no longer current."
            : "The Work request exceeds the selected model's context budget. Remove context or start a new task.",
        });
      return;
    }
    const providerContext = (published?.context ?? finalPlan.context).filter(
      (block) => !input.sessionHolds.has(block),
    );
    if (
      input.preparedProductFeedback?.context !== undefined &&
      !providerContext.some((block) => block.text === input.preparedProductFeedback?.context)
    ) {
      observation?.finish();
      await Effect.runPromise(
        Effect.promise(async () => {
          await appManagedTools?.close?.();
        }).pipe(
          Effect.timeout("2 seconds"),
          Effect.catchAllCause(() =>
            Effect.logWarning("Prepared Work feedback tool cleanup failed."),
          ),
        ),
      );
      this.#refuseTurn(input.command, {
        category: "invalid",
        message:
          "Selected product notes could not fit this Work turn. Review the pending notes before sending again.",
      });
      return;
    }
    const harnessScope: NativeHarnessTurnScope | undefined =
      input.thread === undefined
        ? undefined
        : {
            threadId: String(input.thread.id),
            mode: "work",
            providerInstanceId: input.thread.providerInstanceId,
            modelId: input.thread.modelId,
            projectId: input.thread.projectId,
          };
    if (harnessScope !== undefined) this.#nativeHarness?.turnStarted(harnessScope);
    let endedTurn: TurnEndSummary | undefined;
    // The turn is reconciled once, when it ends, with what it used in all.
    // Reconciling each report as it arrived recorded a Claude turn's per-call
    // reports again beside its final total. Per-request reports add up and a
    // whole-turn report replaces them, so a turn that failed or was cancelled
    // before its total arrived still counts every request it made.
    let turnUsage: TurnUsage | undefined;
    let usageFacts: WorkUsageFacts = {};
    let promptSent = false;
    let runOutcome: WorkTurnRuntimeOutcome | undefined;
    try {
      if (input.access !== undefined) {
        this.#runningAccess.set(String(input.command.threadId), {
          requestId: String(input.command.requestId),
          access: input.access,
          ...(input.fullAccessSandbox === true ? { fullAccessSandbox: true } : {}),
        });
      }
      const outcome = await this.#turnRuntime.run({
        ...(input.admissionCurrent === undefined
          ? {}
          : { admissionCurrent: input.admissionCurrent }),
        command: input.command,
        providerSessionId: input.providerSessionId,
        ...(this.#outsideContentMarks === undefined
          ? {}
          : { outsideContentMarks: this.#outsideContentMarks }),
        ...(this.#forgeChanges === undefined ? {} : { forgeChanges: this.#forgeChanges }),
        ...(this.#nativeHarness?.observeRemoteCommand === undefined || harnessScope === undefined
          ? {}
          : {
              observeRemoteCommand: (event: ProviderRuntimeEvent) =>
                this.#nativeHarness?.observeRemoteCommand?.(
                  harnessScope.threadId,
                  harnessScope.projectId === undefined ? undefined : String(harnessScope.projectId),
                  event,
                ),
            }),
        ...(input.access === undefined ? {} : { access: input.access }),
        ...(input.fullAccessSandbox === true ? { fullAccessSandbox: true } : {}),
        ...(artifactToolName === undefined ? {} : { nativeArtifacts: true }),
        ...nativeSetupOption(
          sessionNativeSetup(this.#persistence, {
            providerInstanceId: input.command.authority.providerInstanceId,
            projectId: input.command.authority.projectId,
            threadId: String(input.command.threadId),
            mode: "work",
            executionPolicy:
              input.access === "auto-accept-edits" ? "auto-accept-edits" : "approval-gated",
          }),
        ),
        ...(input.resumeCursor === undefined ? {} : { resumeCursor: input.resumeCursor }),
        ...(input.driver.conversationOwnership !== "provider" &&
        input.driver.conversationOwnership !== "host-resumable"
          ? {}
          : {
              onSessionReady: (handle: ProviderSessionHandle) => {
                const resumeCursor = handle.resumeCursor ?? input.resumeCursor;
                if (handle.sessionId !== input.providerSessionId || resumeCursor === undefined)
                  throw new Error("Provider did not return an exact resumable Work session.");
                const latest = this.#projection.lookup(input.command.requestId);
                if (latest === undefined) throw new Error("Work turn is unavailable.");
                this.#append(latest.requestId, latest.version, "work.turn-updated@1", {
                  kind: "turn-updated",
                  requestId: latest.requestId,
                  threadId: latest.threadId,
                  turnId: latest.turnId,
                  status: "running",
                  resumeCursor,
                  updatedAt: decodeTimestamp(this.#clock()),
                });
              },
            }),
        projectRoot: input.projectRoot,
        ...(input.extraFolders.length === 0 ? {} : { extraFolders: input.extraFolders }),
        driver: input.driver,
        signal: input.signal,
        ...(input.thread?.modelOptionValues === undefined
          ? {}
          : { modelOptionValues: input.thread.modelOptionValues }),
        ...(appManagedTools === undefined ? {} : { appManagedTools }),
        ...(input.attachments.length === 0 ? {} : { attachments: input.attachments }),
        ...(input.admissionCurrent === undefined
          ? {}
          : { admissionCurrent: input.admissionCurrent }),
        ...(input.preparedProductFeedback === undefined
          ? {}
          : {
              takeProductFeedback: (maxAttachments) => {
                const carried = input.preparedProductFeedback?.take(maxAttachments);
                if (
                  carried === undefined ||
                  carried.context !== input.preparedProductFeedback?.context
                )
                  throw new Error("Prepared product notes changed before delivery.");
                // The exact context already passed the ordinary required-context plan.
                return { attachments: carried.attachments };
              },
            }),
        ...(providerContext.length === 0 ? {} : { context: providerContext }),
        onDelta: (response) => {
          const projected = this.#projection.lookup(input.command.requestId);
          if (
            input.signal.aborted ||
            (projected?.status !== "accepted" && projected?.status !== "running")
          ) {
            return;
          }
          const previous = this.#liveResponses.get(String(input.command.requestId)) ?? "";
          this.#liveResponses.set(String(input.command.requestId), response);
          const delta = response.startsWith(previous) ? response.slice(previous.length) : response;
          this.#liveUpdates.appendResponse(input.command.threadId, input.command.requestId, delta);
        },
        onRetrying: (event) => {
          if (harnessScope !== undefined) {
            this.#nativeHarness?.noteRetry?.(harnessScope, {
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
              reason: event.reason,
              announcedAt: event.occurredAt,
            });
          }
          this.#liveUpdates.appendRetry(input.command.threadId, input.command.requestId, {
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            reason: event.reason,
            announcedAt: event.occurredAt,
          });
        },
        onRetryCleared: () => {
          if (harnessScope !== undefined) this.#nativeHarness?.clearRetry?.(harnessScope);
          this.#liveUpdates.clearRetry(input.command.threadId, input.command.requestId);
        },
        ...(this.#onRequestSettled === undefined
          ? {}
          : { onRequestSettled: this.#onRequestSettled }),
        onTurnEnded: (ended) => {
          endedTurn = withPromptDigest(
            ended,
            this.#nativeHarness?.promptDigest,
            input.command.prompt,
            {
              // A subagent result delivery is the host's text, never a task a person set.
              firstTurn:
                input.command.delivery === undefined &&
                String(this.#projection.listForThread(input.command.threadId)[0]?.requestId) ===
                  String(input.command.requestId),
            },
          );
        },
        ...(this.#liveTurns === undefined
          ? {}
          : {
              liveTurn: this.#liveTurns.tracker(String(input.command.threadId), "work-navigation"),
            }),
        onPromptSent: () => {
          promptSent = true;
        },
        ...(this.#contextHarness === undefined
          ? {}
          : {
              onAutomaticCompaction: (sighting: AutomaticCompactionSighting) => {
                this.#contextHarness?.recordAutomaticCompaction({
                  subject: decodeContextSubjectRef({
                    aggregateType: "work-thread",
                    aggregateId: String(input.command.threadId),
                  }),
                  turnKey: String(input.command.turnId),
                  sighting,
                  executor: {
                    kind: "runtime",
                    driverKind: input.driver.kind,
                    providerInstanceId: input.command.authority.providerInstanceId,
                    modelId: input.command.authority.modelId,
                  },
                });
              },
            }),
        onUsage: (usage) => {
          // What the turn cost counts even when its report arrives after a
          // cancel: a cancelled Claude turn's total comes in its result, after
          // the abort, and dropping it charged the turn nothing.
          turnUsage = accumulateTurnUsage(turnUsage, usage);
          usageFacts = {
            contextTokens: usage.contextTokens ?? usageFacts.contextTokens,
            contextWindow: usage.contextWindow ?? usageFacts.contextWindow,
            providerExecutionDurationMs:
              usage.providerExecutionDurationMs ?? usageFacts.providerExecutionDurationMs,
          };
          const projected = this.#projection.lookup(input.command.requestId);
          if (
            input.signal.aborted ||
            (projected?.status !== "accepted" && projected?.status !== "running")
          ) {
            return;
          }
          this.#usageStore?.record(input.command.requestId, {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
          });
        },
        onChildActivity: (event) => {
          if (input.signal.aborted) return;
          const current = this.#projection.lookup(input.command.requestId);
          if (
            current === undefined ||
            current.providerSessionId !== event.sessionId ||
            current.authority.providerInstanceId !== event.instanceId
          )
            return;
          const childObservations = recordProviderChildObservation(
            current.childObservations,
            event,
          );
          if (childObservations === current.childObservations) return;
          this.#persistUpdate(current, { status: "running", childObservations });
        },
        onTasks: (tasks) => {
          if (input.signal.aborted) return;
          this.#liveTasks.set(String(input.command.requestId), tasks);
          this.#liveUpdates.appendTasks(input.command.threadId, input.command.requestId, tasks);
        },
        onToolSteps: (toolSteps) => {
          if (input.signal.aborted) return;
          this.#liveToolSteps.set(String(input.command.requestId), toolSteps);
          this.#liveUpdates.appendToolSteps(
            input.command.threadId,
            input.command.requestId,
            withoutPublishedSnapshots(toolSteps),
          );
        },
      });
      runOutcome = outcome;
      const wroteFiles = observation?.finish();
      const beforeCompletion = this.#projection.lookup(input.command.requestId);
      if (beforeCompletion === undefined) return;
      if (
        beforeCompletion.status !== "cancelled" &&
        outcome.kind === "completed" &&
        harnessScope !== undefined &&
        this.#nativeHarness !== undefined
      ) {
        await this.#nativeHarness
          .turnCompleted({
            ...harnessScope,
            text: outcome.response,
            toolCalls: 0,
            ...(endedTurn === undefined ? {} : { turn: endedTurn }),
          })
          .catch(() => undefined);
      }
      // Completion observers can yield; cancellation committed meanwhile wins.
      const latest = this.#projection.lookup(input.command.requestId);
      if (latest === undefined) return;
      if (latest.status === "cancelled") {
        // Cancelling settles the turn, but files the provider wrote before it
        // stopped are still on disk. Returning without recording them told the
        // person the folder was untouched when it was not. The tool calls it
        // made are recorded the same way, whether or not a file changed.
        const cancelledToolSteps = this.#liveToolSteps.get(String(input.command.requestId));
        if (wroteFiles !== undefined || cancelledToolSteps !== undefined) {
          const settledTasks = this.#liveTasks.get(String(input.command.requestId));
          const settledToolSteps = cancelledToolSteps;
          this.#persistUpdate(latest, {
            status: "cancelled",
            ...(latest.response === undefined ? {} : { response: latest.response }),
            ...(wroteFiles === undefined ? {} : { wroteFiles }),
            ...(settledTasks === undefined ? {} : { tasks: settledTasks }),
            ...(settledToolSteps === undefined ? {} : { toolSteps: settledToolSteps }),
          });
          const settledCancel = this.#projection.lookup(input.command.requestId);
          if (settledCancel !== undefined) {
            this.#liveUpdates.settle(input.command.threadId, settledCancel);
          }
        }
        return;
      }
      const live = this.#liveResponses.get(String(input.command.requestId));
      this.#persistOutcome(
        live === undefined ? latest : decodeWorkTurnState({ ...latest, response: live }),
        outcome,
        wroteFiles,
        this.#liveTasks.get(String(input.command.requestId)),
        this.#liveToolSteps.get(String(input.command.requestId)),
      );
      if (outcome.kind === "completed" && wroteFiles !== undefined) {
        await this.#backfillStatus(
          input.command.authority.projectId,
          input.projectCanonicalRoot,
          input.thread,
          wroteFiles,
        );
      }
      const settled = this.#projection.lookup(input.command.requestId);
      if (settled !== undefined) this.#liveUpdates.settle(input.command.threadId, settled);
    } finally {
      // Every turn that reached the provider leaves a ledger row, whatever its
      // outcome: one that reported nothing is recorded as unreported, so a
      // spend ceiling refuses rather than counting it as free. A completed
      // turn reached the provider even when the runtime did not say so.
      const reachedProvider =
        promptSent || turnUsage !== undefined || runOutcome?.kind === "completed";
      if (reachedProvider && published !== undefined) {
        this.#reconcileWorkUsage(published.snapshot, turnUsage, usageFacts);
      }
      // Record the final outcome after completion, cancellation and cleanup settle.
      if (harnessScope !== undefined) {
        const settled = this.#projection.lookup(input.command.requestId);
        const finalTurn =
          endedTurn !== undefined && settled?.status === "cancelled"
            ? { ...endedTurn, stopReason: "cancelled" as const }
            : endedTurn;
        this.#nativeHarness?.turnEnded?.(harnessScope, finalTurn);
      }
    }
  }

  #reconcileWorkUsage(
    snapshot: ContextInspectorSnapshot,
    usage: TurnUsage | undefined,
    facts: WorkUsageFacts,
  ): void {
    if (this.#contextHarness === undefined) return;
    try {
      this.#contextHarness.reconcileUsage({
        subject: snapshot.subject,
        planId: snapshot.next.plan.id,
        requestShape: "work-turn",
        actualInputTokens: usage?.inputTokens ?? 0,
        actualOutputTokens: usage?.outputTokens ?? 0,
        ...(usage === undefined ? { providerReported: false } : {}),
        ...(facts.contextTokens === undefined ? {} : { contextTokens: facts.contextTokens }),
        ...(facts.contextWindow === undefined ? {} : { contextWindow: facts.contextWindow }),
        ...(usage?.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
        ...(usage?.cacheReadInputTokens === undefined
          ? {}
          : { cacheReadInputTokens: usage.cacheReadInputTokens }),
        ...(usage?.cacheWriteInputTokens === undefined
          ? {}
          : { cacheWriteInputTokens: usage.cacheWriteInputTokens }),
        ...(facts.providerExecutionDurationMs === undefined
          ? {}
          : { providerExecutionDurationMs: facts.providerExecutionDurationMs }),
        ...(usage?.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
        ...(usage?.estimatedCostUsd === undefined
          ? {}
          : { estimatedCostUsd: usage.estimatedCostUsd }),
        currentVarianceReserve: snapshot.next.plan.reserves.variance,
        maxAdjustmentTokens: Math.ceil(snapshot.modelLimits.contextWindow * 0.1),
      });
    } catch {
      // Usage reconciliation is best-effort for a Work turn. A stale or
      // rejected variance must not convert the provider run into a failed
      // outcome.
    }
  }

  /**
   * End a turn that never reached the provider, and tell the live stream.
   *
   * A refusal is still the end of the turn: a reader attached before it — which
   * is exactly when a view attaches, at the start of the thread — otherwise
   * waits on a frame that never comes and shows nothing until a reload. Every
   * early refusal goes through here so none of them can forget to settle.
   */
  #refuseTurn(
    command: ReturnType<typeof decodeStartWorkThreadTurnCommand>,
    failure: NonNullable<WorkTurnState["failure"]>,
  ): void {
    const current = this.#projection.lookup(command.requestId);
    if (current === undefined) return;
    this.#persistUpdate(current, { status: "failed", failure });
    const settled = this.#projection.lookup(command.requestId);
    if (settled !== undefined) this.#liveUpdates.settle(command.threadId, settled);
  }

  #settleSpendReservation(requestId: WorkTurnRequestId | string): void {
    const reservationId = this.#spendReservations.get(String(requestId));
    if (reservationId === undefined) return;
    this.#spendReservations.delete(String(requestId));
    this.#spendCeiling?.settle({ reservationId });
  }

  #issueContextContribution(threadId: WorkThreadId): ReadonlyArray<WorkTurnContextContribution> {
    const framed =
      this.#peekIssueContextFramed?.(String(threadId)) ??
      this.#takeIssueContextFramed?.(String(threadId));
    if (framed === undefined) return [];
    return [
      {
        text: framed.text,
        sourceKind: "message",
        referenceId: `github-issue:${String(threadId)}`,
        category: "workspace-context",
        posture: "required",
        block: { kind: "user-message", text: framed.text },
      },
    ];
  }

  /**
   * The Project's status, ahead of everything the thread itself remembers,
   * for a Project that opted into a status file; any other Project gets
   * nothing here and nothing written into its folder.
   *
   * `STATUS.md` is read from the bound root on every turn, so a task started
   * two weeks later knows where the work stands without the person
   * re-explaining. It is keyed standing context: a runtime that keeps its own
   * conversation is sent it again only when the file changed, where it once
   * received a full copy every turn. A missing file is seeded here. When a
   * task opens on a stale status or a dated line overdue or near, that first
   * turn is also told to take stock — summarize, ask what happened, update the
   * file — before doing what it was asked, unless the request is a greeting or
   * unrelated to the work.
   */
  async #projectBriefContributions(
    project: Extract<Project, { readonly type: "work" }>,
    threadId: WorkThreadId,
    opensTask: boolean,
  ): Promise<ReadonlyArray<WorkTurnContextContribution>> {
    const files = this.#projectStatusFiles;
    if (files === undefined || !workProjectKeepsStatusFile(project)) return [];
    const root = project.binding.canonicalRoot;
    const today = this.#today();
    try {
      await files.seed(root, project.name, today);
    } catch {
      // A folder that refuses the seed still gets whatever it already has.
    }
    let status;
    try {
      status = await files.read(root);
    } catch {
      return [];
    }
    const contributions: WorkTurnContextContribution[] = [];
    if (status !== undefined) {
      contributions.push({
        text: status.text,
        sourceKind: "file",
        referenceId: `project-brief:${WORK_STATUS_FILE_NAME}:${String(threadId)}`,
        category: "workspace-context",
        posture: "compressible",
        block: {
          kind: "project-memory",
          key: STATUS_FILE_CONTEXT_KEY,
          text: `Contents of ${WORK_STATUS_FILE_NAME} at the top of this Project's folder:\n\n${status.text}`,
        },
      });
    }
    contributions.push({
      text: STATUS_UPKEEP_INSTRUCTION,
      sourceKind: "instruction",
      referenceId: `project-brief:instruction:${String(threadId)}`,
      category: "octant-policy",
      posture: "required",
      block: { kind: "instructions", text: STATUS_UPKEEP_INSTRUCTION },
    });
    const takeStock =
      !opensTask || status === undefined
        ? undefined
        : takeStockInstruction(
            decideWorkResumeBrief(
              parseWorkStatus(status.text, today),
              today,
              this.#statusStaleAfterDays,
            ),
          );
    if (takeStock !== undefined) {
      contributions.push({
        text: takeStock,
        sourceKind: "instruction",
        referenceId: `project-brief:take-stock:${String(threadId)}`,
        category: "octant-policy",
        posture: "required",
        block: { kind: "turn-instructions", text: takeStock },
      });
    }
    return contributions;
  }

  /**
   * The Project's design system, so user-facing work follows it: the rule,
   * then the primary `DESIGN.md` as keyed standing context that is sent again
   * only when the file changed.
   */
  async #designSystemContributions(
    project: Extract<Project, { readonly type: "work" }>,
    threadId: WorkThreadId,
  ): Promise<ReadonlyArray<WorkTurnContextContribution>> {
    const files = this.#designSystemFiles;
    const folders = designSystemFolders(project);
    if (files === undefined || folders === undefined) return [];
    const context = await designSystemTurnContext(files, folders);
    if (context === undefined) return [];
    return [
      {
        text: context.instructions,
        sourceKind: "instruction",
        referenceId: `design-system:instruction:${String(threadId)}`,
        category: "octant-policy",
        posture: "required",
        block: { kind: "instructions", text: context.instructions },
      },
      ...(context.system === undefined
        ? []
        : [
            {
              text: context.system.text,
              sourceKind: "file" as const,
              referenceId: `design-system:${String(threadId)}`,
              category: "workspace-context" as const,
              posture: "compressible" as const,
              block: {
                kind: "project-memory" as const,
                key: context.system.key,
                text: context.system.text,
              },
            },
          ]),
    ];
  }

  /**
   * When a turn changed files but left `STATUS.md` alone, record the change
   * there itself. Octant asserts only what it observed — which paths, in which
   * task — never what the change meant; that sentence is the agent's or the
   * person's to write.
   */
  async #backfillStatus(
    projectId: ProjectId,
    canonicalRoot: string,
    thread: WorkThread | undefined,
    wroteFiles: WorkTurnWrittenFiles,
  ): Promise<void> {
    const files = this.#projectStatusFiles;
    if (files === undefined) return;
    // Read the setting again: a person who turned the status file off while
    // the turn ran has asked Octant to stop writing into the folder.
    const project = this.#persistence.readProject(projectId);
    if (project === undefined || !workProjectKeepsStatusFile(project)) return;
    const changed = wroteFiles.paths.filter((path) => path !== WORK_STATUS_FILE_NAME);
    if (changed.length === 0 || wroteFiles.paths.includes(WORK_STATUS_FILE_NAME)) return;
    try {
      await files.appendRecentChange(canonicalRoot, {
        date: this.#today(),
        taskTitle: thread?.title ?? "Task",
        paths: changed,
        truncated: wroteFiles.truncated,
      });
    } catch {
      // The turn already happened; a status file that cannot be written is
      // reported by its absence on the Project page, not by failing the turn.
    }
  }

  #today() {
    const date = this.#clock().slice(0, 10);
    if (!isWorkStatusDate(date)) throw new Error("Host clock did not produce a calendar date.");
    return date;
  }

  /**
   * The thread's earlier turns as context. Conversation a compaction already
   * summarized is carried by its summary and kept in the manifest as
   * summarized, so the next compaction knows it is covered; the transcript
   * keeps every original message either way.
   */
  #priorTranscriptContributions(
    threadId: WorkThreadId,
  ): ReadonlyArray<WorkTurnContextContribution> {
    const messages = this.sessionCompactionConversation(threadId);
    const compacted = this.#contextHarness?.compactedConversation(
      decodeContextSubjectRef({ aggregateType: "work-thread", aggregateId: String(threadId) }),
    );
    const reusable =
      compacted === undefined
        ? new Set<string>()
        : reusableContextSummaryIds(
            compacted.summarizedSourceKeys,
            new Set(messages.map((message) => contextSourceKey(message.source))),
          );
    const summaries = (compacted?.summaries ?? [])
      .filter((summary) => reusable.has(String(summary.id)))
      .map(
        (summary): WorkTurnContextContribution => ({
          text: summary.content,
          sourceKind: "summary",
          referenceId: String(summary.id),
          category: "conversation",
          posture: "compressible",
          block: { kind: "conversation-summary", text: summary.content },
        }),
      );
    return [
      ...summaries,
      ...messages.map((message): WorkTurnContextContribution => {
        const summaryId = compacted?.summarizedSourceKeys.get(contextSourceKey(message.source));
        return {
          text: message.content,
          sourceKind: "message",
          referenceId: message.source.referenceId,
          category: "conversation",
          posture: "compressible",
          block: {
            kind: message.role === "assistant" ? "assistant-message" : "user-message",
            text: message.content,
          },
          ...(summaryId !== undefined && reusable.has(String(summaryId)) ? { summaryId } : {}),
        };
      }),
    ];
  }

  /** The conversation a requested compaction may summarize, sourced as turn context sources it. */
  sessionCompactionConversation(threadId: WorkThreadId): ReadonlyArray<SessionConversationMessage> {
    return this.#projection.listForThread(threadId).flatMap((turn) =>
      turn.transcript.flatMap(
        (entry, index): ReadonlyArray<SessionConversationMessage> =>
          entry.text.trim() === ""
            ? []
            : [
                {
                  source: {
                    kind: "message",
                    referenceId: `${String(turn.requestId)}:${entry.role}:${String(index)}`,
                  },
                  role: entry.role,
                  exchangeKey: String(turn.turnId),
                  content: entry.text,
                },
              ],
      ),
    );
  }

  /** Whether a turn on this thread is accepted, running, or waiting on the person. */
  isTurnActive(threadId: WorkThreadId): boolean {
    return (
      this.#runningAccess.has(String(threadId)) ||
      this.#projection
        .listForThread(threadId)
        .some(
          (turn) =>
            turn.status === "accepted" || turn.status === "running" || turn.status === "waiting",
        )
    );
  }

  async #sideChatReturnContributions(
    threadId: WorkThreadId,
    references: ReadonlyArray<import("@octant/contracts").SideChatDraftReturnReference> | undefined,
    windowId: WindowId,
  ): Promise<ReadonlyArray<WorkTurnContextContribution>> {
    if ((references?.length ?? 0) === 0) return [];
    if (this.#resolveSideChatReturns === undefined)
      throw this.#failure("unavailable", SIDE_CHAT_RETURN_UNAVAILABLE);
    let text: string;
    try {
      text = await this.#resolveSideChatReturns({
        references: references ?? [],
        readerThreadId: String(threadId),
        mode: "work",
        windowId,
      });
    } catch {
      throw this.#failure("unavailable", SIDE_CHAT_RETURN_UNAVAILABLE);
    }
    if (text.trim().length === 0) throw this.#failure("unavailable", SIDE_CHAT_RETURN_UNAVAILABLE);
    return [
      {
        text,
        sourceKind: "message",
        referenceId: `side-chat-return:${threadId}`,
        category: "workspace-context",
        posture: "required",
        block: { kind: "user-message", text },
      },
    ];
  }

  async #threadMentionContributions(
    readerThreadId: WorkThreadId,
    threadMentionIds: ReadonlyArray<MentionableThreadId> | undefined,
    windowId: WindowId,
  ): Promise<ReadonlyArray<WorkTurnContextContribution>> {
    if (threadMentionIds === undefined || threadMentionIds.length === 0) return [];
    const unreadable = (): ReadonlyArray<WorkTurnContextContribution> =>
      threadMentionIds.map((threadId, index) => ({
        text: THREAD_MENTION_UNREADABLE_CONTEXT,
        sourceKind: "message",
        referenceId: `thread-mention-unread:${String(threadId)}:${String(index)}`,
        category: "workspace-context",
        posture: "compressible",
        block: { kind: "user-message", text: THREAD_MENTION_UNREADABLE_CONTEXT },
      }));
    const resolve = this.#resolveThreadMentionContext;
    if (resolve === undefined) return unreadable();
    try {
      const blocks = await resolve({
        threadMentionIds,
        readerThreadId: String(readerThreadId),
        windowId,
      });
      return blocks.map((block, index) => ({
        text: block.text,
        sourceKind: "message",
        referenceId: `thread-mention:${String(threadMentionIds[index] ?? index)}`,
        category: "workspace-context",
        posture: "compressible",
        block,
      }));
    } catch {
      return unreadable();
    }
  }

  async #fileMentionContributions(
    fileMentionPaths: ReadonlyArray<string> | undefined,
    windowId: WindowId,
    threadId: WorkThreadId,
  ): Promise<ReadonlyArray<WorkTurnContextContribution>> {
    if (fileMentionPaths === undefined || fileMentionPaths.length === 0) return [];
    const unreadable = (): ReadonlyArray<WorkTurnContextContribution> =>
      fileMentionPaths.map((path, index) => ({
        text: FILE_MENTION_UNREADABLE_CONTEXT,
        sourceKind: "file",
        referenceId: `file-mention-unread:${path}:${String(index)}`,
        category: "workspace-context",
        posture: "required",
        block: { kind: "user-message", text: FILE_MENTION_UNREADABLE_CONTEXT },
      }));
    const resolve = this.#resolveFileMentionContext;
    if (resolve === undefined) return unreadable();
    try {
      const blocks = await resolve({ fileMentionPaths, windowId, threadId });
      return blocks.map((block, index) => ({
        text: block.text,
        sourceKind: "file",
        referenceId: `file-mention:${fileMentionPaths[index] ?? String(index)}`,
        category: "workspace-context",
        posture: "required",
        block,
      }));
    } catch {
      return unreadable();
    }
  }

  #persistOutcome(
    turn: WorkTurnState,
    outcome: WorkTurnRuntimeOutcome,
    // Recorded on every settled outcome, not only a completed one: a turn that
    // failed or was interrupted may still have written a file, and leaving that
    // out would tell the person the folder is untouched when it is not.
    wroteFiles?: WorkTurnWrittenFiles,
    // The provider's task list survived only in process-local state while the
    // turn ran; settling is the last chance to journal it for replay.
    tasks?: ThreadTaskProgressList,
    // Held in process for the same reason as the task list.
    toolSteps?: ThreadToolSteps,
  ): void {
    const written = wroteFiles === undefined ? {} : { wroteFiles };
    const recordedTasks = {
      ...(tasks === undefined ? {} : { tasks }),
      ...(toolSteps === undefined ? {} : { toolSteps }),
    };
    if (outcome.kind === "completed") {
      this.#persistUpdate(turn, {
        status: "completed",
        response: outcome.response,
        ...written,
        ...recordedTasks,
      });
      return;
    }
    if (outcome.kind === "cancelled") {
      this.#persistUpdate(turn, {
        status: "cancelled",
        ...(turn.response === undefined ? {} : { response: turn.response }),
        ...written,
        ...recordedTasks,
      });
      return;
    }
    this.#persistUpdate(turn, {
      status: outcome.kind === "waiting" ? "waiting" : "failed",
      ...(turn.response === undefined ? {} : { response: turn.response }),
      ...written,
      ...recordedTasks,
      failure: outcome.failure,
    });
  }

  #persistUpdate(
    turn: WorkTurnState,
    update: {
      readonly status: "running" | "completed" | "cancelled" | "failed" | "waiting";
      readonly response?: string;
      readonly wroteFiles?: WorkTurnWrittenFiles;
      readonly failure?: WorkTurnState["failure"];
      readonly tasks?: ThreadTaskProgressList;
      readonly toolSteps?: ThreadToolSteps;
      readonly childObservations?: WorkTurnState["childObservations"];
    },
  ): void {
    const latest = this.#projection.lookup(turn.requestId) ?? turn;
    const updatedAt = decodeTimestamp(this.#clock());
    const response = update.response ?? latest.response;
    const tasks = update.tasks ?? latest.tasks;
    const toolSteps =
      update.toolSteps ??
      (latest.toolSteps === undefined
        ? undefined
        : { steps: latest.toolSteps, truncated: latest.toolStepsTruncated === true });
    const transcript = [
      { role: "user" as const, text: latest.prompt },
      ...(response === undefined && update.status === "running"
        ? [{ role: "assistant" as const, text: "", status: "running" as const }]
        : response === undefined
          ? []
          : [
              {
                role: "assistant" as const,
                text: response,
                status: update.status,
              },
            ]),
    ];
    try {
      this.#append(latest.requestId, latest.version, "work.turn-updated@1", {
        kind: "turn-updated",
        requestId: latest.requestId,
        threadId: latest.threadId,
        turnId: latest.turnId,
        status: update.status,
        ...(response === undefined ? {} : { response }),
        transcript,
        ...(update.wroteFiles === undefined ? {} : { wroteFiles: update.wroteFiles }),
        ...(update.failure === undefined ? {} : { failure: update.failure }),
        ...(tasks === undefined ? {} : { tasks }),
        ...(toolSteps === undefined
          ? {}
          : {
              toolSteps: toolSteps.steps,
              ...(toolSteps.truncated ? { toolStepsTruncated: true } : {}),
            }),
        ...(update.childObservations === undefined
          ? {}
          : { childObservations: update.childObservations }),
        updatedAt,
      });
    } catch {
      // Projection/journal failures after acceptance are retained as waiting so
      // reconnect can surface an honest interrupted/recovery state.
    }
  }

  #append(
    requestId: WorkTurnRequestId,
    expectedVersion: number,
    eventName: "work.turn-accepted@1" | "work.turn-updated@1" | "work.thread-rewound@1",
    payload: unknown,
    // A person's turn is theirs; a turn the host starts on its own (a routine,
    // a usage-limit resume) is the system's, so the journal tells them apart.
    actorKind: "local-user" | "system" = "local-user",
  ): void {
    this.#persistence.journal.append({
      aggregate: {
        aggregateType: "work-turn",
        aggregateId: String(requestId),
      },
      expectedVersion,
      events: [
        {
          eventId: decodeEventId(this.#uuid()),
          eventName,
          eventVersion: 1,
          correlationId: decodeCorrelationId(this.#uuid()),
          actor: {
            kind: actorKind,
            actorId: decodeActorId(OCTANT_LOCAL_ACTOR_ID),
          },
          occurredAt: decodeTimestamp(this.#clock()),
          payload,
        },
      ],
    });
    if (eventName === "work.turn-accepted@1") {
      this.#projection.apply(payload as never);
    } else {
      this.#projection.apply(payload as never);
    }
  }

  #lookupMatching(
    command: ReturnType<typeof decodeStartWorkThreadTurnCommand>,
    existing: WorkTurnState,
    externalInput?: WorkExternalInputReceipt,
  ): WorkTurnLookupResult {
    if (
      externalInput !== undefined &&
      !sameWorkExternalInput(existing.externalInput, externalInput)
    )
      throw this.#failure(
        "stale",
        "External input acceptance is unconfirmed for this Work request. Open the existing task; do not resend automatically.",
      );
    if (
      String(existing.threadId) !== String(command.threadId) ||
      String(existing.turnId) !== String(command.turnId) ||
      existing.prompt !== command.prompt ||
      (existing.toolCatalogHandoff === true) !== (command.toolCatalogHandoff === true) ||
      (existing.inputReceipt !== undefined &&
        existing.inputReceipt.policy !== (command.contextInputPolicy ?? "preserve")) ||
      JSON.stringify(existing.delivery ?? null) !== JSON.stringify(command.delivery ?? null) ||
      JSON.stringify(existing.extensionSelections ?? []) !==
        JSON.stringify(command.extensionSelections ?? []) ||
      JSON.stringify(existing.sideChatReturns ?? []) !==
        JSON.stringify(command.sideChatReturns ?? []) ||
      !sameAttachmentIds(existing.attachments, command.attachmentIds)
    ) {
      throw this.#failure("stale", "Work turn request identity conflict.");
    }
    return decodeWorkTurnLookupResult({ kind: "accepted", turn: existing });
  }

  /**
   * Accept one image for a thread's next turn.
   *
   * Authority is the thread's own: whoever may send this thread a turn may
   * attach a picture to it. Nothing the renderer claims about the bytes is
   * kept — the store re-derives the name, size, and digest the journal will
   * later record from what it actually wrote.
   */
  async stageAttachment(
    authenticatedWindowId: WindowId,
    input: {
      readonly threadId: WorkThreadId;
      readonly attachmentId: WorkAttachmentId;
      readonly displayName: string;
      readonly mediaType: WorkAttachmentMediaType;
      readonly bytes: Uint8Array;
      readonly signal?: AbortSignal;
    },
  ): Promise<WorkAttachmentReference> {
    const attachments = await this.#authorizeAttachment(authenticatedWindowId, input.threadId);
    try {
      return await attachments.stage(input);
    } catch (error) {
      throw this.#failure(
        error instanceof WorkAttachmentTooLarge || error instanceof WorkAttachmentInvalid
          ? "invalid"
          : "failed",
        error instanceof WorkAttachmentTooLarge || error instanceof WorkAttachmentInvalid
          ? error.message
          : "Work attachment could not be staged.",
      );
    }
  }

  async discardAttachment(
    authenticatedWindowId: WindowId,
    threadId: WorkThreadId,
    attachmentId: WorkAttachmentId,
  ): Promise<void> {
    const attachments = await this.#authorizeAttachment(authenticatedWindowId, threadId);
    try {
      await attachments.discard(threadId, attachmentId);
    } catch {
      throw this.#failure("failed", "Work attachment could not be discarded.");
    }
  }

  async #authorizeAttachment(
    authenticatedWindowId: WindowId,
    threadId: WorkThreadId,
  ): Promise<WorkAttachmentStore> {
    this.#assertReady();
    const thread = await this.#threads.read(authenticatedWindowId, threadId);
    if (thread === undefined) {
      throw this.#failure("unauthorized", "Work thread is unavailable for this window.");
    }
    if (this.#attachments === undefined) {
      throw this.#failure("unavailable", "Work attachments are unavailable.");
    }
    return this.#attachments;
  }

  #startingAttachments(
    threadId: WorkThreadId,
    attachmentIds: ReadonlyArray<WorkAttachmentId> | undefined,
  ):
    | { readonly status: "ok"; readonly attachments: ReadonlyArray<WorkAttachmentReference> }
    | { readonly status: "unknown" } {
    if (attachmentIds === undefined || attachmentIds.length === 0) {
      return { status: "ok", attachments: [] };
    }
    if (this.#attachments === undefined) return { status: "unknown" };
    const peeked = this.#attachments.peek(threadId, attachmentIds);
    if (peeked.status !== "ok") return { status: "unknown" };
    return { status: "ok", attachments: peeked.attachments };
  }

  async #attachmentInputs(
    threadId: WorkThreadId,
    references: ReadonlyArray<WorkAttachmentReference>,
  ): Promise<ReadonlyArray<ProviderAttachmentInput> | undefined> {
    if (references.length === 0) return [];
    if (this.#attachments === undefined) return undefined;
    const inputs: ProviderAttachmentInput[] = [];
    for (const reference of references) {
      let bytes: Uint8Array;
      try {
        bytes = await this.#attachments.read(threadId, reference);
      } catch {
        return undefined;
      }
      inputs.push({
        attachmentId: String(reference.attachmentId),
        displayName: reference.displayName,
        mediaType: reference.mediaType,
        bytes,
      });
    }
    return inputs;
  }

  #modelReadsImages(authority: {
    readonly providerInstanceId: WorkThread["providerInstanceId"];
    readonly modelId: WorkThread["modelId"];
  }): boolean {
    return this.#supportsAttachments?.(authority) === true;
  }

  async #assertThreadAccess(
    windowId: WindowId,
    threadId: WorkThreadId,
    projectId: ProjectId,
  ): Promise<void> {
    const thread = await this.#threads.read(windowId, threadId);
    if (thread === undefined || String(thread.projectId) !== String(projectId)) {
      throw this.#failure("unauthorized", "Work turn is unavailable for this window.");
    }
  }

  #assertReady(): void {
    const status = this.#persistence.status();
    if (status.state !== "current" || status.integrity !== "ok") {
      throw this.#failure("unavailable", "Octant Work turn service is unavailable.");
    }
  }

  #mapFailure(error: unknown): WorkTurnServiceError {
    if (error instanceof WorkTurnServiceError) return error;
    if (error instanceof ConcurrencyConflict) {
      return this.#failure("stale", "Work turn changed; reload and retry.");
    }
    if (error instanceof JournalWriteFailed || error instanceof ProjectionApplicationFailed) {
      return this.#failure(
        "unavailable",
        persistenceFailureMessage(error, "Octant Work turn service is unavailable."),
      );
    }
    return this.#failure("unavailable", "Octant Work turn service is unavailable.");
  }

  #failure(
    category: WorkTurnServiceError["failure"]["category"],
    message: string,
  ): WorkTurnServiceError {
    return new WorkTurnServiceError(decodeWorkTurnFailure({ category, message }));
  }
}

function sameAttachmentIds(
  recorded: ReadonlyArray<WorkAttachmentReference> | undefined,
  named: ReadonlyArray<WorkAttachmentId> | undefined,
): boolean {
  const left = recorded?.map((attachment) => String(attachment.attachmentId)) ?? [];
  const right = named?.map((attachmentId) => String(attachmentId)) ?? [];
  if (left.length !== right.length) return false;
  return left.every((id, index) => id === right[index]);
}

/** The Project as the Work turn decision reads it. */
function workTurnProjectFacts(
  project: Project | undefined,
): Parameters<typeof decideWorkTurnAuthority>[0]["project"] {
  return project === undefined
    ? undefined
    : {
        type: project.type,
        lifecycle: project.lifecycle,
        bindingHistory: project.type === "work" ? project.bindingHistory : [],
        binding:
          project.type === "work"
            ? { canonicalRoot: project.binding.canonicalRoot }
            : { canonicalRoot: "" },
      };
}

/** The thread as the Work turn decision reads it. */
function workTurnThreadFacts(
  thread: WorkThread | undefined,
): Parameters<typeof decideWorkTurnAuthority>[0]["thread"] {
  return thread === undefined
    ? undefined
    : {
        projectId: String(thread.projectId),
        lifecycle: thread.lifecycle,
        providerInstanceId: String(thread.providerInstanceId),
        modelId: String(thread.modelId),
        bindingRevisionId:
          thread.bindingRevisionId === undefined ? undefined : String(thread.bindingRevisionId),
        workingDirectory:
          thread.workingDirectory === undefined ? undefined : String(thread.workingDirectory),
        ...(thread.workingFolderId === undefined
          ? {}
          : { workingFolderId: thread.workingFolderId }),
      };
}

/**
 * A running turn's tool calls as the live feed carries them: a published
 * page keeps its link, and its snapshot waits for the settled turn. Every
 * step change restates the whole list, so a snapshot of up to
 * `MAX_THREAD_PUBLISHED_SNAPSHOT_BYTES` carried live was resent to every
 * window, and held in the feed's frames, once per later tool event of the
 * turn (sixty later events held about 15 MB for one snapshot).
 */
/** Tells the agent about the Project's extra folders, which its runtime cannot see. */
function extraFolderContributions(
  project: Parameters<typeof projectExtraFolderRoots>[0],
): ReadonlyArray<WorkTurnContextContribution> {
  const text = projectExtraFoldersInstructions(projectExtraFolderRoots(project));
  if (text === undefined) return [];
  return [
    {
      text,
      sourceKind: "instruction",
      referenceId: "octant-project-extra-folders",
      category: "octant-policy",
      posture: "required",
      block: { kind: "instructions", text },
    },
  ];
}

function withoutPublishedSnapshots(toolSteps: ThreadToolSteps): ThreadToolSteps {
  if (!toolSteps.steps.some((step) => step.published?.snapshot !== undefined)) return toolSteps;
  return {
    ...toolSteps,
    steps: toolSteps.steps.map((step) => {
      if (step.published?.snapshot === undefined) return step;
      const { snapshot: _settled, ...page } = step.published;
      return { ...step, published: page };
    }),
  };
}

/**
 * The Project's active memory, one entry each, as a Chat turn in the Project
 * carries it: after person memory and before the Project's own files.
 */
function projectMemoryContributions(
  memory: ProjectMemoryView | undefined,
): ReadonlyArray<WorkTurnContextContribution> {
  return (memory?.active ?? []).map((entry) => ({
    text: entry.content,
    sourceKind: "memory",
    referenceId: String(entry.id),
    category: "project-memory",
    posture: "compressible",
    block: { kind: "project-memory", text: entry.content },
  }));
}

/** What Octant remembers about the person, placed after instructions and before the Project's own context. */
function personMemoryContributions(
  text: string | undefined,
): ReadonlyArray<WorkTurnContextContribution> {
  if (text === undefined) return [];
  return [
    {
      text,
      sourceKind: "memory",
      referenceId: "person-memory",
      category: "person-memory",
      posture: "compressible",
      block: { kind: "person-memory", text },
    },
  ];
}
