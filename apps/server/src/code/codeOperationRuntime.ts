import { OwnerApprovalId } from "@octant/contracts/owner-approvals";
import type { DesignSystemTurnContext } from "../designSystems/designSystemContext";
import type { RuntimeApprovalRecovery } from "../providers/runtimeApprovalRecovery";
import { withHandoverSummary } from "../agentRun/conversationHandoff";
import { validateQuestionnaireAnswer } from "@octant/domain";
import { MAX_PROVIDER_ATTACHMENTS } from "@octant/contracts";
import { THREAD_MOVING_REFUSAL } from "../hub/threadMoveHolds";
import type {
  CodeProviderFileReviewRequest,
  CodeProviderFileReviewRead,
} from "@octant/contracts/code-provider-file-review";
import { createCodeProviderFileReview } from "./codeProviderFileReview";
import type {
  ConversationInputReceipt,
  ConversationInputPurpose,
  ConversationInputPolicy,
} from "@octant/contracts/conversation-inputs";
import type { ConversationInputTransfer } from "../attachments/conversationInputTransfer";
import { conversationInputReceiptBlock } from "../attachments/conversationInputs";
import type { ProviderAttachmentInput } from "@octant/contracts";
import { type Questionnaire } from "@octant/contracts";
import { isBrowserUseSelection } from "@octant/plugin-host/browser-use";
import { CodeTurnReviewCaptureScheduler } from "./codeTurnReviewCaptureScheduler";
import { boundReviewText } from "./codeReviewComparison";
import { DEFAULT_MAX_GIT_DIFF_BYTES } from "./gitObservationPort";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, sep } from "node:path";
import {
  type AgentRun,
  type AgentRunId,
  CodeApprovalId,
  ToolApprovalId,
  MAX_CODE_OPERATION_FAILURE_MESSAGE_BYTES,
  MAX_CODE_OPERATION_SUMMARY_BYTES,
  MAX_CODE_OPERATION_TEXT_BYTES,
  decodeCodeOperationApprovalRequest,
  decodeCodeOperationApprovalConfirmation,
  decodeCodeCheckoutId,
  decodeCodeCheckoutHead,
  decodeCodeOperationCommand,
  decodeCodeTurnReviewCapture,
  decodeCodeOperationId,
  CodeGitOperationId,
  decodeCodeThreadId,
  decodeCodeEvidenceBatchResponse,
  decodeCodeRelativePath,
  decodeHarnessRetryNotice,
  decodeCodeReviewFindingId,
  decodeProviderSessionId,
  type CodeCheckoutIdentity,
  type AppleActionRequest,
  type AndroidEmulatorRequest,
  type CodeOperationCommand,
  type CodeOperationFailure,
  type CodeConversationPage,
  type CodeTurnReviewCapture,
  type CodeTurnReviewPreview,
  type CodeConversationWindowRequest,
  type CodeForkMergeBackOutcome,
  type ProviderSessionId,
  type ContextCompactionExecutor,
  type CodeEvidenceBatchRequest,
  type CodeEvidenceBatchResponse,
  type CodeOperationApprovalReceipt,
  type CodeOperationApprovalRequest,
  type CodeOperationApprovalChallenge,
  type CodeOperationApprovalConfirmation,
  type CodeEvidenceContentId,
  type CodeEvidenceReference,
  type CodeOperationEvent,
  type HarnessRetryNotice,
  type CodeOperationEventFrame,
  type CodeOperationId,
  type CodeRuntimeWork,
  type CodeRuntimeWorkId,
  type CodeOperationResult,
  type CodeThread,
  type AutoReviewer,
  type ShieldDecision,
  type ComputerUseDestinationSelection,
  type CodeMergeStandingSource,
  type CodeProjectPullRequestSwitchTarget,
  type CodeThreadId,
  type AutomationRunReference,
  type EventActor,
  type PendingRequest,
  type ProviderCapabilities,
  type ProviderNativeSetup,
  type ProviderRuntimeEvent,
  type ProviderResumeCursor,
  type ProviderProbeResult,
  type WindowId,
  CODE_PROJECT_PULL_REQUEST_WATCH_LIFETIME_MS,
  CODE_PROJECT_PULL_REQUEST_WATCH_MAX_WAKES,
  decodeCodeFailure,
  MAX_THREAD_TASKS_PER_TURN,
} from "@octant/contracts";
import {
  forgeShellChanges,
  FORGE_SHELL_TOOL_REQUIRED_MESSAGE,
} from "@octant/domain/forge-shell-change-policy";
import { shieldCallFromProviderRequest } from "@octant/domain/shield-judge-policy";
import type { ShieldReviewPort } from "../shield/octantShield";
import { Effect, Schema } from "effect";
import type {
  ProviderAcquireInput,
  ProviderConnection,
  ProviderDriver,
  ProviderSessionResume,
} from "@octant/provider-sdk/driver";
import type { Journal } from "../persistence/journal";
import { createGhPullRequestPort } from "./ghPullRequestActionPort";
import { createGhCommandPort, type GhDeliveryTarget } from "./ghPullRequestPort";
import { GitMutationPort } from "./gitMutationPort";
import {
  GitObservationPort,
  type GitObservationResult,
  type GitScopedDiffResult,
} from "./gitObservationPort";
import { GitService } from "./gitService";
import {
  CodeOperationEventStore,
  MAX_CODE_OPERATION_REPLAY_LIMIT,
  type CodeConversationWindowRead,
} from "./codeOperationEventStore";
import { chooseCodeForkPoint, codeThreadTurns } from "./codeForkPoint";
import {
  forkMergeDelivery,
  mergeForkConversation,
  type CodeForkMergeBackReader,
  type ForkContextDelivered,
} from "./codeForkMergeBack";
import {
  CodeRuntimeWorkRecorder,
  codeRuntimeWorkObserved,
  codeRuntimeWorkStarted,
  codeRuntimeWorkStateFrom,
  type CodeRuntimeWorkRecordFailure,
  type CodeRuntimeWorkRecordOutcome,
} from "./codeRuntimeWorkRecorder";
import {
  APPROVAL_POSTURE_CHANGED_MESSAGE,
  approvalAnswerUnderPosture,
  approvalPostureOf,
  clampTurnAccessPosture,
  decidesCodeEffectsByApproval,
  isAppleSimulatorInputKind,
  isAppleSimulatorOpenInputKind,
  isAndroidEmulatorInputKind,
  isAndroidEmulatorOpenInputKind,
  harnessAutoReviewEffective,
  mayWriteToRepository,
  projectExtraFoldersInstructions,
  turnBlocksInPlaceRestore,
  unsupportedModelOptionValues,
} from "@octant/domain";
import { decodeSpendCeilingReservationId, type SpendCeilingService } from "../spendCeilingService";
import { WORK_TURN_SAFE_INPUT_TOKENS } from "../work/workTurnContext";
import {
  approvalContextDigest,
  CodeOperationApprovalStore,
  type CodeApprovalValidationPort,
} from "./codeOperationApprovalStore";
import {
  CodeOperationService,
  CodeOperationServiceError,
  type CodeOperationAuthorityPort,
  type CodeOperationEvidencePort,
  type CodeOperationExecuteOptions,
  type CodeOperationGitPort,
  type CodeOperationPullRequestPort,
  type CodeOperationScaffoldPort,
  type CodeOperationServiceOptions,
  type CodeOperationTurnPort,
  type CodeTurnPendingRequest,
} from "./codeOperationService";
import type { CodeAttachmentStore } from "./codeAttachmentStore";
import type { PullRequestWatchPort } from "./pullRequestWatchPort";
import { RepositoryTestProcessPort } from "./repositoryTestProcessPort";
import type {
  NativeHarnessTurnAdmission,
  NativeHarnessTurnScope,
} from "../harness/nativeHarnessTurnObserver";
import { withPromptDigest, type TurnEndSummary } from "../metrics/turnEnd";
import type { AutomaticCompactionSighting } from "../context/automaticCompaction";
import type { RuntimeOutsideContentMarking } from "../context/runtimeOutsideContentMark";
import type { RuntimeForgeChangeObserver } from "../shield/runtimeForgeChanges";
import type { LiveTurnRegistry } from "../liveTurn/liveTurnRegistry";
import {
  decodeAgentRunAdmittedContext,
  MAX_SHIELD_REASON_LENGTH,
  type ProviderContextBlock,
} from "@octant/contracts";
import type {
  AgentRunParentContextSelection,
  AgentRunParentContextUnavailableReason,
} from "../agentRun/agentRunParentContext";
import {
  CODE_FORK_HANDOFF_REFUSALS,
  selectCodeForkHandoff,
  type CodeForkConversationReader,
  type CodeForkHandoffRefusal,
} from "./codeForkHandoff";
import {
  CodeServiceError,
  type CodeForkPoint,
  type ManagedCodeThreadCreationPort,
} from "./codeService";
import { RepositoryTestRunner } from "./repositoryTestRunner";
import { RepositoryTestDiscoveryService } from "./repositoryTestDiscoveryService";
import { CURATED_SCAFFOLDS, curatedScaffoldTools } from "../scaffold/curatedScaffoldCatalog";
import {
  makeScaffoldDirectory,
  resolveAvailableTools,
  scaffoldEntryExists,
} from "../scaffold/scaffoldFilesystem";
import { ScaffoldRunner } from "../scaffold/scaffoldRunner";
import {
  ReviewFindingService,
  type ReviewFindingFilePort,
  type ReviewFindingPersistencePort,
} from "./reviewFindingService";
import { TerminalProcessPort } from "./terminalProcessPort";
import { liveCodeTestSourcePort, type CodeTestSourcePort } from "./codeDirectoryPort";
import { createCodeAcpClientTools, type CodeAcpTerminalConfinement } from "./codeAcpClientTools";
import { makeProcessConfinementLive } from "../process/seatbeltProfile";
import type { TerminalBrowserGrantService } from "./terminalBrowserGrantService";
import { TerminalService } from "./terminalService";
import { CodeSessionAuthorityStore } from "./codeSessionAuthorityStore";
import { boundedDiff, draftGitText, type CodeGitDraftResult } from "./codeGitDraftService";
import { turnChangedFiles } from "./codeTurnChangedFiles";
import { CodeTurnRunner, type CodeTurnEvent, type CodeTurnOutcome } from "./codeTurnRunner";
import {
  carriedSentContext,
  estimateSentContextParts,
  type CarriedSentContext,
  type CodeTurnContextAccount,
  type CodeTurnSentContext,
} from "./codeTurnContext";
import {
  createCodeAppManagedTools,
  type CodeAppManagedToolsOptions,
  type CodeDeviceApprovalEffect,
  type PullRequestToolCommand,
} from "./codeAppManagedTools";
import type { CodePlannerToolPort } from "./codePlannerTools";
import { combineAppManagedToolSets, type AppManagedToolSet } from "../providers/appManagedToolSet";
import { heldTurnContext } from "../providers/heldTurnContext";
import {
  PROVIDER_CONTEXT_RESTATED,
  type ProviderTurnContextDelta,
} from "@octant/provider-sdk/chat-conformance";
import { CANVAS_TOOL_NAME } from "../canvas/canvasAgentTools";
import {
  documentDeliveryInstructions,
  offersCanvasTool,
} from "../canvas/canvasDeliveryInstructions";
import { CodeEvidenceCapacityExceeded } from "./codeEvidenceStore";
import { appToolHostLines } from "../providers/appToolHostLines";

type Awaitable<T> = T | Promise<T>;

interface RuntimePersistence extends ReviewFindingPersistencePort {
  readonly readCodeRuntimeWorkAggregateVersion: (id: CodeRuntimeWorkId) => number;
  /** A thread's runtime work records; without it a lost push or pull request is never settled. */
  readonly readCodeRuntimeWorks?: (
    threadId: CodeThreadId,
  ) => ReadonlyArray<{ readonly work: CodeRuntimeWork }>;
  readonly journal: Journal;
  readonly readCodeCheckout: (
    checkoutId: CodeCheckoutIdentity["id"],
  ) => CodeCheckoutIdentity | undefined;
}

interface CredentialResolver {
  resolve(reference: string): Promise<string | undefined>;
}

interface ProcessTestPort {
  execute: RepositoryTestProcessPort["execute"];
  readArtifact: RepositoryTestProcessPort["readArtifact"];
  reconcile?: () => Promise<void>;
}

function defaultAcpTerminalConfinement(): CodeAcpTerminalConfinement {
  const environment = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME ?? "/tmp",
    TMPDIR: process.env.TMPDIR ?? process.env.TMP ?? "/tmp",
    ...(process.env.LANG === undefined ? {} : { LANG: process.env.LANG }),
  };
  const confinement = makeProcessConfinementLive({ platform: process.platform });
  return {
    environment,
    prepare: (input) =>
      confinement.prepare({
        executable: input.executable,
        args: input.args,
        boundRoot: input.boundRoot,
        ...(input.extraBoundRoots === undefined ? {} : { extraBoundRoots: input.extraBoundRoots }),
        temporaryDirectory: input.temporaryDirectory,
        networkEgress: "allow",
        allowProcessExec: true,
        allowProcessFork: true,
        allowFileReadStar: true,
        writeBoundRoot: true,
        readRoots: [
          input.boundRoot,
          ...(input.extraBoundRoots ?? []),
          input.temporaryDirectory,
          dirname(input.executable),
        ],
      }),
  };
}

export interface CodeOperationRuntimeOptions {
  readonly prepareWorktree?: CodeOperationServiceOptions["prepareWorktree"];
  /** How long a Stop waits for the runtime to confirm it; defaults to {@link CODE_STOP_CONFIRMATION_MS}. */
  readonly stopConfirmationMs?: number;
  /**
   * Whether a move holds the thread: frozen while it leaves this computer, or
   * arriving and not yet committed. A held thread starts no turn.
   */
  readonly moveHold?: (threadId: string) => boolean;
  /** Where a running turn's start time and latest step are kept for the navigation read. */
  readonly liveTurns?: LiveTurnRegistry;
  /**
   * Where the runtime keeps its running turns. The host passes one it built
   * before its window authority, which reads a running turn's posture from it
   * with {@link threadWithActiveTurnPosture}; absent, the runtime keeps its own.
   */
  readonly activeTurns?: CodeActiveTurns;
  /**
   * Told when a pending request ends without a journal event: a browser-origin
   * approval that expires or whose tool call is abandoned leaves nothing in the
   * stream, so the change feed would otherwise never say it is gone.
   */
  readonly onPendingRequestWithdrawn?: () => void;
  /**
   * The turn's Computer tool, bound to the send's destination: this Mac, or
   * one of the thread's disposable desktops. `ask` asks the turn's person in
   * the thread, which is where a desktop's approvals are answered.
   */
  /**
   * The thread's own running desktop, for a send that names no destination on
   * a host with no screen of its own. Absent when there is none or more than
   * one, so the host never chooses between two.
   */
  readonly threadDesktopDestination?: (
    thread: CodeThread,
  ) => ComputerUseDestinationSelection | undefined;
  readonly computerUseTools?: (input: {
    readonly windowId: WindowId;
    readonly thread: CodeThread;
    readonly destination?: ComputerUseDestinationSelection;
    readonly ask: (
      summary: string,
      signal?: AbortSignal,
    ) => Promise<"approved" | "denied" | "cancelled" | "expired">;
  }) => AppManagedToolSet | undefined;
  readonly persistence: RuntimePersistence;
  /**
   * The extra folders of a Code thread's Project, read at each turn start so
   * a folder added or removed applies from the next turn. Absent reads none.
   */
  readonly readProjectExtraFolders?: (projectId: CodeThread["projectId"]) => ReadonlyArray<string>;
  /**
   * The paired device a lease confirmation names, as the host last saw it.
   * Absent on a host with no device layer, where no lease is ever confirmed.
   */
  readonly windowAccess: {
    readonly canAccessProject: CodeOperationAuthorityPort["canAccessProject"];
    /** Existing host authority read synchronously at fresh capture publication; absent means unavailable. */
    readonly currentProjectAccess?: CodeOperationAuthorityPort["currentProjectAccess"];
    /**
     * Runs `run` on the window's standing authority: its persisted binding,
     * judged when each check inside runs, never a request's admission.
     */
    readonly standingAuthority: <T>(run: () => T) => T;
    readonly retainProjectAccess?: CodeOperationAuthorityPort["retainProjectAccess"];
  };
  readonly resolveCheckoutRoot: CodeOperationAuthorityPort["resolveCheckoutRoot"];
  readonly resolveProviderDriver: (thread: CodeThread) => Awaitable<ProviderDriver | undefined>;
  readonly credentialResolver: CredentialResolver;
  /**
   * Mints the Browser grant a thread terminal can be started with. Its two
   * variables reach the shell through the terminal's credential path, so the
   * grant is resolved here before the host's own credentials are asked.
   */
  readonly terminalBrowserGrants?: Pick<
    TerminalBrowserGrantService,
    "open" | "abandon" | "switchOff" | "terminalClosed" | "resolveCredential" | "liveGrant"
  >;
  readonly resolvePullRequestTarget: (
    threadId: CodeThreadId,
  ) => Promise<GhDeliveryTarget | undefined>;
  /** The standing merge permissions the person has stored for a thread; absent reads none. */
  readonly standingMergeAllowance?: (thread: CodeThread) => ReadonlyArray<CodeMergeStandingSource>;
  /** A thread's watch on its own pull request; absent, the tool refuses watch and unwatch. */
  readonly pullRequestWatch?: PullRequestWatchPort;
  readonly reviewFiles: ReviewFindingFilePort;
  readonly evidence: CodeOperationEvidencePort;
  /** The images Code threads have staged for their next turn. */
  readonly attachments?: CodeAttachmentStore;
  readonly conversationInputTransfer?: Pick<ConversationInputTransfer, "prepare">;
  readonly approvalValidator?: CodeApprovalValidationPort;
  readonly approvalStore?: CodeOperationApprovalStore;
  readonly managedThreadCreation?: ManagedCodeThreadCreationPort;
  readonly sessionAuthority?: CodeSessionAuthorityStore;
  readonly actor: EventActor;
  readonly clock: () => string;
  readonly uuid: () => string;
  /** Reports a board-record failure without exposing journal or provider details. */
  readonly reportRuntimeWorkFailure?: (failure: CodeRuntimeWorkRecordFailure) => void;
  /**
   * A person asked the thread for a turn. Fires once per new turn, after the
   * scope check and before any runtime work is recorded, so a completed or
   * snoozed thread comes back the moment it is spoken to. A throw refuses the
   * turn: a thread that stayed completed or snoozed while its turn ran would
   * be a half-applied state, so the host starts nothing on a record it could
   * not bring back.
   */
  readonly onProviderTurnRequested?: (threadId: CodeThreadId) => void;
  /** Refuses every new Code turn whose current Project policy no longer accepts its provider/model. */
  readonly isProviderModelAllowed?: (thread: CodeThread) => boolean;
  /**
   * Read access to journaled subagent runs, for verifying the delivery mark a
   * `start-provider-turn` claims. Absent means delivery claims are refused.
   */
  readonly agentRuns?: {
    readonly getById: (runId: AgentRunId) => AgentRun | undefined;
  };
  readonly probeProvider?: (
    instanceId: CodeThread["providerInstanceId"],
  ) => Promise<Pick<ProviderProbeResult, "readiness" | "models">>;
  readonly ghExecutable?: string;
  readonly pullRequestPort?: CodeOperationPullRequestPort;
  readonly inheritedEnvironment?: Readonly<Record<string, string | undefined>>;
  readonly terminalProcessPort?: Pick<TerminalProcessPort, "start"> & {
    readonly reconcile?: () => Promise<void>;
  };
  readonly acpTerminalConfinement?: CodeAcpTerminalConfinement;
  readonly acpPathPort?: CodeTestSourcePort;
  readonly repositoryTestProcessPort?: ProcessTestPort;
  /**
   * Discovery of the definitions a checkout offers. A run is authorized against
   * it, so the runtime always has one; the option exists so a host can share
   * the instance it already built for the listing surface.
   */
  readonly repositoryTestDiscovery?: Pick<RepositoryTestDiscoveryService, "discover">;
  readonly gitObservationPort?: Pick<GitObservationPort, "observe"> &
    Partial<
      Pick<GitObservationPort, "observeRemotes" | "readDiff" | "readTreeChanges" | "readTreeDiff">
    >;
  readonly gitMutationPort?: Pick<
    GitMutationPort,
    | "stage"
    | "unstage"
    | "discard"
    | "commit"
    | "push"
    | "revertCommit"
    | "snapshotWorkingTree"
    | "restoreWorkingTree"
    | "releaseCheckpoint"
  > &
    Partial<Pick<GitMutationPort, "applyHunks" | "remoteHead">>;
  readonly supportsAppManagedTools?: (thread: CodeThread) => boolean;
  readonly supportsAcpClientCapabilities?: (thread: CodeThread) => boolean;
  /**
   * Whether the thread's provider can carry its native session on to another
   * of its models. A host that cannot say so answers false, and a turn whose
   * model differs from its session's is refused as before.
   */
  readonly supportsModelSwitch?: (thread: CodeThread) => boolean;
  /**
   * Whether the thread's provider reports it can cut its own session back
   * (`sessionRollback`), which a rewind's preview names. A host that cannot
   * say so previews a rewind as continuing with a text handoff.
   */
  readonly supportsSessionRollback?: (thread: CodeThread) => boolean;
  /**
   * Whether the thread's session is being compacted. A turn is refused
   * meanwhile: it would resume the session the runtime is rewriting.
   */
  readonly compactionRunning?: (threadId: CodeThreadId) => boolean;
  /**
   * The thread's context ledger, for compactions a turn's runtime makes by
   * itself: each one is journaled there, and any compaction journaled since
   * the previous turn's usage report leaves Octant's earlier per-turn context
   * uncounted in the next turn's window breakdown.
   */
  readonly sessionCompactions?: {
    readonly record: (input: {
      readonly threadId: CodeThreadId;
      readonly turnKey: string;
      readonly sighting: AutomaticCompactionSighting;
      readonly executor: Extract<ContextCompactionExecutor, { readonly kind: "runtime" }>;
      readonly priorOccupancy?: { readonly tokens: number; readonly observedAt: string };
    }) => void;
    /** Whether the ledger records a compaction after this journal position. */
    readonly compactedAfter: (threadId: CodeThreadId, globalSequence: number) => boolean;
  };
  /**
   * Reads the thread's own earlier conversation for a provider-switch handoff,
   * through the bounded selector a child's parent context uses. Absent means
   * this host cannot hand a conversation over, so a turn on a provider other
   * than its session's is refused, naming that reason.
   */
  /**
   * The summary the limit rule wrote with the thread's earlier provider, when
   * it still covers the thread's conversation; a provider switch leads with it.
   */
  readonly handoverSummary?: (
    thread: CodeThread,
  ) => { readonly content: string; readonly completedAt: string } | undefined;
  readonly providerSwitchContext?: (input: {
    readonly thread: CodeThread;
    readonly excludeOperationId: CodeOperationId;
    /** Why the previous session is left behind; the receiving model is told which. */
    readonly purpose?: "provider-switch" | "rewind";
    /**
     * For a forked thread, the source it inherited its conversation from,
     * already authorized for the window sending the turn, read through the
     * fork point ahead of the thread's own turns.
     */
    readonly inheritedFrom?: {
      readonly source: CodeThread;
      readonly throughOperationId: string;
    };
  }) => AgentRunParentContextSelection;
  /**
   * Whether the thread's provider can take an image. A host that cannot say so
   * answers false: a turn that attached images then fails in words rather than
   * reaching the provider with the pictures silently dropped.
   */
  readonly supportsAttachments?: (thread: CodeThread) => boolean;
  readonly routineBrowserTools?: (input: {
    readonly thread: CodeThread;
    readonly readThread: () => CodeThread | undefined;
    readonly routineRun: AutomationRunReference;
  }) => AppManagedToolSet | undefined;
  readonly browserAutomation?: CodeAppManagedToolsOptions["browser"];
  readonly browserProfiles?: CodeAppManagedToolsOptions["browserProfiles"];
  /** The Project's Browser flows and the recorder; see the Code Browser tool. */
  readonly browserFlows?: CodeAppManagedToolsOptions["browserFlows"];
  /**
   * Whether an origin already holds a remembered "always allow" grant. Read
   * live so a grant forgotten in Settings stops satisfying it at once.
   */
  readonly isBrowserOriginRemembered?: (origin: string) => boolean;
  /** The Browser approvals a sign-in handoff asks through; see the Code tools. */
  readonly browserSignIn?: CodeAppManagedToolsOptions["browserSignIn"];
  /** Who may not be asked to save a download: a paired device. */
  readonly browserDownloadRefusal?: (windowId: WindowId) => string | undefined;
  /** The app-managed Apple capability, when this host has an Apple toolchain. */
  readonly appleToolchain?: CodeAppManagedToolsOptions["apple"];
  /** The app-managed Android emulator capability. */
  readonly androidToolchain?: CodeAppManagedToolsOptions["android"];
  /**
   * The planner capability: a Project-board read and an advisory work
   * proposal, both answered only for the Project's designated planner thread.
   * The runtime hands it to the threads tool (`board`) and the side-task tool
   * (target `board`) of each turn.
   */
  readonly planner?: CodePlannerToolPort;
  /** Optional Project-fixed, read-only GitHub tools composed per active turn. */
  readonly githubReadTools?: (input: {
    readonly windowId: WindowId;
    readonly thread: CodeThread;
    readonly readThread: (windowId: WindowId, threadId: CodeThreadId) => CodeThread | undefined;
  }) => AppManagedToolSet | undefined;
  /**
   * The threads tool for one turn: a view of the other Code threads of this
   * thread's Project, messaging them where the host admits it, and the
   * planner's board. Asked once per turn, so its read and wait bounds are the
   * turn's. `readPosture` is the turn's access posture at the moment it is
   * asked, so a turn in Plan is neither offered messaging nor able to send.
   */
  readonly threads?: (input: {
    readonly windowId: WindowId;
    readonly thread: CodeThread;
    readonly readPosture: () => CodeThread["executionPolicy"];
    readonly planner?: CodePlannerToolPort;
  }) => AppManagedToolSet | undefined;
  /**
   * Lets the model offer out-of-scope work as a side task the person may
   * start, and the designated planner offer one to the Project board.
   */
  readonly sideTasks?: (input: {
    readonly windowId: WindowId;
    readonly thread: CodeThread;
    /** The operation the tools serve; an offer names it as its turn. */
    readonly operationId: string;
    readonly planner?: CodePlannerToolPort;
  }) => AppManagedToolSet | undefined;
  /**
   * Tool sets that areas built after this runtime add to each turn, such as
   * the language server's reads. `readThread` is the thread as the turn's
   * window sees it when a call runs, the running turn's posture included.
   * `folders` are the turn's checkout root and extra folders, for a set that
   * is offered only where it can answer for their files.
   */
  readonly contributedTools?: (input: {
    readonly windowId: WindowId;
    readonly thread: CodeThread;
    readonly readThread: () => CodeThread | undefined;
    readonly folders: ReadonlyArray<string>;
    /** The routine run this turn was started for, from the dispatcher only. */
    readonly routineRun?: AutomationRunReference;
  }) => AppManagedToolSet | undefined;
  /** Lets the model author a Canvas bound to this thread's checkout. */
  readonly canvas?: (input: {
    readonly windowId: WindowId;
    readonly thread: CodeThread;
  }) => AppManagedToolSet | undefined;
  /**
   * The agent-run tool set for this thread: the model petitions the server's
   * own run admission for a child run, scoped to this thread as the parent.
   */
  readonly agents?: (input: {
    readonly windowId: WindowId;
    readonly thread: CodeThread;
  }) => AppManagedToolSet | undefined;
  /**
   * The native harness tool set for a direct-endpoint provider: reads, edits,
   * the sandboxed shell, and the harness's own reads, each authorized at the
   * server choke point. Absent for providers that bring their own tools.
   */
  readonly nativeHarnessTools?: (input: {
    readonly thread: CodeThread;
    readonly checkoutRoot: string;
    readonly extraFolders?: ReadonlyArray<string>;
    readonly windowId: WindowId;
    /** The turn's resolved credential values, which a journal read redacts. */
    readonly secrets: ReadonlyArray<string>;
  }) => AppManagedToolSet | undefined;
  /**
   * A turn of a thread in a server Project: the native harness's tools with
   * its file tools and shell on the server, or why the thread cannot run
   * there. Undefined means the thread is not a server Project's (a thread the
   * retired SSH target build left), which runs nothing.
   */
  /** Whether a thread runs in a server Project, on the checkout that Project derives. */
  readonly holdsServerThread?: (thread: CodeThread) => boolean;
  /** The login a server thread's terminal opens on its server. */
  readonly serverTerminalLogin?: CodeOperationServiceOptions["serverTerminalLogin"];
  /** Git on a server thread's server, for its Git panel. */
  readonly serverGit?: (thread: CodeThread) => GitService | undefined;
  /** The Tests panel on a server thread's server. */
  readonly serverRepositoryTests?: CodeOperationServiceOptions["serverRepositoryTests"];
  readonly serverCodeTurn?: (input: {
    readonly thread: CodeThread;
    readonly windowId: WindowId;
    readonly secrets: ReadonlyArray<string>;
  }) =>
    | { readonly status: "bound"; readonly tools: AppManagedToolSet }
    | { readonly status: "refused"; readonly message: string }
    | undefined;
  readonly spendCeiling?: {
    readonly admit: SpendCeilingService["admit"];
    readonly settle: SpendCeilingService["settle"];
  };
  /** The harness around a turn: stable instructions in front, the reply observed after. */
  /**
   * The person-memory block for this thread's turn, or undefined when the
   * turn gets none (memory off, the thread or its Project kept out, or a
   * principal other than a window on this host).
   */
  readonly personMemoryBlock?: (input: {
    readonly thread: CodeThread;
    readonly windowId: WindowId;
  }) => string | undefined;
  /**
   * The active Project memory entries this thread's turn carries, as a Chat
   * or Work turn in the Project does. Absent gives none.
   */
  readonly projectMemoryEntries?: (thread: CodeThread) => ReadonlyArray<string>;
  /**
   * The Project's design system as this turn should see it, read from the
   * folder the runtime works in (a worktree carries its own `DESIGN.md`).
   * Absent, or undefined, gives none.
   */
  readonly designSystemContext?: (input: {
    readonly thread: CodeThread;
    readonly root: string;
    readonly extraFolders: ReadonlyArray<string>;
  }) => Promise<DesignSystemTurnContext | undefined>;
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
    /** Settles a harness question the person answered through the Code question surface. */
    readonly answerQuestion?: (
      threadId: string,
      questionId: string,
      answer: string,
    ) => void | "answered" | "question-not-found" | "already-settled" | "invalid-answer";
  };
  readonly recordExternalContentIngestion?: CodeAppManagedToolsOptions["recordExternalContentIngestion"];
  /** Marks a thread whose runtime read outside content with its own tools. */
  readonly outsideContentMarks?: RuntimeOutsideContentMarking;
  /** Journals the pushes and pull-request changes a runtime's own shell starts. */
  readonly forgeChanges?: RuntimeForgeChangeObserver;
  /**
   * Reads whether a thread has ingested untrusted external content. Used to
   * clamp harness-delegated approvals back to user-answered prompts when taint
   * is present. Absent means no taint reader is available, so
   * delegation is never enabled.
   */
  readonly readThreadExternalContentTaint?: (threadId: CodeThreadId) => {
    readonly externalContentIngested: boolean;
  };
  /**
   * Octant Shield, which answers a provider's approval prompts before the
   * person is asked when it is the thread's reviewer at Auto. Absent, or
   * answering nothing for a thread, every prompt goes to the person.
   */
  readonly shield?: ShieldReviewPort;
  /**
   * The person's Auto reviewer for a thread (its Project's, else Settings').
   * Octant Shield chosen means the provider's own reviewer stays off, so its
   * prompts reach Octant.
   */
  readonly chosenAutoReviewer?: (thread: CodeThread) => AutoReviewer | undefined;
  /**
   * Resolves the cached provider capabilities for a thread's provider, so the
   * runtime can check `harnessAutoReview` without re-probing on every turn.
   * Absent means capabilities are unknown, so delegation is never enabled.
   */
  readonly resolveProviderCapabilities?: (thread: CodeThread) => ProviderCapabilities | undefined;
  /**
   * What the next session of this thread may load of the provider's own
   * setup, from the account's switch, the Project's trust, and the thread's
   * level. Absent keeps every native feature off.
   */
  readonly resolveProviderNativeSetup?: (thread: CodeThread) => ProviderNativeSetup | undefined;
  /** Reads the `#thread` mentions a turn names, on that turn's own principal. */
  readonly resolveThreadMentionContext?: CodeOperationServiceOptions["resolveThreadMentionContext"];
  readonly resolveSideChatReturns?: CodeOperationServiceOptions["resolveSideChatReturns"];
  /** Reads the `@file` mentions a turn names against this thread's bound root. */
  readonly resolveFileMentionContext?: CodeOperationServiceOptions["resolveFileMentionContext"];
  /** Takes the notes the user pointed at the running product into the next turn. */
  readonly takeProductFeedbackForTurn?: CodeOperationServiceOptions["takeProductFeedbackForTurn"];
  readonly takeIssueContextFramed?: CodeOperationServiceOptions["takeIssueContextFramed"];
  readonly peekIssueContextFramed?: CodeOperationServiceOptions["peekIssueContextFramed"];
  readonly consumeIssueContextFramed?: CodeOperationServiceOptions["consumeIssueContextFramed"];
  /** Reads the agent messages waiting for a thread into its next turn. */
  readonly carryAgentMessages?: CodeOperationServiceOptions["carryAgentMessages"];
  readonly isCoordinatorThread?: CodeOperationServiceOptions["isCoordinatorThread"];
  readonly coordinatorContext?: CodeOperationServiceOptions["coordinatorContext"];
  /** Records that a provider has accepted the turn carrying those messages. */
  readonly confirmAgentMessagesDelivered?: CodeOperationServiceOptions["confirmAgentMessagesDelivered"];
  /**
   * The Project checkout a run comes home to. The host resolves the path; this
   * runtime observes its branch and cleanliness itself, so the merge gate reads
   * the checkout as it stands rather than as the caller last saw it.
   */
  readonly resolveBaseCheckoutRoot?: (thread: CodeThread) => Promise<string | undefined>;
  /**
   * Reads a fork's source conversation through the fork point for a text
   * handoff, through the selector a provider switch uses. Absent means this
   * host cannot carry a conversation into a fork, so a fork's first turn that
   * cannot take up the source's own session is refused, naming that reason.
   */
  readonly forkContext?: CodeForkConversationReader;
  /**
   * Reads a fork's own turns for a merge back into the thread it was forked
   * from, through the same selector. Absent means this host cannot merge a
   * fork's conversation back, so a merge is refused as unsupported.
   */
  readonly forkMergeBackContext?: CodeForkMergeBackReader;
  /**
   * Starts a fork's first provider session from the source's own
   * conversation through the fork point, returning the cursor that resumes
   * it. Undefined when the provider cannot take that up exactly, in which
   * case the fork reads the source's history as text instead.
   */
  readonly forkProviderSession?: (input: {
    readonly fork: CodeThread;
    readonly origin: NonNullable<CodeThread["forkedFrom"]>;
    readonly sessionId: ProviderSessionId;
    readonly checkoutRoot: string;
    readonly secrets: ReadonlyArray<string>;
  }) => Promise<ProviderResumeCursor | undefined>;
  readonly resolveProfileSkills?: CodeOperationServiceOptions["resolveProfileSkills"];
  readonly resolveSelectedExtensions?: CodeOperationServiceOptions["resolveSelectedExtensions"];
  readonly pinnedExtensionIds?: CodeOperationServiceOptions["pinnedExtensionIds"];
  /**
   * Where a curated scaffold runs. Absent on a host that offers none, which
   * refuses the operation rather than running a generator nobody configured.
   */
  readonly scaffoldProcess?: {
    readonly execute: ProcessTestPort["execute"];
    /** Variables the generator needs, notably where to keep its package cache. */
    readonly environment: Readonly<Record<string, string>>;
  };
}

