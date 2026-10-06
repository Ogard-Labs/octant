import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, sep } from "node:path";
import {
  type AgentRun,
  type AgentRunId,
  CodeApprovalId,
  MAX_CODE_CONVERSATION_PAGE_SIZE,
  MAX_CODE_OPERATION_FAILURE_MESSAGE_BYTES,
  MAX_CODE_OPERATION_SUMMARY_BYTES,
  MAX_CODE_OPERATION_TEXT_BYTES,
  decodeCodeOperationApprovalRequest,
  decodeCodeOperationApprovalConfirmation,
  decodeCodeCheckoutId,
  decodeCodeCheckoutHead,
  decodeCodeOperationCommand,
  decodeCodeEvidenceBatchResponse,
  decodeCodeRelativePath,
  decodeCodeReviewFindingId,
  decodeProviderSessionId,
  type CodeCheckoutIdentity,
  type AppleActionRequest,
  type AndroidEmulatorRequest,
  type CodeOperationCommand,
  type CodeOperationFailure,
  type CodeConversationPage,
  type ProviderSessionId,
  type CodeEvidenceBatchRequest,
  type CodeEvidenceBatchResponse,
  type CodeOperationApprovalReceipt,
  type CodeOperationApprovalRequest,
  type CodeOperationApprovalChallenge,
  type CodeOperationApprovalConfirmation,
  type CodeEvidenceContentId,
  type CodeOperationEvent,
  type CodeOperationEventFrame,
  type CodeOperationId,
  type CodeRuntimeWorkId,
  type CodeOperationResult,
  type CodeThread,
  type CodeThreadId,
  type EventActor,
  type ProviderCapabilities,
  type ProviderRuntimeEvent,
  type ProviderResumeCursor,
  type ProviderProbeResult,
  type WindowId,
  decodeCodeFailure,
} from "@octant/contracts";
import { Effect } from "effect";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import type { Journal } from "../persistence/journal";
import { GhPullRequestPort, createGhCommandPort, type GhDeliveryTarget } from "./ghPullRequestPort";
import { GitMutationPort } from "./gitMutationPort";
import {
  GitObservationPort,
  type GitObservationResult,
  type GitScopedDiffResult,
} from "./gitObservationPort";
import { GitService } from "./gitService";
import { CodeOperationEventStore } from "./codeOperationEventStore";
import { chooseCodeForkPoint, codeThreadTurns } from "./codeForkPoint";
import {
  CodeRuntimeWorkRecorder,
  codeRuntimeWorkObserved,
  codeRuntimeWorkStarted,
  codeRuntimeWorkStateFrom,
  type CodeRuntimeWorkRecordFailure,
  type CodeRuntimeWorkRecordOutcome,
} from "./codeRuntimeWorkRecorder";
import {
  clampTurnAccessPosture,
  decidesCodeEffectsByApproval,
  isAppleSimulatorInputKind,
  isAppleSimulatorOpenInputKind,
  isAndroidEmulatorInputKind,
  isAndroidEmulatorOpenInputKind,
  harnessAutoReviewEffective,
  mayWriteToRepository,
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
} from "./codeOperationService";
import type { CodeAttachmentStore } from "./codeAttachmentStore";
import { RepositoryTestProcessPort } from "./repositoryTestProcessPort";
import type {
  NativeHarnessTurnAdmission,
  NativeHarnessTurnScope,
} from "../harness/nativeHarnessTurnObserver";
import type { ProviderContextBlock } from "@octant/contracts";
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
import { makeSeatbeltConfinementLive } from "../process/seatbeltProfile";
import { TerminalService } from "./terminalService";
import { CodeSessionAuthorityStore } from "./codeSessionAuthorityStore";
import { boundedDiff, draftGitText, type CodeGitDraftResult } from "./codeGitDraftService";
import { turnChangedFiles } from "./codeTurnChangedFiles";
import { CodeTurnRunner, type CodeTurnEvent, type CodeTurnOutcome } from "./codeTurnRunner";
import { createCodeAppManagedTools, type CodeAppManagedToolsOptions } from "./codeAppManagedTools";
import { combineAppManagedToolSets, type AppManagedToolSet } from "../providers/appManagedToolSet";
import { CodeEvidenceCapacityExceeded } from "./codeEvidenceStore";
import {
  BROWSER_SELECTION_GUIDANCE,
  isBrowserUseSelection,
  validateBrowserUseSelection,
} from "@octant/plugin-host/browser-use";

type Awaitable<T> = T | Promise<T>;

interface RuntimePersistence extends ReviewFindingPersistencePort {
  readonly readCodeRuntimeWorkAggregateVersion: (id: CodeRuntimeWorkId) => number;
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
  const confinement = makeSeatbeltConfinementLive({ platform: process.platform });
  return {
    environment,
    prepare: (input) =>
      confinement.prepare({
        executable: input.executable,
        args: input.args,
        boundRoot: input.boundRoot,
        temporaryDirectory: input.temporaryDirectory,
        networkEgress: "allow",
        allowProcessExec: true,
        allowProcessFork: true,
        allowFileReadStar: true,
        writeBoundRoot: true,
        readRoots: [input.boundRoot, input.temporaryDirectory, dirname(input.executable)],
      }),
  };
}