export interface CodeOperationRuntime {
  readonly ownerApprovals?: () => ReadonlyArray<RuntimeApprovalRecovery>;
  readProviderFileReview?(
    windowId: WindowId,
    request: CodeProviderFileReviewRequest,
    current: () => boolean,
    signal?: AbortSignal,
  ): Promise<CodeProviderFileReviewRead>;
  execute(
    windowId: WindowId,
    command: unknown,
    options?: CodeOperationExecuteOptions,
  ): Promise<CodeOperationResult>;
  inspectTerminal(
    windowId: WindowId,
    input: import("@octant/contracts").CodeTerminalInspectionRequest,
  ): Promise<import("@octant/contracts").CodeTerminalInspection>;
  /**
   * Follow a terminal's output live, outside the journal. The authority check
   * runs before the stream exists, so a refusal still has a status to become.
   */
  watchTerminal(
    windowId: WindowId,
    input: import("@octant/contracts").CodeTerminalLiveRequest & {
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<AsyncIterable<import("@octant/contracts").CodeTerminalLiveFrame>>;
  /** End the live output streams a window holds, because its capability was revoked. */
  revokeTerminalStreams(windowId: WindowId): void;
  subscribe(
    windowId: WindowId,
    threadId: CodeThreadId,
    operationId: CodeOperationId,
    afterCursor: number,
    limit: number,
  ): Promise<readonly import("@octant/contracts").CodeOperationEventFrame[]>;
  readRepositoryTestStatus(
    windowId: WindowId,
    threadId: CodeThreadId,
    checkoutId: import("@octant/contracts").CodeCheckoutId,
  ): Promise<import("@octant/contracts").CodeRepositoryTestStatus>;
  conversation(
    windowId: WindowId,
    threadId: CodeThreadId,
    afterCursor: number,
    limit: number,
  ): Promise<CodeConversationPage>;
  /**
   * One page of the thread's own turns, newest first in reading order, under
   * the same two checks as the forward read. A refused anchor is a value: the
   * client starts again from the newest page.
   */
  conversationWindow(
    windowId: WindowId,
    threadId: CodeThreadId,
    request: CodeConversationWindowRequest,
  ): Promise<CodeConversationWindowRead>;
  /**
   * Merge a fork's conversation back into the thread it was forked from, for
   * that thread's next turn to carry. Refusals are values.
   */
  mergeForkContext?(
    windowId: WindowId,
    forkThreadId: CodeThreadId,
    throughOperationId: string,
    contextInputPolicy?: ConversationInputPolicy,
  ): Promise<CodeForkMergeBackOutcome>;
  /** The files a fork of `source` at `throughOperationId` starts from. */
  forkPoint(
    windowId: WindowId,
    source: CodeThread,
    throughOperationId: string,
  ): Promise<CodeForkPoint>;
  readEvidence(
    windowId: WindowId,
    threadId: CodeThreadId,
    operationId: CodeOperationId,
    contentId: CodeEvidenceContentId,
    admissionCurrent?: () => boolean,
  ): Promise<{ readonly bytes: Uint8Array; readonly digest: string; readonly byteLength: number }>;
  readEvidenceBatch?(
    windowId: WindowId,
    input: CodeEvidenceBatchRequest,
    admissionCurrent?: () => boolean,
  ): Promise<CodeEvidenceBatchResponse>;
  prepareApproval(
    windowId: WindowId,
    request: CodeOperationApprovalRequest,
  ): Promise<CodeOperationApprovalChallenge | undefined>;
  confirmApproval(
    windowId: WindowId,
    confirmation: CodeOperationApprovalConfirmation,
  ): Promise<CodeOperationApprovalReceipt | undefined>;
  cancelApproval?(windowId: WindowId, confirmation: CodeOperationApprovalConfirmation): void;
  validateAppleApproval(windowId: WindowId, request: AppleActionRequest): Promise<boolean>;
  validateAndroidApproval(windowId: WindowId, request: AndroidEmulatorRequest): Promise<boolean>;
  /** Whether a person at this window confirmed exactly this device lease. */
  revokeApprovals(windowId: WindowId): void;
  /**
   * Shows a native-harness question on the thread's running turn so it is
   * answered through the same inline surface as a provider's own question.
   * False when the thread has no running turn.
   */
  raiseHarnessQuestion?(input: {
    readonly threadId: string;
    readonly questionId: string;
    readonly questionnaire?: Questionnaire;
    readonly prompt: string;
    readonly options: ReadonlyArray<string>;
  }): boolean;
  /**
   * Takes a native-harness question off the thread's inline surface once the
   * harness has settled it some other way (an answer from another surface,
   * expiry, or cancellation), so it is no longer listed or answerable here.
   */
  withdrawHarnessQuestion?(input: { readonly threadId: string; readonly questionId: string }): void;
  /**
   * Every approval and question a running turn is waiting on that this window
   * could answer through `execute`, under the same scope those answers pass.
   */
  pendingRequests?(windowId: WindowId): Promise<ReadonlyArray<PendingRequest>>;
  /** Whether this window's `start-provider-turn` would pass its scope on the thread's checkout. */
  admitsTurn?(windowId: WindowId, thread: Pick<CodeThread, "id" | "checkoutId">): Promise<boolean>;
  /**
   * Whether the thread's running turn waits on an approval or a question that
   * `pendingRequests` would list. It ends the moment the answer is taken, so
   * the board moves the thread back to In progress on the same read that sees
   * the request gone.
   */
  turnAwaitsPerson?(threadId: string): boolean;
  /** Shows one Octant Shield decision on the thread's running turn. */
  recordShieldReview?(input: {
    readonly threadId: string;
    readonly summary: string;
    readonly decision: ShieldDecision;
  }): void;
  /**
   * Settles as interrupted every provider turn of the thread that a host
   * restart left reading running or waiting, when nothing is running it now.
   * The harness session lifts its recovery by settling the same cut-off turn
   * on its side; this is the transcript's half, so the turn shows how it ended
   * instead of waiting for a person who can no longer answer it.
   */
  settleCutOffTurns?(threadId: string): void;
  /**
   * The thread as its running turn may use it: a turn keeps the posture it
   * started under, so a later wider grant does not reach its tool calls.
   */
  threadWithActiveTurnPosture?(
    thread: import("@octant/contracts").CodeThread,
  ): import("@octant/contracts").CodeThread;
  /**
   * Whether a turn on the thread is being prepared, runs, or waits on the
   * person. A compaction is refused meanwhile.
   */
  turnInProgress?(threadId: string): boolean;
  /**
   * The provider session a compaction of the thread resumes: the one its next
   * turn would resume, in the checkout that turn would run in.
   */
  readonly compactionSessions?: {
    /** Whether the thread has such a session. Reads stored facts only. */
    readonly exists: (threadId: string) => boolean;
    /** How full its window was at the thread's latest usage report, and when. */
    readonly occupancy: (
      threadId: string,
    ) =>
      | { readonly tokens: number; readonly observedAt: string; readonly contextWindow?: number }
      | undefined;
    /**
     * How to open it, under the asking window's authority over the thread's
     * checkout; undefined when that window may not, or the session is gone.
     */
    readonly open: (
      threadId: string,
      windowId: WindowId | undefined,
    ) => Promise<
      { readonly acquire: ProviderAcquireInput; readonly resume: ProviderSessionResume } | undefined
    >;
  };
  close(): Promise<void>;
  reconcile?: () => Promise<void>;
  /**
   * The host's terminals, shared with Project terminals so one receipt store,
   * one reconcile, and one shutdown cover every shell the host started.
   */
  readonly terminals?: TerminalService;
}

export function createCodeOperationRuntime(
  options: CodeOperationRuntimeOptions,
): CodeOperationRuntime {
  /** Each start's spend reservation, under the start's own operation. */
  const spendReservations = new Map<string, ReturnType<typeof decodeSpendCeilingReservationId>>();
  const events = new CodeOperationEventStore({
    journal: options.persistence.journal,
    actor: options.actor,
    clock: options.clock,
    uuid: options.uuid,
  });
  const runtimeWork = new CodeRuntimeWorkRecorder({
    journal: options.persistence.journal,
    readVersion: options.persistence.readCodeRuntimeWorkAggregateVersion,
    actor: options.actor,
    clock: options.clock,
    uuid: options.uuid,
  });
  const reportRuntimeWorkFailure =
    options.reportRuntimeWorkFailure ??
    ((failure: CodeRuntimeWorkRecordFailure) => {
      console.warn(`Code runtime work record ${failure.kind}.`);
    });
  const observeRuntimeWorkOutcome = (outcome: CodeRuntimeWorkRecordOutcome): void => {
    if (outcome.status !== "failed") return;
    try {
      reportRuntimeWorkFailure(outcome);
    } catch {
      // Diagnostics must never replace the operation result they describe.
    }
  };
  const roots = new Map<
    string,
    Awaited<ReturnType<CodeOperationAuthorityPort["resolveCheckoutRoot"]>>
  >();
  const authority: CodeOperationAuthorityPort = {
    readThread: (threadId) => options.persistence.readCodeThread(threadId),
    effectiveThread: (windowId, thread) =>
      options.sessionAuthority?.effectiveThread(windowId, thread) ?? thread,
    readCheckout: (checkoutId) => options.persistence.readCodeCheckout(checkoutId),
    canAccessProject: options.windowAccess.canAccessProject,
    ...(options.windowAccess.currentProjectAccess === undefined
      ? {}
      : { currentProjectAccess: options.windowAccess.currentProjectAccess }),
    ...(options.windowAccess.retainProjectAccess === undefined
      ? {}
      : { retainProjectAccess: options.windowAccess.retainProjectAccess }),
    approvalContextDigest: async (_windowId, command, thread, checkout) => {
      const context = await approvalContext(options, command, thread, checkout);
      return context === undefined ? undefined : approvalContextDigest(context);
    },
    resolveCheckoutRoot: async (windowId, thread, checkout) => {
      const resolved = await options.resolveCheckoutRoot(windowId, thread, checkout);
      const folders = extraFoldersOf(thread.projectId);
      const root =
        resolved === undefined || folders.length === 0
          ? resolved
          : { ...resolved, extraFolders: folders };
      roots.set(String(thread.id), root);
      return root;
    },
  };
  const approvalStore =
    options.approvalValidator === undefined
      ? (options.approvalStore ??
        new CodeOperationApprovalStore({
          uuid: options.uuid,
          now: () => Date.parse(options.clock()),
        }))
      : undefined;
  const approvalValidator = options.approvalValidator ?? approvalStore;

  const terminalProcessPort = options.terminalProcessPort ?? new TerminalProcessPort();
  const terminal = new TerminalService({
    port: terminalProcessPort,
    inheritedEnvironment: options.inheritedEnvironment ?? process.env,
    credentials: {
      resolve: async (reference) => {
        const hostCredential = async (hostReference: string) => {
          const value = await options.credentialResolver.resolve(hostReference);
          if (value === undefined) throw new Error("Credential is unavailable.");
          return value;
        };
        return options.terminalBrowserGrants === undefined
          ? hostCredential(reference)
          : options.terminalBrowserGrants.resolveCredential(reference, hostCredential);
      },
    },
  });
  const testProcess = options.repositoryTestProcessPort ?? new RepositoryTestProcessPort();
  const testRunner = new RepositoryTestRunner({
    execute: (input, signal) => testProcess.execute(input, signal),
    readArtifact: (input) => testProcess.readArtifact(input),
    now: options.clock,
    newId: options.uuid,
  });
  const activeTests = new Map<
    string,
    Readonly<{
      threadId: string;
      checkoutId: string;
      controller: AbortController;
      done: Promise<void>;
    }>
  >();
  const testDiscovery = options.repositoryTestDiscovery ?? new RepositoryTestDiscoveryService();
  const extraFoldersOf = (projectId: string | undefined): ReadonlyArray<string> =>
    projectId === undefined
      ? []
      : (options.readProjectExtraFolders?.(projectId as CodeThread["projectId"]) ?? []);
  const repositoryTests = {
    discover: (input: {
      readonly checkoutId: string;
      readonly rootPath: string;
      readonly projectId?: string;
    }) => testDiscovery.discover(input),
    run: async (input: Parameters<CodeOperationServiceOptions["repositoryTests"]["run"]>[0]) => {
      if (activeTests.has(input.runId)) throw new Error("Repository test is already running.");
      const controller = new AbortController();
      let markDone!: () => void;
      const done = new Promise<void>((resolve) => {
        markDone = resolve;
      });
      activeTests.set(input.runId, {
        threadId: input.threadId,
        checkoutId: input.checkoutId,
        controller,
        done,
      });
      try {
        return await testRunner.run({
          ...input,
          extraFolders: extraFoldersOf(input.projectId),
          signal: controller.signal,
        });
      } finally {
        activeTests.delete(input.runId);
        markDone();
      }
    },
    cancel: async (input: { testRunId: string; threadId: string; checkoutId: string }) => {
      const active = activeTests.get(input.testRunId);
      if (
        active === undefined ||
        active.threadId !== input.threadId ||
        active.checkoutId !== input.checkoutId
      ) {
        return false;
      }
      active.controller.abort();
      return true;
    },
  };
  const scaffoldProcess = options.scaffoldProcess;
  const scaffolds =
    scaffoldProcess === undefined
      ? undefined
      : scaffoldRunnerPort(
          new ScaffoldRunner({
            entryExists: scaffoldEntryExists,
            makeDirectory: makeScaffoldDirectory,
            availableTools: () => resolveAvailableTools(curatedScaffoldTools()),
            execute: (input, signal) =>
              scaffoldProcess
                .execute(
                  { ...input, environment: scaffoldProcess.environment },
                  ...(signal === undefined ? [] : [signal]),
                )
                .then((result) => ({
                  termination: result.termination,
                  exitCode: result.exitCode,
                  // A generator narrates on both streams; the user reads one log.
                  output: concatenatedOutput(result.stdout, result.stderr),
                })),
            now: options.clock,
          }),
        );
  const observation = options.gitObservationPort ?? new GitObservationPort();
  const mutation = options.gitMutationPort ?? new GitMutationPort();
  const gitService = new GitService(observation, mutation);
  const git = {
    ...codeOperationGitPort(gitService),
    draft: (input: {
      readonly thread: CodeThread;
      readonly checkoutRoot: string;
      readonly purpose: "commit-message" | "pull-request";
    }) => draftDeliveryText(options, gitService, input),
  } satisfies CodeOperationGitPort;
  const pullRequests = options.pullRequestPort ?? createPullRequestPort(options);
  const reviewFindings = new ReviewFindingService({
    persistence: options.persistence,
    access: options.windowAccess,
    files: {
      ...options.reviewFiles,
      resolveDiff: async (windowId, input) => {
        if (input.anchor === undefined || input.location.kind !== "line") return undefined;
        try {
          return await service.resolveReviewTarget(windowId, {
            threadId: input.threadId,
            checkoutId: input.checkoutId,
            reviewOperationId: input.anchor.reviewOperationId,
            ...(input.anchor.revision.kind === "turn-capture"
              ? { captureCursor: input.anchor.revision.captureCursor }
              : {}),
            path: input.path,
            side: input.anchor.side,
            line: input.location.line,
          });
        } catch {
          return undefined;
        }
      },
    },
    uuid: options.uuid,
    clock: options.clock,
  });
  const startingTurns = new Map<string, number>();
  const holdStartingTurn = (threadId: string) => {
    startingTurns.set(threadId, (startingTurns.get(threadId) ?? 0) + 1);
  };
  const releaseStartingTurn = (threadId: string) => {
    const remaining = (startingTurns.get(threadId) ?? 1) - 1;
    if (remaining === 0) startingTurns.delete(threadId);
    else startingTurns.set(threadId, remaining);
  };
  const turns = new RuntimeTurnController({
    options,
    events,
    roots,
    gitService,
    runtimeWork,
    observeRuntimeWorkOutcome,
    spendReservations,
    approvalStore,
  });
  const authorityForTurn: CodeOperationAuthorityPort = {
    ...authority,
    effectiveThread: (windowId, thread) => {
      const session = authority.effectiveThread?.(windowId, thread) ?? thread;
      return turns.threadWithActiveTurnPosture(session);
    },
  };
  const readRuntimeWorks = options.persistence.readCodeRuntimeWorks;
  const service = new CodeOperationService({
    authority: authorityForTurn,
    ...(readRuntimeWorks === undefined
      ? {}
      : {
          unconfirmedSteps: {
            list: (threadId: CodeThreadId) =>
              readRuntimeWorks(threadId)
                .map((entry) => entry.work)
                .filter((work) => work.state === "ambiguous"),
            settle: (work: CodeRuntimeWork, state: "completed" | "failed") =>
              observeRuntimeWorkOutcome(
                runtimeWork.settleOrphaned({
                  // A push is recorded under its Git operation, a pull request
                  // step under its own operation.
                  id:
                    work.kind === "git"
                      ? decodeCodeGitOperationId(String(work.id))
                      : decodeCodeOperationId(String(work.id)),
                  threadId: work.threadId,
                  kind: work.kind,
                  state,
                }),
              ),
          },
        }),
    ...(options.holdsServerThread === undefined
      ? {}
      : { holdsServerThread: options.holdsServerThread }),
    ...(options.serverTerminalLogin === undefined
      ? {}
      : { serverTerminalLogin: options.serverTerminalLogin }),
    ...(options.serverGit === undefined
      ? {}
      : {
          serverGit: (thread: CodeThread) => {
            const serverGit = options.serverGit?.(thread);
            return serverGit === undefined ? undefined : codeOperationGitPort(serverGit);
          },
        }),
    ...(options.serverRepositoryTests === undefined
      ? {}
      : { serverRepositoryTests: options.serverRepositoryTests }),
    ...(options.isProviderModelAllowed === undefined
      ? {}
      : { isProviderModelAllowed: options.isProviderModelAllowed }),
    ...(options.agentRuns === undefined ? {} : { agentRuns: options.agentRuns }),
    onScopedOperation: ({ command, executeOptions }) => {
      // The service invokes this only after its authoritative scope check and
      // replay lookup, but before approval or the operation side effect. That
      // keeps inaccessible commands out of the durable runtime-work journal
      // while still recording work that waits on approval.
      // Bringing the thread back comes before any runtime-work record: a
      // reset that fails must leave no "running" record behind for a turn
      // that never starts.
      // The host's own limit-recovery dispatch is not the person re-engaging,
      // so it must not wake a snooze or reopen a completion the way their
      // turn would; the spent limit-owned snooze goes in the settle instead.
      if (command.kind === "start-provider-turn" && executeOptions?.limitRecovery !== true)
        options.onProviderTurnRequested?.(command.threadId);
      const started = codeRuntimeWorkStarted(command);
      if (started !== undefined)
        observeRuntimeWorkOutcome(
          runtimeWork.open({
            id: started.id,
            threadId: command.threadId,
            kind: started.kind,
            remoteStep: started.remoteStep,
          }),
        );
    },
    ...(approvalValidator === undefined ? {} : { approvals: approvalValidator }),
    ...(options.prepareWorktree === undefined ? {} : { prepareWorktree: options.prepareWorktree }),
    terminals: terminal,
    ...(options.terminalBrowserGrants === undefined
      ? {}
      : { terminalBrowserGrants: options.terminalBrowserGrants }),
    repositoryTests,
    ...(scaffolds === undefined ? {} : { scaffolds }),
    git,
    pullRequests,
    ...(options.standingMergeAllowance === undefined
      ? {}
      : { standingMergeAllowance: options.standingMergeAllowance }),
    ...(options.recordExternalContentIngestion === undefined
      ? {}
      : { recordReviewContent: options.recordExternalContentIngestion }),
    reviewFindings: {
      list: (windowId, threadId) => reviewFindings.list(windowId, threadId),
      create: (windowId, input, admissionCurrent) =>
        reviewFindings.create(windowId, input, admissionCurrent),
      changeState: (windowId, input, admissionCurrent) =>
        reviewFindings.changeState(
          windowId,
          {
            ...input,
            findingId: decodeCodeReviewFindingId(input.findingId),
          },
          admissionCurrent,
        ),
    },
    turns,
    evidence: options.evidence,
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
    ...(options.supportsAttachments === undefined
      ? {}
      : { supportsAttachments: options.supportsAttachments }),
    conversationTurns: (threadId, read) =>
      codeThreadTurns((page) => events.conversation(page), threadId, read),
    ...(options.supportsSessionRollback === undefined
      ? {}
      : { supportsSessionRollback: options.supportsSessionRollback }),
    events,
    ...(options.resolveSideChatReturns === undefined
      ? {}
      : { resolveSideChatReturns: options.resolveSideChatReturns }),
    ...(options.resolveThreadMentionContext === undefined
      ? {}
      : { resolveThreadMentionContext: options.resolveThreadMentionContext }),
    ...(options.resolveFileMentionContext === undefined
      ? {}
      : { resolveFileMentionContext: options.resolveFileMentionContext }),
    ...(options.takeProductFeedbackForTurn === undefined
      ? {}
      : { takeProductFeedbackForTurn: options.takeProductFeedbackForTurn }),
    ...(options.takeIssueContextFramed === undefined
      ? {}
      : { takeIssueContextFramed: options.takeIssueContextFramed }),
    ...(options.peekIssueContextFramed === undefined
      ? {}
      : { peekIssueContextFramed: options.peekIssueContextFramed }),
    ...(options.consumeIssueContextFramed === undefined
      ? {}
      : { consumeIssueContextFramed: options.consumeIssueContextFramed }),
    ...(options.isCoordinatorThread === undefined
      ? {}
      : { isCoordinatorThread: options.isCoordinatorThread }),
    ...(options.coordinatorContext === undefined
      ? {}
      : { coordinatorContext: options.coordinatorContext }),
    ...(options.carryAgentMessages === undefined
      ? {}
      : { carryAgentMessages: options.carryAgentMessages }),
    ...(options.confirmAgentMessagesDelivered === undefined
      ? {}
      : { confirmAgentMessagesDelivered: options.confirmAgentMessagesDelivered }),
    ...(options.resolveBaseCheckoutRoot === undefined
      ? {}
      : {
          resolveBaseCheckout: baseCheckoutResolver(gitService, options.resolveBaseCheckoutRoot),
        }),
    ...(options.resolveSelectedExtensions === undefined
      ? {}
      : { resolveSelectedExtensions: options.resolveSelectedExtensions }),
    ...(options.pinnedExtensionIds === undefined
      ? {}
      : { pinnedExtensionIds: options.pinnedExtensionIds }),
    ...(options.resolveProfileSkills === undefined
      ? {}
      : { resolveProfileSkills: options.resolveProfileSkills }),
  });
  turns.bindService(service);
  /**
   * The session the thread's next turn would resume, with nothing a turn would
   * refuse: the same provider, checkout, and model (or one the provider can
   * carry the session on to), and a cursor to resume from.
   */
  const compactableSession = (threadId: CodeThreadId) => {
    const thread = options.persistence.readCodeThread(threadId);
    if (thread === undefined || thread.lifecycle !== "active") return undefined;
    const recovered = events.providerSessionForThread(thread.id, NO_OPERATION);
    if (recovered.status !== "ok") return undefined;
    const session = recovered.session;
    const resumeCursor = session?.resumeCursor;
    if (
      session === undefined ||
      recovered.rewoundAfterSession !== undefined ||
      resumeCursor === undefined ||
      String(session.providerInstanceId) !== String(thread.providerInstanceId) ||
      String(session.checkoutId) !== String(thread.checkoutId) ||
      (String(session.modelId) !== String(thread.modelId) &&
        options.supportsModelSwitch?.(thread) !== true)
    )
      return undefined;
    return { thread, sessionId: session.sessionId, resumeCursor };
  };

  const fileReviewLeases = new Set<string>();
  const readProviderFileReview = createCodeProviderFileReview({
    host: options,
    source: compactableSession,
    busy: (threadId) =>
      startingTurns.has(threadId) ||
      turns.holdsTurn(threadId) ||
      options.compactionRunning?.(threadId) === true,
    leases: fileReviewLeases,
  });

  return {
    ownerApprovals: () => turns.ownerApprovals(),
    terminals: terminal,
    readProviderFileReview,
    prepareApproval: async (windowId, rawRequest) => {
      if (approvalStore === undefined) return undefined;
      const request = decodeCodeOperationApprovalRequest(rawRequest);
      let approvalEffect = request.effect;
      let thread: CodeThread | undefined;
      let checkout: CodeCheckoutIdentity | undefined;
      let directContext: ApprovalContext | undefined;
      let directPrompt: { readonly message: string; readonly detail: string } | undefined;
      let directThreadTitle: string | undefined;
      if (request.effect.kind === "operation") {
        const { command } = request.effect;
        thread = options.persistence.readCodeThread(command.threadId);
        checkout = options.persistence.readCodeCheckout(command.checkoutId);
        if (
          thread === undefined ||
          checkout === undefined ||
          thread.checkoutId !== checkout.id ||
          thread.repositoryId !== checkout.repositoryId ||
          thread.lifecycle !== "active" ||
          !decidesCodeEffectsByApproval(thread.executionPolicy) ||
          checkout.availability !== "available" ||
          !(await options.windowAccess.canAccessProject(windowId, thread.projectId))
        ) {
          return undefined;
        }
      } else if (request.effect.kind === "apple-action") {
        const resolved = await resolveAppleApprovalScope(options, windowId, request.effect.request);
        thread = resolved?.thread;
        checkout = resolved?.checkout;
      } else if (request.effect.kind === "android-action") {
        const resolved = await resolveAndroidApprovalScope(
          options,
          windowId,
          request.effect.request,
        );
        thread = resolved?.thread;
        checkout = resolved?.checkout;
      } else if (request.effect.kind === "create-thread-full-access") {
        thread = request.effect.thread;
        checkout = options.persistence.readCodeCheckout(thread.checkoutId);
        if (
          checkout === undefined ||
          checkout.repositoryId !== thread.repositoryId ||
          checkout.availability !== "available" ||
          thread.version !== 1 ||
          !(await options.windowAccess.canAccessProject(windowId, thread.projectId))
        ) {
          return undefined;
        }
      } else if (request.effect.kind === "create-managed-code-thread-full-access") {
        const creation = options.managedThreadCreation;
        const command = request.effect.command;
        if (
          creation === undefined ||
          command.approvalId !== undefined ||
          !(await options.windowAccess.canAccessProject(windowId, command.projectId))
        ) {
          return undefined;
        }
        const prepared = await creation.prepare(
          {
            authenticatedWindowId: windowId,
            projectId: command.projectId,
            bindingRevisionId: command.bindingRevisionId,
            threadId: command.threadId,
            branchIntent: command.deliveryTarget.branchIntent,
            sourceBranch: command.sourceBranch,
            startFromOrigin: command.startFromOrigin,
            ...(command.remoteName === undefined ? {} : { remoteName: command.remoteName }),
            ...(command.sourceRevision === undefined
              ? {}
              : { sourceRevision: command.sourceRevision }),
          },
          new AbortController().signal,
        );
        if (prepared.status !== "prepared") return undefined;
        const source = {
          bindingRevisionId: command.bindingRevisionId,
          repositoryId: prepared.preparation.repositoryId,
          checkoutId: prepared.preparation.checkoutId,
          checkoutHead: decodeCodeCheckoutHead({
            kind: "branch",
            name: prepared.preparation.branchIntent,
            oid: prepared.preparation.resolvedHead,
          }),
        };
        if (
          request.effect.source !== undefined &&
          JSON.stringify(request.effect.source) !== JSON.stringify(source)
        ) {
          return undefined;
        }
        approvalEffect = { ...request.effect, source };
        directThreadTitle = command.title;
        directContext = {
          projectId: command.projectId,
          threadId: command.threadId,
          checkoutId: prepared.preparation.checkoutId,
          repositoryId: prepared.preparation.repositoryId,
          checkoutHead: source.checkoutHead,
        };
        directPrompt = {
          message: "Allow full access for this new Code thread?",
          detail: `Create managed worktree from ${source.checkoutHead.kind === "branch" ? source.checkoutHead.name : "detached source"} · ${persistenceLabel(command.permissionPersistence)}`,
        };
      } else {
        thread = options.persistence.readCodeThread(request.effect.threadId);
        checkout =
          thread === undefined
            ? undefined
            : options.persistence.readCodeCheckout(thread.checkoutId);
        if (
          thread === undefined ||
          checkout === undefined ||
          checkout.repositoryId !== thread.repositoryId ||
          checkout.availability !== "available" ||
          thread.lifecycle !== "active" ||
          thread.version !== request.effect.expectedVersion ||
          !(await options.windowAccess.canAccessProject(windowId, thread.projectId))
        ) {
          return undefined;
        }
      }
      if (directContext !== undefined && directPrompt !== undefined) {
        return approvalStore.prepare({
          windowId,
          effect: approvalEffect,
          contextDigest: approvalContextDigest(directContext),
          projectId: directContext.projectId,
          threadId: directContext.threadId,
          threadTitle: directThreadTitle ?? "Code thread",
          checkoutId: directContext.checkoutId,
          repositoryId: directContext.repositoryId,
          checkoutHead: directContext.checkoutHead,
          ...directPrompt,
        });
      }
      if (thread === undefined || checkout === undefined) return undefined;
      const command = approvalEffect.kind === "operation" ? approvalEffect.command : undefined;
      const context = await approvalContext(options, command, thread, checkout);
      if (context === undefined) return undefined;
      let hunkDetail: string | undefined;
      if (
        command?.kind === "stage-git-hunks" ||
        command?.kind === "unstage-git-hunks" ||
        command?.kind === "reverse-git-hunks"
      ) {
        const replay = events.replay({
          threadId: thread.id,
          operationId: command.comparisonOperationId,
          afterCursor: 0,
          limit: 16,
        });
        if (replay.status !== "ok") return undefined;
        const comparison = replay.frames
          .map((frame) =>
            frame.event.kind === "operation-result" ? frame.event.result : undefined,
          )
          .find((result) => result?.kind === "git-hunks");
        if (
          comparison?.kind !== "git-hunks" ||
          comparison.threadId !== thread.id ||
          comparison.checkoutId !== checkout.id ||
          comparison.scope !== (command.kind === "unstage-git-hunks" ? "staged" : "unstaged")
        )
          return undefined;
        const hunks = command.selected.map((id) => comparison.hunks.find((hunk) => hunk.id === id));
        if (hunks.some((hunk) => hunk === undefined)) return undefined;
        hunkDetail = [
          comparison.scope === "staged" ? "HEAD → Index" : "Index → Working tree",
          ...hunks.flatMap((hunk) =>
            hunk === undefined
              ? []
              : [
                  `${hunk.path}: −${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines}`,
                ],
          ),
        ].join("\n");
      }
      const prompt = approvalPrompt(
        approvalEffect,
        thread,
        checkout,
        context.pullRequestTarget,
        hunkDetail,
      );
      return approvalStore.prepare({
        windowId,
        effect: approvalEffect,
        contextDigest: approvalContextDigest(context),
        projectId: thread.projectId,
        threadId: thread.id,
        threadTitle: thread.title,
        checkoutId: checkout.id,
        repositoryId: checkout.repositoryId,
        checkoutHead: checkout.head,
        ...(context.pullRequestTarget === undefined
          ? {}
          : { pullRequestTarget: context.pullRequestTarget }),
        ...prompt,
      });
    },
    confirmApproval: async (windowId, rawConfirmation) => {
      if (approvalStore === undefined) return undefined;
      const confirmation = decodeCodeOperationApprovalConfirmation(rawConfirmation);
      return approvalStore.confirm({ windowId, challengeId: confirmation.challengeId });
    },
    cancelApproval: (windowId, rawConfirmation) => {
      if (approvalStore === undefined) return;
      const confirmation = decodeCodeOperationApprovalConfirmation(rawConfirmation);
      approvalStore.cancel({ windowId, challengeId: confirmation.challengeId });
    },
    validateAppleApproval: async (windowId, request) => {
      if (approvalValidator === undefined || request.approval.kind !== "approved") return false;
      const resolved = await resolveAppleApprovalScope(options, windowId, request);
      if (resolved === undefined) return false;
      const context = await approvalContext(options, undefined, resolved.thread, resolved.checkout);
      if (context === undefined) return false;
      return await approvalValidator.validate({
        windowId,
        effect: { kind: "apple-action", request },
        contextDigest: approvalContextDigest(context),
        approvalId: request.approval.approvalId,
      });
    },
    validateAndroidApproval: async (windowId, request) => {
      if (approvalValidator === undefined || request.approval.kind !== "approved") return false;
      const resolved = await resolveAndroidApprovalScope(options, windowId, request);
      if (resolved === undefined) return false;
      const context = await approvalContext(options, undefined, resolved.thread, resolved.checkout);
      if (context === undefined) return false;
      return await approvalValidator.validate({
        windowId,
        effect: { kind: "android-action", request },
        contextDigest: approvalContextDigest(context),
        approvalId: request.approval.approvalId,
      });
    },
    revokeApprovals: (windowId) => approvalStore?.revokeWindow(windowId),
    execute: async (windowId, rawCommand, executeOptions) => {
      if (process.platform === "win32")
        throw new CodeServiceError(
          decodeCodeFailure({
            category: "unavailable",
            message: "Code execution requires Windows host confinement.",
          }),
        );
      // A turn counts as running for a compaction from the moment it passes the
      // compaction check until it is launched or refused, because it reads the
      // session it resumes while it is prepared.
      let heldStart: string | undefined;
      /** Whether this call took the operation's spend reservation, and so gives it back. */
      let ownsReservation = false;
      try {
        const command = decodeCodeOperationCommand(rawCommand);
        if (command.kind === "start-provider-turn") {
          const thread = options.persistence.readCodeThread(command.threadId);
          // The pause state is the thread's own; a window without Open
          // authority over its Project learns nothing here, not even "paused".
          if (
            thread !== undefined &&
            !(await options.windowAccess.canAccessProject(windowId, thread.projectId))
          ) {
            throw new CodeServiceError(
              decodeCodeFailure({
                category: "unauthorized",
                message: "Code operation is unauthorized.",
              }),
            );
          }
          if (
            thread !== undefined &&
            (options.compactionRunning?.(thread.id) === true ||
              fileReviewLeases.has(String(thread.id)))
          ) {
            throw new CodeServiceError(
              decodeCodeFailure({
                category: "waiting",
                message:
                  options.compactionRunning?.(thread.id) === true
                    ? "This session is being compacted. Send again when it finishes."
                    : "This session's checkpoint is being read. Send again when it finishes.",
              }),
            );
          }
          if (thread !== undefined) {
            heldStart = String(thread.id);
            holdStartingTurn(heldStart);
          }
          if (thread !== undefined && options.isProviderModelAllowed?.(thread) === false) {
            throw new CodeServiceError(
              decodeCodeFailure({
                category: "unauthorized",
                message:
                  "This provider or model is not allowed by this Code Project's provider policy.",
              }),
            );
          }
          if (thread !== undefined && Object.keys(thread.modelOptionValues ?? {}).length > 0) {
            const probe = await options
              .probeProvider?.(thread.providerInstanceId)
              .catch(() => undefined);
            const model = probe?.models.find(
              (candidate) => String(candidate.id) === String(thread.modelId),
            );
            if (
              probe === undefined ||
              (probe.readiness !== "ready" && probe.readiness !== "degraded")
            ) {
              throw new CodeServiceError(
                decodeCodeFailure({
                  category: "unavailable",
                  message:
                    "Selected Code model options cannot be verified. Check the provider before sending.",
                }),
              );
            }
            if (
              model === undefined ||
              unsupportedModelOptionValues(thread.modelOptionValues, model.options).length > 0
            ) {
              throw new CodeServiceError(
                decodeCodeFailure({
                  category: "unsupported",
                  message:
                    "Selected Code model no longer offers these options. Choose an available option before sending.",
                }),
              );
            }
          }
          const admission =
            thread === undefined
              ? undefined
              : options.nativeHarness?.admitTurn?.({
                  threadId: String(thread.id),
                  mode: "code",
                  providerInstanceId: thread.providerInstanceId,
                  modelId: thread.modelId,
                  projectId: thread.projectId,
                });
          if (admission?.kind === "paused") {
            throw new CodeServiceError(
              decodeCodeFailure({
                category: "waiting",
                message: `${admission.status === "paused-by-advisor" ? "The advisor paused this thread" : "This thread is paused"}: ${admission.detail} Resume the harness session to continue.`,
              }),
            );
          }
          // A retry of an operation that still holds its reservation (its first
          // call still preparing, or its turn still live) reserves nothing more;
          // a second reservation under the same operation would replace the
          // first, which then was never given back.
          if (
            thread !== undefined &&
            options.spendCeiling !== undefined &&
            !spendReservations.has(String(command.operationId))
          ) {
            const spendReservationId = decodeSpendCeilingReservationId(options.uuid());
            const spendAdmission = options.spendCeiling.admit({
              reservationId: spendReservationId,
              threadId: String(thread.id),
              threadType: "code-thread",
              projectId: String(thread.projectId),
              turnUpperBoundTokens: WORK_TURN_SAFE_INPUT_TOKENS,
            });
            if (spendAdmission.status === "refused") {
              throw new CodeServiceError(
                decodeCodeFailure({
                  category: "unavailable",
                  message: spendAdmission.refusal.message,
                }),
              );
            }
            spendReservations.set(String(command.operationId), spendReservationId);
            ownsReservation = true;
          }
          turns.noteStart(command);
        }
        // Runtime work is opened by the service after its authoritative scope
        // check, while provider turns outlive this call and are opened by the
        // turn controller itself.
        const observed = codeRuntimeWorkObserved(command);
        try {
          const result = await service.execute(windowId, command, executeOptions);
          if (command.kind === "start-provider-turn") {
            if (result.kind === "provider-turn-state" && result.state === "running") {
              turns.launch(command.threadId);
              // A `running` answered from the journal, for a turn that already
              // ended, leaves no live turn to give back what this call reserved.
              if (ownsReservation && !turns.runsOperation(command.operationId))
                turns.settleSpendReservation(command.operationId);
            } else if (ownsReservation) {
              turns.settleSpendReservation(command.operationId);
            }
          }
          if (observed !== undefined) {
            const state = codeRuntimeWorkStateFrom(command, result);
            if (state !== undefined)
              observeRuntimeWorkOutcome(
                runtimeWork.settle({
                  id: observed.id,
                  threadId: command.threadId,
                  kind: observed.kind,
                  state,
                }),
              );
          }
          return result;
        } catch (error) {
          // A throw is the service refusing or breaking, not the work finishing.
          // The record closes rather than staying open for a unit that will never
          // report again.
          if (command.kind === "start-provider-turn" && ownsReservation) {
            turns.settleSpendReservation(command.operationId);
          }
          if (observed !== undefined)
            observeRuntimeWorkOutcome(
              runtimeWork.settle({
                id: observed.id,
                threadId: command.threadId,
                kind: observed.kind,
                state: "failed",
              }),
            );
          throw error;
        } finally {
          if (command.kind === "start-provider-turn") turns.clearStart(command);
        }
      } finally {
        if (heldStart !== undefined) releaseStartingTurn(heldStart);
      }
    },
    inspectTerminal: async (windowId, input) => {
      const snapshot = await service.readTerminal(windowId, input);
      return { terminalId: input.terminalId, state: snapshot.status };
    },
    watchTerminal: async (windowId, input) => {
      try {
        return await service.watchTerminal(windowId, input);
      } catch (error) {
        throw terminalLiveFailure(error);
      }
    },
    revokeTerminalStreams: (windowId) => service.revokeTerminalStreams(windowId),
    raiseHarnessQuestion: (input) => turns.raiseHarnessQuestion(input),
    withdrawHarnessQuestion: (input) => turns.withdrawHarnessQuestion(input),
    pendingRequests: (windowId) => service.listPendingForWindow(windowId),
    admitsTurn: (windowId, thread) => service.admitsTurn(windowId, thread),
    turnAwaitsPerson: (threadId) => turns.awaitsPerson(threadId),
    recordShieldReview: (input) => turns.recordShieldReview(input),
    settleCutOffTurns: (threadId) => turns.settleCutOffTurns(threadId),
    threadWithActiveTurnPosture: (thread) => turns.threadWithActiveTurnPosture(thread),
    turnInProgress: (threadId) =>
      startingTurns.has(threadId) || turns.holdsTurn(threadId) || fileReviewLeases.has(threadId),
    compactionSessions: {
      exists: (threadId) => compactableSession(decodeCodeThreadId(threadId)) !== undefined,
      occupancy: (threadId) => {
        const found = compactableSession(decodeCodeThreadId(threadId));
        return found === undefined
          ? undefined
          : events.latestWindowOccupancy(found.thread.id, found.sessionId);
      },
      open: async (threadId, windowId) => {
        if (fileReviewLeases.has(threadId)) return undefined;
        if (windowId === undefined) return undefined;
        const found = compactableSession(decodeCodeThreadId(threadId));
        if (found === undefined) return undefined;
        const stored = found.thread;
        if (!(await options.windowAccess.canAccessProject(windowId, stored.projectId)))
          return undefined;
        const checkout = options.persistence.readCodeCheckout(stored.checkoutId);
        // A remote root names a folder on another machine, so a runtime
        // started here would run against that path on this host.
        if (checkout === undefined || checkout.kind === "remote-root") return undefined;
        const root = await options.resolveCheckoutRoot(windowId, stored, checkout);
        if (root === undefined || root === null) return undefined;
        const thread = options.sessionAuthority?.effectiveThread(windowId, stored) ?? stored;
        return {
          acquire: {
            instanceId: thread.providerInstanceId,
            mode: "code",
            projectRoot:
              stored.workingFolderId === undefined
                ? root.checkoutRoot
                : (root.workingDirectory ?? root.checkoutRoot),
            permissionPersistence: thread.permissionPersistence,
          },
          resume: {
            sessionId: found.sessionId,
            resumeCursor: found.resumeCursor,
            // The compaction runs no tool, so it never needs more than the
            // gated posture; a Plan thread stays read-only.
            executionPolicy: thread.executionPolicy === "plan" ? "plan" : "approval-gated",
            modelId: thread.modelId,
            ...(thread.modelOptionValues === undefined ||
            Object.keys(thread.modelOptionValues).length === 0
              ? {}
              : { modelOptionValues: thread.modelOptionValues }),
            tools: [],
          },
        };
      },
    },
    subscribe: (windowId, threadId, operationId, afterCursor, limit) =>
      service.subscribe(windowId, threadId, operationId, afterCursor, limit),
    readRepositoryTestStatus: (windowId, threadId, checkoutId) =>
      service.readRepositoryTestStatus(windowId, threadId, checkoutId),
    conversation: async (windowId, threadId, afterCursor, limit) => {
      const thread = options.persistence.readCodeThread(threadId);
      if (thread === undefined || thread.id !== threadId) {
        throw new CodeOperationServiceError("invalid");
      }
      if (!(await options.windowAccess.canAccessProject(windowId, thread.projectId))) {
        throw new CodeOperationServiceError("unauthorized");
      }
      return events.conversation({
        threadId,
        afterCursor,
        limit,
        providerInstanceId: thread.providerInstanceId,
      });
    },
    conversationWindow: async (windowId, threadId, request) => {
      const thread = options.persistence.readCodeThread(threadId);
      if (thread === undefined || thread.id !== threadId) {
        throw new CodeOperationServiceError("invalid");
      }
      if (!(await options.windowAccess.canAccessProject(windowId, thread.projectId))) {
        throw new CodeOperationServiceError("unauthorized");
      }
      return events.conversationWindow({
        threadId,
        limit: request.limit,
        ...(request.before === undefined ? {} : { before: request.before }),
        ...(request.through === undefined ? {} : { through: request.through }),
        providerInstanceId: thread.providerInstanceId,
      });
    },
    mergeForkContext: (windowId, forkThreadId, throughOperationId, contextInputPolicy) =>
      mergeForkConversation(
        {
          ...(options.conversationInputTransfer === undefined
            ? {}
            : { conversationInputTransfer: options.conversationInputTransfer }),
          read: options.forkMergeBackContext,
          readThread: (id) => options.persistence.readCodeThread(id),
          canAccessProject: (id, projectId) => options.windowAccess.canAccessProject(id, projectId),
          forkTurns: (id) => codeThreadTurns((page) => events.conversation(page), id),
          events,
          putEvidence: (content) => options.evidence.put(content),
          ...(options.recordExternalContentIngestion === undefined
            ? {}
            : { recordExternalContentIngestion: options.recordExternalContentIngestion }),
          uuid: options.uuid,
        },
        {
          windowId,
          forkThreadId,
          throughOperationId,
          ...(contextInputPolicy === undefined ? {} : { contextInputPolicy }),
        },
      ),
    forkPoint: async (windowId, source, throughOperationId) => {
      if (!(await options.windowAccess.canAccessProject(windowId, source.projectId))) {
        return { status: "refused", reason: "unavailable" };
      }
      // A fork starts from files this host's Git captured. A remote root's
      // path names a folder on another machine, and on this host either
      // nothing or an unrelated folder of the same name, so no capture runs.
      if (options.persistence.readCodeCheckout(source.checkoutId)?.kind === "remote-root") {
        return { status: "refused", reason: "unavailable" };
      }
      const turns = codeThreadTurns((page) => events.conversation(page), source.id, {
        includeRewound: true,
      });
      const shown = codeThreadTurns((page) => events.conversation(page), source.id);
      if (turns === undefined || shown === undefined)
        return { status: "refused", reason: "not-found" };
      const choice = chooseCodeForkPoint(
        turns,
        throughOperationId,
        new Set(shown.map((turn) => String(turn.operationId))),
      );
      if (choice.kind === "refused") return { status: "refused", reason: choice.reason };
      if (choice.kind === "checkpoint") return forkPointFrom(choice.checkpoint);
      // The named turn is the newest: the checkout as it stands now is its result.
      const checkout = options.persistence.readCodeCheckout(source.checkoutId);
      if (checkout === undefined || checkout.availability !== "available") {
        return { status: "refused", reason: "unavailable" };
      }
      const capture = git.checkpoint;
      if (capture === undefined) return { status: "refused", reason: "unavailable" };
      const root = await authority.resolveCheckoutRoot(windowId, source, checkout);
      if (root === undefined) return { status: "refused", reason: "unavailable" };
      const captured = await capture({
        checkoutId: String(checkout.id),
        checkoutRoot: root.checkoutRoot,
        // Capturing writes only Git objects, which a Plan thread's own posture
        // would refuse; the person asking for the fork is what authorizes it.
        executionPolicy: mayWriteToRepository(source.executionPolicy)
          ? source.executionPolicy
          : "approval-gated",
      }).catch(() => undefined);
      return captured?.status === "captured"
        ? forkPointFrom(captured.snapshot)
        : { status: "refused", reason: "unavailable" };
    },
    readEvidence: async (windowId, threadId, operationId, contentId, admissionCurrent) => {
      try {
        const evidence = await service.readEvidence(
          windowId,
          threadId,
          operationId,
          contentId,
          admissionCurrent,
        );
        const bytes = new TextEncoder().encode(evidence.text);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (
          bytes.byteLength !== evidence.reference.byteLength ||
          digest !== evidence.reference.digest
        ) {
          throw new Error("verification failed");
        }
        return { bytes, digest, byteLength: bytes.byteLength };
      } catch (error) {
        throw codeEvidenceReadFailure(error);
      }
    },
    readEvidenceBatch: async (windowId, input, admissionCurrent) => {
      try {
        return decodeCodeEvidenceBatchResponse({
          threadId: input.threadId,
          items: await service.readEvidenceBatch(
            windowId,
            input.threadId,
            input.items,
            admissionCurrent,
          ),
        });
      } catch (error) {
        throw codeEvidenceReadFailure(error);
      }
    },
    close: async () => {
      const pendingTests = service.cancelPendingRepositoryTests();
      const tests = [...activeTests.values()];
      for (const test of tests) test.controller.abort();
      await Promise.allSettled([pendingTests, ...tests.map((test) => test.done)]);
      await turns.closeAll();
      await terminal.closeAll();
    },
    reconcile: async () => {
      await Promise.all([
        terminalProcessPort.reconcile?.() ?? Promise.resolve(),
        testProcess.reconcile?.() ?? Promise.resolve(),
      ]);
    },
  };
}

function terminalLiveFailure(error: unknown): Error {
  const category =
    error instanceof CodeOperationServiceError ? error.category : ("unavailable" as const);
  return Object.assign(new Error("Terminal output is unavailable."), {
    failure: {
      category,
      message:
        category === "unauthorized"
          ? "Terminal output is unauthorized."
          : "Terminal output is unavailable.",
    },
  });
}

function codeEvidenceReadFailure(error: unknown): Error {
  const category =
    error instanceof CodeOperationServiceError ? error.category : ("unavailable" as const);
  return Object.assign(new Error("Code operation evidence is unavailable."), {
    failure: {
      category,
      message:
        category === "unauthorized"
          ? "Code operation evidence is unauthorized."
          : "Code operation evidence is unavailable.",
    },
  });
}

interface ApprovalContext {
  readonly projectId: CodeThread["projectId"];
  readonly threadId: CodeThread["id"];
  readonly checkoutId: CodeCheckoutIdentity["id"];
  readonly repositoryId: CodeCheckoutIdentity["repositoryId"];
  readonly checkoutHead: CodeCheckoutIdentity["head"];
  readonly pullRequestTarget?: Readonly<{
    baseRepository: string;
    baseBranch: string;
    head: string;
  }>;
}

async function approvalContext(
  options: CodeOperationRuntimeOptions,
  command: CodeOperationCommand | undefined,
  thread: CodeThread,
  checkout: CodeCheckoutIdentity,
): Promise<ApprovalContext | undefined> {
  const changesPullRequest =
    command?.kind === "create-pull-request" ||
    command?.kind === "update-pull-request" ||
    command?.kind === "comment-pull-request" ||
    command?.kind === "merge-pull-request";
  const pullRequestTarget = changesPullRequest
    ? await options.resolvePullRequestTarget(thread.id)
    : undefined;
  if (changesPullRequest && pullRequestTarget === undefined) return undefined;
  return {
    projectId: thread.projectId,
    threadId: thread.id,
    checkoutId: checkout.id,
    repositoryId: checkout.repositoryId,
    checkoutHead: checkout.head,
    ...(pullRequestTarget === undefined
      ? {}
      : {
          pullRequestTarget: {
            baseRepository: pullRequestTarget.baseRepository,
            baseBranch: pullRequestTarget.baseBranch,
            head: pullRequestTarget.head,
          },
        }),
  };
}

async function resolveAppleApprovalScope(
  options: CodeOperationRuntimeOptions,
  windowId: WindowId,
  request: AppleActionRequest,
): Promise<{ readonly thread: CodeThread; readonly checkout: CodeCheckoutIdentity } | undefined> {
  return resolveDeviceApprovalScope(options, windowId, request);
}

async function resolveAndroidApprovalScope(
  options: CodeOperationRuntimeOptions,
  windowId: WindowId,
  request: AndroidEmulatorRequest,
): Promise<{ readonly thread: CodeThread; readonly checkout: CodeCheckoutIdentity } | undefined> {
  return resolveDeviceApprovalScope(options, windowId, request);
}

async function resolveDeviceApprovalScope(
  options: CodeOperationRuntimeOptions,
  windowId: WindowId,
  request: {
    readonly threadId: CodeThread["id"];
    readonly checkoutId: CodeCheckoutIdentity["id"];
    readonly authority: AppleActionRequest["authority"];
  },
  /** The posture that decides; a live turn may run narrower than the stored thread. */
  effectiveThread: (thread: CodeThread) => CodeThread = (thread) => thread,
): Promise<{ readonly thread: CodeThread; readonly checkout: CodeCheckoutIdentity } | undefined> {
  const thread = options.persistence.readCodeThread(request.threadId);
  const checkout = options.persistence.readCodeCheckout(request.checkoutId);
  if (
    thread === undefined ||
    checkout === undefined ||
    thread.checkoutId !== checkout.id ||
    thread.repositoryId !== checkout.repositoryId ||
    thread.projectId !== request.authority.projectId ||
    thread.providerInstanceId !== request.authority.providerInstanceId ||
    thread.lifecycle !== "active" ||
    !decidesCodeEffectsByApproval(effectiveThread(thread).executionPolicy) ||
    checkout.availability !== "available" ||
    request.authority.mode !== "code" ||
    request.authority.extension.kind !== "core" ||
    !(await options.windowAccess.canAccessProject(windowId, thread.projectId))
  ) {
    return undefined;
  }
  return { thread, checkout };
}

function approvalPrompt(
  effect: CodeOperationApprovalRequest["effect"],
  thread: CodeThread,
  checkout: CodeCheckoutIdentity,
  pullRequestTarget: ApprovalContext["pullRequestTarget"],
  hunkDetail?: string,
): { readonly message: string; readonly detail: string } {
  const head =
    checkout.head.kind === "branch"
      ? `Branch: ${checkout.head.name}`
      : checkout.head.kind === "detached"
        ? "Detached checkout"
        : "Folder without Git";
  const scope = [`Thread: ${thread.title}`, head].join("\n");
  let message: string;
  let effectDetail: string;
  if (effect.kind === "create-thread-full-access") {
    message = "Allow full access for this Code thread?";
    effectDetail = `Full repository and shell access · ${persistenceLabel(effect.thread.permissionPersistence)}`;
  } else if (effect.kind === "create-managed-code-thread-full-access") {
    message = "Allow full access for this new Code thread?";
    const source = effect.source;
    effectDetail =
      source === undefined
        ? `Create managed worktree · ${persistenceLabel(effect.command.permissionPersistence)}`
        : `Create managed worktree from ${source.checkoutHead.kind === "branch" ? source.checkoutHead.name : "detached source"} · ${persistenceLabel(effect.command.permissionPersistence)}`;
  } else if (effect.kind === "change-thread-full-access") {
    message = "Elevate this Code thread to full access?";
    effectDetail = `Full repository and shell access · ${persistenceLabel(effect.permissionPersistence)}`;
  } else if (effect.kind === "apple-action") {
    // Allow input is approved once per Simulator, not once per tap, and the
    // dialog says what that approval covers. Clicks never raise it.
    const input =
      isAppleSimulatorInputKind(effect.request.kind) ||
      isAppleSimulatorOpenInputKind(effect.request.kind);
    const url = "url" in effect.request ? effect.request.url : undefined;
    message = input
      ? "Allow input to this Simulator?"
      : url !== undefined
        ? "Open this URL on the Simulator?"
        : effect.request.kind === "start-recording"
          ? "Record this Simulator's screen?"
          : `Allow Apple ${effect.request.kind}?`;
    effectDetail = [
      // The whole address, exactly as the device receives it: the approval
      // binds to it, and the evidence later keeps only its origin.
      ...(url === undefined ? [] : [`URL: ${url}`]),
      ...(input
        ? [
            "Covers taps, swipes, typing and keys on this Simulator for 15 minutes after each input.",
          ]
        : []),
      `Action: ${effect.request.kind}`,
      `Platform: ${"platform" in effect.request ? effect.request.platform : "Simulator"}`,
      ...(effect.request.simulatorId === undefined
        ? []
        : [`Simulator: ${effect.request.simulatorId}`]),
      ...("projectPath" in effect.request ? [`Project: ${effect.request.projectPath}`] : []),
      ...("scheme" in effect.request && effect.request.scheme !== undefined
        ? [`Scheme: ${effect.request.scheme}`]
        : []),
    ].join("\n");
  } else if (effect.kind === "android-action") {
    const input =
      isAndroidEmulatorInputKind(effect.request.kind) ||
      isAndroidEmulatorOpenInputKind(effect.request.kind);
    const url = effect.request.url;
    message = input
      ? "Allow input to this emulator?"
      : url !== undefined
        ? "Open this URL on the emulator?"
        : effect.request.kind === "start-recording"
          ? "Record this emulator's screen?"
          : `Allow Android ${effect.request.kind}?`;
    effectDetail = [
      ...(url === undefined ? [] : [`URL: ${url}`]),
      ...(input
        ? ["Covers taps, swipes, typing and keys on this emulator for 15 minutes after each input."]
        : []),
      `Action: ${effect.request.kind}`,
      `Emulator: ${effect.request.emulatorId}`,
      ...(effect.request.apkPath === undefined ? [] : [`APK: ${effect.request.apkPath}`]),
      ...(effect.request.packageName === undefined
        ? []
        : [`Package: ${effect.request.packageName}`]),
    ].join("\n");
  } else {
    const command = effect.command;
    switch (command.kind) {
      case "start-terminal":
        message = "Allow terminal access?";
        effectDetail = `Start repository terminal (${command.columns} × ${command.rows})${command.credentialRefs.length === 0 ? "" : ` with credentials: ${command.credentialRefs.join(", ")}`}`;
        break;
      case "run-repository-test":
        message = "Allow repository test execution?";
        effectDetail = `${command.definition.name}\n${command.definition.argv.join(" ")}\nWorking directory: ${command.definition.cwd}`;
        break;
      case "cancel-repository-test":
        message = "Allow repository test cancellation?";
        effectDetail = `Cancel test run ${command.testRunId}`;
        break;
      case "stage-git-hunks":
      case "unstage-git-hunks":
      case "reverse-git-hunks":
        if (hunkDetail === undefined)
          throw new TypeError("Selected Git comparison is unavailable.");
        message =
          command.kind === "reverse-git-hunks"
            ? "Reverse these uncommitted hunks?"
            : command.kind === "stage-git-hunks"
              ? "Stage these selected hunks?"
              : "Unstage these selected hunks?";
        effectDetail = `${command.kind === "reverse-git-hunks" ? "Selected uncommitted changes are lost. Other hunks and the index are kept.\n" : "Working files are kept.\n"}${hunkDetail}`;
        break;
      case "stage-git":
        message = "Allow Code stage operation?";
        effectDetail = command.paths.join("\n");
        break;
      case "unstage-git":
        message = "Allow Code unstage operation?";
        effectDetail = `These files leave the index:\n${command.paths.join("\n")}`;
        break;
      case "restore-git-checkpoint":
        message = "Restore the checkout to this checkpoint?";
        // The one Git effect that destroys work the user never staged, so the
        // prompt names what is at risk before naming the point restored to.
        effectDetail = [
          "Uncommitted work not saved in this checkpoint is overwritten.",
          `Worktree: ${command.checkpoint.worktree}`,
          `Index: ${command.checkpoint.index}`,
          ...(command.checkpoint.head === undefined
            ? ["HEAD: no commits"]
            : [`HEAD: ${command.checkpoint.head}`]),
        ].join("\n");
        break;
      case "rewind-code-thread":
        message =
          command.scope === "conversation"
            ? "Rewind this thread's conversation?"
            : "Rewind this thread and put the files back?";
        // The host picks the checkpoint from its own record, so the prompt
        // names what is at risk rather than a tree the command never carried.
        effectDetail = [
          command.scope === "files"
            ? "The files go back to how they were before the chosen message."
            : "The chosen message and every later one leave the conversation.",
          ...(command.scope === "conversation"
            ? []
            : [
                "Uncommitted work not saved in that checkpoint is overwritten; Undo restore puts it back.",
              ]),
        ].join("\n");
        break;
      case "discard-git-changes":
        message = "Discard uncommitted changes?";
        effectDetail = `These files lose their uncommitted changes:\n${command.paths.join("\n")}`;
        break;
      case "commit-git":
        message = "Allow Code commit operation?";
        effectDetail = `${command.message}\n\n${command.stagedSummary.map(({ path }) => path).join("\n")}`;
        break;
      case "push-git":
        message = "Allow Code push operation?";
        effectDetail = [
          `${command.remote}: ${command.localRef} → ${command.remoteRef}`,
          ...(command.force === undefined
            ? []
            : [
                command.force.mode === "with-lease"
                  ? `Replaces the remote branch only if it is still ${command.force.expectedRemoteOid}`
                  : "Overwrites the remote branch, whatever is there",
              ]),
          `HEAD ${command.expectedHeadOid}`,
        ].join("\n");
        break;
      case "create-pull-request":
        message =
          command.draft === true
            ? "Allow draft pull request creation?"
            : "Allow pull request creation?";
        effectDetail = [
          `Target: ${pullRequestTarget?.baseRepository}:${command.baseBranch ?? pullRequestTarget?.baseBranch}`,
          ...(command.baseBranch === undefined
            ? []
            : ["Stacked on the open pull request of that branch"]),
          `Head: ${pullRequestTarget?.head}`,
          `Title: ${command.title}`,
          "Body:",
          command.body,
        ].join("\n");
        break;
      case "update-pull-request":
        message = "Allow pull request change?";
        effectDetail = [
          `Pull request of ${pullRequestTarget?.head} in ${pullRequestTarget?.baseRepository}`,
          ...(command.draft === undefined
            ? []
            : [command.draft ? "Turn it back into a draft" : "Mark it ready for review"]),
          ...(command.state === undefined
            ? []
            : [command.state === "closed" ? "Close it (the branch stays)" : "Reopen it"]),
          ...((command.addLabels?.length ?? 0) === 0
            ? []
            : [`Add labels: ${command.addLabels?.join(", ")}`]),
          ...((command.removeLabels?.length ?? 0) === 0
            ? []
            : [`Remove labels: ${command.removeLabels?.join(", ")}`]),
          ...(command.title === undefined ? [] : [`Title: ${command.title}`]),
          ...(command.body === undefined ? [] : ["Body:", command.body]),
        ].join("\n");
        break;
      case "comment-pull-request":
        message = "Post this under your name?";
        effectDetail = [
          `Pull request of ${pullRequestTarget?.head} in ${pullRequestTarget?.baseRepository}`,
          command.reviewThreadId === undefined ? "Comment:" : "Reply in one review thread:",
          command.body,
        ].join("\n");
        break;
      case "merge-pull-request":
        message = "Allow merging this pull request?";
        effectDetail = [
          `Pull request of ${pullRequestTarget?.head} in ${pullRequestTarget?.baseRepository}`,
          `Method: ${command.method}`,
          `Only if its head is still ${command.headSha} and its required checks pass`,
        ].join("\n");
        break;
      case "create-review-finding":
        message = "Allow local review update?";
        effectDetail = `${command.path} · ${command.severity}\n${command.summary}`;
        break;
      case "update-review-finding":
        message = "Allow local review update?";
        effectDetail = `${command.state} finding ${command.findingId}`;
        break;
      default:
        throw new TypeError("Unsupported Code approval effect.");
    }
  }
  return { message, detail: boundApprovalDetail(`${effectDetail}\n\n${scope}`) };
}

/**
 * Stands in for the operation a session read would otherwise exclude: a
 * compaction is no turn, so every recorded turn counts as an earlier one.
 */
const NO_OPERATION = decodeCodeOperationId("00000000-0000-4000-8000-000000000000");

const APPROVAL_DETAIL_SUFFIX =
  "\n[Additional approval detail omitted; the exact effect remains digest-bound.]";

function boundApprovalDetail(detail: string): string {
  const maximumBytes = MAX_CODE_OPERATION_TEXT_BYTES + 4_096;
  const bytes = new TextEncoder().encode(detail);
  if (bytes.byteLength <= maximumBytes) return detail;
  const suffixBytes = new TextEncoder().encode(APPROVAL_DETAIL_SUFFIX).byteLength;
  const prefixBytes = Math.max(0, maximumBytes - suffixBytes);
  return `${new TextDecoder().decode(bytes.slice(0, prefixBytes))}${APPROVAL_DETAIL_SUFFIX}`;
}

function persistenceLabel(value: "current-session" | "project-default"): string {
  return value === "current-session" ? "current session only" : "remember for this Project";
}

type HandoffAttached = Extract<CodeOperationEvent, { readonly kind: "context-handoff-attached" }>;

/**
 * The handoff record a turn still has to journal, without the content
 * reference a text handoff gets when it is saved. A fork that took up the
 * source's own session carries no text, so its record has no content.
 */
type PendingHandoffRecord = HandoffAttached extends infer Record
  ? Record extends { readonly content: unknown }
    ? Omit<Record, "content">
    : Record
  : never;

/** The running Code turns, by thread id. */
export type CodeActiveTurns = Map<string, ActiveTurn>;

/**
 * The durable thread as its running turn may use it. A one-shot overlay is
 * the requested ceiling and the current grant still clamps it, so app-managed
 * tools cannot exceed either the turn or a later lower grant.
 */
export function threadWithActiveTurnPosture(
  thread: CodeThread,
  activeTurns: ReadonlyMap<string, Pick<ActiveTurn, "thread">>,
): CodeThread {
  const active = activeTurns.get(String(thread.id));
  if (active === undefined) return thread;
  const executionPolicy = clampTurnAccessPosture({
    requested: active.thread.executionPolicy,
    thread: thread.executionPolicy,
  });
  // A turn that started sandboxed stays sandboxed: turning the sandbox off
  // takes effect from the next turn, as a wider posture does.
  const keepsSandbox =
    active.thread.fullAccessSandbox === true && thread.fullAccessSandbox !== true;
  if (executionPolicy === thread.executionPolicy && !keepsSandbox) return thread;
  return {
    ...thread,
    executionPolicy,
    ...(keepsSandbox ? { fullAccessSandbox: true } : {}),
  };
}

/** The Code thread whose running turn holds this provider session, if any. */
export function threadOfActiveSession(
  activeTurns: ReadonlyMap<string, Pick<ActiveTurn, "thread" | "sessionId" | "requestedSessionId">>,
  sessionId: string,
): string | undefined {
  for (const active of activeTurns.values()) {
    if (active.sessionId === sessionId || active.requestedSessionId === sessionId) {
      return String(active.thread.id);
    }
  }
  return undefined;
}

interface ActiveTurn {
  readonly inputsCurrent?: () => boolean;
  /**
   * A provider-switch or fork handoff this turn selected and has not
   * journaled yet. It is journaled when the new session is ready, before the
   * prompt is sent.
   */
  pendingHandoff?: {
    readonly blocks: ReadonlyArray<ProviderContextBlock>;
    readonly record: PendingHandoffRecord;
  };
  /**
   * Merged fork conversations this turn carries and has not journaled as
   * carried yet. Journaled with the handoff, before the prompt is sent.
   */
  pendingForkMerges?: ReadonlyArray<ForkContextDelivered>;
  readonly computerUseSelection?: import("@octant/contracts/extensions").ExtensionSelection;
  readonly computerUseDestination?: ComputerUseDestinationSelection;
  /** The selected MCP servers' tools, resolved when the turn was accepted. */
  readonly extensionTools?: AppManagedToolSet;
  /**
   * A server Project's turn: the harness's tools on the server, bound when
   * the turn was taken on. They are the turn's whole tool set; nothing of
   * this host's checkout tools joins them.
   */
  readonly serverTools?: AppManagedToolSet;
  readonly extensionSelections?: ReadonlyArray<
    import("@octant/contracts/extensions").ExtensionSelection
  >;
  readonly windowId: WindowId;
  readonly thread: CodeThread;
  /** The routine run this turn was started for, from the dispatcher only. */
  readonly routineRun?: AutomationRunReference;
  readonly operationId: CodeOperationId;
  readonly sessionId: string;
  readonly requestedSessionId: string;
  readonly providerRoot: string;
  readonly folderCurrent?: () => boolean;
  readonly checkoutRoot: string;
  /** Read once as the turn starts, so `#launch` stays synchronous. */
  readonly designSystem?: DesignSystemTurnContext;
  readonly rootIdentity?: { readonly device: string; readonly inode: string };
  /** The Project's extra folders, granted what the checkout is granted. */
  readonly extraFolders: ReadonlyArray<string>;
  readonly driver: ProviderDriver;
  readonly resumeCursor?: ProviderResumeCursor;
  /** What the provider session held of Octant's per-turn context before this turn. */
  readonly carriedSentContext: CarriedSentContext;
  /**
   * Whether this is the thread's first turn on a context of its own: no earlier
   * turn, and no session, handoff or fork conversation carried in.
   */
  readonly firstTurn: boolean;
  /** Which of this turn's context blocks are Octant's instructions and skills. */
  readonly sentContext?: CodeTurnSentContext;
  readonly secrets: readonly string[];
  readonly abort: AbortController;
  readonly approvals: Map<string, string>;
  /**
   * The thread's posture, as `#approvalPosture` reads it, when each pending
   * approval (provider or app-managed tool) was asked, by approval id. An
   * allow answered under a different posture is refused, and the approval
   * stays pending under the current one.
   */
  readonly approvalPostures: Map<string, string | undefined>;
  /**
   * Each app-managed tool ask's settle function: a Browser session, with the
   * site it waits to open, or a device effect, which has none.
   */
  readonly toolApprovals: Map<
    string,
    {
      readonly origin?: string;
      readonly finish: (outcome: "approved" | "denied" | "cancelled" | "expired") => void;
    }
  >;
  readonly browserGrantKeys: Set<string>;
  readonly browserProfileContexts: Set<string>;
  readonly questions: Set<string>;
  readonly providerQuestionnaires: Map<string, Questionnaire>;
  /** Questions the native harness asked on this turn; answered by the host, not the provider. */
  readonly harnessQuestions: Set<string>;
  connection?: ProviderConnection;
  cursor: number;
  /** Streamed text of one channel not yet journaled; see `#bufferDelta`. */
  deltaBurst?: {
    readonly channel: "message" | "reasoning";
    readonly parts: string[];
    bytes: number;
    readonly timer: ReturnType<typeof setTimeout>;
  };
  /** Set once the turn has settled; a late chunk is dropped instead of re-arming a timer. */
  closed?: boolean;
  /** A burst that could not be journaled; the turn may not report `completed` afterwards. */
  deltaFlushFailure?: { readonly error: unknown };
  /** Denied tool requests on this turn, provider and browser alike; the third ends it. */
  deniedApprovals: number;
  /** Reason a forced stop journals instead of the runner's generic cancellation copy. */
  interruptMessage?: string;
  state: "running" | "waiting" | "completed" | "interrupted" | "failed";
  /** The `operation-state` value and reason last journaled, whichever path wrote the frame. */
  lastPersistedState?: "running" | "waiting" | "completed" | "interrupted" | "failed";
  lastPersistedFailure?: string | undefined;
  /** In-flight change-list recording, so a second terminal path waits instead of skipping. */
  changedFilesRecording?: Promise<void>;
  reviewCapture?: CodeTurnReviewCaptureScheduler;
  reviewLatest?: CodeTurnReviewCapture;
  reviewFinalCaptured?: boolean;
  reviewCaptureGuard?: (() => boolean) | undefined;
  /** Current-attempt failure receipt; no new evidence or journal authority. */
  reviewCaptureFailure?: { readonly current: () => boolean; readonly explanation: string };
  launch?: () => void;
  /** Told once the provider has accepted this turn's prompt and context. */
  readonly onContextDelivered?: () => void;
}

/** Why a turn on a thread whose checkout is a folder on another machine did not start. */
const REMOTE_FOLDER_UNSUPPORTED =
  "This thread's checkout is a folder on a remote machine, which Octant no longer supports. Start a new thread in a local Project.";

/** Why a turn carrying conversation merged back from a fork did not start. */
const FORK_MERGE_UNREADABLE =
  "Conversation merged back from a fork of this thread could not be read, so the message was not sent. Send it again.";

class HandoffUnsaved extends Error {
  readonly fork: boolean;
  constructor(fork: boolean) {
    super();
    this.fork = fork;
  }
}

type ProviderSwitchHandoffRefusal =
  | AgentRunParentContextUnavailableReason
  | "unsupported"
  | "handoff-unreadable"
  | "handoff-unsaved";

/**
 * Why a turn that moved to another provider did not start. Each names what
 * the person can do; none starts the new provider without the handoff.
 */
const PROVIDER_SWITCH_HANDOFF_REFUSALS: Record<ProviderSwitchHandoffRefusal, string> = {
  unsupported:
    "This host cannot hand a task's conversation to another provider. Restore the previous provider or start a new task.",
  "thread-unavailable":
    "This task is no longer available, so its conversation cannot be handed to the new provider.",
  "foreign-thread":
    "The conversation read for the handoff does not belong to this task, so nothing was handed over. Restore the previous provider or start a new task.",
  "foreign-project":
    "The conversation read for the handoff does not belong to this task's Project, so nothing was handed over. Restore the previous provider or start a new task.",
  "source-point-unavailable":
    "This task has no recorded conversation to hand to the new provider. Restore the previous provider or start a new task.",
  "source-empty":
    "This task has no readable messages to hand to the new provider; earlier messages may have been removed. Restore the previous provider or start a new task.",
  "source-changed":
    "This task's conversation changed while it was being read for the handoff. Send the message again.",
  "source-unavailable":
    "This task's conversation could not be read for the handoff. Send the message again, or restore the previous provider.",
  "invalid-page":
    "This task's conversation could not be read consistently for the handoff. Send the message again, or restore the previous provider.",
  "history-window-exceeded":
    "This task's history is too long to choose recent messages to hand over. Restore the previous provider or start a new task.",
  "handoff-unreadable":
    "The handoff this message was prepared with can no longer be read. Send the message again.",
  "handoff-unsaved":
    "The handoff to the new provider could not be saved, so the message was not sent. Send it again.",
};

type InheritedHandoffRefusal = AgentRunParentContextUnavailableReason | "source-unauthorized";

/**
 * Why a forked thread that moved to another provider did not start because
 * the conversation it inherited could not be read. The new provider is never
 * started with only the fork's own turns while its transcript shows the
 * inherited ones.
 */
const INHERITED_HANDOFF_REFUSALS: Record<InheritedHandoffRefusal, string> = {
  "thread-unavailable":
    "The thread this was forked from is no longer available, so the conversation it carried cannot be handed to the new provider. Restore the previous provider or start a new task.",
  "source-unauthorized":
    "This window cannot read the thread this was forked from, so nothing was handed to the new provider. Restore the previous provider or start a new task.",
  "foreign-thread":
    "The conversation read for the handoff does not belong to the thread this was forked from, so nothing was handed over. Restore the previous provider or start a new task.",
  "foreign-project":
    "The thread this was forked from is not in this task's Project, so nothing was handed to the new provider. Restore the previous provider or start a new task.",
  "source-point-unavailable":
    "The reply this was forked from is no longer in its thread's recorded conversation, so nothing was handed to the new provider. Restore the previous provider or start a new task.",
  "source-empty":
    "The conversation this was forked from has no readable messages left to hand to the new provider; they may have been removed. Restore the previous provider or start a new task.",
  "source-changed":
    "The thread this was forked from changed while it was being read for the handoff. Send the message again.",
  "source-unavailable":
    "The conversation this was forked from could not be read for the handoff. Send the message again, or restore the previous provider.",
  "invalid-page":
    "The conversation this was forked from could not be read consistently for the handoff. Send the message again, or restore the previous provider.",
  "history-window-exceeded":
    "The conversation up to the fork point is too long to choose recent messages to hand over. Restore the previous provider or start a new task.",
};

/**
 * Why the first turn after a rewind did not start because the kept turns
 * could not be handed to a fresh session. Each names what the person can do;
 * none starts the session with less than the thread shows.
 */
const REWIND_HANDOFF_REFUSALS: Record<ProviderSwitchHandoffRefusal, string> = {
  unsupported:
    "This host cannot hand a rewound thread's kept turns to a fresh session. Rewind to the first message or start a new task.",
  "thread-unavailable":
    "This task is no longer available, so its kept turns cannot be handed to a fresh session.",
  "foreign-thread":
    "The conversation read for the handoff does not belong to this task, so nothing was handed over. Send the message again.",
  "foreign-project":
    "The conversation read for the handoff does not belong to this task's Project, so nothing was handed over. Send the message again.",
  "source-point-unavailable":
    "This task has no recorded conversation left to hand to a fresh session. Rewind to the first message or start a new task.",
  "source-empty":
    "The turns this task kept have no readable messages to hand to a fresh session. Rewind to the first message or start a new task.",
  "source-changed":
    "This task's conversation changed while it was being read for the handoff. Send the message again.",
  "source-unavailable":
    "This task's kept turns could not be read for the handoff. Send the message again.",
  "invalid-page":
    "This task's kept turns could not be read consistently for the handoff. Send the message again.",
  "history-window-exceeded":
    "This task's kept history is too long to choose recent messages to hand over. Rewind further back or start a new task.",
  "handoff-unreadable":
    "The conversation this message was prepared with after the rewind can no longer be read. Send the message again.",
  "handoff-unsaved":
    "The kept turns could not be saved for the fresh session, so the message was not sent. Send it again.",
};

type HandoffRefusal =
  | { readonly subject: "switch"; readonly reason: ProviderSwitchHandoffRefusal }
  | { readonly subject: "rewind"; readonly reason: ProviderSwitchHandoffRefusal }
  | { readonly subject: "fork"; readonly reason: CodeForkHandoffRefusal }
  | { readonly subject: "inherited"; readonly reason: InheritedHandoffRefusal };

function handoffRefusalMessage(refusal: HandoffRefusal): string {
  switch (refusal.subject) {
    case "switch":
      return PROVIDER_SWITCH_HANDOFF_REFUSALS[refusal.reason];
    case "rewind":
      return REWIND_HANDOFF_REFUSALS[refusal.reason];
    case "fork":
      return CODE_FORK_HANDOFF_REFUSALS[refusal.reason];
    case "inherited":
      return INHERITED_HANDOFF_REFUSALS[refusal.reason];
  }
}

class RuntimeTurnController implements CodeOperationTurnPort {
  readonly #options: CodeOperationRuntimeOptions;
  readonly #events: CodeOperationEventStore;
  readonly #roots: Map<
    string,
    Awaited<ReturnType<CodeOperationAuthorityPort["resolveCheckoutRoot"]>>
  >;
  readonly #git: GitService;
  readonly #runtimeWork: CodeRuntimeWorkRecorder;
  readonly #observeRuntimeWorkOutcome: (outcome: CodeRuntimeWorkRecordOutcome) => void;
  #service: CodeOperationService | undefined;
  readonly #runner = new CodeTurnRunner();
  /**
   * Starts noted before the service prepares them, under each start's own
   * operation. A stopped start can still be preparing when the next one on
   * its thread is sent, and when it finally settles it clears only its own.
   */
  readonly #pending = new Map<
    string,
    Extract<CodeOperationCommand, { kind: "start-provider-turn" }>
  >();
  readonly #active: CodeActiveTurns;
  readonly #approvedBrowserContexts = new Set<string>();
  // Full access may open without approval, but recovery still needs the
  // original controller identity. Keeping this separate never manufactures a grant.
  readonly #boundBrowserContexts = new Set<string>();

  readonly #spendReservations: Map<string, ReturnType<typeof decodeSpendCeilingReservationId>>;
  /** Mints the one-use approval a device effect the person allowed in the thread carries. */
  readonly #approvalStore: CodeOperationApprovalStore | undefined;

  constructor(input: {
    options: CodeOperationRuntimeOptions;
    events: CodeOperationEventStore;
    roots: Map<string, Awaited<ReturnType<CodeOperationAuthorityPort["resolveCheckoutRoot"]>>>;
    gitService: GitService;
    runtimeWork: CodeRuntimeWorkRecorder;
    observeRuntimeWorkOutcome: (outcome: CodeRuntimeWorkRecordOutcome) => void;
    spendReservations: Map<string, ReturnType<typeof decodeSpendCeilingReservationId>>;
    approvalStore: CodeOperationApprovalStore | undefined;
  }) {
    this.#options = input.options;
    this.#active = input.options.activeTurns ?? new Map();
    this.#approvalStore = input.approvalStore;
    this.#spendReservations = input.spendReservations;
    this.#events = input.events;
    this.#roots = input.roots;
    this.#git = input.gitService;
    this.#runtimeWork = input.runtimeWork;
    this.#observeRuntimeWorkOutcome = input.observeRuntimeWorkOutcome;
  }

  bindService(service: CodeOperationService): void {
    this.#service = service;
  }

  /** Whether a turn on the thread was noted, runs, or waits on the person. */
  holdsTurn(threadId: string): boolean {
    if (this.#active.has(threadId)) return true;
    for (const command of this.#pending.values())
      if (String(command.threadId) === threadId) return true;
    return false;
  }

  noteStart(command: Extract<CodeOperationCommand, { kind: "start-provider-turn" }>): void {
    this.#pending.set(String(command.operationId), command);
  }

  clearStart(command: Extract<CodeOperationCommand, { kind: "start-provider-turn" }>): void {
    // A retry of the same operation noted its own command meanwhile.
    if (this.#pending.get(String(command.operationId)) === command)
      this.#pending.delete(String(command.operationId));
  }

  /** Whether a live turn runs under this operation. */
  runsOperation(operationId: CodeOperationId): boolean {
    for (const active of this.#active.values())
      if (String(active.operationId) === String(operationId)) return true;
    return false;
  }

  launch(threadId: CodeThreadId): void {
    const active = this.#active.get(String(threadId));
    const launch = active?.launch;
    if (active !== undefined) delete active.launch;
    launch?.();
  }

  settleSpendReservation(operationId: CodeOperationId): void {
    const reservationId = this.#spendReservations.get(String(operationId));
    if (reservationId === undefined) return;
    this.#spendReservations.delete(String(operationId));
    this.#options.spendCeiling?.settle({ reservationId });
  }

  async start(input: Parameters<CodeOperationTurnPort["start"]>[0]) {
    const key = String(input.thread.id);
    if (this.#options.moveHold?.(key) === true) {
      this.settleSpendReservation(input.operationId);
      return turnState("failed", { category: "failed", message: THREAD_MOVING_REFUSAL });
    }
    const existing = this.#active.get(key);
    if (
      existing !== undefined &&
      existing.requestedSessionId === input.sessionId &&
      existing.checkoutRoot === input.checkoutRoot
    ) {
      // Idempotent recovery: a prior start that returned `running` before
      // launch()/stream evidence may still own the in-memory controller.
      return turnState(existing.state);
    }
    /**
     * A refused start the person can act on carries its reason; the generic
     * state is for races they cannot (a start that lost its pending command, a
     * root that moved, a turn already active).
     */
    const failStart = (reason?: string) => {
      this.settleSpendReservation(input.operationId);
      return turnState(
        "failed",
        reason === undefined ? undefined : { category: "failed", message: reason },
      );
    };
    const command = this.#pending.get(String(input.operationId));
    const root = this.#roots.get(key);
    if (
      command === undefined ||
      String(command.threadId) !== key ||
      root === undefined ||
      root === null ||
      root.checkoutRoot !== input.checkoutRoot ||
      this.#active.has(key)
    )
      return failStart();
    if (command.toolCatalogHandoff === true && input.routineRun !== undefined) {
      return failStart("Only a person can choose to replace a native session's tools.");
    }
    const resolvedDriver = await this.#options.resolveProviderDriver(input.thread);
    if (resolvedDriver === undefined) return failStart();
    const recovered = this.#events.providerSessionForThread(input.thread.id, command.operationId);
    if (recovered.status !== "ok")
      return failStart(
        "The task's provider session could not be recovered. Retry after reloading the task.",
      );
    // A rewind journaled after the thread's session leaves that session
    // holding turns the thread no longer has, so it is never resumed as it
    // stands. With turns kept, the turn starts a new session from them: a
    // copy of the session cut back at the last kept turn where the provider
    // can make one, otherwise the kept turns as a disclosed text handoff.
    // With none kept, the thread starts again as it did at first.
    const rewind = recovered.rewoundAfterSession;
    let lastKeptTurn: CodeOperationId | undefined;
    if (rewind !== undefined) {
      const shown = codeThreadTurns((page) => this.#events.conversation(page), input.thread.id);
      if (shown === undefined)
        return failStart(
          "This thread's conversation could not be read after its rewind. Send the message again.",
        );
      lastKeptTurn = shown.findLast(
        (turn) => String(turn.operationId) !== String(command.operationId),
      )?.operationId;
    }
    const previous =
      rewind !== undefined && lastKeptTurn === undefined ? undefined : recovered.session;
    const priorTurn = recovered.priorTurn;
    const priorTurnSettled = recovered.priorTurnSettled;
    // The composer offers another model of the same provider in a started
    // thread. A provider that can resume onto the new model keeps the
    // conversation; one that cannot starts a fresh session with the same
    // disclosed handoff a provider switch takes, rather than wedging the
    // thread on a refusal it cannot act on. A rewind with turns kept takes
    // the same path: a session the turn will not resume.
    const providerSwitch =
      previous?.kind === "provider-session-ready" &&
      (rewind !== undefined ||
        (command.toolCatalogHandoff === true &&
          resolvedDriver.toolCatalogContinuation !== undefined) ||
        String(previous.providerInstanceId) !== String(input.thread.providerInstanceId) ||
        (String(previous.modelId) !== String(input.thread.modelId) &&
          this.#options.supportsModelSwitch?.(input.thread) !== true))
        ? previous
        : undefined;
    if (
      previous?.kind === "provider-session-ready" &&
      String(previous.checkoutId) !== String(input.thread.checkoutId)
    )
      return failStart(
        "This task's provider session belongs to a different checkout. Restore that selection or start a new task.",
      );
    // Another provider, or another model this provider cannot carry the
    // session on to, cannot take up this session, so the turn starts a new
    // one with a disclosed text handoff of the thread's own conversation. The
    // handoff is chosen before anything else is prepared, so a refusal names
    // its reason and leaves nothing behind.
    let switchHandoff = await this.#providerSwitchHandoff(
      input.thread,
      command.operationId,
      providerSwitch,
      input.windowId,
      rewind === undefined ? "provider-switch" : "rewind",
    );
    if (switchHandoff?.status === "refused")
      return failStart(handoffRefusalMessage(switchHandoff.refusal));
    // A recorded session without a resume cursor wedges the thread rather than
    // silently discarding the conversation the provider still holds. A prior
    // turn that never reached its session left nothing to discard only once it
    // provably settled (a send refused before acquisition); one interrupted
    // between its `running` result and its launch still owns a journaled
    // prompt the provider never saw, and only that turn's own retry may
    // recover it.
    if (
      priorTurn &&
      previous?.kind === "provider-session-ready" &&
      providerSwitch === undefined &&
      previous.resumeCursor === undefined
    ) {
      return failStart(
        "This task has no resumable provider session. Start a new task; Octant will not silently discard its conversation.",
      );
    }
    if (priorTurn && !priorTurnSettled && previous === undefined)
      return failStart(
        "The task's previous turn stopped before the provider started. Retry that message, or start a new task.",
      );
    const driver = resolvedDriver;
    // A `remote-root` thread runs only as a server Project's, with the
    // server's tools; a thread the retired SSH target build left runs
    // nothing. Browser, Computer, and a fork's session seeding act on this
    // host, so a server thread is offered none of them.
    const remoteThread = this.#isRemoteThread(input.thread);
    if (remoteThread) {
      if (this.#options.serverCodeTurn === undefined) return failStart(REMOTE_FOLDER_UNSUPPORTED);
      if (
        command.computerUseSelection !== undefined ||
        command.extensionSelections?.some(isBrowserUseSelection) === true
      )
        return failStart(
          "Browser and Computer act on this computer, so a thread in a Project on a server does not offer them. Send the message without them.",
        );
      if (input.thread.forkedFrom !== undefined)
        return failStart("A thread in a Project on a server cannot start from a fork.");
    }
    // Computer is offered on every eligible turn, so a send names only where
    // it acts. A desktop destination the send cannot bind is refused rather
    // than quietly falling back to this Mac. A Computer selection from an
    // older draft or queued message is ignored.
    const admitsComputer = (destination: ComputerUseDestinationSelection) =>
      this.#options.supportsAppManagedTools?.(input.thread) === true &&
      this.#options.computerUseTools?.({
        windowId: input.windowId,
        thread: input.thread,
        destination,
        // Admission only checks that the send can bind its destination;
        // the turn's own tool set asks in its thread.
        ask: () => Promise.resolve("cancelled"),
      }) !== undefined;
    // The thread's running desktop is only a default: a turn that cannot carry
    // Computer (Plan, or an allowlist without it) proceeds without the tool
    // instead of being refused.
    const implicitDestination =
      command.computerUseDestination === undefined
        ? this.#options.threadDesktopDestination?.(input.thread)
        : undefined;
    const computerUseDestination =
      command.computerUseDestination ??
      (implicitDestination !== undefined && admitsComputer(implicitDestination)
        ? implicitDestination
        : undefined);
    if (
      command.computerUseDestination !== undefined &&
      !admitsComputer(command.computerUseDestination)
    )
      return failStart(
        "The selected desktop is not this thread's running desktop, or this provider cannot carry Octant's Computer tool. Choose a running desktop of this thread and retry.",
      );
    const secrets: string[] = [];
    for (const credential of root.credentialReferences) {
      const value = await this.#options.credentialResolver.resolve(credential.reference);
      if (value === undefined) return failStart();
      if (value.length > 0) secrets.push(value);
    }
    // A fork's first turn starts from the source's own provider conversation
    // when the provider can take it up exactly; otherwise it reads the
    // source's history as text. Never both.
    let resumeCursor =
      previous?.kind === "provider-session-ready" && providerSwitch === undefined
        ? previous.resumeCursor
        : undefined;
    let forkSeeded = false;
    const refuseRevokedAdmission = async () => {
      this.settleSpendReservation(input.operationId);
      await input.extensionTools?.close?.().catch(() => undefined);
      return {
        state: "failed" as const,
        admission: "refused" as const,
        failure: {
          category: "unauthorized" as const,
          message: "Code turn admission is no longer current.",
        },
      };
    };
    // A fork's first session: no session of its own yet. One whose text
    // handoff is already journaled keeps that record rather than switching to
    // the source's session on a recovered start.
    const forkOrigin = previous === undefined ? input.thread.forkedFrom : undefined;
    if (forkOrigin !== undefined && switchHandoff?.journaled !== "text") {
      // Seeding durably copies the source's session, so a turn whose admission
      // lapsed during driver and credential preparation copies nothing.
      if (input.folderCurrent?.() === false || input.admissionCurrent?.() === false)
        return refuseRevokedAdmission();
      const seeded = await this.#options
        .forkProviderSession?.({
          fork: input.thread,
          origin: forkOrigin,
          sessionId: decodeProviderSessionId(input.sessionId),
          checkoutRoot: input.providerRoot ?? input.checkoutRoot,
          secrets,
        })
        .catch(() => undefined);
      if (seeded !== undefined) {
        resumeCursor = seeded;
        forkSeeded = true;
      }
    }
    // A rewound thread whose provider can copy its own session cut back at
    // the last kept turn continues that copy, so the provider keeps the kept
    // turns' tool activity and never sees the removed ones. Otherwise the text
    // handoff chosen above goes, and a recovered start that disclosed a copy
    // and can no longer make one refuses rather than send something else.
    if (
      rewind !== undefined &&
      !remoteThread &&
      providerSwitch !== undefined &&
      lastKeptTurn !== undefined &&
      switchHandoff?.status === "ready" &&
      switchHandoff.journaled !== "text"
    ) {
      if (input.folderCurrent?.() === false || input.admissionCurrent?.() === false)
        return refuseRevokedAdmission();
      const seeded = await this.#options
        .forkProviderSession?.({
          fork: input.thread,
          origin: { threadId: input.thread.id, throughOperationId: lastKeptTurn },
          sessionId: decodeProviderSessionId(input.sessionId),
          checkoutRoot: input.providerRoot ?? input.checkoutRoot,
          secrets,
        })
        .catch(() => undefined);
      if (seeded !== undefined) {
        resumeCursor = seeded;
        // The copy's history is the kept turns', not the newest turn's (a
        // removed one), so the window counts it as a copied session.
        forkSeeded = true;
        switchHandoff = {
          status: "ready",
          blocks: [],
          ...(switchHandoff.journaled === undefined
            ? {
                record: {
                  kind: "context-handoff-attached",
                  reason: "rewind-native-session",
                  previousSessionId: providerSwitch.sessionId,
                  throughOperationId: lastKeptTurn,
                  providerInstanceId: input.thread.providerInstanceId,
                  modelId: input.thread.modelId,
                  nativeSessionTransferred: true,
                },
              }
            : { journaled: switchHandoff.journaled }),
        };
      } else if (switchHandoff.journaled === "native-session") {
        await input.extensionTools?.close?.().catch(() => undefined);
        return failStart(REWIND_HANDOFF_REFUSALS["handoff-unreadable"]);
      }
    }
    // Otherwise the fork reads its source's conversation through the fork
    // point as text, journaled like a provider switch's handoff. A fork that
    // can do neither refuses rather than starting from nothing while its
    // transcript shows an inherited conversation.
    let forkHandoff:
      | {
          readonly blocks: ReadonlyArray<ProviderContextBlock>;
          readonly record?: PendingHandoffRecord;
          readonly inputSelection?: Extract<
            AgentRunParentContextSelection,
            { readonly status: "available" }
          >;
          readonly inputReceipt?: ConversationInputReceipt;
        }
      | undefined;
    if (forkOrigin !== undefined && switchHandoff === undefined) {
      if (forkSeeded) {
        forkHandoff = {
          blocks: [],
          record: {
            kind: "context-handoff-attached",
            reason: "fork-native-session",
            forkedFrom: forkOrigin,
            providerInstanceId: input.thread.providerInstanceId,
            modelId: input.thread.modelId,
            nativeSessionTransferred: true,
          },
        };
      } else {
        const selected = await this.#forkTextHandoff(input.thread, forkOrigin, input.windowId);
        if (selected.status === "refused") {
          await input.extensionTools?.close?.().catch(() => undefined);
          return failStart(CODE_FORK_HANDOFF_REFUSALS[selected.reason]);
        }
        forkHandoff = selected;
      }
    } else if (
      forkOrigin !== undefined &&
      switchHandoff?.journaled === "native-session" &&
      !forkSeeded
    ) {
      // The record says this turn took up the source's session; sending it
      // anything else would contradict what was disclosed.
      await input.extensionTools?.close?.().catch(() => undefined);
      return failStart(CODE_FORK_HANDOFF_REFUSALS["handoff-unreadable"]);
    }
    const transferredAttachments: ProviderAttachmentInput[] = [];
    const inputGuards: Array<() => boolean> = [];
    const inputContext: ProviderContextBlock[] = [];
    for (const handoff of [switchHandoff, forkHandoff]) {
      if (
        handoff === undefined ||
        handoff.record?.reason === "fork-native-session" ||
        handoff.record?.reason === "rewind-native-session" ||
        ("journaled" in handoff && handoff.journaled === "native-session")
      )
        continue;
      const selection = handoff.inputSelection;
      const receipt = handoff.inputReceipt;
      if (
        (selection?.inputs?.length ?? 0) === 0 &&
        selection?.inputUnavailable !== true &&
        receipt === undefined
      )
        continue;
      const transfer = this.#options.conversationInputTransfer;
      if (transfer === undefined) {
        await input.extensionTools?.close?.().catch(() => undefined);
        return failStart(
          "Original source inputs cannot be transferred on this host. Nothing was sent.",
        );
      }
      if (
        receipt !== undefined &&
        command.contextInputPolicy !== undefined &&
        command.contextInputPolicy !== receipt.policy
      ) {
        await input.extensionTools?.close?.().catch(() => undefined);
        return failStart(
          "This admitted turn keeps its original input choice. Start a new turn to choose different inputs.",
        );
      }
      const purpose: ConversationInputPurpose =
        receipt?.purpose ??
        (handoff.record?.reason === "fork"
          ? "fork"
          : handoff.record?.reason === "rewind"
            ? "rewind"
            : "provider-switch");
      const prepared = await transfer.prepare({
        owner: {
          mode: "code",
          threadId: String(input.thread.id),
          projectId: String(input.thread.projectId),
        },
        purpose,
        ...(selection === undefined ? {} : { selection }),
        ...(receipt === undefined ? {} : { previous: receipt }),
        ...(command.contextInputPolicy === undefined ? {} : { policy: command.contextInputPolicy }),
        target: {
          providerInstanceId: String(input.thread.providerInstanceId),
          modelId: String(input.thread.modelId),
        },
        current: () => input.admissionCurrent?.() !== false,
      });
      if (prepared.status === "refused") {
        await input.extensionTools?.close?.().catch(() => undefined);
        return failStart(prepared.message);
      }
      if (prepared.inputsCurrent !== undefined) inputGuards.push(prepared.inputsCurrent);
      transferredAttachments.push(...prepared.attachments);
      if (prepared.receipt !== undefined) {
        inputContext.push(conversationInputReceiptBlock(prepared.manifest));
        if (handoff.record !== undefined) {
          const record = {
            ...handoff.record,
            inputReceipt: prepared.receipt,
            ...("omissions" in handoff.record
              ? {
                  omissions: {
                    ...handoff.record.omissions,
                    attachments: Math.max(
                      0,
                      handoff.record.omissions.attachments - prepared.receipt.included,
                    ),
                  },
                }
              : {}),
          };
          if (handoff === switchHandoff) switchHandoff = { ...switchHandoff, record };
          else forkHandoff = { ...forkHandoff, blocks: handoff.blocks, record };
        }
      }
    }
    // Conversation a person merged back from a fork of this thread goes with
    // its next turn, disclosed and journaled before the prompt is sent. A turn
    // that cannot read it refuses rather than dropping it silently.
    let forkMerges: Awaited<ReturnType<typeof forkMergeDelivery>>;
    let recoveredMergeInputs = false;
    try {
      const replay = this.#events.replay({
        threadId: input.thread.id,
        operationId: command.operationId,
        afterCursor: 0,
        limit: MAX_CODE_OPERATION_REPLAY_LIMIT,
      });
      recoveredMergeInputs =
        replay.status === "ok" &&
        replay.frames.some((frame) => frame.event.kind === "fork-context-delivered");
      forkMerges =
        replay.status === "ok"
          ? await forkMergeDelivery(
              { events: this.#events, readEvidence: this.#options.evidence.read },
              { threadId: input.thread.id, frames: replay.frames },
            )
          : { status: "refused" };
    } catch {
      forkMerges = { status: "refused" };
    }
    if (forkMerges.status === "refused") {
      await input.extensionTools?.close?.().catch(() => undefined);
      return failStart(FORK_MERGE_UNREADABLE);
    }
    for (const entry of forkMerges.inputReceipts ?? []) {
      if (
        recoveredMergeInputs &&
        command.contextInputPolicy !== undefined &&
        command.contextInputPolicy !== entry.receipt.policy
      ) {
        await input.extensionTools?.close?.().catch(() => undefined);
        return failStart(
          "This admitted turn keeps its original merge-back input choice. Start a new turn to choose different inputs.",
        );
      }
      const transfer = this.#options.conversationInputTransfer;
      if (transfer === undefined) {
        await input.extensionTools?.close?.().catch(() => undefined);
        return failStart(
          "Merged original inputs are unavailable on this host. Pending feedback was retained.",
        );
      }
      const prepared = await transfer.prepare({
        owner: {
          mode: "code",
          threadId: String(input.thread.id),
          projectId: String(input.thread.projectId),
        },
        purpose: "fork-merge-back",
        previous: entry.receipt,
        ...(command.contextInputPolicy === undefined ? {} : { policy: command.contextInputPolicy }),
        target: {
          providerInstanceId: String(input.thread.providerInstanceId),
          modelId: String(input.thread.modelId),
        },
        current: () => input.admissionCurrent?.() !== false,
      });
      if (prepared.status === "refused") {
        await input.extensionTools?.close?.().catch(() => undefined);
        return failStart(prepared.message);
      }
      if (prepared.inputsCurrent !== undefined) inputGuards.push(prepared.inputsCurrent);
      transferredAttachments.push(...prepared.attachments);
      inputContext.push(conversationInputReceiptBlock(prepared.manifest));
      const deliveredReceipt = prepared.receipt;
      if (deliveredReceipt !== undefined)
        forkMerges = {
          ...forkMerges,
          records: forkMerges.records.map((record) =>
            record.mergeOperationId === entry.mergeOperationId
              ? {
                  ...record,
                  inputReceipt: deliveredReceipt,
                  omissions: {
                    ...record.omissions,
                    attachments:
                      record.omissions.attachments +
                      Math.max(
                        0,
                        (record.inputReceipt?.included ?? entry.receipt.included) -
                          deliveredReceipt.included,
                      ),
                  },
                }
              : record,
          ),
        };
    }
    const originalInputCount = (input.attachments?.length ?? 0) + transferredAttachments.length;
    if (originalInputCount > MAX_PROVIDER_ATTACHMENTS) {
      await input.extensionTools?.close?.().catch(() => undefined);
      return failStart(
        "Current and continuation inputs exceed the provider's attachment limit. Remove an input or explicitly choose text-only continuation. Pending feedback was retained.",
      );
    }
    // A server thread's tools are bound last, before anything launches, so
    // no refusal after this point leaves them behind. The provider is
    // checked here too: only the Octant Harness runs on a server.
    let serverTools: AppManagedToolSet | undefined;
    if (remoteThread) {
      const bound = this.#options.serverCodeTurn?.({
        thread: input.thread,
        windowId: input.windowId,
        secrets,
      });
      if (bound === undefined || bound.status === "refused") {
        await input.extensionTools?.close?.().catch(() => undefined);
        return failStart(bound?.message ?? REMOTE_FOLDER_UNSUPPORTED);
      }
      serverTools = bound.tools;
      // Extensions' tools act on this host; the server tool set is the turn's whole set.
      await input.extensionTools?.close?.().catch(() => undefined);
    }
    const providerRoot = input.providerRoot ?? input.checkoutRoot;
    const extraFolders = [
      ...new Set([
        ...(this.#options.readProjectExtraFolders?.(input.thread.projectId) ?? []),
        ...(input.providerRoot !== undefined && input.providerRoot !== input.checkoutRoot
          ? [input.checkoutRoot]
          : []),
      ]),
    ].filter((folder) => folder !== providerRoot);
    // Read before the final admission check, which must not yield before the
    // turn is owned. A server Project's folder is on another machine, so its
    // design system is the runtime's to read there.
    const designSystem = remoteThread
      ? undefined
      : await this.#options
          .designSystemContext?.({ thread: input.thread, root: providerRoot, extraFolders })
          .catch(() => undefined);
    // Driver, credentials, and fork preparation may outlive the host's admission.
    if (
      input.folderCurrent?.() === false ||
      input.admissionCurrent?.() === false ||
      inputGuards.some((current) => !current())
    ) {
      await serverTools?.close?.().catch(() => undefined);
      return refuseRevokedAdmission();
    }
    // Feedback stays pending through every preparation refusal. Consuming it
    // here does not yield between the final admission check and owning the turn.
    let feedback: ReturnType<NonNullable<typeof input.takeProductFeedback>> | undefined;
    try {
      feedback = input.takeProductFeedback?.(MAX_PROVIDER_ATTACHMENTS - originalInputCount);
    } catch {
      await serverTools?.close?.().catch(() => undefined);
      await input.extensionTools?.close?.().catch(() => undefined);
      return {
        ...failStart(
          "Product-note delivery changed while preparing the message. Refresh notes before sending again.",
        ),
        admission: "refused" as const,
      };
    }
    const context = [
      ...(switchHandoff?.blocks ?? []),
      ...(forkHandoff?.blocks ?? []),
      ...forkMerges.blocks,
      ...inputContext,
      ...(input.context ?? []),
      ...(feedback?.context === undefined || feedback.context.trim().length === 0
        ? []
        : [{ kind: "user-message", text: feedback.context } as const]),
    ];
    const attachments = [
      ...(input.attachments ?? []),
      ...transferredAttachments,
      ...(feedback?.attachments ?? []),
    ];
    const active: ActiveTurn = {
      ...(designSystem === undefined ? {} : { designSystem }),
      ...(inputGuards.length === 0
        ? {}
        : { inputsCurrent: () => inputGuards.every((current) => current()) }),
      ...(switchHandoff?.record !== undefined
        ? { pendingHandoff: { blocks: switchHandoff.blocks, record: switchHandoff.record } }
        : forkHandoff?.record !== undefined
          ? { pendingHandoff: { blocks: forkHandoff.blocks, record: forkHandoff.record } }
          : {}),
      ...(forkMerges.records.length === 0 ? {} : { pendingForkMerges: forkMerges.records }),
      ...(computerUseDestination === undefined ? {} : { computerUseDestination }),
      ...(input.extensionTools === undefined || serverTools !== undefined
        ? {}
        : { extensionTools: input.extensionTools }),
      ...(serverTools === undefined ? {} : { serverTools }),
      ...(command.extensionSelections === undefined || command.extensionSelections.length === 0
        ? {}
        : { extensionSelections: command.extensionSelections }),
      windowId: input.windowId,
      thread: input.thread,
      ...(input.routineRun === undefined ? {} : { routineRun: input.routineRun }),
      operationId: command.operationId,
      sessionId:
        previous?.kind === "provider-session-ready" && providerSwitch === undefined
          ? previous.sessionId
          : input.sessionId,
      requestedSessionId: input.sessionId,
      providerRoot,
      ...(input.folderCurrent === undefined ? {} : { folderCurrent: input.folderCurrent }),
      ...(resumeCursor === undefined ? {} : { resumeCursor }),
      checkoutRoot: input.checkoutRoot,
      ...(input.rootIdentity === undefined ? {} : { rootIdentity: input.rootIdentity }),
      extraFolders,
      driver,
      firstTurn:
        !priorTurn &&
        resumeCursor === undefined &&
        switchHandoff?.record === undefined &&
        forkHandoff?.record === undefined &&
        forkMerges.records.length === 0,
      carriedSentContext: carriedSentContext({
        freshSession: resumeCursor === undefined,
        forkSeeded,
        priorTurn,
        previousBreakdown: recovered.priorTurnBreakdown,
        compactedSinceReport:
          recovered.priorTurnReportSequence !== undefined &&
          this.#options.sessionCompactions?.compactedAfter(
            input.thread.id,
            recovered.priorTurnReportSequence,
          ) === true,
      }),
      ...(input.sentContext === undefined ? {} : { sentContext: input.sentContext }),
      ...(input.onContextDelivered === undefined
        ? {}
        : { onContextDelivered: input.onContextDelivered }),
      secrets,
      abort: new AbortController(),
      approvals: new Map(),
      approvalPostures: new Map(),
      toolApprovals: new Map(),
      browserGrantKeys: new Set(),
      browserProfileContexts: new Set(),
      questions: new Set(),
      harnessQuestions: new Set(),
      providerQuestionnaires: new Map(),
      cursor: 0,
      deniedApprovals: 0,
      state: "running",
    };
    active.launch = () =>
      this.#launch(
        active,
        input.prompt,
        context.length === 0 ? undefined : context,
        attachments.length === 0 ? undefined : attachments,
      );
    this.#active.set(key, active);
    // The turn is the unit of work, so the operation it runs under is the
    // record's identity. It opens here rather than in `#launch`, because a turn
    // that never reaches its launch still holds the thread until something
    // closes it.
    this.#observeRuntimeWorkOutcome(
      this.#runtimeWork.open({
        id: active.operationId,
        threadId: active.thread.id,
        kind: "provider-turn",
        remoteStep: undefined,
      }),
    );
    return turnState("running");
  }

  /**
   * The handoff a turn that moved to another provider starts with, or the one
   * a recovered turn already journaled.
   *
   * A turn's handoff is chosen once. If its operation already journaled one
   * (a start recovered after a restart), that record is read back rather than
   * the conversation selected again, so a recovery never sends context other
   * than what was disclosed. That includes a recovery whose new session was
   * already recorded: the provider may never have received the prompt the
   * handoff went with, so it is sent again with it. A fork's journaled record
   * is read back the same way. Otherwise, only for a turn that moved
   * providers, the thread's own conversation is selected and checked to be
   * this thread's in this Project; a forked thread also carries the source's
   * conversation through the fork point, read only after the sending window
   * is authorized against the source. The record is journaled when the new
   * session is ready.
   */
  async #providerSwitchHandoff(
    thread: CodeThread,
    operationId: CodeOperationId,
    previous: Extract<CodeOperationEvent, { readonly kind: "provider-session-ready" }> | undefined,
    windowId: WindowId,
    /** Why the previous session is not resumed: another provider or model, or a rewind. */
    reason: "provider-switch" | "rewind" = "provider-switch",
  ): Promise<
    | {
        readonly status: "ready";
        readonly blocks: ReadonlyArray<ProviderContextBlock>;
        readonly record?: PendingHandoffRecord;
        /** What an already journaled record carried, when this read it back. */
        readonly journaled?: "text" | "native-session";
        readonly inputSelection?: Extract<
          AgentRunParentContextSelection,
          { readonly status: "available" }
        >;
        readonly inputReceipt?: ConversationInputReceipt;
      }
    | { readonly status: "refused"; readonly refusal: HandoffRefusal }
    | undefined
  > {
    const refused = (refusal: HandoffRefusal) => ({ status: "refused", refusal }) as const;
    const replay = this.#events.replay({
      threadId: thread.id,
      operationId,
      afterCursor: 0,
      limit: MAX_CODE_OPERATION_REPLAY_LIMIT,
    });
    if (replay.status !== "ok")
      return previous === undefined
        ? thread.forkedFrom === undefined
          ? undefined
          : refused({ subject: "fork", reason: "source-unavailable" })
        : refused({ subject: "switch", reason: "source-unavailable" });
    const journaled = replay.frames.find(
      (frame) => frame.event.kind === "context-handoff-attached",
    )?.event;
    if (journaled?.kind === "context-handoff-attached") {
      const leftSession =
        journaled.reason === "provider-switch" ||
        journaled.reason === "rewind" ||
        journaled.reason === "rewind-native-session";
      const subject = leftSession
        ? journaled.reason === "provider-switch"
          ? "switch"
          : "rewind"
        : "fork";
      const sameOrigin = (origin: NonNullable<CodeThread["forkedFrom"]>) =>
        thread.forkedFrom !== undefined &&
        String(thread.forkedFrom.threadId) === String(origin.threadId) &&
        String(thread.forkedFrom.throughOperationId) === String(origin.throughOperationId);
      // A selection changed since the record belongs to a different switch or
      // fork than the one the record disclosed.
      if (
        String(journaled.providerInstanceId) !== String(thread.providerInstanceId) ||
        String(journaled.modelId) !== String(thread.modelId) ||
        (leftSession &&
          previous !== undefined &&
          String(journaled.previousSessionId) !== String(previous.sessionId)) ||
        ((journaled.reason === "fork" || journaled.reason === "fork-native-session") &&
          !sameOrigin(journaled.forkedFrom))
      )
        return refused({ subject, reason: "source-changed" });
      if (
        (journaled.reason === "provider-switch" || journaled.reason === "rewind") &&
        journaled.inherited !== undefined &&
        !sameOrigin(journaled.inherited.forkedFrom)
      )
        return refused({ subject: "inherited", reason: "source-changed" });
      if (
        journaled.reason === "fork-native-session" ||
        journaled.reason === "rewind-native-session"
      )
        return { status: "ready", blocks: [], journaled: "native-session" };
      try {
        const text = await this.#options.evidence.read?.(journaled.content);
        if (text === undefined) return refused({ subject, reason: "handoff-unreadable" });
        return {
          status: "ready",
          blocks: decodeAgentRunAdmittedContext(JSON.parse(text)),
          ...(journaled.inputReceipt === undefined ? {} : { inputReceipt: journaled.inputReceipt }),
          journaled: "text",
        };
      } catch {
        return refused({ subject, reason: "handoff-unreadable" });
      }
    }
    if (previous === undefined) return undefined;
    const own = reason === "rewind" ? "rewind" : "switch";
    const select = this.#options.providerSwitchContext;
    if (select === undefined) return refused({ subject: own, reason: "unsupported" });
    // A fork carries the conversation it inherited. The source is authorized
    // for this window before anything is read out of it; a source that can no
    // longer be read refuses the switch rather than handing the new provider
    // only the fork's own turns while its transcript shows the inherited ones.
    const origin = thread.forkedFrom;
    let inheritedFrom:
      | { readonly source: CodeThread; readonly throughOperationId: string }
      | undefined;
    if (origin !== undefined) {
      const readable = await this.#readableForkSource(thread, origin, windowId);
      if (readable.status === "refused")
        return refused({ subject: "inherited", reason: readable.reason });
      inheritedFrom = {
        source: readable.source,
        throughOperationId: String(origin.throughOperationId),
      };
    }
    let selection: AgentRunParentContextSelection;
    try {
      selection = select({
        thread,
        excludeOperationId: operationId,
        purpose: reason,
        ...(inheritedFrom === undefined ? {} : { inheritedFrom }),
      });
    } catch {
      return refused({ subject: own, reason: "source-unavailable" });
    }
    if (selection.status === "unavailable")
      return refused(
        selection.part === "inherited"
          ? { subject: "inherited", reason: selection.reason }
          : { subject: own, reason: selection.reason },
      );
    // The selector is handed this thread, but what it read is checked here too:
    // a handoff is the thread's own conversation, never another thread's or
    // another Project's that a reader happened to return.
    if (selection.source.mode !== "code" || selection.source.threadId !== String(thread.id))
      return refused({ subject: own, reason: "foreign-thread" });
    if (selection.source.projectId !== String(thread.projectId))
      return refused({ subject: own, reason: "foreign-project" });
    // The same holds for what a fork inherited: exactly the authorized source,
    // in this thread's Project, and present whenever it was asked for.
    const inherited = selection.inherited;
    if (origin !== undefined) {
      if (
        inherited === undefined ||
        inherited.source.mode !== "code" ||
        inherited.source.threadId !== String(origin.threadId)
      )
        return refused({ subject: "inherited", reason: "foreign-thread" });
      if (inherited.source.projectId !== String(thread.projectId))
        return refused({ subject: "inherited", reason: "foreign-project" });
    }
    // A switch to another provider leads with the summary the limit rule
    // wrote, when one waits. A fork's handoff also carries its source's turns,
    // which that summary never read, so a fork hands over as before.
    const handover =
      reason === "provider-switch" && origin === undefined
        ? this.#handoverSummary(thread)
        : undefined;
    const carried = withHandoverSummary(selection, handover);
    return {
      status: "ready",
      blocks: carried.blocks,
      inputSelection: carried,
      record: {
        kind: "context-handoff-attached",
        reason,
        previousProviderInstanceId: previous.providerInstanceId,
        previousModelId: previous.modelId,
        previousSessionId: previous.sessionId,
        providerInstanceId: thread.providerInstanceId,
        modelId: thread.modelId,
        messages: carried.blocks.filter((block) => block.kind !== "conversation-summary").length,
        omissions: carried.omissions,
        externalContentIngested: carried.source.externalContentIngested,
        ...(carried === selection ? {} : { handoverSummary: true as const }),
        ...(origin === undefined || inherited === undefined
          ? {}
          : {
              inherited: {
                forkedFrom: origin,
                messages: inherited.messages,
                externalContentIngested: inherited.source.externalContentIngested,
              },
            }),
        nativeSessionTransferred: false,
        hiddenReasoningTransferred: false,
      },
    };
  }

  /** The limit rule's summary for the thread, if one waits; a read that fails hands over as before. */
  #handoverSummary(
    thread: CodeThread,
  ): { readonly content: string; readonly completedAt: string } | undefined {
    try {
      return this.#options.handoverSummary?.(thread);
    } catch {
      return undefined;
    }
  }

  /**
   * The thread a fork was made from, once the window sending this turn may
   * read it. The origin is on the fork's own record and was checked when the
   * fork was created, but the window is authorized against the source here,
   * at the moment it is read: a window that may not observe the source reads
   * nothing out of it through the fork, on its first turn or a later switch.
   */
  async #readableForkSource(
    thread: CodeThread,
    origin: NonNullable<CodeThread["forkedFrom"]>,
    windowId: WindowId,
  ): Promise<
    | { readonly status: "readable"; readonly source: CodeThread }
    | {
        readonly status: "refused";
        readonly reason: Extract<
          CodeForkHandoffRefusal,
          "source-unavailable" | "thread-unavailable" | "source-unauthorized" | "foreign-project"
        >;
      }
  > {
    let source: CodeThread | undefined;
    try {
      source = this.#options.persistence.readCodeThread(origin.threadId);
    } catch {
      return { status: "refused", reason: "source-unavailable" };
    }
    if (source === undefined) return { status: "refused", reason: "thread-unavailable" };
    let authorized: boolean;
    try {
      authorized = await this.#options.windowAccess.canAccessProject(windowId, source.projectId);
    } catch {
      authorized = false;
    }
    if (!authorized) return { status: "refused", reason: "source-unauthorized" };
    if (String(source.projectId) !== String(thread.projectId))
      return { status: "refused", reason: "foreign-project" };
    return { status: "readable", source };
  }

  /** A fork's text handoff: the source's conversation through the fork point. */
  async #forkTextHandoff(
    thread: CodeThread,
    origin: NonNullable<CodeThread["forkedFrom"]>,
    windowId: WindowId,
  ): Promise<
    | {
        readonly status: "ready";
        readonly blocks: ReadonlyArray<ProviderContextBlock>;
        readonly record: PendingHandoffRecord;
        readonly inputSelection: Extract<
          AgentRunParentContextSelection,
          { readonly status: "available" }
        >;
      }
    | { readonly status: "refused"; readonly reason: CodeForkHandoffRefusal }
  > {
    if (this.#options.forkContext === undefined)
      return { status: "refused", reason: "unsupported" };
    const readable = await this.#readableForkSource(thread, origin, windowId);
    if (readable.status === "refused") return readable;
    // The fork's handoff is read by the fork's own model, so its bound comes
    // from that model's window when the probe reported it, exactly as a
    // provider switch's does.
    const targetProbe = await this.#options
      .probeProvider?.(thread.providerInstanceId)
      .catch(() => undefined);
    const targetContextLimitTokens = targetProbe?.models.find(
      (candidate) => String(candidate.id) === String(thread.modelId),
    )?.contextLimit;
    const selected = selectCodeForkHandoff(this.#options.forkContext, {
      source: readable.source,
      origin,
      projectId: thread.projectId,
      ...(targetContextLimitTokens === undefined ? {} : { targetContextLimitTokens }),
    });
    if (selected.status === "refused") return selected;
    const { selection } = selected;
    return {
      status: "ready",
      blocks: selection.blocks,
      inputSelection: selection,
      record: {
        kind: "context-handoff-attached",
        reason: "fork",
        forkedFrom: origin,
        providerInstanceId: thread.providerInstanceId,
        modelId: thread.modelId,
        messages: selection.blocks.length - 1,
        omissions: selection.omissions,
        externalContentIngested: selection.source.externalContentIngested,
        nativeSessionTransferred: false,
        hiddenReasoningTransferred: false,
      },
    };
  }

  async answerInput(
    input: Parameters<CodeOperationTurnPort["answerInput"]>[0],
  ): Promise<Awaited<ReturnType<CodeOperationTurnPort["answerInput"]>>> {
    const active = this.#owned(input.thread, input.checkoutRoot);
    if (active === undefined || !active.questions.has(input.requestId)) {
      return this.#settleDeadTurnRequest(input.thread, "input", String(input.requestId));
    }
    if (active.harnessQuestions.has(input.requestId)) {
      // A harness question is the host's own; the provider never saw it and
      // is waiting on the tool call that asked.
      const outcome = this.#options.nativeHarness?.answerQuestion?.(
        String(active.thread.id),
        input.requestId,
        input.response,
      );
      if (outcome === "invalid-answer")
        return {
          state: active.state,
          failure: {
            category: "invalid",
            message: "The questionnaire answer is incomplete or contains invalid choices.",
          },
        };
      if (outcome === "already-settled" || outcome === "question-not-found")
        return {
          state: active.state,
          failure: { category: "stale", message: "That question is no longer pending." },
        };
      active.questions.delete(input.requestId);
      active.harnessQuestions.delete(input.requestId);
      return answeredTurnState(active.state);
    }
    if (active.connection === undefined) return turnState("failed");
    const questionnaire = active.providerQuestionnaires.get(input.requestId);
    if (
      questionnaire !== undefined &&
      validateQuestionnaireAnswer(questionnaire, input.response).status === "invalid"
    ) {
      return {
        state: active.state,
        failure: {
          category: "invalid",
          message: "The questionnaire answer is incomplete or contains invalid choices.",
        },
      };
    }
    active.questions.delete(input.requestId);
    active.providerQuestionnaires.delete(input.requestId);
    await Effect.runPromise(
      active.connection.answerUserInput({
        sessionId: active.sessionId as never,
        requestId: input.requestId,
        answer: input.response,
      }),
    );
    return answeredTurnState(active.state);
  }

  /**
   * Shows a native-harness question on this thread's own question surface,
   * so it is answered exactly where a provider's question would be. Nothing
   * happens for a thread without a running turn: the harness only asks from
   * inside one.
   */
  raiseHarnessQuestion(input: {
    readonly threadId: string;
    readonly questionId: string;
    readonly questionnaire?: Questionnaire;
    readonly prompt: string;
    readonly options: ReadonlyArray<string>;
  }): boolean {
    const active = this.#active.get(input.threadId);
    if (active === undefined || active.state !== "running") return false;
    active.questions.add(input.questionId);
    active.harnessQuestions.add(input.questionId);
    const frame = this.#appendTurnEvent(active, {
      event: {
        kind: "input-requested",
        ...(input.questionnaire === undefined ? {} : { questionnaire: input.questionnaire }),
        requestId: input.questionId,
        prompt: input.prompt,
        options: input.options,
      } as never,
    });
    active.cursor = frame.cursor;
    return true;
  }

  /**
   * Forgets a native-harness question the harness has already settled. Only
   * a question this turn raised for the harness is removed; a provider's own
   * question with the same id is left alone.
   */
  withdrawHarnessQuestion(input: { readonly threadId: string; readonly questionId: string }): void {
    const active = this.#active.get(input.threadId);
    if (active === undefined || !active.harnessQuestions.has(input.questionId)) return;
    active.harnessQuestions.delete(input.questionId);
    active.questions.delete(input.questionId);
  }

  /**
   * Journals one Octant Shield decision on the thread's running turn, where
   * the transcript shows it beside the tool rows. A thread with no live turn
   * has no transcript row to add it to; the approval journal that asked still
   * holds the decision.
   */
  recordShieldReview(input: {
    readonly threadId: string;
    readonly summary: string;
    readonly decision: ShieldDecision;
  }): void {
    const active = this.#active.get(input.threadId);
    if (active === undefined || (active.state !== "running" && active.state !== "waiting")) return;
    const summary = boundProviderSummary(input.summary) ?? "Tool call";
    try {
      const frame = this.#appendTurnEvent(active, {
        event: { kind: "approval-reviewed", summary, decision: input.decision },
      });
      active.cursor = frame.cursor;
    } catch {
      // A journal that refuses the row leaves the decision where it was made.
    }
  }

  /**
   * A provider's pending approval prompt. Recognizable forge writes below
   * Full access must use the scoped tools; only other calls reach Shield when
   * it reviews this thread. An allow or deny goes back to the provider for this
   * one call and nobody is asked; an ask, or a thread Shield does not review,
   * becomes the ordinary approval for the person. Shield's decision is
   * journaled beside the tool rows either way. The pending call comes from the
   * connection, never from the event: the event's text had the checkout path
   * replaced with a placeholder, which is put back so its description reads
   * as the runtime wrote it.
   */
  async #reviewProviderApproval(active: ActiveTurn, event: CodeTurnEvent): Promise<void> {
    const shield = this.#options.shield;
    const requestId = event.requestId;
    if (requestId === undefined || active.connection === undefined) {
      this.#persistNormalized(active, event);
      return;
    }
    // A runtime that has not yet answered a Stop can keep working and ask for
    // more. The person asked for the turn to end, so nothing new is put to
    // them; the request is declined and the turn waits for the runtime.
    if (active.abort.signal.aborted) {
      await Effect.runPromise(
        active.connection
          .answerApproval({
            sessionId: active.sessionId as never,
            requestId,
            approved: false,
            scope: "once",
          })
          .pipe(Effect.catchAll(() => Effect.void)),
      );
      return;
    }
    const restore = (text: string | undefined) =>
      text?.replaceAll("[CHECKOUT]", active.checkoutRoot);
    const summary = event.text ?? "Provider approval requested.";
    let call: ReturnType<NonNullable<ProviderConnection["approvalCall"]>>;
    try {
      call = active.connection.approvalCall?.({
        sessionId: active.sessionId as never,
        requestId,
      });
    } catch {
      call = undefined;
    }
    const pendingCall = shieldCallFromProviderRequest({
      tool: call?.tool ?? "provider-action",
      input: call?.input,
      workingDirectory: call?.workingDirectory,
      description: restore(summary) ?? summary,
      boundRoot: active.checkoutRoot,
    });
    // Only a pending call supplied by the connection can be stopped here.
    // A provider's own reviewer and tool-start observations never enter this path.
    const posture = this.#effectiveThread(active.windowId, active.thread.id)?.executionPolicy;
    if (
      posture !== "full-access" &&
      pendingCall.command !== undefined &&
      forgeShellChanges(pendingCall.command).length > 0
    ) {
      const frame = this.#appendTurnEvent(active, {
        event: {
          kind: "tool-activity",
          toolCallId: `forge-refusal:${requestId}`,
          toolName: pendingCall.tool,
          state: "failed",
          summary: FORGE_SHELL_TOOL_REQUIRED_MESSAGE,
        },
      });
      active.cursor = frame.cursor;
      try {
        await Effect.runPromise(
          active.connection.answerApproval({
            sessionId: active.sessionId as never,
            requestId,
            approved: false,
            scope: "once",
          }),
        );
      } catch {
        // A denied forge call must never become an ordinary approvable prompt.
        active.interruptMessage = FORGE_SHELL_TOOL_REQUIRED_MESSAGE;
        active.abort.abort();
        await Effect.runPromise(
          active.connection
            .interrupt(active.sessionId as never)
            .pipe(Effect.catchAll(() => Effect.void)),
        );
      }
      return;
    }
    if (shield === undefined) {
      this.#persistNormalized(active, event);
      return;
    }
    let decision: ShieldDecision | undefined;
    try {
      decision = await shield.review({
        threadId: String(active.thread.id),
        call: pendingCall,
        boundRoot: active.checkoutRoot,
        signal: active.abort.signal,
      });
    } catch {
      decision = undefined;
    }
    if (active.state !== "running" && active.state !== "waiting") return;
    if (decision === undefined) {
      this.#persistNormalized(active, event);
      return;
    }
    this.recordShieldReview({ threadId: String(active.thread.id), summary, decision });
    if (decision.verdict === "ask") {
      this.#persistNormalized(active, event);
      return;
    }
    // Shield's answer covers this one call. It is not the person's, so it
    // does not count toward the three refusals that end a turn; Shield's own
    // brake hands the next call to the person after repeated denials.
    try {
      await Effect.runPromise(
        active.connection.answerApproval({
          sessionId: active.sessionId as never,
          requestId,
          approved: decision.verdict === "allow",
          // Shield's answer covers this one call; nothing is remembered.
          scope: "once",
        }),
      );
    } catch {
      // A provider that cannot take the answer is asked by the person instead,
      // through the ordinary approval, which cannot widen what Shield decided.
      this.#persistNormalized(active, event);
    }
  }

  /** Whether this thread's running turn has an approval or a question still unanswered. */
  awaitsPerson(threadId: string): boolean {
    const active = this.#active.get(threadId);
    if (active === undefined || (active.state !== "running" && active.state !== "waiting"))
      return false;
    return active.approvals.size > 0 || active.toolApprovals.size > 0 || active.questions.size > 0;
  }

  /**
   * The approvals and questions running turns in this process are parked on,
   * with the text and time the journal recorded when each was asked. Only a
   * live turn can deliver an answer: a journaled request whose turn died with
   * the process is settled interrupted by its answer, so it is never offered.
   * A turn whose stream cannot be replayed whole offers nothing rather than a
   * request without its journaled text.
   */
  pendingRequests(): ReadonlyArray<CodeTurnPendingRequest> {
    const pending: CodeTurnPendingRequest[] = [];
    for (const active of this.#active.values()) {
      if (active.state !== "running" && active.state !== "waiting") continue;
      const approvals = new Set([...active.approvals.keys(), ...active.toolApprovals.keys()]);
      if (approvals.size === 0 && active.questions.size === 0) continue;
      // A provider may ask again under an identity it used before; the latest
      // ask is the one still waiting.
      const asked = new Map<string, CodeTurnPendingRequest>();
      for (const frame of this.#operationFrames(active)) {
        const event = frame.event;
        const scope = {
          threadId: active.thread.id,
          checkoutId: active.thread.checkoutId,
          requestedAt: frame.occurredAt,
        };
        if (event.kind === "approval-requested" && approvals.has(String(event.approvalId))) {
          const browserOrigin = active.toolApprovals.get(String(event.approvalId))?.origin;
          asked.set(`approval:${String(event.approvalId)}`, {
            ...scope,
            kind: "approval",
            approvalId: event.approvalId,
            summary: event.summary,
            ...(browserOrigin === undefined ? {} : { browserOrigin }),
          });
        } else if (event.kind === "input-requested" && active.questions.has(event.requestId)) {
          asked.set(`question:${event.requestId}`, {
            ...scope,
            kind: "question",
            requestId: event.requestId,
            prompt: event.prompt,
            options: event.options,
          });
        }
      }
      pending.push(...asked.values());
    }
    return pending;
  }

  /**
   * The other threads whose live turn would race an in-place restore of this
   * checkout root. `executionPolicy` on a live turn's thread is its clamped
   * posture, so a Plan turn is not reported.
   */
  threadsWritingIn(checkoutRoot: string, exceptThreadId: CodeThreadId): ReadonlyArray<CodeThread> {
    const writing: CodeThread[] = [];
    for (const active of this.#active.values()) {
      if (
        turnBlocksInPlaceRestore(
          {
            threadId: String(active.thread.id),
            checkoutRoot: active.checkoutRoot,
            state: active.state,
            posture: active.thread.executionPolicy,
          },
          { threadId: String(exceptThreadId), checkoutRoot },
        )
      ) {
        writing.push(active.thread);
      }
    }
    return writing;
  }

  #operationFrames(active: ActiveTurn): ReadonlyArray<CodeOperationEventFrame> {
    const frames: CodeOperationEventFrame[] = [];
    let afterCursor = 0;
    for (;;) {
      const replay = this.#events.replay({
        threadId: active.thread.id,
        operationId: active.operationId,
        afterCursor,
        limit: MAX_CODE_OPERATION_REPLAY_LIMIT,
      });
      if (replay.status !== "ok") return [];
      frames.push(...replay.frames);
      const last = replay.frames.at(-1);
      if (last === undefined || replay.frames.length < MAX_CODE_OPERATION_REPLAY_LIMIT) {
        return frames;
      }
      afterCursor = last.cursor;
    }
  }

  #browserApprovalKey(active: ActiveTurn, contextId: string): string {
    return JSON.stringify([
      active.windowId,
      active.thread.id,
      active.thread.checkoutId,
      active.thread.providerInstanceId,
      active.thread.modelId,
      contextId,
    ]);
  }

  #askBrowserApproval(
    active: ActiveTurn,
    origin: string,
    signal?: AbortSignal,
  ): Promise<"approved" | "denied" | "cancelled" | "expired"> {
    return this.#askToolApproval(
      active,
      `Allow this thread to use an isolated browser session at ${origin.slice(0, 512)}? Shell and file access stay unchanged.`,
      origin.slice(0, 2048),
      signal,
    );
  }

  /**
   * One device effect the thread's agent asked for, asked of the person in the
   * thread like a Browser session. An approval becomes the host's one-use
   * approval for exactly that request, so the Apple or Android policy checks it
   * as it checks a workbench click's. Only an approved input goes on to open
   * the window's Allow input grant, exactly as a pane input does.
   */
  async #askDeviceApproval(
    active: ActiveTurn,
    effect: CodeDeviceApprovalEffect,
    signal?: AbortSignal,
  ): Promise<
    | { readonly status: "approved"; readonly approvalId: ToolApprovalId }
    | { readonly status: "denied" | "cancelled" | "expired" | "unavailable" }
  > {
    const store = this.#approvalStore;
    if (store === undefined) return { status: "unavailable" };
    const asked = await this.#deviceApprovalPrompt(active, effect);
    if (asked === undefined) return { status: "unavailable" };
    const { context, prompt } = asked;
    const summary = boundProviderSummary(`${prompt.message}\n${prompt.detail}`);
    if (summary === undefined) return { status: "unavailable" };
    const outcome = await this.#askToolApproval(active, summary, undefined, signal);
    if (outcome !== "approved") return { status: outcome };
    try {
      const receipt = store.issue({
        windowId: active.windowId,
        effect,
        contextDigest: approvalContextDigest(context),
      });
      return receipt === undefined
        ? { status: "unavailable" }
        : { status: "approved", approvalId: ToolApprovalId.make(String(receipt.approvalId)) };
    } catch {
      // Host time recovery refuses to mint approvals; the effect stays refused.
      return { status: "unavailable" };
    }
  }

  /**
   * One pull-request change the thread's agent asked for, asked of the person
   * in the thread like a device effect. An approval becomes the host's one-use
   * approval for exactly that command, bound to the thread's delivery target,
   * which the operation service validates before `gh` runs.
   */
  /**
   * One command the agent wants to type into its thread terminal, asked of the
   * person in the thread with the command shown. When the terminal must start
   * first, an approval mints the host's one-use approval for exactly that
   * start, which the operation gate checks as it checks any approved effect.
   */
  async #askTerminalApproval(
    active: ActiveTurn,
    input: { readonly text: string; readonly start?: CodeOperationCommand },
    signal?: AbortSignal,
  ): Promise<"approved" | "denied" | "cancelled" | "expired" | "unavailable"> {
    const shown = `Run this in the thread's terminal?\n${input.text}`;
    const summary = boundProviderSummary(shown);
    // The person must read the whole command they allow.
    if (summary === undefined || summary !== shown.trim()) return "unavailable";
    const outcome = await this.#askToolApproval(active, summary, undefined, signal);
    if (outcome !== "approved" || input.start === undefined) return outcome;
    const store = this.#approvalStore;
    if (store === undefined) return "unavailable";
    const thread = this.#options.persistence.readCodeThread(active.thread.id);
    const checkout = this.#options.persistence.readCodeCheckout(active.thread.checkoutId);
    if (thread === undefined || checkout === undefined) return "unavailable";
    const context = await approvalContext(this.#options, input.start, thread, checkout);
    if (context === undefined) return "unavailable";
    try {
      const receipt = store.issue({
        windowId: active.windowId,
        effect: { kind: "operation", command: input.start },
        contextDigest: approvalContextDigest(context),
      });
      return receipt === undefined ? "unavailable" : "approved";
    } catch {
      // Host time recovery refuses to mint approvals; the start stays refused.
      return "unavailable";
    }
  }

  async #askPullRequestApproval(
    active: ActiveTurn,
    command: PullRequestToolCommand,
    signal?: AbortSignal,
  ): Promise<
    | { readonly status: "approved"; readonly approvalId: CodeApprovalId }
    | { readonly status: "denied" | "cancelled" | "expired" | "unavailable" | "too-large" }
  > {
    const store = this.#approvalStore;
    if (store === undefined) return { status: "unavailable" };
    const thread = this.#options.persistence.readCodeThread(command.threadId);
    const checkout = this.#options.persistence.readCodeCheckout(command.checkoutId);
    if (
      thread === undefined ||
      checkout === undefined ||
      String(thread.id) !== String(active.thread.id) ||
      thread.checkoutId !== checkout.id ||
      thread.lifecycle !== "active" ||
      checkout.availability !== "available" ||
      !(await this.#options.windowAccess.canAccessProject(active.windowId, thread.projectId))
    ) {
      return { status: "unavailable" };
    }
    const context = await approvalContext(this.#options, command, thread, checkout);
    if (context === undefined) return { status: "unavailable" };
    const effect: CodeOperationApprovalRequest["effect"] = { kind: "operation", command };
    const prompt = approvalPrompt(effect, thread, checkout, context.pullRequestTarget);
    const shown = `${prompt.message}\n${prompt.detail}`;
    const summary = boundProviderSummary(shown);
    if (summary === undefined) return { status: "unavailable" };
    // The approval authorizes the full title and body, so the person must be
    // able to read all of it; a prompt cut at the summary bound would have
    // them allow text they never saw.
    if (summary !== shown.trim()) return { status: "too-large" };
    const outcome = await this.#askToolApproval(active, summary, undefined, signal);
    if (outcome !== "approved") return { status: outcome };
    try {
      const receipt = store.issue({
        windowId: active.windowId,
        effect,
        contextDigest: approvalContextDigest(context),
      });
      return receipt === undefined
        ? { status: "unavailable" }
        : { status: "approved", approvalId: receipt.approvalId };
    } catch {
      // Host time recovery refuses to mint approvals; the change stays refused.
      return { status: "unavailable" };
    }
  }

  /**
   * One watch the thread's agent asked for, asked of the person in the thread
   * with the pull request and the watch's bounds named. Nothing is minted: the
   * watch turns on inside this same tool call, right after the answer, and the
   * switch service checks the window and the thread again before it does.
   */
  #askPullRequestWatchApproval(
    active: ActiveTurn,
    target: CodeProjectPullRequestSwitchTarget,
    signal?: AbortSignal,
  ): Promise<"approved" | "denied" | "cancelled" | "expired" | "unavailable"> {
    const summary = boundProviderSummary(
      `Let this thread's agent watch pull request #${target.number} in ${target.repositoryOwner}/${target.repositoryName}? Octant will start a new turn here when its checks finish, a review or comment arrives, or a merge conflict appears: at most ${CODE_PROJECT_PULL_REQUEST_WATCH_MAX_WAKES} times, for up to ${CODE_PROJECT_PULL_REQUEST_WATCH_LIFETIME_MS / 86_400_000} days, ending when it merges or closes. Each turn runs at this thread's access level.`,
    );
    return summary === undefined
      ? Promise.resolve("unavailable")
      : this.#askToolApproval(active, summary, undefined, signal);
  }

  /**
   * The wording and binding context of one device approval. A Simulator,
   * emulator, or device effect is asked only while the turn's posture decides
   * effects by approval; a device lease is asked under every posture, Full
   * access and Plan included, and names the device and the thread exactly as
   * the desktop's lease confirmation does.
   */
  async #deviceApprovalPrompt(
    active: ActiveTurn,
    effect: CodeDeviceApprovalEffect,
  ): Promise<
    | {
        readonly context: ApprovalContext;
        readonly prompt: { readonly message: string; readonly detail: string };
      }
    | undefined
  > {
    // The turn's posture, not the stored one: a Full-access thread running an
    // approval-gated turn asks here too, and its stored policy alone refused it.
    const turnPosture = (thread: CodeThread) => this.threadWithActiveTurnPosture(thread);
    const scope = await resolveDeviceApprovalScope(
      this.#options,
      active.windowId,
      effect.request,
      turnPosture,
    );
    if (scope === undefined) return undefined;
    const context = await approvalContext(this.#options, undefined, scope.thread, scope.checkout);
    return context === undefined
      ? undefined
      : { context, prompt: approvalPrompt(effect, scope.thread, scope.checkout, undefined) };
  }

  #askToolApproval(
    active: ActiveTurn,
    summary: string,
    origin: string | undefined,
    signal?: AbortSignal,
  ): Promise<"approved" | "denied" | "cancelled" | "expired"> {
    if (signal?.aborted || active.abort.signal.aborted || active.toolApprovals.size >= 4)
      return Promise.resolve("cancelled");
    const approvalId = CodeApprovalId.make(this.#options.uuid());
    return new Promise((resolve) => {
      const finish = (outcome: "approved" | "denied" | "cancelled" | "expired") => {
        if (!active.toolApprovals.delete(String(approvalId))) return;
        active.approvalPostures.delete(String(approvalId));
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        active.abort.signal.removeEventListener("abort", abort);
        // An answer journals its own operation result; expiry and abandonment
        // journal nothing.
        if (outcome === "cancelled" || outcome === "expired") {
          this.#options.onPendingRequestWithdrawn?.();
        }
        resolve(outcome);
      };
      const abort = () => finish("cancelled");
      const timer = setTimeout(() => finish("expired"), 10 * 60_000);
      active.toolApprovals.set(String(approvalId), {
        ...(origin === undefined ? {} : { origin }),
        finish,
      });
      active.approvalPostures.set(String(approvalId), this.#approvalPosture(active));
      signal?.addEventListener("abort", abort, { once: true });
      active.abort.signal.addEventListener("abort", abort, { once: true });
      try {
        const frame = this.#appendTurnEvent(active, {
          event: {
            kind: "approval-requested",
            approvalId,
            action: "provider-tool",
            summary,
          },
        });
        active.cursor = frame.cursor;
      } catch {
        finish("cancelled");
      }
    });
  }

  ownerApprovals(): ReadonlyArray<RuntimeApprovalRecovery> {
    const pending: RuntimeApprovalRecovery[] = [];
    for (const active of this.#active.values()) {
      if (active.abort.signal.aborted || (active.state !== "running" && active.state !== "waiting"))
        continue;
      for (const requestId of active.toolApprovals.keys()) {
        pending.push({
          mode: "code",
          threadId: active.thread.id,
          requestId: OwnerApprovalId.make(requestId),
          identity: String(active.operationId),
          action: undefined,
          current: () => false,
          answer: async () => false,
        });
      }
      for (const [requestId, callback] of active.approvals) {
        pending.push({
          mode: "code",
          threadId: active.thread.id,
          requestId: OwnerApprovalId.make(requestId),
          root: active.checkoutRoot,
          identity: JSON.stringify({
            operationId: active.operationId,
            sessionId: active.sessionId,
            callback,
            windowId: active.windowId,
            policy: active.thread.executionPolicy,
            persistence: active.thread.permissionPersistence,
          }),
          get action() {
            try {
              return active.connection?.approvalCall?.({
                sessionId: decodeProviderSessionId(active.sessionId),
                requestId: callback,
              })?.ownerAction;
            } catch {
              return undefined;
            }
          },
          current: () =>
            this.#active.get(active.thread.id) === active &&
            active.approvals.get(requestId) === callback &&
            !active.abort.signal.aborted &&
            (active.state === "running" || active.state === "waiting"),
          answer: async (approved, current, principal) => {
            const thread = this.#options.persistence.readCodeThread(active.thread.id);
            if (thread === undefined || !current() || active.abort.signal.aborted) return false;
            let outcome: "approved" | "denied" | "uncertain" = "uncertain";
            try {
              const result = await this.answerApproval(
                {
                  thread,
                  checkoutRoot: active.checkoutRoot,
                  approvalId: requestId,
                  decision: approved ? "approved" : "denied",
                },
                current,
              );
              if (result.state === "failed") return false;
              outcome = approved ? "approved" : "denied";
              return true;
            } finally {
              if (!active.approvals.has(requestId)) {
                const frame = this.#appendTurnEvent(active, {
                  event: {
                    kind: "owner-approval-settled",
                    approvalId: CodeApprovalId.make(requestId),
                    outcome,
                    actingPrincipal: principal,
                  },
                });
                active.cursor = frame.cursor;
                this.#options.onPendingRequestWithdrawn?.();
              }
            }
          },
        });
      }
    }
    return pending;
  }

  async answerApproval(
    input: Parameters<CodeOperationTurnPort["answerApproval"]>[0],
    ownerCurrent?: () => boolean,
  ) {
    if (ownerCurrent !== undefined && !ownerCurrent()) return turnState("failed");
    const active = this.#owned(input.thread, input.checkoutRoot);
    const providerRequestId = active?.approvals.get(input.approvalId);
    const turnPosture =
      active === undefined
        ? undefined
        : clampTurnAccessPosture({
            requested: active.thread.executionPolicy,
            thread: input.thread.executionPolicy,
          });
    const toolApproval = active?.toolApprovals.get(input.approvalId);
    if (
      active !== undefined &&
      (toolApproval !== undefined || providerRequestId !== undefined) &&
      input.decision === "approved"
    ) {
      // An allow given under a wider posture must not take effect after the
      // person narrowed it, so the ask stands again under the posture the
      // thread holds now. A denial never widens and is delivered as asked.
      const current = this.#approvalPosture(active);
      if (
        approvalAnswerUnderPosture({
          approved: true,
          askedUnder: active.approvalPostures.get(input.approvalId),
          current,
        }) === "ask-again"
      ) {
        active.approvalPostures.set(input.approvalId, current);
        return turnState("failed", {
          category: "failed",
          message: APPROVAL_POSTURE_CHANGED_MESSAGE,
        });
      }
    }
    if (active !== undefined && toolApproval !== undefined) {
      if (
        input.decision === "approved" &&
        (turnPosture === "plan" ||
          active.thread.permissionPersistence !== input.thread.permissionPersistence)
      )
        return turnState("failed");
      toolApproval.finish(input.decision === "approved" ? "approved" : "denied");
      if (input.decision === "approved") return answeredTurnState(active.state);
      return this.#countDeniedApproval(active);
    }
    if (active === undefined || providerRequestId === undefined)
      return this.#settleDeadTurnRequest(input.thread, "approval", String(input.approvalId));
    if (
      active.connection === undefined ||
      (input.decision === "approved" &&
        (turnPosture === "plan" ||
          active.thread.permissionPersistence !== input.thread.permissionPersistence))
    )
      return turnState("failed");
    const connection = active.connection;
    if (ownerCurrent === undefined) {
      active.approvals.delete(input.approvalId);
      active.approvalPostures.delete(input.approvalId);
    }
    await Effect.runPromise(
      Effect.suspend(() => {
        if (ownerCurrent !== undefined && !ownerCurrent())
          return Effect.die(new Error("Owner approval target changed before delivery."));
        if (ownerCurrent !== undefined) {
          active.approvals.delete(input.approvalId);
          active.approvalPostures.delete(input.approvalId);
        }
        return connection.answerApproval({
          sessionId: active.sessionId as never,
          requestId: providerRequestId,
          approved: input.decision === "approved",
          ...(ownerCurrent === undefined ? {} : { scope: "once" as const }),
        });
      }),
    );
    if (input.decision === "approved") return answeredTurnState(active.state);
    return this.#countDeniedApproval(active);
  }

  /**
   * A provider that keeps asking after repeated refusals is looping on the
   * person, so the third denial ends the turn the way a cancel does. The
   * reason rides on `interruptMessage` so the runner's settlement — not this
   * answer — writes the single terminal frame after the change list. The
   * denial itself was delivered, so its result is a bare `interrupted` with no
   * failure: every refused answer names its reason, and a surface that read
   * this one as refused would keep a Deny the provider already acted on.
   */
  async #countDeniedApproval(active: ActiveTurn) {
    active.deniedApprovals += 1;
    if (active.deniedApprovals < 3 || (active.state !== "running" && active.state !== "waiting"))
      return answeredTurnState(active.state);
    const lostText = this.#flushBeforeStop(active);
    const deniedMessage =
      "Stopped after 3 denied tool requests in one turn. Send a new message to continue.";
    active.interruptMessage =
      lostText === undefined ? deniedMessage : `${deniedMessage} ${lostText}`;
    active.state = "interrupted";
    this.#revokeBrowserGrants(active);
    this.#persistRuntimeWork(active, "interrupted");
    active.abort.abort();
    if (active.connection !== undefined) {
      await Effect.runPromise(
        active.connection
          .interrupt(active.sessionId as never)
          .pipe(Effect.catchAll(() => Effect.void)),
      );
    }
    return turnState("interrupted");
  }

  /**
   * A restart leaves a journaled approval or question parked: the provider
   * session that would consume its answer died with the process, so the answer
   * can never be delivered. The attempt settles interrupted — naming the
   * outcome — instead of holding an undeliverable card forever, and the turn
   * stays retryable. The live turn's own stream is excluded so an answer that
   * misses the in-memory map cannot interrupt work that is actually running.
   */
  #settleDeadTurnRequest(
    thread: CodeThread,
    kind: "approval" | "input",
    requestId: string,
  ): ReturnType<typeof turnState> {
    const history = this.#events.historyForThread(thread.id);
    if (history.status !== "ok") return turnState("failed");
    const liveOperationId = this.#active.get(String(thread.id))?.operationId;
    let owner:
      | {
          readonly operationId: CodeOperationId;
          cursor: number;
          unsettled: boolean;
        }
      | undefined;
    for (const frame of history.frames) {
      const event = frame.event;
      if (String(frame.operationId) === String(liveOperationId)) continue;
      const ownsRequest =
        (kind === "approval" &&
          event.kind === "approval-requested" &&
          String(event.approvalId) === requestId) ||
        (kind === "input" &&
          event.kind === "input-requested" &&
          String(event.requestId) === requestId);
      if (ownsRequest) {
        owner = { operationId: frame.operationId, cursor: frame.cursor, unsettled: true };
        continue;
      }
      if (owner === undefined || String(frame.operationId) !== String(owner.operationId)) continue;
      owner.cursor = frame.cursor;
      if (event.kind === "operation-state") {
        owner.unsettled = event.state === "running" || event.state === "waiting";
      } else if (event.kind === "operation-result" && event.result.kind === "provider-turn-state") {
        owner.unsettled = event.result.state === "running" || event.result.state === "waiting";
      }
    }
    if (owner === undefined || !owner.unsettled) return turnState("failed");
    const failure = {
      category: "failed",
      message:
        "The provider session that asked ended when Octant stopped. Send a new message to continue.",
    } as const;
    return this.#interruptOwner(thread.id, owner, failure)
      ? turnState("interrupted", failure)
      : turnState("failed");
  }

  /**
   * A host restart ends the turn it cut off, but the journal keeps reading it
   * running or waiting: only a provider turn can outlive the process as a
   * wait, and nothing can resume this one. Once the harness has given up on
   * it, the transcript says so too. A turn that is live now is never touched.
   */
  settleCutOffTurns(threadIdInput: string): void {
    const threadId = decodeCodeThreadId(threadIdInput);
    const history = this.#events.historyForThread(threadId);
    if (history.status !== "ok") return;
    const liveOperationId = this.#active.get(threadIdInput)?.operationId;
    const turns = new Map<
      string,
      { operationId: CodeOperationId; cursor: number; unsettled: boolean }
    >();
    for (const frame of history.frames) {
      const key = String(frame.operationId);
      if (key === String(liveOperationId)) continue;
      const event = frame.event;
      if (event.kind === "conversation-turn-started") {
        turns.set(key, { operationId: frame.operationId, cursor: frame.cursor, unsettled: true });
        continue;
      }
      const turn = turns.get(key);
      if (turn === undefined) continue;
      turn.cursor = frame.cursor;
      if (event.kind === "operation-state") {
        turn.unsettled = event.state === "running" || event.state === "waiting";
      } else if (event.kind === "operation-result" && event.result.kind === "provider-turn-state") {
        turn.unsettled = event.result.state === "running" || event.result.state === "waiting";
      }
    }
    for (const turn of turns.values()) {
      if (!turn.unsettled) continue;
      this.#interruptOwner(threadId, turn, {
        category: "failed",
        message:
          "Octant restarted while this turn was running, so it did not finish. Send a new message to continue.",
      });
    }
  }

  /** Journals the turn interrupted with the reason and closes its runtime work record. */
  #interruptOwner(
    threadId: CodeThreadId,
    owner: { readonly operationId: CodeOperationId; readonly cursor: number },
    failure: { readonly category: "failed"; readonly message: string },
  ): boolean {
    try {
      this.#events.append({
        threadId,
        operationId: owner.operationId,
        expectedCursor: owner.cursor,
        event: { kind: "operation-state", state: "interrupted", failure },
      });
    } catch {
      return false;
    }
    this.#observeRuntimeWorkOutcome(
      this.#runtimeWork.settleOrphaned({
        id: owner.operationId,
        threadId,
        kind: "provider-turn",
        state: "interrupted",
      }),
    );
    return true;
  }

  async forceStop(input: {
    readonly thread: CodeThread;
    readonly checkoutRoot: string;
    readonly turnOperationId: CodeOperationId;
  }) {
    const active = this.#owned(input.thread, input.checkoutRoot);
    if (
      active === undefined ||
      String(active.operationId) !== String(input.turnOperationId) ||
      !active.abort.signal.aborted ||
      active.connection?.forceStop === undefined
    )
      return turnState("failed", {
        category: "failed",
        message:
          "Only this host's exact stopped attempt on a supported runtime can be force-stopped.",
      });
    const connection = active.connection;
    const kill = connection.forceStop;
    if (kill === undefined) return turnState("failed");
    try {
      await Effect.runPromise(kill(decodeProviderSessionId(active.sessionId)));
    } catch {
      return turnState("failed", {
        category: "failed",
        message: "The owned runtime process could not be force-stopped.",
      });
    }
    if (this.#owned(input.thread, input.checkoutRoot) !== active) return turnState("interrupted");
    const lostText = this.#flushBeforeStop(active);
    const forcedMessage = "The provider attempt was stopped by force.";
    active.interruptMessage =
      lostText === undefined ? forcedMessage : `${forcedMessage} ${lostText}`;
    active.state = "interrupted";
    this.#persistRuntimeWork(active, "interrupted");
    return turnState("interrupted");
  }

  async cancel(input: Parameters<CodeOperationTurnPort["cancel"]>[0]) {
    const active = this.#owned(input.thread, input.checkoutRoot);
    if (active === undefined) return turnState("failed");
    if (
      input.turnOperationId !== undefined &&
      String(active.operationId) !== String(input.turnOperationId)
    )
      return turnState("failed", {
        category: "failed",
        message: "That turn has already ended, so Stop left the turn running now alone.",
      });
    const lostText = this.#flushBeforeStop(active);
    if (lostText !== undefined) {
      active.interruptMessage =
        active.interruptMessage === undefined ? lostText : `${active.interruptMessage} ${lostText}`;
    }
    active.state = "interrupted";
    active.reviewCapture?.cancelPending();
    this.#revokeBrowserGrants(active);
    this.#persistRuntimeWork(active, "interrupted");
    active.abort.abort();
    const connection = active.connection;
    if (connection !== undefined) {
      const confirmed = await settlesWithin(
        Effect.runPromise(
          connection.interrupt(active.sessionId as never).pipe(Effect.catchAll(() => Effect.void)),
        ),
        this.#options.stopConfirmationMs ?? CODE_STOP_CONFIRMATION_MS,
      );
      // A Stop is only a request, and the caller hears back within the bound.
      // The turn stays live and holds the thread until the runtime itself
      // reports how it ended: recording it interrupted here while a runtime
      // that shares its process kept working let a late completion land on a
      // turn that already read as ended, and freed the thread under work
      // that was still running. A runtime that owns its process can also be
      // ended by Force stop.
      if (!confirmed) {
        return {
          ...turnState("interrupted", {
            category: "failed",
            message:
              connection.forceStop === undefined
                ? STOP_UNCONFIRMED_MESSAGE
                : `${STOP_UNCONFIRMED_MESSAGE} Force stop can end it.`,
          }),
          stoppedOperationId: active.operationId,
        };
      }
    }
    return { ...turnState("interrupted"), stoppedOperationId: active.operationId };
  }

  async closeAll(): Promise<void> {
    const activeTurns = [...this.#active.values()];
    this.#active.clear();
    this.#pending.clear();
    await Promise.all(
      activeTurns.map(async (active) => {
        active.reviewCapture?.close();
        // Shutdown loses only the open burst, as a crash would.
        this.#flushBeforeStop(active);
        active.closed = true;
        active.state = "interrupted";
        this.#persistRuntimeWork(active, "interrupted");
        active.abort.abort();
        if (active.connection === undefined) return;
        await Effect.runPromise(
          active.connection
            .interrupt(active.sessionId as never)
            .pipe(Effect.catchAll(() => Effect.void)),
        );
        await Effect.runPromise(
          active.connection
            .stop(active.sessionId as never)
            .pipe(Effect.catchAll(() => Effect.void)),
        );
      }),
    );
  }

  /** Whether the thread's checkout is a remote root, which no local path resolves. */
  #isRemoteThread(thread: CodeThread): boolean {
    return this.#options.persistence.readCodeCheckout(thread.checkoutId)?.kind === "remote-root";
  }

  #appManagedTools(active: ActiveTurn): AppManagedToolSet | undefined {
    if (active.serverTools !== undefined) {
      // The turn's whole tool set: every other set reads or acts on a folder
      // or a device of this host. The runner closes it when the turn ends.
      const tools = active.serverTools;
      const standing = this.#options.windowAccess.standingAuthority;
      return { ...tools, execute: (input) => standing(() => tools.execute(input)) };
    }
    const supportsAppManagedTools = this.#options.supportsAppManagedTools?.(active.thread) === true;
    const supportsAcpClientCapabilities =
      this.#options.supportsAcpClientCapabilities?.(active.thread) === true;
    const sets: Array<AppManagedToolSet | undefined> = [];
    const service = this.#service;
    if (supportsAppManagedTools && service !== undefined) {
      const delegatedBrowserTools =
        active.routineRun === undefined
          ? undefined
          : this.#options.routineBrowserTools?.({
              thread: active.thread,
              readThread: () => this.#effectiveThread(active.windowId, active.thread.id),
              routineRun: active.routineRun,
            });
      const browserProfiles = this.#options.browserProfiles;
      const pullRequestWatch = this.#options.pullRequestWatch;
      sets.push(
        this.#options.computerUseTools?.({
          windowId: active.windowId,
          thread: active.thread,
          ...(active.computerUseDestination === undefined
            ? {}
            : { destination: active.computerUseDestination }),
          ask: (summary, signal) => {
            const bounded = boundProviderSummary(summary);
            return bounded === undefined
              ? Promise.resolve("cancelled")
              : this.#askToolApproval(active, bounded, undefined, signal);
          },
        }),
        createCodeAppManagedTools({
          ...(delegatedBrowserTools === undefined ? {} : { delegatedBrowserTools }),
          windowId: active.windowId,
          thread: active.thread,
          readThread: (windowId, threadId) => this.#effectiveThread(windowId, threadId),
          uuid: this.#options.uuid,
          onCheckoutActivity: () => {
            if (this.#captureIdentityCurrent(active, false))
              this.#reviewScheduler(active).request();
          },
          deviceApproval: {
            request: (effect, signal) => this.#askDeviceApproval(active, effect, signal),
          },
          pullRequestApproval: {
            request: (command, signal) => this.#askPullRequestApproval(active, command, signal),
          },
          standingMerge: () => {
            const current = this.#effectiveThread(active.windowId, active.thread.id);
            return current === undefined
              ? undefined
              : this.#options.standingMergeAllowance?.(current)[0];
          },
          ...(pullRequestWatch === undefined
            ? {}
            : {
                pullRequestWatch: {
                  watch: (ask, signal) =>
                    pullRequestWatch.watch({
                      windowId: active.windowId,
                      threadId: active.thread.id,
                      providerInstanceId: String(active.thread.providerInstanceId),
                      ask,
                      signal: signal ?? active.abort.signal,
                    }),
                  unwatch: () =>
                    pullRequestWatch.unwatch({
                      threadId: active.thread.id,
                      providerInstanceId: String(active.thread.providerInstanceId),
                    }),
                  request: (target, signal) =>
                    this.#askPullRequestWatchApproval(active, target, signal),
                },
              }),
          terminalApproval: {
            request: (input, signal) => this.#askTerminalApproval(active, input, signal),
          },
          // An upload sends files from this thread's checkout only, and asks
          // every time, at every access level, as the first Browser action on
          // a site does.
          browserUpload: {
            root: active.checkoutRoot,
            request: (summary, signal) => {
              const bounded = boundProviderSummary(summary);
              return bounded === undefined
                ? Promise.resolve("cancelled" as const)
                : this.#askToolApproval(active, bounded, undefined, signal);
            },
          },
          // A saved download lands in this thread's checkout only, and the
          // person is asked every time, as for an upload.
          browserDownload: {
            root: active.checkoutRoot,
            ...(this.#options.browserDownloadRefusal === undefined
              ? {}
              : { refusal: this.#options.browserDownloadRefusal }),
            request: (summary, signal) => {
              const bounded = boundProviderSummary(summary);
              return bounded === undefined
                ? Promise.resolve("cancelled" as const)
                : this.#askToolApproval(active, bounded, undefined, signal);
            },
          },
          ...(browserProfiles === undefined
            ? {}
            : {
                browserProfiles: {
                  approvals: browserProfiles.approvals,
                  readBinding: (contextId: string) =>
                    active.abort.signal.aborted
                      ? undefined
                      : browserProfiles.readBinding(contextId),
                  rememberBinding: (
                    contextId: string,
                    binding: Parameters<
                      NonNullable<CodeAppManagedToolsOptions["browserProfiles"]>["rememberBinding"]
                    >[1],
                  ) => {
                    if (active.abort.signal.aborted) return;
                    browserProfiles.rememberBinding(contextId, binding);
                    active.browserProfileContexts.add(contextId);
                  },
                  forgetBinding: (contextId: string) => {
                    active.browserProfileContexts.delete(contextId);
                    browserProfiles.forgetBinding(contextId);
                  },
                },
              }),
          browserApproval: {
            isBound: (contextId) => {
              const key = this.#browserApprovalKey(active, contextId);
              const bound = this.#boundBrowserContexts.has(key);
              if (bound) active.browserGrantKeys.add(key);
              return bound;
            },
            rememberBinding: (contextId) => {
              const key = this.#browserApprovalKey(active, contextId);
              if (!this.#boundBrowserContexts.has(key) && this.#boundBrowserContexts.size >= 256) {
                const oldest = this.#boundBrowserContexts.values().next().value;
                if (oldest !== undefined) this.#boundBrowserContexts.delete(oldest);
              }
              this.#boundBrowserContexts.add(key);
              active.browserGrantKeys.add(key);
            },
            isApproved: (contextId) => {
              const key = this.#browserApprovalKey(active, contextId);
              const approved = this.#approvedBrowserContexts.has(key);
              if (approved) active.browserGrantKeys.add(key);
              return approved;
            },
            request: (origin, signal) => this.#askBrowserApproval(active, origin, signal),
            ...(this.#options.isBrowserOriginRemembered === undefined
              ? {}
              : { isOriginRemembered: this.#options.isBrowserOriginRemembered }),
            remember: (contextId) => {
              if (this.#approvedBrowserContexts.size >= 256) {
                const oldest = this.#approvedBrowserContexts.values().next().value;
                if (oldest !== undefined) this.#approvedBrowserContexts.delete(oldest);
              }
              const key = this.#browserApprovalKey(active, contextId);
              this.#approvedBrowserContexts.add(key);
              active.browserGrantKeys.add(key);
            },
            forget: (contextId) => {
              const key = this.#browserApprovalKey(active, contextId);
              this.#approvedBrowserContexts.delete(key);
              this.#boundBrowserContexts.delete(key);
            },
          },
          ...(this.#options.browserSignIn === undefined
            ? {}
            : { browserSignIn: this.#options.browserSignIn }),
          ...(this.#options.recordExternalContentIngestion === undefined
            ? {}
            : { recordExternalContentIngestion: this.#options.recordExternalContentIngestion }),
          executeOperation: (windowId, command) => service.execute(windowId, command),
          terminal: {
            read: (windowId, input) => service.readTerminal(windowId, input),
            interrupt: (windowId, input) => service.interruptTerminal(windowId, input),
            terminate: (windowId, input) => service.terminateTerminal(windowId, input),
          },
          ...(this.#options.browserAutomation === undefined
            ? {}
            : { browser: this.#options.browserAutomation }),
          ...(this.#options.browserFlows === undefined
            ? {}
            : { browserFlows: this.#options.browserFlows }),
          ...(this.#options.appleToolchain === undefined
            ? {}
            : { apple: this.#options.appleToolchain }),
          ...(this.#options.androidToolchain === undefined
            ? {}
            : { android: this.#options.androidToolchain }),
        }),
        this.#options.githubReadTools?.({
          windowId: active.windowId,
          thread: active.thread,
          readThread: (windowId, threadId) => this.#effectiveThread(windowId, threadId),
        }),
        this.#options.threads?.({
          windowId: active.windowId,
          thread: active.thread,
          readPosture: () =>
            clampTurnAccessPosture({
              requested: active.thread.executionPolicy,
              thread:
                this.#effectiveThread(active.windowId, active.thread.id)?.executionPolicy ??
                active.thread.executionPolicy,
            }),
          ...(this.#options.planner === undefined ? {} : { planner: this.#options.planner }),
        }),
        this.#options.contributedTools?.({
          windowId: active.windowId,
          thread: active.thread,
          readThread: () => this.#effectiveThread(active.windowId, active.thread.id),
          folders: [active.providerRoot, ...active.extraFolders],
          ...(active.routineRun === undefined ? {} : { routineRun: active.routineRun }),
        }),
        this.#options.sideTasks?.({
          windowId: active.windowId,
          thread: active.thread,
          operationId: String(active.operationId),
          ...(this.#options.planner === undefined ? {} : { planner: this.#options.planner }),
        }),
        this.#options.canvas?.({ windowId: active.windowId, thread: active.thread }),
        this.#options.agents?.({ windowId: active.windowId, thread: active.thread }),
        this.#options.nativeHarnessTools?.({
          thread: active.thread,
          checkoutRoot: active.providerRoot,
          ...(active.extraFolders.length === 0 ? {} : { extraFolders: active.extraFolders }),
          windowId: active.windowId,
          secrets: active.secrets,
        }),
      );
    }
    if (supportsAcpClientCapabilities) {
      sets.push(
        createCodeAcpClientTools({
          windowId: active.windowId,
          thread: active.thread,
          readExecutionPolicy: () =>
            this.#effectiveThread(active.windowId, active.thread.id)?.executionPolicy ??
            active.thread.executionPolicy,
          checkoutRoot: active.providerRoot,
          ...(active.extraFolders.length === 0 ? {} : { extraFolders: active.extraFolders }),
          uuid: this.#options.uuid,
          pathPort: this.#options.acpPathPort ?? liveCodeTestSourcePort,
          terminalConfinement:
            this.#options.acpTerminalConfinement ?? defaultAcpTerminalConfinement(),
          wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        }),
      );
    }
    sets.push(active.extensionTools);
    if (sets.every((set) => set === undefined)) return undefined;
    // A provider's tool call reaches this set as an async descendant of the
    // request that started the turn (or the provider's process). Once that
    // request ended, every Project check inside the call refused; while it was
    // still open, a paired device's wider in-request reach applied. Each call
    // is judged instead on the turn's window as it stands when the call runs,
    // never on any request's admission.
    const tools = combineAppManagedToolSets(...sets);
    const standing = this.#options.windowAccess.standingAuthority;
    return { ...tools, execute: (input) => standing(() => tools.execute(input)) };
  }

  #owned(thread: CodeThread, checkoutRoot: string): ActiveTurn | undefined {
    const active = this.#active.get(String(thread.id));
    return active !== undefined &&
      active.checkoutRoot === checkoutRoot &&
      active.thread.checkoutId === thread.checkoutId &&
      active.thread.projectId === thread.projectId
      ? active
      : undefined;
  }

  #launch(
    active: ActiveTurn,
    prompt: string,
    context: Parameters<CodeOperationTurnPort["start"]>[0]["context"],
    attachments: Parameters<CodeOperationTurnPort["start"]>[0]["attachments"],
  ): void {
    const replay = this.#events.replay({
      threadId: active.thread.id,
      operationId: active.operationId,
      afterCursor: 0,
      limit: 256,
    });
    if (replay.status !== "ok") {
      active.state = "waiting";
      // Nothing downstream reports an outcome for a turn that never reached the
      // provider, so the record it opened has to be closed here or the board
      // would read the thread as executing until the next restart.
      this.#persistRuntimeWork(active, "waiting");
      return;
    }
    active.cursor = replay.nextCursor;
    const harnessScope: NativeHarnessTurnScope = {
      threadId: String(active.thread.id),
      mode: "code",
      providerInstanceId: active.thread.providerInstanceId,
      modelId: active.thread.modelId,
      projectId: active.thread.projectId,
      windowId: active.windowId,
    };
    const harnessContext = this.#options.nativeHarness?.contextFor(harnessScope) ?? [];
    this.#options.nativeHarness?.turnStarted(harnessScope);
    let endedTurn: TurnEndSummary | undefined;
    const appManagedTools = this.#appManagedTools(active);
    // Only a thread whose person chose the runtime's artifact tool is told to
    // use it; the turn runner starts that thread's session with the same
    // choice, and every other thread keeps Canvas.
    const artifactToolName =
      active.thread.documentDelivery === "native-artifacts"
        ? active.driver.nativeArtifactTool?.({
            mode: "code",
            executionPolicy: active.thread.executionPolicy,
          })
        : undefined;
    const deliveryInstructions = documentDeliveryInstructions({
      artifactToolName,
      canvasOffered: offersCanvasTool(appManagedTools?.definitions),
    });
    const extraFolderInstructions = projectExtraFoldersInstructions(active.extraFolders);
    // This mode's rules before the tool notes, as in Work.
    const hostGuidance = [
      ...(deliveryInstructions === undefined
        ? []
        : [
            {
              kind: "instructions" as const,
              text: deliveryInstructions,
              ...(artifactToolName === undefined ? { tool: CANVAS_TOOL_NAME } : {}),
            },
          ]),
      ...(extraFolderInstructions === undefined
        ? []
        : [{ kind: "instructions" as const, text: extraFolderInstructions }]),
      ...(active.designSystem === undefined
        ? []
        : [{ kind: "instructions" as const, text: active.designSystem.instructions }]),
      ...appToolHostLines(appManagedTools?.definitions).map((line) => ({
        kind: "instructions" as const,
        text: line.text,
        tool: line.tool,
      })),
    ];
    const personMemoryText = this.#options.personMemoryBlock?.({
      thread: active.thread,
      windowId: active.windowId,
    });
    // Counted with Octant's instructions: a Code window is reported by part,
    // and person memory is standing text Octant sends with them.
    const personMemory =
      personMemoryText === undefined
        ? []
        : [{ kind: "person-memory" as const, text: personMemoryText }];
    // After person memory, as in Chat and Work, and counted with it.
    const projectMemory = [
      ...(this.#options.projectMemoryEntries?.(active.thread) ?? []).map((text) => ({
        kind: "project-memory" as const,
        text,
      })),
      // Keyed, so a session that holds this file is sent it again only once it changed.
      ...(active.designSystem?.system === undefined
        ? []
        : [
            {
              kind: "project-memory" as const,
              key: active.designSystem.system.key,
              text: active.designSystem.system.text,
            },
          ]),
    ];
    const fullContext = [
      ...harnessContext,
      ...hostGuidance,
      ...personMemory,
      ...projectMemory,
      ...(context ?? []),
    ];
    // A runtime that keeps its own conversation already holds the standing
    // context an earlier completed turn of this session carried; only what is
    // new goes out, and only that is counted as this turn's copy.
    const delivery: ProviderTurnContextDelta =
      active.driver.conversationOwnership === "provider"
        ? heldTurnContext.forTurn({
            sessionId: decodeProviderSessionId(active.sessionId),
            resumed: active.resumeCursor !== undefined,
            context: fullContext,
          })
        : { kind: "appended", context: fullContext, held: [] };
    const heldKeys = new Set(delivery.held.map((block) => `${block.kind}\u0000${block.text}`));
    const sentNow = (blocks: ReadonlyArray<ProviderContextBlock>) =>
      blocks.filter((block) => !heldKeys.has(`${block.kind}\u0000${block.text}`));
    const harnessAutoReviewEnabled = this.#resolveHarnessAutoReview(active.thread);
    const nativeSetup = this.#options.resolveProviderNativeSetup?.(active.thread);
    const contextAccount: CodeTurnContextAccount = {
      carried: active.carriedSentContext,
      turn: estimateSentContextParts({
        sent: {
          instructions: [
            ...(delivery.kind === "restated"
              ? [{ kind: "instructions" as const, text: PROVIDER_CONTEXT_RESTATED }]
              : []),
            ...sentNow([
              ...hostGuidance,
              ...personMemory,
              ...projectMemory,
              ...(active.sentContext?.instructions ?? []),
            ]),
          ],
          skills: sentNow(active.sentContext?.skills ?? []),
        },
        attachments,
      }),
    };
    const folderWatch =
      active.folderCurrent === undefined
        ? undefined
        : setInterval(() => {
            let revoked: boolean;
            try {
              revoked = active.folderCurrent?.() === false;
            } catch {
              revoked = true;
            }
            if (revoked) {
              active.interruptMessage =
                "The working folder became unavailable. Nothing was redirected.";
              active.abort.abort();
            }
          }, 250);
    void Effect.runPromise(
      Effect.scoped(
        this.#runner.run({
          thread: active.thread,
          providerDriverKind: active.driver.kind,
          ...(active.inputsCurrent === undefined ? {} : { inputsCurrent: active.inputsCurrent }),
          sessionId: active.sessionId as never,
          ...(active.resumeCursor === undefined ? {} : { resumeCursor: active.resumeCursor }),
          onSessionReady: (handle) =>
            Effect.try({
              try: () => {
                // The handoff is recorded before the session it opened is, and
                // both before the prompt is sent, so nothing reaches the new
                // provider that the journal does not disclose.
                const pending = active.pendingHandoff;
                if (pending !== undefined) {
                  const record = pending.record;
                  let event: HandoffAttached;
                  if (
                    record.reason === "fork-native-session" ||
                    record.reason === "rewind-native-session"
                  )
                    event = record;
                  else {
                    let content: CodeEvidenceReference;
                    try {
                      content = this.#options.evidence.put(JSON.stringify(pending.blocks));
                    } catch {
                      throw new HandoffUnsaved(record.reason === "fork");
                    }
                    event = { ...record, content };
                  }
                  const handoff = this.#appendTurnEvent(active, {
                    event,
                  });
                  active.cursor = handoff.cursor;
                  delete active.pendingHandoff;
                }
                for (const record of active.pendingForkMerges ?? []) {
                  const delivered = this.#appendTurnEvent(active, {
                    event: record,
                  });
                  active.cursor = delivered.cursor;
                }
                delete active.pendingForkMerges;
                const resumeCursor = handle.resumeCursor ?? active.resumeCursor;
                const frame = this.#appendTurnEvent(active, {
                  event: {
                    kind: "provider-session-ready",
                    sessionId: handle.sessionId,
                    providerInstanceId: active.thread.providerInstanceId,
                    modelId: active.thread.modelId,
                    checkoutId: active.thread.checkoutId,
                    ...(resumeCursor === undefined ? {} : { resumeCursor }),
                  },
                });
                active.cursor = frame.cursor;
              },
              catch: (error) => ({
                category: "failed" as const,
                message:
                  error instanceof HandoffUnsaved
                    ? error.fork
                      ? CODE_FORK_HANDOFF_REFUSALS["handoff-unsaved"]
                      : PROVIDER_SWITCH_HANDOFF_REFUSALS["handoff-unsaved"]
                    : "The provider session could not be saved. The message was not sent.",
              }),
            }),
          checkoutRoot: active.checkoutRoot,
          providerRoot: active.providerRoot,
          extraFolders: active.extraFolders,
          prompt,
          ...(delivery.context.length === 0 ? {} : { context: delivery.context }),
          contextAccount,
          ...(this.#options.sessionCompactions === undefined
            ? {}
            : {
                onAutomaticCompaction: (sighting: AutomaticCompactionSighting) => {
                  const occupancy = this.#events.latestWindowOccupancy(
                    active.thread.id,
                    decodeProviderSessionId(active.sessionId),
                  );
                  this.#options.sessionCompactions?.record({
                    threadId: active.thread.id,
                    // A Code turn is one operation; its id is the turn's.
                    turnKey: String(active.operationId),
                    sighting,
                    executor: {
                      kind: "runtime",
                      driverKind: active.driver.kind,
                      providerInstanceId: active.thread.providerInstanceId,
                      modelId: active.thread.modelId,
                    },
                    ...(occupancy === undefined ? {} : { priorOccupancy: occupancy }),
                  });
                },
              }),
          onTurnEnded: (ended) => {
            endedTurn = withPromptDigest(ended, this.#options.nativeHarness?.promptDigest, prompt, {
              firstTurn: active.firstTurn,
            });
          },
          ...(this.#options.liveTurns === undefined
            ? {}
            : {
                liveTurn: this.#options.liveTurns.tracker(
                  String(active.thread.id),
                  "code-navigation",
                ),
              }),
          ...(this.#options.nativeHarness === undefined
            ? {}
            : {
                onTurnCompleted: (completed) => {
                  this.settleSpendReservation(active.operationId);
                  return this.#options.nativeHarness!.turnCompleted({
                    ...harnessScope,
                    ...completed,
                  });
                },
              }),
          ...(attachments === undefined ? {} : { attachments }),
          ...(harnessAutoReviewEnabled ? { harnessAutoReviewEnabled: true } : {}),
          ...(nativeSetup === undefined ? {} : { nativeSetup }),
          signal: active.abort.signal,
          provider: {
            acquire: (acquireInput) => {
              if (
                acquireInput.projectRoot !== active.providerRoot ||
                JSON.stringify(acquireInput.extraFolders ?? []) !==
                  JSON.stringify(active.extraFolders) ||
                acquireInput.permissionPersistence !== active.thread.permissionPersistence
              )
                return Effect.fail({
                  category: "unauthorized",
                  message: "Provider authority mismatch.",
                });
              return active.driver.acquire(acquireInput).pipe(
                Effect.tap((connection) =>
                  Effect.sync(() => {
                    active.connection = connection;
                  }),
                ),
              );
            },
          },
          ...(this.#options.outsideContentMarks === undefined
            ? {}
            : { outsideContentMarks: this.#options.outsideContentMarks }),
          ...(this.#options.forgeChanges === undefined
            ? {}
            : { forgeChanges: this.#options.forgeChanges }),
          ...(this.#options.nativeHarness?.observeRemoteCommand === undefined
            ? {}
            : {
                observeRemoteCommand: (event: ProviderRuntimeEvent) =>
                  this.#options.nativeHarness?.observeRemoteCommand?.(
                    String(active.thread.id),
                    String(active.thread.projectId),
                    event,
                  ),
              }),
          sanitizeProviderEvent: ({ event }) =>
            Effect.try({
              try: () => sanitizeProviderEvent(event, active.checkoutRoot, active.secrets),
              catch: () => ({
                category: "failed" as const,
                message: "Provider event sanitization failed.",
              }),
            }),
          reconcileObservation: ({ claim }) =>
            Effect.promise(async () => {
              // A server folder is no folder of this host, so no local Git
              // process may observe a path that only names it.
              if (active.serverTools !== undefined) {
                return {
                  status: "not-confirmed" as const,
                  summary: "The checkout is on a server; this host does not observe it.",
                };
              }
              if (claim.kind === "file-change" || claim.kind === "diff") {
                if (this.#captureIdentityCurrent(active, false))
                  this.#reviewScheduler(active).request();
                const observation = await this.#git.observe(active.checkoutRoot);
                return observation.status === "ready"
                  ? { status: "confirmed" as const, summary: "Checkout observation completed." }
                  : { status: "waiting" as const, summary: "Checkout observation unavailable." };
              }
              return {
                status: "not-confirmed" as const,
                summary: "Provider tool claim is observational.",
              };
            }),
          ...(appManagedTools === undefined ? {} : { appManagedTools }),
          ...(active.onContextDelivered === undefined
            ? {}
            : { onPromptSent: active.onContextDelivered }),
          persistEvent: (event) =>
            // The provider's own completion, interruption, or failure is
            // journaled as the turn's terminal state, ahead of the outcome
            // below. The change list goes in before whichever comes first.
            Effect.promise(() =>
              event.category === "completion" ||
              event.category === "interruption" ||
              event.category === "failure"
                ? this.#recordChangedFiles(active)
                : Promise.resolve(),
            ).pipe(
              Effect.andThen(
                event.category === "approval"
                  ? Effect.promise(() => this.#reviewProviderApproval(active, event))
                  : Effect.sync(() => this.#persistNormalized(active, event)),
              ),
            ),
          persistOutcome: (outcome, failure) =>
            // What changed is journaled before the terminal state, so a client
            // following the turn has it by the time the turn reads as settled.
            // A turn waiting on the person has not settled and records nothing.
            Effect.promise(() =>
              outcome === "waiting" ? Promise.resolve() : this.#recordChangedFiles(active),
            ).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  // A forced stop can carry its own reason over the runner's
                  // generic cancellation copy; the text is still redacted
                  // before it is journaled like any provider-authored event's.
                  const stopReason =
                    outcome === "interrupted" && active.interruptMessage !== undefined
                      ? active.interruptMessage
                      : failure?.message;
                  const reason =
                    outcome === "completed" || outcome === "waiting"
                      ? stopReason
                      : withLostTextNote(active, stopReason);
                  const message =
                    reason === undefined
                      ? undefined
                      : boundProviderFailureMessage(
                          sanitizeProviderText(reason, active.checkoutRoot, active.secrets),
                        );
                  this.#persistOutcome(
                    active,
                    outcome,
                    message === undefined
                      ? undefined
                      : {
                          // A refused resume keeps its own category: the
                          // transcript's parked-turn recovery keys on it, and
                          // a plain "failed" would make it indistinguishable
                          // from every other provider failure.
                          category:
                            failure?.toolCatalogHandoffRequired === true
                              ? "tools-changed"
                              : failure?.resumeRefused === true
                                ? "stale"
                                : "failed",
                          message,
                          ...(failure?.usageLimit === undefined
                            ? {}
                            : { usageLimit: failure.usageLimit }),
                          ...(failure?.retryAfterMs === undefined
                            ? {}
                            : { retryAfterMs: failure.retryAfterMs }),
                        },
                  );
                }),
              ),
            ),
        }),
      ),
    )
      .catch(async (error: unknown) => {
        // A cancelled turn already reads `interrupted` here, but the runner
        // may still have died without journaling that: a turn with no
        // terminal frame stays Working in every client forever.
        if (active.state !== "running" && active.lastPersistedState !== undefined) return;
        const outcome = active.state === "interrupted" ? "interrupted" : "failed";
        await this.#recordChangedFiles(active);
        try {
          this.#persistOutcome(
            active,
            outcome,
            outcome === "interrupted"
              ? {
                  category: "failed",
                  message:
                    withLostTextNote(
                      active,
                      active.interruptMessage ?? "Code turn was cancelled.",
                    ) ?? "Code turn was cancelled.",
                }
              : evidenceCapacityFailure(error),
          );
        } catch {
          active.state = outcome;
        }
      })
      .finally(() => {
        clearInterval(folderWatch);
        active.reviewCapture?.close();
        // A flush failure here has already marked the turn; the terminal state
        // is journaled, so only the open burst is lost.
        this.#flushBeforeStop(active);
        active.closed = true;
        this.#options.nativeHarness?.turnEnded?.(harnessScope, endedTurn);
        if (this.#active.get(String(active.thread.id)) === active)
          this.#active.delete(String(active.thread.id));
      });
  }

  /** The durable thread as its running turn may use it, from this runtime's own turns. */
  threadWithActiveTurnPosture(thread: CodeThread): CodeThread {
    return threadWithActiveTurnPosture(thread, this.#active);
  }

  /**
   * What a pending approval is asked under: the thread's posture as its
   * running turn holds it, after the window's session grant and the turn's own
   * narrowing. A thread that cannot be read has no posture an allow could match.
   */
  #approvalPosture(active: ActiveTurn): string | undefined {
    const thread = this.#effectiveThread(active.windowId, active.thread.id);
    return thread === undefined ? undefined : approvalPostureOf(thread);
  }

  #effectiveThread(windowId: WindowId, threadId: CodeThreadId): CodeThread | undefined {
    const stored = this.#options.persistence.readCodeThread(threadId);
    if (stored === undefined) return undefined;
    const session = this.#options.sessionAuthority?.effectiveThread(windowId, stored) ?? stored;
    return this.threadWithActiveTurnPosture(session);
  }

  /**
   * Computes whether the harness's native reviewer may answer approval prompts
   * for the next turn on this thread. Clamps to `false` when the thread has
   * ingested untrusted content, when the provider does not advertise the
   * capability, or when the posture produces no prompts.
   */
  #resolveHarnessAutoReview(thread: CodeThread): boolean {
    if (thread.autoApprove !== true) return false;
    if (this.#options.chosenAutoReviewer?.(thread) === "octant-shield") return false;
    const capabilities = this.#options.resolveProviderCapabilities?.(thread);
    if (capabilities === undefined) return false;
    const taint = this.#options.readThreadExternalContentTaint?.(thread.id);
    const externalContentIngested = taint?.externalContentIngested ?? true;
    return harnessAutoReviewEffective({
      autoApprove: true,
      posture: thread.executionPolicy,
      externalContentIngested,
      capabilitySupported: capabilities.harnessAutoReview === "supported",
    });
  }

  #noteHarnessRetry(active: ActiveTurn, event: CodeOperationEvent): void {
    const harness = this.#options.nativeHarness;
    if (harness === undefined) return;
    const scope: NativeHarnessTurnScope = {
      threadId: String(active.thread.id),
      mode: "code",
      providerInstanceId: active.thread.providerInstanceId,
      modelId: active.thread.modelId,
      projectId: active.thread.projectId,
    };
    // A retried response that only calls a tool streams no content.
    if (event.kind === "provider-content" || event.kind === "tool-activity") {
      harness.clearRetry?.(scope);
      return;
    }
    if (event.kind !== "provider-retry") return;
    harness.noteRetry?.(
      scope,
      decodeHarnessRetryNotice({
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        reason: event.reason,
        announcedAt: event.announcedAt,
      }),
    );
  }

  #persistNormalized(active: ActiveTurn, event: CodeTurnEvent): void {
    if (event.category === "message" || event.category === "reasoning") {
      this.#bufferDelta(active, event.category, event.text ?? " ");
      return;
    }
    const operationEvent = normalizedOperationEvent(
      event,
      active,
      this.#options.evidence,
      this.#options.uuid,
    );
    if (operationEvent === undefined) return;
    if (operationEvent.kind === "approval-requested") {
      active.approvalPostures.set(String(operationEvent.approvalId), this.#approvalPosture(active));
    }
    this.#noteHarnessRetry(active, operationEvent);
    // Text that could not be journaled must not sit under a completed turn.
    const lostText = active.deltaFlushFailure;
    const journaled: CodeOperationEvent =
      operationEvent.kind === "operation-state" &&
      operationEvent.state === "completed" &&
      lostText !== undefined
        ? {
            kind: "operation-state",
            state: "failed",
            ...optionalFailure(evidenceCapacityFailure(lostText.error)),
          }
        : operationEvent;
    const frame = this.#appendTurnEvent(active, { event: journaled });
    active.cursor = frame.cursor;
    if (journaled.kind === "operation-state") {
      active.lastPersistedState = journaled.state;
      active.lastPersistedFailure = journaled.failure?.message;
    }
  }

  /**
   * Holds streamed reply text so one burst commits once, not once per chunk.
   * Every journal commit is fully synced, and a long reply streams hundreds of
   * chunks a second. A buffer holds one channel; the other channel, any other
   * event, and the end of the turn flush it first, so nothing is journaled
   * ahead of text that arrived before it.
   */
  #bufferDelta(active: ActiveTurn, channel: "message" | "reasoning", text: string): void {
    // A chunk after the turn settled has no operation left to append to, and a
    // timer armed for it would outlive the turn.
    if (active.closed === true) return;
    if (active.state !== "running" && active.state !== "waiting") return;
    if (
      active.lastPersistedState !== undefined &&
      active.lastPersistedState !== "running" &&
      active.lastPersistedState !== "waiting"
    )
      return;
    if (active.deltaBurst !== undefined && active.deltaBurst.channel !== channel)
      this.#flushDelta(active);
    if (active.deltaBurst === undefined) {
      const timer = setTimeout(() => {
        try {
          this.#flushDelta(active);
        } catch (error) {
          // No runner call is on the stack to receive the throw, so the turn
          // fails here, as it would have on the chunk that overflowed.
          void this.#failOnTimedFlush(active, error);
        }
      }, STREAMED_DELTA_BATCH_WINDOW_MS);
      timer.unref?.();
      active.deltaBurst = { channel, parts: [], bytes: 0, timer };
    }
    active.deltaBurst.parts.push(text);
    active.deltaBurst.bytes += text.length;
    if (active.deltaBurst.bytes >= STREAMED_DELTA_BATCH_MAX_CHARS) this.#flushDelta(active);
  }

  async #failOnTimedFlush(active: ActiveTurn, error: unknown): Promise<void> {
    const stillOpen = (): boolean =>
      (active.state === "running" || active.state === "waiting") &&
      (active.lastPersistedState === undefined ||
        active.lastPersistedState === "running" ||
        active.lastPersistedState === "waiting");
    if (!stillOpen()) return;
    // The change list goes in ahead of the terminal state, as for any outcome.
    await this.#recordChangedFiles(active);
    // A cancel or forced stop may have settled the turn while that await ran.
    if (!stillOpen()) return;
    try {
      this.#persistOutcome(active, "failed", evidenceCapacityFailure(error));
    } catch {
      active.state = "failed";
    }
    active.abort.abort();
  }

  /**
   * Journals the open burst, if any, as one evidence row and one event. The
   * burst stays until both writes land; on failure it is abandoned and the
   * turn is marked so no caller, however it handles the throw, can let the
   * turn report `completed` with text missing.
   */
  #flushDelta(active: ActiveTurn): void {
    try {
      this.#writeBurst(active);
    } catch (error) {
      this.#abandonBurst(active);
      active.deltaFlushFailure ??= { error };
      throw error;
    }
  }

  #writeBurst(active: ActiveTurn): void {
    const burst = active.deltaBurst;
    if (burst === undefined) return;
    const operationEvent: CodeOperationEvent = {
      kind: "provider-content",
      channel: burst.channel,
      content: this.#options.evidence.put(burst.parts.join("")),
    };
    this.#noteHarnessRetry(active, operationEvent);
    const frame = this.#events.append({
      threadId: active.thread.id,
      operationId: active.operationId,
      expectedCursor: active.cursor,
      event: operationEvent,
    });
    active.cursor = frame.cursor;
    this.#abandonBurst(active);
  }

  #abandonBurst(active: ActiveTurn): void {
    const burst = active.deltaBurst;
    if (burst === undefined) return;
    clearTimeout(burst.timer);
    delete active.deltaBurst;
  }

  /**
   * Flushes ahead of a stop. The stop still lands when the write fails, so the
   * loss is returned for the stop's own reason instead of thrown.
   */
  #flushBeforeStop(active: ActiveTurn): string | undefined {
    try {
      this.#writeBurst(active);
    } catch (error) {
      this.#abandonBurst(active);
      active.deltaFlushFailure ??= { error };
    }
    // An earlier timer flush may have failed already, leaving nothing to write
    // here; the stop still owes the person the note.
    return lostTextNote(active);
  }

  /** The one way a turn's events reach the journal, behind any open burst. */
  #appendTurnEvent(active: ActiveTurn, input: { readonly event: CodeOperationEvent }) {
    this.#flushDelta(active);
    return this.#events.append({
      threadId: active.thread.id,
      operationId: active.operationId,
      expectedCursor: active.cursor,
      event: input.event,
    });
  }

  /**
   * Journal what differs in the checkout between the capture this turn started
   * from and the checkout as it stands.
   *
   * The starting capture is read back from the journal rather than carried in
   * memory, so a turn recovered after a restart settles against the same point
   * as one that never stopped. A turn without one (a Plan turn, a checkout the
   * host could not read) records nothing: no record means "not observed", and a
   * guess would read as "nothing changed".
   *
   * Never throws and never fails a turn: the change list is evidence about the
   * turn, not part of it. The turn's own abort signal is deliberately not
   * passed on, because an interrupted turn is exactly one whose changes a
   * person needs to see.
   */
  #reviewSource(threadId: CodeThreadId, operationId: CodeOperationId) {
    return this.#events.reviewSource(threadId, operationId);
  }

  async reviewPreview(
    input: Parameters<NonNullable<CodeOperationTurnPort["reviewPreview"]>>[0],
  ): Promise<CodeTurnReviewPreview | undefined> {
    if (input.admissionCurrent?.() === false) return undefined;
    const source = this.#reviewSource(input.thread.id, input.operationId);
    if (source === undefined || source.checkoutId !== input.thread.checkoutId) return undefined;
    const active = this.#active.get(String(input.thread.id));
    if (input.refresh) {
      if (
        active === undefined ||
        active.operationId !== input.operationId ||
        active.thread.checkoutId !== input.thread.checkoutId ||
        active.windowId !== input.windowId
      )
        return source.reviewPreview;
      active.reviewCaptureGuard = input.admissionCurrent;
      try {
        await this.#reviewScheduler(active).flush();
      } finally {
        if (active.reviewCaptureGuard === input.admissionCurrent)
          active.reviewCaptureGuard = undefined;
      }
    }
    if (input.admissionCurrent?.() === false) return undefined;
    const recorded = this.#reviewSource(input.thread.id, input.operationId);
    if (recorded === undefined || recorded.checkoutId !== input.thread.checkoutId) return undefined;
    const settled = recorded.status !== "incomplete" && recorded.status !== "waiting";
    const retained: CodeTurnReviewPreview = recorded.reviewPreview ?? {
      status: "unavailable" as const,
      explanation:
        source.checkpoint === undefined
          ? "This turn did not record a readable starting capture. No current checkout comparison was substituted."
          : "No edit-triggered capture has finished yet. Refresh explicitly to inspect the current captured state.",
    };
    const failure =
      active?.operationId === input.operationId ? active.reviewCaptureFailure : undefined;
    const preview: CodeTurnReviewPreview =
      failure?.current() === true
        ? { ...retained, status: "unavailable", explanation: failure.explanation }
        : retained;
    return settled && preview.capture?.final !== true
      ? {
          ...preview,
          status: "unavailable",
          settled,
          explanation:
            "The final comparison was not captured. The last valid version is retained; later edits may be missing.",
        }
      : { ...preview, settled };
  }

  #captureIdentityCurrent(active: ActiveTurn, final: boolean): boolean {
    const thread = this.#effectiveThread(active.windowId, active.thread.id);
    const checkout = this.#options.persistence.readCodeCheckout(active.thread.checkoutId);
    return (
      this.#active.get(String(active.thread.id)) === active &&
      active.serverTools === undefined &&
      thread?.lifecycle === "active" &&
      thread.checkoutId === active.thread.checkoutId &&
      thread.projectId === active.thread.projectId &&
      thread.bindingRevisionId === active.thread.bindingRevisionId &&
      thread.repositoryId === active.thread.repositoryId &&
      thread.providerInstanceId === active.thread.providerInstanceId &&
      thread.modelId === active.thread.modelId &&
      thread.executionPolicy !== "plan" &&
      checkout?.availability === "available" &&
      checkout.repositoryId === active.thread.repositoryId &&
      (final ||
        (!active.abort.signal.aborted &&
          (active.state === "running" || active.state === "waiting")))
    );
  }

  #publishReview(active: ActiveTurn, preview: CodeTurnReviewPreview): void {
    const frame = this.#appendTurnEvent(active, {
      event: { kind: "conversation-turn-review-preview", preview },
    });
    active.cursor = frame.cursor;
    if (preview.capture !== undefined) active.reviewLatest = preview.capture;
  }

  async #captureRootCurrent(
    active: ActiveTurn,
    current: () => boolean,
  ): Promise<(() => boolean) | undefined> {
    const accessCurrent = this.#options.windowAccess.currentProjectAccess;
    if (!current() || accessCurrent === undefined) return undefined;
    return this.#options.windowAccess.standingAuthority(async () => {
      if (
        !(await this.#options.windowAccess.canAccessProject(
          active.windowId,
          active.thread.projectId,
        )) ||
        !current()
      )
        return undefined;
      const thread = this.#effectiveThread(active.windowId, active.thread.id);
      const checkout = this.#options.persistence.readCodeCheckout(active.thread.checkoutId);
      if (thread === undefined || checkout === undefined) return undefined;
      const root = await this.#options.resolveCheckoutRoot(active.windowId, thread, checkout);
      const access = this.#options.windowAccess.canAccessProject(
        active.windowId,
        active.thread.projectId,
      );
      if (!(typeof access === "boolean" ? access : await access)) return undefined;
      const proof = () =>
        current() &&
        accessCurrent(active.windowId, active.thread.projectId) &&
        root?.rootCurrent?.() !== false &&
        root?.checkoutRoot === active.checkoutRoot &&
        (active.thread.workingFolderId === undefined ||
          root.workingDirectory === active.providerRoot) &&
        (active.rootIdentity === undefined ||
          (root.rootIdentity?.device === active.rootIdentity.device &&
            root.rootIdentity.inode === active.rootIdentity.inode)) &&
        current();
      return proof() ? proof : undefined;
    });
  }

  #reviewScheduler(active: ActiveTurn): CodeTurnReviewCaptureScheduler {
    active.reviewCapture ??= new CodeTurnReviewCaptureScheduler({
      now: () => performance.now(),
      capture: (final, signal, deadline) => this.#captureReview(active, final, signal, deadline),
      unavailable: (reason, attemptCurrent) => {
        const guard = active.reviewCaptureGuard;
        const current = () =>
          attemptCurrent() && this.#captureIdentityCurrent(active, true) && guard?.() !== false;
        if (!current()) return;
        const explanation =
          reason === "deadline"
            ? "The newer capture timed out. The last valid version is retained; later edits remain uncaptured."
            : "The newer comparison could not be retained. The last valid version is retained; later edits remain uncaptured.";
        active.reviewCaptureFailure = { current, explanation };
        void this.#captureRootCurrent(active, current)
          .then((proof) => {
            if (proof?.() === true && current())
              this.#publishReview(active, {
                status: "unavailable",
                explanation,
              });
          })
          .catch(() => {});
      },
    });
    return active.reviewCapture;
  }

  async #captureReview(
    active: ActiveTurn,
    final: boolean,
    signal: AbortSignal,
    deadline: number,
  ): Promise<void | "unavailable"> {
    const admissionCurrent = active.reviewCaptureGuard;
    const identityCurrent = () =>
      !signal.aborted &&
      performance.now() < deadline &&
      admissionCurrent?.() !== false &&
      this.#captureIdentityCurrent(active, final);
    let rootCurrent: (() => boolean) | undefined;
    const current = () => identityCurrent() && rootCurrent?.() !== false;
    const authorized = async () => {
      const proof = await this.#captureRootCurrent(active, identityCurrent);
      if (proof === undefined) return false;
      rootCurrent = proof;
      return current();
    };
    if (!(await authorized())) return identityCurrent() ? "unavailable" : undefined;
    const source = this.#reviewSource(active.thread.id, active.operationId);
    if (
      source?.checkoutId !== active.thread.checkoutId ||
      source.checkpoint === undefined ||
      !this.#git.supportsCapturedDiff
    ) {
      if (current())
        this.#publishReview(active, {
          status: "unavailable",
          explanation:
            "A readable starting capture or bounded tree comparison is unavailable for this turn. No working-tree substitute was captured.",
        });
      return;
    }
    if (source.reviewPreview?.capture !== undefined)
      active.reviewLatest ??= source.reviewPreview.capture;
    this.#publishReview(active, {
      status: "capturing",
      explanation:
        "Capturing a newer checkout comparison. The last valid version stays readable; later edits may be uncaptured.",
    });
    const result = await this.#git.changesSince(
      {
        checkoutId: String(active.thread.checkoutId),
        checkoutRoot: active.checkoutRoot,
        from: source.checkpoint.worktree,
        includeDiff: true,
        captureCurrent: authorized,
        resolveExecutionPolicy: () =>
          this.#effectiveThread(active.windowId, active.thread.id)?.executionPolicy ?? "plan",
      },
      signal,
    );
    if (!(await authorized())) return identityCurrent() ? "unavailable" : undefined;
    if (result.status !== "ready" || result.capture === undefined) {
      this.#publishReview(active, {
        status: "unavailable",
        explanation:
          "The newer capture failed. The last valid version remains readable; later changes have not been captured.",
      });
      return;
    }
    const bounded = boundReviewText(result.capture.diff.text, DEFAULT_MAX_GIT_DIFF_BYTES);
    if (!current()) return identityCurrent() ? "unavailable" : undefined;
    const diff = this.#options.evidence.put(bounded.text, {
      truncated: bounded.truncated || result.capture.diff.truncated,
    });
    // The capture's cursor must equal its own event's cursor, so journal any
    // buffered reply text first; flushing later would advance the cursor past it.
    this.#flushDelta(active);
    const capture = decodeCodeTurnReviewCapture({
      checkoutId: active.thread.checkoutId,
      version: (active.reviewLatest?.version ?? 0) + 1,
      cursor: active.cursor + 1,
      baseline: source.checkpoint.worktree,
      tree: result.capture.to,
      diff,
      changedFiles: turnChangedFiles(result.changes) ?? { files: [], total: 0, truncated: false },
      capturedAt: this.#options.clock(),
      final,
    });
    if (!current()) return identityCurrent() ? "unavailable" : undefined;
    this.#publishReview(active, {
      status: "ready",
      capture,
      explanation:
        "Checkout changes since this turn’s starting capture, possibly including other writers. Later edits may be uncaptured; viewing does not verify the changes.",
    });
    if (final) active.reviewFinalCaptured = true;
  }

  async #recordChangedFiles(active: ActiveTurn): Promise<void> {
    if (active.changedFilesRecording !== undefined) return active.changedFilesRecording;
    active.changedFilesRecording = (async () => {
      try {
        if (this.#git.supportsCapturedDiff) {
          await this.#reviewScheduler(active).flush(true);
          const changedFiles =
            active.reviewFinalCaptured === true ? active.reviewLatest?.changedFiles : undefined;
          if (changedFiles === undefined || changedFiles.total === 0) return;
          const frame = this.#appendTurnEvent(active, {
            event: { kind: "conversation-turn-changed-files", changedFiles },
          });
          active.cursor = frame.cursor;
          return;
        }
        const replay = this.#events.replay({
          threadId: active.thread.id,
          operationId: active.operationId,
          afterCursor: 0,
          limit: 256,
        });
        if (replay.status !== "ok") return;
        const started = replay.frames.find(
          (frame) => frame.event.kind === "conversation-turn-started",
        );
        const from =
          started?.event.kind === "conversation-turn-started"
            ? started.event.checkpoint?.worktree
            : undefined;
        if (from === undefined) return;
        const resolveExecutionPolicy = () =>
          this.#effectiveThread(active.windowId, active.thread.id)?.executionPolicy ??
          active.thread.executionPolicy;
        const result = await this.#git.changesSince({
          checkoutId: String(active.thread.checkoutId),
          checkoutRoot: active.checkoutRoot,
          from,
          executionPolicy: resolveExecutionPolicy(),
          resolveExecutionPolicy,
        });
        if (result.status !== "ready") return;
        const changedFiles = turnChangedFiles(result.changes);
        if (changedFiles === undefined) return;
        const frame = this.#appendTurnEvent(active, {
          event: { kind: "conversation-turn-changed-files", changedFiles },
        });
        active.cursor = frame.cursor;
      } catch {
        // Evidence only; see above.
      }
    })();
    return active.changedFilesRecording;
  }

  #persistOutcome(
    active: ActiveTurn,
    outcome: CodeTurnOutcome,
    failure?: CodeOperationFailure,
  ): void {
    if (outcome === "completed" && active.deltaFlushFailure !== undefined) {
      outcome = "failed";
      failure = evidenceCapacityFailure(active.deltaFlushFailure.error);
    }
    // Only a lost-text failure keeps its terminal state: the runner settles the
    // aborted turn after that failure was journaled, and its `interrupted` must
    // not stack on it. Every other turn journals a later, different outcome as
    // it always did.
    const journaledTerminal =
      active.deltaFlushFailure !== undefined &&
      (active.lastPersistedState === "completed" ||
        active.lastPersistedState === "failed" ||
        active.lastPersistedState === "interrupted")
        ? active.lastPersistedState
        : undefined;
    const supersededTerminal = journaledTerminal !== undefined && journaledTerminal !== outcome;
    if (journaledTerminal !== undefined) outcome = journaledTerminal;
    active.state = outcome;
    if (outcome === "failed" || outcome === "interrupted") this.#revokeBrowserGrants(active);
    // The provider's own terminal event already journaled this state, reason
    // and all; a second frame would only repeat it. The settle below is not
    // part of that dedupe: the board reads runtime work, not this journal.
    const alreadyJournaled =
      supersededTerminal ||
      (active.lastPersistedState === outcome && active.lastPersistedFailure === failure?.message);
    if (!alreadyJournaled) {
      const frame = this.#appendTurnEvent(active, {
        event: {
          kind: "operation-state",
          state: outcome,
          ...(failure === undefined ? {} : { failure }),
        },
      });
      active.cursor = frame.cursor;
      active.lastPersistedState = outcome;
      active.lastPersistedFailure = failure?.message;
    }
    this.#persistRuntimeWork(active, outcome);
  }

  #revokeBrowserGrants(active: ActiveTurn): void {
    for (const contextId of active.browserProfileContexts)
      this.#options.browserProfiles?.forgetBinding(contextId);
    active.browserProfileContexts.clear();
    for (const key of active.browserGrantKeys) {
      this.#approvedBrowserContexts.delete(key);
      this.#boundBrowserContexts.delete(key);
    }
    active.browserGrantKeys.clear();
  }

  /**
   * Mirror the turn's live state into the thread's runtime work record.
   *
   * The Code board and the sidebar row both read runtime work, never the
   * operation journal, so a turn that writes no record is reported as idle for
   * its whole run: the card sits in Ready while the agent is working and the
   * row falls through to an unread dot instead of Working.
   *
   * The record is also what restart reconciliation looks for. A `running`
   * provider turn left behind by a killed host becomes `waiting` there, where
   * an operation frame frozen mid-turn would claim the thread was executing
   * forever.
   */
  #persistRuntimeWork(active: ActiveTurn, state: CodeTurnOutcome): void {
    this.settleSpendReservation(active.operationId);
    this.#observeRuntimeWorkOutcome(
      this.#runtimeWork.settle({
        id: active.operationId,
        threadId: active.thread.id,
        kind: "provider-turn",
        state,
      }),
    );
  }
}