export interface CodeOperationRuntimeOptions {
  readonly computerUseTools?: (input: {
    readonly windowId: WindowId;
    readonly thread: CodeThread;
    readonly selection: import("@octant/contracts/extensions").ExtensionSelection;
  }) => AppManagedToolSet | undefined;
  /**
   * A refusal-only `octant_computer` for turns that carry no Computer
   * selection: registering the name lets a stale call return the
   * re-attach recovery instead of a provider-side unknown-tool failure.
   */
  readonly computerUseUnattachedTools?: (input: {
    readonly windowId: WindowId;
    readonly thread: CodeThread;
  }) => AppManagedToolSet | undefined;
  readonly persistence: RuntimePersistence;
  readonly windowAccess: {
    readonly canAccessProject: CodeOperationAuthorityPort["canAccessProject"];
  };
  readonly resolveCheckoutRoot: CodeOperationAuthorityPort["resolveCheckoutRoot"];
  readonly resolveProviderDriver: (thread: CodeThread) => Awaitable<ProviderDriver | undefined>;
  readonly credentialResolver: CredentialResolver;
  readonly resolvePullRequestTarget: (
    threadId: CodeThreadId,
  ) => Promise<GhDeliveryTarget | undefined>;
  readonly reviewFiles: ReviewFindingFilePort;
  readonly evidence: CodeOperationEvidencePort;
  /** The images Code threads have staged for their next turn. */
  readonly attachments?: CodeAttachmentStore;
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
    Partial<Pick<GitObservationPort, "observeRemotes" | "readDiff">>;
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
  >;
  readonly supportsAppManagedTools?: (thread: CodeThread) => boolean;
  readonly supportsAcpClientCapabilities?: (thread: CodeThread) => boolean;
  /**
   * Whether the thread's provider can carry its native session on to another
   * of its models. A host that cannot say so answers false, and a turn whose
   * model differs from its session's is refused as before.
   */
  readonly supportsModelSwitch?: (thread: CodeThread) => boolean;
  /**
   * Whether the thread's provider can take an image. A host that cannot say so
   * answers false: a turn that attached images then fails in words rather than
   * reaching the provider with the pictures silently dropped.
   */
  readonly supportsAttachments?: (thread: CodeThread) => boolean;
  readonly browserAutomation?: CodeAppManagedToolsOptions["browser"];
  /**
   * Whether an origin already holds a remembered "always allow" grant. Read
   * live so a grant forgotten in Settings stops satisfying it at once.
   */
  readonly isBrowserOriginRemembered?: (origin: string) => boolean;
  /** The app-managed Apple capability, when this host has an Apple toolchain. */
  readonly appleToolchain?: CodeAppManagedToolsOptions["apple"];
  /** The app-managed Android emulator capability. */
  readonly androidToolchain?: CodeAppManagedToolsOptions["android"];
  /**
   * The planner capability: a Project-board read and an advisory work
   * proposal, both answered only for the Project's designated planner thread.
   */
  readonly planner?: CodeAppManagedToolsOptions["planner"];
  /** Optional Project-fixed, read-only GitHub tools composed per active turn. */
  readonly githubReadTools?: (input: {
    readonly windowId: WindowId;
    readonly thread: CodeThread;
    readonly readThread: (windowId: WindowId, threadId: CodeThreadId) => CodeThread | undefined;
  }) => AppManagedToolSet | undefined;
  /**
   * The agent-message tool set for this thread, when the host admits agent
   * messaging (decision 0063). The service is server-owned; the tool only
   * petitions it.
   */
  readonly agentMessages?: (input: {
    readonly thread: CodeThread;
  }) => AppManagedToolSet | undefined;
  /** Lets the model offer out-of-scope work as a side task the person may start. */
  readonly sideTasks?: (input: { readonly thread: CodeThread }) => AppManagedToolSet | undefined;
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
    readonly windowId: WindowId;
  }) => AppManagedToolSet | undefined;
  readonly spendCeiling?: {
    readonly admit: SpendCeilingService["admit"];
    readonly settle: SpendCeilingService["settle"];
  };
  /** The harness around a turn: stable instructions in front, the reply observed after. */
  readonly nativeHarness?: {
    readonly contextFor: (scope: NativeHarnessTurnScope) => ReadonlyArray<ProviderContextBlock>;
    /** Absent means every turn is admitted. */
    readonly admitTurn?: (scope: NativeHarnessTurnScope) => NativeHarnessTurnAdmission;
    readonly turnStarted: (scope: NativeHarnessTurnScope) => void;
    /** Every turn's end, whatever its outcome. */
    readonly turnEnded?: (scope: NativeHarnessTurnScope) => void;
    readonly turnCompleted: (
      input: NativeHarnessTurnScope & { readonly text: string; readonly toolCalls: number },
    ) => Promise<void>;
    /** Settles a harness question the person answered through the Code question surface. */
    readonly answerQuestion?: (threadId: string, questionId: string, answer: string) => void;
  };
  readonly recordExternalContentIngestion?: CodeAppManagedToolsOptions["recordExternalContentIngestion"];
  /**
   * Reads whether a thread has ingested untrusted external content. Used to
   * clamp harness-delegated approvals back to user-answered prompts when taint
   * is present (0104). Absent means no taint reader is available, so
   * delegation is never enabled.
   */
  readonly readThreadExternalContentTaint?: (threadId: CodeThreadId) => {
    readonly externalContentIngested: boolean;
  };
  /**
   * Resolves the cached provider capabilities for a thread's provider, so the
   * runtime can check `harnessAutoReview` without re-probing on every turn.
   * Absent means capabilities are unknown, so delegation is never enabled.
   */
  readonly resolveProviderCapabilities?: (thread: CodeThread) => ProviderCapabilities | undefined;
  /** Reads the `#thread` mentions a turn names, on that turn's own principal. */
  readonly resolveThreadMentionContext?: CodeOperationServiceOptions["resolveThreadMentionContext"];
  /** Reads the `@file` mentions a turn names against this thread's bound root. */
  readonly resolveFileMentionContext?: CodeOperationServiceOptions["resolveFileMentionContext"];
  /** Takes the notes the user pointed at the running product into the next turn. */
  readonly takeProductFeedbackForTurn?: CodeOperationServiceOptions["takeProductFeedbackForTurn"];
  readonly takeIssueContextFramed?: CodeOperationServiceOptions["takeIssueContextFramed"];
  readonly peekIssueContextFramed?: CodeOperationServiceOptions["peekIssueContextFramed"];
  readonly consumeIssueContextFramed?: CodeOperationServiceOptions["consumeIssueContextFramed"];
  /**
   * The Project checkout a run comes home to. The host resolves the path; this
   * runtime observes its branch and cleanliness itself, so the merge gate reads
   * the checkout as it stands rather than as the caller last saw it.
   */
  readonly resolveBaseCheckoutRoot?: (thread: CodeThread) => Promise<string | undefined>;
  readonly resolveForkHandoff?: CodeOperationServiceOptions["resolveForkHandoff"];
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
  execute(
    windowId: WindowId,
    command: unknown,
    options?: CodeOperationExecuteOptions,
  ): Promise<CodeOperationResult>;
  inspectTerminal(
    windowId: WindowId,
    input: import("@octant/contracts").CodeTerminalInspectionRequest,
  ): Promise<import("@octant/contracts").CodeTerminalInspection>;
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
  ): Promise<{ readonly bytes: Uint8Array; readonly digest: string; readonly byteLength: number }>;
  readEvidenceBatch?(
    windowId: WindowId,
    input: CodeEvidenceBatchRequest,
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
  revokeApprovals(windowId: WindowId): void;
  /**
   * Shows a native-harness question on the thread's running turn so it is
   * answered through the same inline surface as a provider's own question.
   * False when the thread has no running turn.
   */
  raiseHarnessQuestion?(input: {
    readonly threadId: string;
    readonly questionId: string;
    readonly prompt: string;
    readonly options: ReadonlyArray<string>;
  }): boolean;
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
    approvalContextDigest: async (_windowId, command, thread, checkout) => {
      const context = await approvalContext(options, command, thread, checkout);
      return context === undefined ? undefined : approvalContextDigest(context);
    },
    resolveCheckoutRoot: async (windowId, thread, checkout) => {
      const root = await options.resolveCheckoutRoot(windowId, thread, checkout);
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
        const value = await options.credentialResolver.resolve(reference);
        if (value === undefined) throw new Error("Credential is unavailable.");
        return value;
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
  const repositoryTests = {
    discover: (input: { readonly checkoutId: string; readonly rootPath: string }) =>
      testDiscovery.discover(input),
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
        return await testRunner.run({ ...input, signal: controller.signal });
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
    files: options.reviewFiles,
    uuid: options.uuid,
    clock: options.clock,
  });
  const turns = new RuntimeTurnController({
    options,
    events,
    roots,
    gitService,
    runtimeWork,
    observeRuntimeWorkOutcome,
    spendReservations,
  });
  const authorityForTurn: CodeOperationAuthorityPort = {
    ...authority,
    effectiveThread: (windowId, thread) => {
      const session = authority.effectiveThread?.(windowId, thread) ?? thread;
      return turns.threadWithActiveTurnPosture(session);
    },
  };
  const service = new CodeOperationService({
    authority: authorityForTurn,
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
          runtimeWork.open({ id: started.id, threadId: command.threadId, kind: started.kind }),
        );
    },
    ...(approvalValidator === undefined ? {} : { approvals: approvalValidator }),
    terminals: terminal,
    repositoryTests,
    ...(scaffolds === undefined ? {} : { scaffolds }),
    git,
    pullRequests,
    reviewFindings: {
      create: (windowId, input) => reviewFindings.create(windowId, input),
      changeState: (windowId, input) =>
        reviewFindings.changeState(windowId, {
          ...input,
          findingId: decodeCodeReviewFindingId(input.findingId),
        }),
    },
    turns,
    evidence: options.evidence,
    ...(options.attachments === undefined ? {} : { attachments: options.attachments }),
    ...(options.supportsAttachments === undefined
      ? {}
      : { supportsAttachments: options.supportsAttachments }),
    events,
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
    ...(options.resolveBaseCheckoutRoot === undefined
      ? {}
      : {
          resolveBaseCheckout: baseCheckoutResolver(gitService, options.resolveBaseCheckoutRoot),
        }),
    ...(options.resolveForkHandoff === undefined
      ? {}
      : { resolveForkHandoff: options.resolveForkHandoff }),
    ...(options.resolveSelectedExtensions === undefined
      ? {}
      : { resolveSelectedExtensions: options.resolveSelectedExtensions }),
    ...(options.resolveProfileSkills === undefined
      ? {}
      : { resolveProfileSkills: options.resolveProfileSkills }),
  });
  turns.bindService(service);

  return {
    terminals: terminal,
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
      const prompt = approvalPrompt(approvalEffect, thread, checkout, context.pullRequestTarget);
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
        if (thread !== undefined && options.spendCeiling !== undefined) {
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
          spendReservations.set(String(thread.id), spendReservationId);
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
          } else {
            turns.settleSpendReservation(command.threadId);
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
        if (command.kind === "start-provider-turn") {
          turns.settleSpendReservation(command.threadId);
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
        if (command.kind === "start-provider-turn") turns.clearStart(command.threadId);
      }
    },
    inspectTerminal: async (windowId, input) => {
      const snapshot = await service.readTerminal(windowId, input);
      return { terminalId: input.terminalId, state: snapshot.status };
    },
    raiseHarnessQuestion: (input) => turns.raiseHarnessQuestion(input),
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
    forkPoint: async (windowId, source, throughOperationId) => {
      if (!(await options.windowAccess.canAccessProject(windowId, source.projectId))) {
        return { status: "refused", reason: "unavailable" };
      }
      const turns = codeThreadTurns((page) => events.conversation(page), source.id);
      if (turns === undefined) return { status: "refused", reason: "not-found" };
      const choice = chooseCodeForkPoint(turns, throughOperationId);
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
    readEvidence: async (windowId, threadId, operationId, contentId) => {
      try {
        const evidence = await service.readEvidence(windowId, threadId, operationId, contentId);
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
    readEvidenceBatch: async (windowId, input) => {
      try {
        return decodeCodeEvidenceBatchResponse({
          threadId: input.threadId,
          items: await service.readEvidenceBatch(windowId, input.threadId, input.items),
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
  const pullRequestTarget =
    command?.kind === "create-pull-request"
      ? await options.resolvePullRequestTarget(thread.id)
      : undefined;
  if (command?.kind === "create-pull-request" && pullRequestTarget === undefined) return undefined;
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
    !decidesCodeEffectsByApproval(thread.executionPolicy) ||
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
    message = input ? "Allow input to this Simulator?" : `Allow Apple ${effect.request.kind}?`;
    effectDetail = [
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
    message = input ? "Allow input to this emulator?" : `Allow Android ${effect.request.kind}?`;
    effectDetail = [
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
        effectDetail = `${command.remote}: ${command.localRef} → ${command.remoteRef}\nHEAD ${command.expectedHeadOid}`;
        break;
      case "create-pull-request":
        message = "Allow pull request creation?";
        effectDetail = [
          `Target: ${pullRequestTarget?.baseRepository}:${pullRequestTarget?.baseBranch}`,
          `Head: ${pullRequestTarget?.head}`,
          `Title: ${command.title}`,
          "Body:",
          command.body,
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

interface ActiveTurn {
  readonly computerUseSelection?: import("@octant/contracts/extensions").ExtensionSelection;
  /** The selected MCP servers' tools, resolved when the turn was accepted. */
  readonly extensionTools?: AppManagedToolSet;
  readonly extensionSelections?: ReadonlyArray<
    import("@octant/contracts/extensions").ExtensionSelection
  >;
  readonly windowId: WindowId;
  readonly thread: CodeThread;
  readonly operationId: CodeOperationId;
  readonly sessionId: string;
  readonly requestedSessionId: string;
  readonly checkoutRoot: string;
  readonly driver: ProviderDriver;
  readonly resumeCursor?: ProviderResumeCursor;
  readonly secrets: readonly string[];
  readonly abort: AbortController;
  readonly approvals: Map<string, string>;
  readonly browserApprovals: Map<
    string,
    (outcome: "approved" | "denied" | "cancelled" | "expired") => void
  >;
  readonly browserGrantKeys: Set<string>;
  readonly questions: Set<string>;
  /** Questions the native harness asked on this turn; answered by the host, not the provider. */
  readonly harnessQuestions: Set<string>;
  connection?: ProviderConnection;
  cursor: number;
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
  launch?: () => void;
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
  readonly #pending = new Map<
    string,
    Extract<CodeOperationCommand, { kind: "start-provider-turn" }>
  >();
  readonly #active = new Map<string, ActiveTurn>();
  readonly #approvedBrowserContexts = new Set<string>();

  readonly #spendReservations: Map<string, ReturnType<typeof decodeSpendCeilingReservationId>>;

  constructor(input: {
    options: CodeOperationRuntimeOptions;
    events: CodeOperationEventStore;
    roots: Map<string, Awaited<ReturnType<CodeOperationAuthorityPort["resolveCheckoutRoot"]>>>;
    gitService: GitService;
    runtimeWork: CodeRuntimeWorkRecorder;
    observeRuntimeWorkOutcome: (outcome: CodeRuntimeWorkRecordOutcome) => void;
    spendReservations: Map<string, ReturnType<typeof decodeSpendCeilingReservationId>>;
  }) {
    this.#options = input.options;
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

  noteStart(command: Extract<CodeOperationCommand, { kind: "start-provider-turn" }>): void {
    this.#pending.set(String(command.threadId), command);
  }

  clearStart(threadId: CodeThreadId): void {
    this.#pending.delete(String(threadId));
  }

  launch(threadId: CodeThreadId): void {
    const active = this.#active.get(String(threadId));
    const launch = active?.launch;
    if (active !== undefined) delete active.launch;
    launch?.();
  }

  settleSpendReservation(threadId: string): void {
    const reservationId = this.#spendReservations.get(String(threadId));
    if (reservationId === undefined) return;
    this.#spendReservations.delete(String(threadId));
    this.#options.spendCeiling?.settle({ reservationId });
  }

  async start(input: Parameters<CodeOperationTurnPort["start"]>[0]) {
    const key = String(input.thread.id);
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
      this.settleSpendReservation(key);
      return turnState(
        "failed",
        reason === undefined ? undefined : { category: "failed", message: reason },
      );
    };
    const command = this.#pending.get(key);
    const root = this.#roots.get(key);
    if (
      command === undefined ||
      root === undefined ||
      root === null ||
      root.checkoutRoot !== input.checkoutRoot ||
      this.#active.has(key)
    )
      return failStart();
    const resolvedDriver = await this.#options.resolveProviderDriver(input.thread);
    if (resolvedDriver === undefined) return failStart();
    const recovered = this.#events.providerSessionForThread(input.thread.id, command.operationId);
    if (recovered.status !== "ok")
      return failStart(
        "The task's provider session could not be recovered. Retry after reloading the task.",
      );
    const previous = recovered.session;
    const priorTurn = recovered.priorTurn;
    const priorTurnSettled = recovered.priorTurnSettled;
    // The composer offers another model of the same provider in a started
    // thread; refusing every turn after that switch left the thread stuck. A
    // provider that can resume onto the new model keeps the conversation, and
    // the turn records the new model on its session.
    if (
      previous?.kind === "provider-session-ready" &&
      (String(previous.providerInstanceId) !== String(input.thread.providerInstanceId) ||
        (String(previous.modelId) !== String(input.thread.modelId) &&
          this.#options.supportsModelSwitch?.(input.thread) !== true) ||
        String(previous.checkoutId) !== String(input.thread.checkoutId))
    )
      return failStart(
        "This task's provider session belongs to a different provider, model, or checkout. Restore that selection or start a new task.",
      );
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
    const browserSelections = command.extensionSelections?.filter(isBrowserUseSelection) ?? [];
    if (
      browserSelections.length > 1 ||
      browserSelections.some((selection) => !validateBrowserUseSelection(selection)) ||
      (browserSelections.length > 0 &&
        (this.#options.browserAutomation === undefined ||
          this.#options.supportsAppManagedTools?.(input.thread) !== true))
    ) {
      return failStart(
        "This provider cannot carry Octant's Browser tool. Check the provider's connection in Settings, then retry without the Browser selection.",
      );
    }
    if (
      command.computerUseSelection !== undefined &&
      (this.#options.supportsAppManagedTools?.(input.thread) !== true ||
        this.#options.computerUseTools?.({
          windowId: input.windowId,
          thread: input.thread,
          selection: command.computerUseSelection,
        }) === undefined)
    )
      return failStart(
        "This provider cannot carry Octant's Computer tool. Check the provider's connection in Settings, then retry without the Computer selection.",
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
      previous?.kind === "provider-session-ready" ? previous.resumeCursor : undefined;
    let forkSeeded = false;
    if (previous === undefined && input.thread.forkedFrom !== undefined) {
      const seeded = await this.#options
        .forkProviderSession?.({
          fork: input.thread,
          origin: input.thread.forkedFrom,
          sessionId: decodeProviderSessionId(input.sessionId),
          checkoutRoot: input.checkoutRoot,
          secrets,
        })
        .catch(() => undefined);
      if (seeded !== undefined) {
        resumeCursor = seeded;
        forkSeeded = true;
      }
    }
    // Driver, credentials, and fork preparation may outlive the host's admission.
    if (input.admissionCurrent?.() === false) {
      this.settleSpendReservation(key);
      await input.extensionTools?.close?.().catch(() => undefined);
      return {
        state: "failed" as const,
        admission: "refused" as const,
        failure: {
          category: "unauthorized" as const,
          message: "Code turn admission is no longer current.",
        },
      };
    }
    // Feedback stays pending through every preparation refusal. Consuming it
    // here does not yield between the final admission check and owning the turn.
    let feedback: ReturnType<NonNullable<typeof input.takeProductFeedback>> | undefined;
    try {
      feedback = input.takeProductFeedback?.();
    } catch {
      // A feedback read failure must not prevent the person's message from running.
    }
    const context = [
      ...(forkSeeded || input.forkHandoff === undefined ? [] : [input.forkHandoff]),
      ...(input.context ?? []),
      ...(feedback?.context === undefined || feedback.context.trim().length === 0
        ? []
        : [{ kind: "user-message", text: feedback.context } as const]),
    ];
    const attachments = [...(input.attachments ?? []), ...(feedback?.attachments ?? [])];
    const active: ActiveTurn = {
      ...(command.computerUseSelection === undefined
        ? {}
        : { computerUseSelection: command.computerUseSelection }),
      ...(input.extensionTools === undefined ? {} : { extensionTools: input.extensionTools }),
      ...(command.extensionSelections === undefined || command.extensionSelections.length === 0
        ? {}
        : { extensionSelections: command.extensionSelections }),
      windowId: input.windowId,
      thread: input.thread,
      operationId: command.operationId,
      sessionId: previous?.kind === "provider-session-ready" ? previous.sessionId : input.sessionId,
      requestedSessionId: input.sessionId,
      ...(resumeCursor === undefined ? {} : { resumeCursor }),
      checkoutRoot: input.checkoutRoot,
      driver,
      secrets,
      abort: new AbortController(),
      approvals: new Map(),
      browserApprovals: new Map(),
      browserGrantKeys: new Set(),
      questions: new Set(),
      harnessQuestions: new Set(),
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
      }),
    );
    return turnState("running");
  }

  async answerInput(input: Parameters<CodeOperationTurnPort["answerInput"]>[0]) {
    const active = this.#owned(input.thread, input.checkoutRoot);
    if (active === undefined || !active.questions.has(input.requestId)) {
      return this.#settleDeadTurnRequest(input.thread, "input", String(input.requestId));
    }
    if (active.harnessQuestions.has(input.requestId)) {
      // A harness question is the host's own; the provider never saw it and
      // is waiting on the tool call that asked.
      active.questions.delete(input.requestId);
      active.harnessQuestions.delete(input.requestId);
      this.#options.nativeHarness?.answerQuestion?.(
        String(active.thread.id),
        input.requestId,
        input.response,
      );
      return turnState(active.state);
    }
    if (active.connection === undefined) return turnState("failed");
    active.questions.delete(input.requestId);
    await Effect.runPromise(
      active.connection.answerUserInput({
        sessionId: active.sessionId as never,
        requestId: input.requestId,
        answer: input.response,
      }),
    );
    return turnState(active.state);
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
    readonly prompt: string;
    readonly options: ReadonlyArray<string>;
  }): boolean {
    const active = this.#active.get(input.threadId);
    if (active === undefined || active.state !== "running") return false;
    active.questions.add(input.questionId);
    active.harnessQuestions.add(input.questionId);
    const frame = this.#events.append({
      threadId: active.thread.id,
      operationId: active.operationId,
      expectedCursor: active.cursor,
      event: {
        kind: "input-requested",
        requestId: input.questionId,
        prompt: input.prompt,
        options: input.options,
      } as never,
    });
    active.cursor = frame.cursor;
    return true;
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
    if (signal?.aborted || active.abort.signal.aborted || active.browserApprovals.size >= 4)
      return Promise.resolve("cancelled");
    const approvalId = CodeApprovalId.make(this.#options.uuid());
    return new Promise((resolve) => {
      const finish = (outcome: "approved" | "denied" | "cancelled" | "expired") => {
        if (!active.browserApprovals.delete(String(approvalId))) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        active.abort.signal.removeEventListener("abort", abort);
        resolve(outcome);
      };
      const abort = () => finish("cancelled");
      const timer = setTimeout(() => finish("expired"), 10 * 60_000);
      active.browserApprovals.set(String(approvalId), finish);
      signal?.addEventListener("abort", abort, { once: true });
      active.abort.signal.addEventListener("abort", abort, { once: true });
      try {
        const frame = this.#events.append({
          threadId: active.thread.id,
          operationId: active.operationId,
          expectedCursor: active.cursor,
          event: {
            kind: "approval-requested",
            approvalId,
            action: "provider-tool",
            summary: `Allow this thread to use an isolated browser session at ${origin.slice(0, 512)}? Shell and file access stay unchanged.`,
          },
        });
        active.cursor = frame.cursor;
      } catch {
        finish("cancelled");
      }
    });
  }

  async answerApproval(input: Parameters<CodeOperationTurnPort["answerApproval"]>[0]) {
    const active = this.#owned(input.thread, input.checkoutRoot);
    const providerRequestId = active?.approvals.get(input.approvalId);
    const turnPosture =
      active === undefined
        ? undefined
        : clampTurnAccessPosture({
            requested: active.thread.executionPolicy,
            thread: input.thread.executionPolicy,
          });
    const browserApproval = active?.browserApprovals.get(input.approvalId);
    if (active !== undefined && browserApproval !== undefined) {
      if (
        turnPosture === "plan" ||
        active.thread.permissionPersistence !== input.thread.permissionPersistence
      )
        return turnState("failed");
      browserApproval(input.decision === "approved" ? "approved" : "denied");
      if (input.decision === "approved") return turnState(active.state);
      return this.#countDeniedApproval(active);
    }
    if (active === undefined || providerRequestId === undefined)
      return this.#settleDeadTurnRequest(input.thread, "approval", String(input.approvalId));
    if (
      active.connection === undefined ||
      turnPosture === "plan" ||
      active.thread.permissionPersistence !== input.thread.permissionPersistence
    )
      return turnState("failed");
    active.approvals.delete(input.approvalId);
    await Effect.runPromise(
      active.connection.answerApproval({
        sessionId: active.sessionId as never,
        requestId: providerRequestId,
        approved: input.decision === "approved",
      }),
    );
    if (input.decision === "approved") return turnState(active.state);
    return this.#countDeniedApproval(active);
  }

  /**
   * A provider that keeps asking after repeated refusals is looping on the
   * person, so the third denial ends the turn the way a cancel does. The
   * reason rides on `interruptMessage` so the runner's settlement — not this
   * answer — writes the single terminal frame after the change list.
   */
  async #countDeniedApproval(active: ActiveTurn) {
    active.deniedApprovals += 1;
    if (active.deniedApprovals < 3 || (active.state !== "running" && active.state !== "waiting"))
      return turnState(active.state);
    active.interruptMessage =
      "Stopped after 3 denied tool requests in one turn. Send a new message to continue.";
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
  ): { state: ActiveTurn["state"] } {
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
    try {
      this.#events.append({
        threadId: thread.id,
        operationId: owner.operationId,
        expectedCursor: owner.cursor,
        event: {
          kind: "operation-state",
          state: "interrupted",
          failure: {
            category: "failed",
            message:
              "The provider session that asked ended when Octant stopped. Send a new message to continue.",
          },
        },
      });
    } catch {
      return turnState("failed");
    }
    this.#observeRuntimeWorkOutcome(
      this.#runtimeWork.settleOrphaned({
        id: owner.operationId,
        threadId: thread.id,
        kind: "provider-turn",
        state: "interrupted",
      }),
    );
    return turnState("interrupted");
  }

  async cancel(input: Parameters<CodeOperationTurnPort["cancel"]>[0]) {
    const active = this.#owned(input.thread, input.checkoutRoot);
    if (active === undefined) return turnState("failed");
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

  async closeAll(): Promise<void> {
    const activeTurns = [...this.#active.values()];
    this.#active.clear();
    this.#pending.clear();
    await Promise.all(
      activeTurns.map(async (active) => {
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

  #appManagedTools(active: ActiveTurn): AppManagedToolSet | undefined {
    const supportsAppManagedTools = this.#options.supportsAppManagedTools?.(active.thread) === true;
    const supportsAcpClientCapabilities =
      this.#options.supportsAcpClientCapabilities?.(active.thread) === true;
    const sets: Array<AppManagedToolSet | undefined> = [];
    const service = this.#service;
    if (supportsAppManagedTools && service !== undefined) {
      sets.push(
        active.computerUseSelection === undefined
          ? this.#options.computerUseUnattachedTools?.({
              windowId: active.windowId,
              thread: active.thread,
            })
          : this.#options.computerUseTools?.({
              windowId: active.windowId,
              thread: active.thread,
              selection: active.computerUseSelection,
            }),
        createCodeAppManagedTools({
          windowId: active.windowId,
          thread: active.thread,
          readThread: (windowId, threadId) => this.#effectiveThread(windowId, threadId),
          uuid: this.#options.uuid,
          browserApproval: {
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
            forget: (contextId) =>
              this.#approvedBrowserContexts.delete(this.#browserApprovalKey(active, contextId)),
          },
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
          ...(this.#options.appleToolchain === undefined
            ? {}
            : { apple: this.#options.appleToolchain }),
          ...(this.#options.androidToolchain === undefined
            ? {}
            : { android: this.#options.androidToolchain }),
          ...(this.#options.planner === undefined ? {} : { planner: this.#options.planner }),
        }),
        this.#options.githubReadTools?.({
          windowId: active.windowId,
          thread: active.thread,
          readThread: (windowId, threadId) => this.#effectiveThread(windowId, threadId),
        }),
        this.#options.agentMessages?.({ thread: active.thread }),
        this.#options.sideTasks?.({ thread: active.thread }),
        this.#options.canvas?.({ windowId: active.windowId, thread: active.thread }),
        this.#options.agents?.({ windowId: active.windowId, thread: active.thread }),
        this.#options.nativeHarnessTools?.({
          thread: active.thread,
          checkoutRoot: active.checkoutRoot,
          windowId: active.windowId,
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
          checkoutRoot: active.checkoutRoot,
          uuid: this.#options.uuid,
          pathPort: this.#options.acpPathPort ?? liveCodeTestSourcePort,
          terminalConfinement:
            this.#options.acpTerminalConfinement ?? defaultAcpTerminalConfinement(),
          wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        }),
      );
    }
    sets.push(active.extensionTools);
    return sets.every((set) => set === undefined) ? undefined : combineAppManagedToolSets(...sets);
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
    };
    const harnessContext = this.#options.nativeHarness?.contextFor(harnessScope) ?? [];
    this.#options.nativeHarness?.turnStarted(harnessScope);
    const browserSelected = active.extensionSelections?.some(isBrowserUseSelection) === true;
    const fullContext = [
      ...harnessContext,
      ...(browserSelected
        ? [{ kind: "instructions" as const, text: BROWSER_SELECTION_GUIDANCE }]
        : []),
      ...(context ?? []),
    ];
    const harnessAutoReviewEnabled = this.#resolveHarnessAutoReview(active.thread);
    const appManagedTools = this.#appManagedTools(active);
    void Effect.runPromise(
      Effect.scoped(
        this.#runner.run({
          thread: active.thread,
          sessionId: active.sessionId as never,
          ...(active.resumeCursor === undefined ? {} : { resumeCursor: active.resumeCursor }),
          onSessionReady: (handle) =>
            Effect.try({
              try: () => {
                const resumeCursor = handle.resumeCursor ?? active.resumeCursor;
                const frame = this.#events.append({
                  threadId: active.thread.id,
                  operationId: active.operationId,
                  expectedCursor: active.cursor,
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
              catch: () => ({
                category: "failed" as const,
                message: "The provider session could not be saved. The message was not sent.",
              }),
            }),
          checkoutRoot: active.checkoutRoot,
          prompt,
          ...(fullContext.length === 0 ? {} : { context: fullContext }),
          ...(this.#options.nativeHarness === undefined
            ? {}
            : {
                onTurnCompleted: (completed) => {
                  this.settleSpendReservation(String(active.thread.id));
                  return this.#options.nativeHarness!.turnCompleted({
                    ...harnessScope,
                    ...completed,
                  });
                },
              }),
          ...(attachments === undefined ? {} : { attachments }),
          ...(harnessAutoReviewEnabled ? { harnessAutoReviewEnabled: true } : {}),
          signal: active.abort.signal,
          provider: {
            acquire: (acquireInput) => {
              if (
                acquireInput.projectRoot !== active.checkoutRoot ||
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
              if (claim.kind === "file-change" || claim.kind === "diff") {
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
            ).pipe(Effect.andThen(Effect.sync(() => this.#persistNormalized(active, event)))),
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
                  const reason =
                    outcome === "interrupted" && active.interruptMessage !== undefined
                      ? active.interruptMessage
                      : failure?.message;
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
                          category: "failed",
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
                  message: active.interruptMessage ?? "Code turn was cancelled.",
                }
              : evidenceCapacityFailure(error),
          );
        } catch {
          active.state = outcome;
        }
      })
      .finally(() => {
        this.#options.nativeHarness?.turnEnded?.(harnessScope);
        if (this.#active.get(String(active.thread.id)) === active)
          this.#active.delete(String(active.thread.id));
      });
  }

  /**
   * The durable thread as this running turn may use it. A one-shot overlay is
   * the requested ceiling and the current grant still clamps it, so app-managed
   * tools cannot exceed either the turn or a later lower grant.
   */
  threadWithActiveTurnPosture(thread: CodeThread): CodeThread {
    const active = this.#active.get(String(thread.id));
    if (active === undefined) return thread;
    const executionPolicy = clampTurnAccessPosture({
      requested: active.thread.executionPolicy,
      thread: thread.executionPolicy,
    });
    return executionPolicy === thread.executionPolicy ? thread : { ...thread, executionPolicy };
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
   * capability, or when the posture produces no prompts (0104).
   */
  #resolveHarnessAutoReview(thread: CodeThread): boolean {
    if (thread.autoApprove !== true) return false;
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

  #persistNormalized(active: ActiveTurn, event: CodeTurnEvent): void {
    const operationEvent = normalizedOperationEvent(
      event,
      active,
      this.#options.evidence,
      this.#options.uuid,
    );
    if (operationEvent === undefined) return;
    const frame = this.#events.append({
      threadId: active.thread.id,
      operationId: active.operationId,
      expectedCursor: active.cursor,
      event: operationEvent,
    });
    active.cursor = frame.cursor;
    if (operationEvent.kind === "operation-state") {
      active.lastPersistedState = operationEvent.state;
      active.lastPersistedFailure = operationEvent.failure?.message;
    }
  }

  /**
   * Journal what differs in the checkout between the capture this turn started
   * from and the checkout as it stands (0141).
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
  async #recordChangedFiles(active: ActiveTurn): Promise<void> {
    if (active.changedFilesRecording !== undefined) return active.changedFilesRecording;
    active.changedFilesRecording = (async () => {
      try {
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
        const frame = this.#events.append({
          threadId: active.thread.id,
          operationId: active.operationId,
          expectedCursor: active.cursor,
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
    active.state = outcome;
    if (outcome === "failed" || outcome === "interrupted") this.#revokeBrowserGrants(active);
    // The provider's own terminal event already journaled this state, reason
    // and all; a second frame would only repeat it. The settle below is not
    // part of that dedupe: the board reads runtime work, not this journal.
    const alreadyJournaled =
      active.lastPersistedState === outcome && active.lastPersistedFailure === failure?.message;
    if (!alreadyJournaled) {
      const frame = this.#events.append({
        threadId: active.thread.id,
        operationId: active.operationId,
        expectedCursor: active.cursor,
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
    for (const key of active.browserGrantKeys) this.#approvedBrowserContexts.delete(key);
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
    this.settleSpendReservation(String(active.thread.id));
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
  if (event.category === "question" && event.requestId !== undefined) {
    active.questions.add(event.requestId);
    return {
      kind: "input-requested",
      requestId: event.requestId,
      prompt:
        boundProviderText(
          event.text ?? "Provider input requested.",
          MAX_PROVIDER_INPUT_PROMPT_BYTES,
          "",
        ) ?? "Provider input requested.",
      options: [],
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
    };
  }
  if (event.category === "usage")
    return {
      kind: "usage",
      inputTokens: event.inputTokens ?? 0,
      outputTokens: event.outputTokens ?? 0,
      ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
      ...(event.cacheReadInputTokens === undefined
        ? {}
        : { cacheReadInputTokens: event.cacheReadInputTokens }),
      ...(event.cacheWriteInputTokens === undefined
        ? {}
        : { cacheWriteInputTokens: event.cacheWriteInputTokens }),

      ...(event.contextWindow === undefined ? {} : { contextWindow: event.contextWindow }),
      ...(event.contextTokens === undefined ? {} : { contextTokens: event.contextTokens }),
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
    };
  }
  if (event.category === "completion") return { kind: "operation-state", state: "completed" };
  if (event.category === "waiting") return { kind: "operation-state", state: "waiting" };
  if (event.category === "interruption") {
    // The provider's sentence is the only reason the person will ever see, so
    // the journaled frame carries it; a forced stop's own reason wins over the
    // provider's generic cancellation copy, exactly like the outcome path.
    const reason = active.interruptMessage ?? event.text;
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
    const message = event.text === undefined ? undefined : boundProviderFailureMessage(event.text);
    return {
      kind: "operation-state",
      state: "failed",
      ...(message === undefined ? {} : { failure: { category: "failed", message } }),
    };
  }
  return undefined;
}

const FAILURE_MESSAGE_SUFFIX = "\n[Provider failure message truncated.]";
const SUMMARY_SUFFIX = " [truncated]";
const MAX_PROVIDER_INPUT_PROMPT_BYTES = 8 * 1024;

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
    observeReview: async () => ({ status: "unavailable" as const }),
  };
  if (options.ghExecutable === undefined) return unavailable;
  try {
    return new GhPullRequestPort({
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

function codeOperationGitPort(git: GitService): CodeOperationGitPort {
  return {
    observe: async ({ checkoutRoot, maxDiffBytes }) =>
      mapGitObservation(await git.observe(checkoutRoot), maxDiffBytes),
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
    compareBranch: (input) => git.compareBranch(input),
    readBranchDiff: async (input) => {
      const result = await git.readDiff({
        checkoutRoot: input.checkoutRoot,
        scope: { kind: "branch", baseRef: input.baseRef },
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