/**
 * How long a Stop waits for the runtime to confirm the turn ended: the same
 * grace Chat gives a shared-process runtime and the renderer waits before it
 * offers Force stop. A runtime that never answers the interrupt otherwise
 * left the person's Stop request waiting indefinitely; the turn itself stays
 * open until the runtime reports how it ended.
 */
export const CODE_STOP_CONFIRMATION_MS = 10_000;

const STOP_UNCONFIRMED_MESSAGE =
  "Stop was not confirmed. The provider may still be running this turn.";

/** Whether `work` settles, either way, before `ms` pass. */
async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Streamed text of one channel is journaled at most this often. */
const STREAMED_DELTA_BATCH_WINDOW_MS = 100;
/** A burst this long flushes early, well under the evidence bound. */
const STREAMED_DELTA_BATCH_MAX_CHARS = 256 * 1024;

function optionalFailure(failure: CodeOperationFailure | undefined) {
  return failure === undefined ? {} : { failure };
}

function evidenceCapacityFailure(error: unknown): CodeOperationFailure | undefined {
  const capacityExceeded =
    error instanceof CodeEvidenceCapacityExceeded ||
    (error instanceof Error &&
      (error.name.includes("CodeEvidenceCapacityExceeded") ||
        error.message.includes("Code evidence storage capacity is exhausted") ||
        error.stack?.includes("CodeEvidenceCapacityExceeded") === true));
  if (!capacityExceeded) return undefined;
  return {
    category: "unavailable",
    message:
      "Local Code evidence storage is full. Back up this Octant profile and clear its local application data before retrying.",
  };
}

function normalizedOperationEvent(
  event: CodeTurnEvent,
  active: ActiveTurn,
  evidence: CodeOperationEvidencePort,
  uuid: () => string,
): CodeOperationEvent | undefined {
  if (event.category === "message" || event.category === "reasoning") {
    return {
      kind: "provider-content",
      channel: event.category,
      content: evidence.put(event.text ?? " "),
    };
  }
  if (event.category === "approval" && event.requestId !== undefined) {
    const approvalId = CodeApprovalId.make(uuid());
    active.approvals.set(String(approvalId), event.requestId);
    return {
      kind: "approval-requested",
      approvalId,
      action: "provider-tool",
      summary:
        boundProviderSummary(event.text ?? "Provider approval requested.") ??
        "Provider approval requested.",
    };
  }
  // The provider's own reviewer answered a call itself. It is journaled under
  // the provider's name beside the tool rows, and nobody was asked.
  if (event.category === "review" && event.verdict !== undefined) {
    return {
      kind: "approval-reviewed",
      summary: boundProviderSummary(event.text ?? "Tool call") ?? "Tool call",
      decision: {
        reviewer: "provider",
        verdict: event.verdict,
        ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
        ...(event.riskLevel === undefined ? {} : { riskLevel: event.riskLevel }),
        // Sanitizing can lengthen the text (a path becomes a placeholder), and
        // the journal refuses a reason past its bound.
        ...(event.reason === undefined
          ? {}
          : { reason: Array.from(event.reason).slice(0, MAX_SHIELD_REASON_LENGTH).join("") }),
        decidedAt: event.occurredAt,
      },
    };
  }
  if (event.category === "question" && event.requestId !== undefined) {
    active.questions.add(event.requestId);
    if (event.questionnaire !== undefined)
      active.providerQuestionnaires.set(event.requestId, event.questionnaire);
    return {
      kind: "input-requested",
      requestId: event.requestId,
      prompt:
        boundProviderText(
          event.text ?? "Provider input requested.",
          MAX_PROVIDER_INPUT_PROMPT_BYTES,
          "",
        ) ?? "Provider input requested.",
      options: boundProviderInputOptions(event.options ?? []),
      ...(event.questionnaire === undefined ? {} : { questionnaire: event.questionnaire }),
    };
  }
  if (
    event.category === "observation" &&
    event.providerKind === "file-change" &&
    event.path !== undefined
  ) {
    return {
      kind: "file-change",
      path: decodeCodeRelativePath(event.path),
      change: (event.change ?? "modified") as "created" | "modified" | "deleted",
      reconciled: event.reconciliation?.status === "confirmed",
    };
  }
  if (event.category === "observation" && event.providerKind === "diff") {
    return {
      kind: "diff",
      content: evidence.put(event.text ?? " "),
      reconciled: event.reconciliation?.status === "confirmed",
    };
  }
  // The provider's word on how a tool ended is an observation, never proof,
  // but it is still the only thing that closes the tool row the start opened.
  if (
    event.category === "observation" &&
    (event.providerKind === "tool-success" || event.providerKind === "tool-failure") &&
    event.toolCallId !== undefined &&
    event.toolName !== undefined
  ) {
    const summary = event.text === undefined ? undefined : boundProviderSummary(event.text);
    return {
      kind: "tool-activity",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      state: event.providerKind === "tool-success" ? "completed" : "failed",
      ...(summary === undefined ? {} : { summary }),
      ...(event.providerKind === "tool-success" && event.published !== undefined
        ? { published: event.published }
        : {}),
    };
  }
  if (event.category === "usage")
    return {
      kind: "usage",
      inputTokens: event.inputTokens ?? 0,
      outputTokens: event.outputTokens ?? 0,
      ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
      ...(event.cost === undefined ? {} : { cost: event.cost }),
      ...(event.cacheReadInputTokens === undefined
        ? {}
        : { cacheReadInputTokens: event.cacheReadInputTokens }),
      ...(event.cacheWriteInputTokens === undefined
        ? {}
        : { cacheWriteInputTokens: event.cacheWriteInputTokens }),

      ...(event.contextWindow === undefined ? {} : { contextWindow: event.contextWindow }),
      ...(event.contextTokens === undefined ? {} : { contextTokens: event.contextTokens }),
      ...(event.autoCompactThreshold === undefined
        ? {}
        : { autoCompactThreshold: event.autoCompactThreshold }),
      ...(event.contextBreakdown === undefined ? {} : { contextBreakdown: event.contextBreakdown }),
    };
  if (event.category === "provider-limit" && event.text !== undefined)
    return {
      kind: "provider-limit",
      window: event.text,
      status: (event.status ?? "allowed") as "allowed" | "warning" | "exhausted",
      ...(event.utilization === undefined ? {} : { utilization: event.utilization }),
      ...(event.resetsAt === undefined
        ? {}
        : { resetsAt: event.resetsAt as CodeOperationEventFrame["occurredAt"] }),
    };
  if (event.category === "task-progress")
    return {
      kind: "task-progress",
      taskId: event.requestId ?? "provider-task",
      state: event.status === "in-progress" ? "running" : ((event.status ?? "waiting") as never),
      summary:
        boundProviderSummary(event.text ?? "Provider task progress.") ?? "Provider task progress.",
    };
  if (event.category === "task-list")
    return {
      kind: "task-list",
      // The panel keeps at most this many tasks, and the journal bounds the list to match.
      taskIds: (event.taskIds ?? []).slice(0, MAX_THREAD_TASKS_PER_TURN),
    };
  if (event.category === "child-activity")
    return {
      kind: "child-activity",
      ...(event.childObservation === undefined ? {} : { observation: event.childObservation }),
      childId: event.requestId ?? "provider-child",
      state: (event.status ?? "waiting") as never,
      summary:
        boundProviderSummary(event.text ?? "Provider child activity.") ??
        "Provider child activity.",
    };
  if (event.category === "tool") {
    const summary = event.text === undefined ? undefined : boundProviderSummary(event.text);
    return {
      kind: "tool-activity",
      toolCallId: event.toolCallId ?? event.requestId ?? "provider-tool",
      toolName: event.toolName ?? "provider-tool",
      state:
        event.status === "provider-claimed-failure" ||
        event.status === "failed" ||
        event.status === "interrupted"
          ? "failed"
          : event.status === "completed"
            ? "completed"
            : event.status === "started"
              ? "started"
              : "running",
      ...(summary === undefined ? {} : { summary }),
      ...(event.status === "completed" && event.outsideContent !== undefined
        ? { outsideContent: event.outsideContent }
        : {}),
      ...(event.status === "completed" && event.routine !== undefined
        ? { routine: event.routine }
        : {}),
    };
  }
  if (
    event.category === "retry" &&
    event.attempt !== undefined &&
    event.maxAttempts !== undefined &&
    event.delayMs !== undefined &&
    event.status !== undefined
  ) {
    const reason = event.status;
    if (
      reason === "rate-limited" ||
      reason === "unavailable" ||
      reason === "stream-interrupted" ||
      reason === "empty-completion"
    ) {
      return {
        kind: "provider-retry",
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        reason,
        announcedAt: event.occurredAt,
      };
    }
  }
  if (event.category === "completion") return { kind: "operation-state", state: "completed" };
  if (event.category === "waiting") return { kind: "operation-state", state: "waiting" };
  if (event.category === "interruption") {
    // The provider's sentence is the only reason the person will ever see, so
    // the journaled frame carries it; a forced stop's own reason wins over the
    // provider's generic cancellation copy, exactly like the outcome path.
    const reason = withLostTextNote(active, active.interruptMessage ?? event.text);
    const message =
      reason === undefined
        ? undefined
        : boundProviderFailureMessage(
            sanitizeProviderText(reason, active.checkoutRoot, active.secrets),
          );
    return {
      kind: "operation-state",
      state: "interrupted",
      ...(message === undefined ? {} : { failure: { category: "failed", message } }),
    };
  }
  // The provider's sentence is the only reason the person will ever see:
  // without it the transcript said "The provider turn failed" and nothing
  // else, whatever the driver had refused with.
  if (event.category === "failure") {
    const failureText = withLostTextNote(active, event.text);
    const message =
      failureText === undefined ? undefined : boundProviderFailureMessage(failureText);
    return {
      kind: "operation-state",
      state: "failed",
      ...(message === undefined ? {} : { failure: { category: "failed", message } }),
    };
  }
  return undefined;
}

/** The stop's note that streamed reply text was lost, once any flush has failed. */
function lostTextNote(active: ActiveTurn): string | undefined {
  if (active.deltaFlushFailure === undefined) return undefined;
  return (
    evidenceCapacityFailure(active.deltaFlushFailure.error)?.message ??
    "Some streamed reply text could not be saved."
  );
}

/**
 * A stop's reason with the lost-text note appended once. Stops that settle
 * through the runner (the folder going away, a provider-reported failure)
 * never pass #flushBeforeStop, so the note is added where the terminal state
 * is built; a reason that already carries it is left alone.
 */
function withLostTextNote(active: ActiveTurn, reason: string | undefined): string | undefined {
  const note = lostTextNote(active);
  if (note === undefined) return reason;
  if (reason === undefined) return note;
  return reason.includes(note) ? reason : `${reason} ${note}`;
}

const FAILURE_MESSAGE_SUFFIX = "\n[Provider failure message truncated.]";
const SUMMARY_SUFFIX = " [truncated]";
const MAX_PROVIDER_INPUT_PROMPT_BYTES = 8 * 1024;
// `CodeOperationEvent`'s `input-requested` accepts at most this many choices of
// at most this many bytes each; a provider that offers more keeps its first.
const MAX_PROVIDER_INPUT_OPTIONS = 32;
const MAX_PROVIDER_INPUT_OPTION_BYTES = 1_024;

/**
 * What the person is offered to click on a provider's question. Blank labels
 * are dropped rather than invented into something, and a question left with
 * none stays a free-text question.
 */
function boundProviderInputOptions(options: ReadonlyArray<string>): ReadonlyArray<string> {
  return options
    .flatMap((label) => boundProviderText(label, MAX_PROVIDER_INPUT_OPTION_BYTES, "") ?? [])
    .slice(0, MAX_PROVIDER_INPUT_OPTIONS);
}

/**
 * `CodeOperationFailure` accepts at most
 * `MAX_CODE_OPERATION_FAILURE_MESSAGE_BYTES` of trimmed, non-empty UTF-8. A
 * provider sentence that is longer, blank, or untrimmed would make the whole
 * `operation-state` frame invalid when the event store validates it, so the
 * reason it was carrying would never be journaled at all. Bounding it here
 * keeps the reason; only a message with nothing left to say is dropped.
 */
function boundProviderText(text: string, maxBytes: number, suffix: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const bytes = new TextEncoder().encode(trimmed);
  if (bytes.byteLength <= maxBytes) return trimmed;
  const suffixBytes = new TextEncoder().encode(suffix).byteLength;
  const head = new TextDecoder()
    .decode(bytes.slice(0, maxBytes - suffixBytes))
    // Slicing bytes can cut a multi-byte character in half; the decoder leaves
    // a replacement character behind that is wider than the bytes it replaced.
    .replace(/\uFFFD+$/, "")
    .trimEnd();
  return head === "" ? undefined : `${head}${suffix}`;
}

const boundProviderFailureMessage = (text: string): string | undefined =>
  boundProviderText(text, MAX_CODE_OPERATION_FAILURE_MESSAGE_BYTES, FAILURE_MESSAGE_SUFFIX);

// Tool inputs, approval descriptions, and task text are provider-sized (an
// ACP terminal command can carry a whole heredoc); the journal only keeps the
// head of one that will not fit, never the turn's failure.
function boundProviderSummary(text: string): string | undefined {
  return boundProviderText(text, MAX_CODE_OPERATION_SUMMARY_BYTES, SUMMARY_SUFFIX);
}

/**
 * The one treatment every provider-authored string gets before it is journaled:
 * the checkout root and the turn's secrets are replaced. Event text and a
 * typed failure's message share it, so neither has a path the other lacks.
 */
function sanitizeProviderText(value: string, checkoutRoot: string, secrets: readonly string[]) {
  let sanitized = value.replaceAll(checkoutRoot, "[CHECKOUT]");
  for (const secret of secrets) sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  return sanitized;
}

function sanitizeProviderEvent(
  event: ProviderRuntimeEvent,
  checkoutRoot: string,
  secrets: readonly string[],
): ProviderRuntimeEvent {
  const sanitize = (value: unknown): unknown => {
    if (typeof value === "string") return sanitizeProviderText(value, checkoutRoot, secrets);
    if (Array.isArray(value)) return value.map(sanitize);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, sanitize(child)]));
  };
  if (event.kind === "file-change") {
    if (!isAbsolute(event.path)) return sanitize(event) as ProviderRuntimeEvent;
    const relativePath = relative(checkoutRoot, event.path);
    if (relativePath.startsWith("..") || relativePath === "" || relativePath.includes(`..${sep}`))
      throw new Error("Provider path is outside checkout.");
    return sanitize({ ...event, path: relativePath.split(sep).join("/") }) as ProviderRuntimeEvent;
  }
  return sanitize(event) as ProviderRuntimeEvent;
}

/**
 * What an answer the turn took reports. A turn a cancel or an earlier stop
 * already interrupted cannot act on the answer, so it is refused with that
 * reason; only the denial that itself stops a turn reports a bare
 * `interrupted`.
 */
function answeredTurnState(state: ActiveTurn["state"]): ReturnType<typeof turnState> {
  return state === "interrupted"
    ? turnState("interrupted", {
        category: "failed",
        message: "The turn that asked has ended. Send a new message to continue.",
      })
    : turnState(state);
}

function turnState(
  state: ActiveTurn["state"],
  failure?: { readonly category: "failed"; readonly message: string },
): {
  state: ActiveTurn["state"];
  failure?: { readonly category: "failed"; readonly message: string };
} {
  return failure === undefined ? { state } : { state, failure };
}

function createPullRequestPort(options: CodeOperationRuntimeOptions): CodeOperationPullRequestPort {
  const unavailable: CodeOperationPullRequestPort = {
    ensure: async () => ({ status: "unavailable" as const }),
    update: async () => ({ status: "unavailable" as const }),
    observeReview: async () => ({ status: "unavailable" as const }),
  };
  if (options.ghExecutable === undefined) return unavailable;
  try {
    return createGhPullRequestPort({
      command: createGhCommandPort({ ghPath: options.ghExecutable }),
      resolveTarget: options.resolvePullRequestTarget,
      ...(options.inheritedEnvironment === undefined
        ? {}
        : { inheritedEnvironment: options.inheritedEnvironment }),
    });
  } catch {
    return unavailable;
  }
}

/**
 * Read the Project checkout a run would come home to, as it stands now.
 *
 * The path comes from the host, which knows the Project binding; the branch and
 * cleanliness are observed here, immediately before the merge gate reads them.
 * A checkout that cannot be observed is reported unavailable, which the gate
 * treats as a refusal rather than as permission.
 */
function baseCheckoutResolver(
  git: GitService,
  resolveRoot: (thread: CodeThread) => Promise<string | undefined>,
): NonNullable<CodeOperationServiceOptions["resolveBaseCheckout"]> {
  return async (thread) => {
    const checkoutRoot = await resolveRoot(thread).catch(() => undefined);
    if (checkoutRoot === undefined) return { status: "unavailable" };
    const observed = await git.observe(checkoutRoot);
    if (observed.status !== "ready") return { status: "unavailable" };
    return {
      status: "observed",
      checkoutRoot: observed.checkoutRoot,
      branch: observed.head.kind === "branch" ? observed.head.name : undefined,
      clean: observed.changedPaths.length === 0,
    };
  };
}

const decodeCodeGitOperationId = Schema.decodeUnknownSync(CodeGitOperationId);

function codeOperationGitPort(git: GitService): CodeOperationGitPort {
  return {
    remoteHead: (input, signal) => git.remoteHead(input, signal),
    observe: async ({ checkoutRoot, maxDiffBytes, ignoreWhitespace }) =>
      mapGitObservation(
        await git.observe(
          checkoutRoot,
          undefined,
          ignoreWhitespace === true ? { ignoreWhitespace: true } : undefined,
        ),
        maxDiffBytes,
      ),
    observeRemotes: async ({ checkoutRoot }) => {
      const remotes = await git.observeRemotes(checkoutRoot);
      return remotes?.map((remote) => ({
        name: remote.name,
        fetch:
          remote.fetchUrl.length === 0
            ? { kind: "local" as const }
            : { kind: "network" as const, url: remote.fetchUrl },
        push:
          remote.pushUrl.length === 0
            ? { kind: "local" as const }
            : { kind: "network" as const, url: remote.pushUrl },
      }));
    },
    prepareHunks: (input) => git.prepareHunks(input),
    applyHunks: (input) => git.applyHunks(input),
    stage: (input) => git.stage(input),
    discard: (input) => git.discard(input),
    commit: (input) =>
      git.commit({
        ...input,
        stagedSummary: input.stagedSummary.map((entry) => ({
          path: entry.path,
          index: entry.index,
          worktree: entry.worktree,
          ...(entry.originalPath === undefined ? {} : { originalPath: entry.originalPath }),
        })),
      }),
    push: (input) => git.push(input),
    unstage: (input) => git.unstage(input),
    checkpoint: (input) => git.checkpoint(input),
    restoreCheckpoint: (input) => git.restoreCheckpoint(input),
    changesSince: (input) => git.changesSince(input),
    compareBranch: (input) => git.compareBranch(input),
    readBranchDiff: async (input) => {
      const result = await git.readDiff({
        checkoutRoot: input.checkoutRoot,
        scope: { kind: "branch", baseRef: input.baseRef },
        ...(input.ignoreWhitespace === true ? { ignoreWhitespace: true } : {}),
      });
      return result.status === "ready"
        ? {
            status: "ready",
            paths: result.paths,
            diff: result.diff.text,
            diffTruncated: result.diff.truncated,
          }
        : { status: "unavailable" };
    },
    mergeRun: async (input) => {
      const result = await git.mergeBranch({
        checkoutId: input.checkoutRoot,
        checkoutRoot: input.checkoutRoot,
        branch: input.branch,
        executionPolicy: input.executionPolicy,
      });
      return result.status === "applied"
        ? { status: "applied", ...(result.oid === undefined ? {} : { oid: result.oid }) }
        : result.status === "rejected"
          ? { status: "rejected", reason: result.reason }
          : { status: result.status };
    },
  } as CodeOperationGitPort;
}

/**
 * Draft delivery text from the change the checkout already shows.
 *
 * The diff is read here rather than trusted from the renderer, so the model
 * only ever sees what this host observed. A checkout with nothing to describe,
 * or a thread whose provider cannot be resolved, reports unavailable instead
 * of asking a model to invent a message.
 */
async function draftDeliveryText(
  options: CodeOperationRuntimeOptions,
  git: GitService,
  input: {
    readonly thread: CodeThread;
    readonly checkoutRoot: string;
    readonly purpose: "commit-message" | "pull-request";
  },
): Promise<CodeGitDraftResult> {
  const observed = await git.observe(input.checkoutRoot);
  if (observed.status !== "ready") return { status: "unavailable" };
  // Each purpose gets the changes it is actually about. The working-tree diff
  // is neither: it would let a commit message describe unstaged work that the
  // commit will not carry, and it would call a branch whose changes are already
  // committed empty.
  const scoped = await readDraftDiff(git, observed, input);
  if (scoped.status !== "ready" || scoped.paths.length === 0) return { status: "unavailable" };
  if (scoped.diff.text.trim().length === 0) return { status: "unavailable" };
  const driver = await options.resolveProviderDriver(input.thread);
  if (driver === undefined) return { status: "unavailable" };
  const diff = boundedDiff(scoped.diff.text);
  const paths = scoped.paths;
  return draftGitText(
    {
      driver,
      instanceId: input.thread.providerInstanceId,
      modelId: input.thread.modelId,
      sessionId: options.uuid() as ReturnType<typeof decodeProviderSessionId>,
      projectRoot: input.checkoutRoot,
    },
    {
      purpose: input.purpose,
      ...(observed.head.kind === "branch" ? { branch: observed.head.name } : {}),
      diff: diff.text,
      diffTruncated: diff.truncated || scoped.diff.truncated,
      paths,
    },
  );
}

/**
 * The slice of the checkout each kind of draft describes.
 *
 * A commit describes the index. A pull request describes what the branch has
 * committed since it left its base, which is why the base is tried as a
 * remote-tracking ref first and as a local branch second: the remote's copy is
 * what the pull request will actually be opened against, and the local branch
 * is the honest fallback on a checkout that has never fetched.
 */
async function readDraftDiff(
  git: GitService,
  observed: Extract<GitObservationResult, { readonly status: "ready" }>,
  input: {
    readonly thread: CodeThread;
    readonly checkoutRoot: string;
    readonly purpose: "commit-message" | "pull-request";
  },
): Promise<GitScopedDiffResult> {
  const checkoutRoot = observed.checkoutRoot;
  if (input.purpose === "commit-message")
    return await git.readDiff({ checkoutRoot, scope: { kind: "staged" } });
  const target = input.thread.deliveryTarget;
  for (const baseRef of [
    `${target.remoteName}/${target.proposedBaseBranch}`,
    target.proposedBaseBranch,
  ]) {
    const result = await git.readDiff({ checkoutRoot, scope: { kind: "branch", baseRef } });
    if (result.status === "ready") return result;
  }
  return { status: "unavailable" };
}

function mapGitObservation(
  result: GitObservationResult,
  maxDiffBytes: number,
): Awaited<ReturnType<CodeOperationGitPort["observe"]>> {
  if (result.status !== "ready") return result;
  const diff = Buffer.from(result.diff.text, "utf8").subarray(0, maxDiffBytes).toString("utf8");
  return {
    status: "ready",
    head: result.head,
    stateToken: result.stateToken,
    statusEntries: result.statusEntries,
    changedPaths: result.changedPaths,
    insertions: result.insertions,
    deletions: result.deletions,
    diff,
    diffTruncated: result.diff.truncated || diff !== result.diff.text,
    remotes: result.remotes.map((remote) => ({
      name: remote.name,
      fetch: mapRemoteEndpoint(remote.fetchUrl),
      push: mapRemoteEndpoint(remote.pushUrl),
    })),
    upstream: result.upstream,
    worktrees: result.worktrees.flatMap((worktree) => {
      if (worktree.head === null) return [];
      const branch = worktree.branch?.startsWith("refs/heads/")
        ? worktree.branch.slice("refs/heads/".length)
        : undefined;
      // Git reports an all-zero object for a worktree whose branch has no
      // commits yet; that is an unborn head, not an object anyone can resolve.
      const unborn = /^0+$/.test(worktree.head);
      if (unborn && branch === undefined) return [];
      return [
        {
          checkoutId: checkoutIdForPath(worktree.path),
          head: unborn
            ? { kind: "unborn" as const, name: branch! }
            : branch === undefined
              ? { kind: "detached" as const, oid: worktree.head }
              : { kind: "branch" as const, name: branch, oid: worktree.head },
          state: worktree.locked
            ? ("locked" as const)
            : worktree.prunable
              ? ("prunable" as const)
              : worktree.bare
                ? ("unavailable" as const)
                : ("active" as const),
        },
      ];
    }),
  };
}

function mapRemoteEndpoint(value: string) {
  if (isAbsolute(value) || value.startsWith("./") || value.startsWith("../"))
    return { kind: "local" as const };
  const scp = /^(?<authority>[^/:\s]+@[^/:\s]+):(?<path>\S+)$/.exec(value);
  const authority = scp?.groups?.authority;
  const path = scp?.groups?.path;
  if (authority !== undefined && path !== undefined)
    return {
      kind: "network" as const,
      url: `ssh://${authority}/${path.replace(/^\/+/, "")}`,
    };
  try {
    const url = new URL(value);
    if (url.protocol === "ssh:" || url.protocol === "https:")
      return { kind: "network" as const, url: url.toString() };
  } catch {
    // Git accepts relative filesystem remotes as well as URLs.
  }
  return { kind: "local" as const };
}

function checkoutIdForPath(path: string) {
  const digest = createHash("sha256").update("octant-code-checkout\0").update(path).digest("hex");
  return decodeCodeCheckoutId(
    `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
  );
}

/**
 * The curated catalog and one runner, as the operation service asks for them.
 *
 * Resolving the entry here — not in the service, and never from the command —
 * is what keeps the published catalog the only set of generators a thread can
 * reach.
 */
function scaffoldRunnerPort(runner: ScaffoldRunner): CodeOperationScaffoldPort {
  return {
    entry: (scaffoldId) =>
      CURATED_SCAFFOLDS.find((candidate) => String(candidate.id) === scaffoldId),
    run: (input) => runner.run(input),
  };
}

function concatenatedOutput(stdout: Uint8Array, stderr: Uint8Array): Uint8Array {
  const combined = new Uint8Array(stdout.byteLength + stderr.byteLength);
  combined.set(stdout, 0);
  combined.set(stderr, stdout.byteLength);
  return combined;
}

function forkPointFrom(checkpoint: {
  readonly worktree: string;
  readonly index: string;
  readonly head?: string | undefined;
}): CodeForkPoint {
  // A worktree starts from a commit; a repository with none has nowhere to start.
  if (checkpoint.head === undefined) return { status: "refused", reason: "no-commits" };
  return {
    status: "resolved",
    head: checkpoint.head,
    files: { worktree: checkpoint.worktree, index: checkpoint.index },
  };
}
