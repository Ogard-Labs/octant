import { decodeComputerUseOwner } from "@octant/contracts/computer-use-plugin";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  decodeCodeEvidenceContentId,
  decodeCodeFailure,
  decodeCodeOperationId,
  decodeProviderSessionId,
  decodeCodeRelativePath,
  decodeCodeThreadId,
  decodeContextSubjectRef,
  decodeThreadWorkingDirectory,
  LOCAL_TOOL_HOST_ID,
  THREAD_RETENTION_EVENT_NAMES,
} from "@octant/contracts";
import { Effect } from "effect";
import { createProductFeedbackTurnPort } from "../browser/productFeedbackTurnPort";
import { resolveThreadWorkingDirectory } from "../threadWorkingDirectoryAuthority";
import { attachWorkRequestRuntime } from "../work/workRequestRuntime";
import { CodeService, CodeServiceError } from "../code/codeService";
import {
  type CodeOperationRuntime,
  type CodeOperationRuntimeOptions,
  createCodeOperationRuntime,
} from "../code/codeOperationRuntime";
import { combineAppManagedToolSets } from "../providers/appManagedToolSet";
import { CodePlannerService } from "../code/codePlannerService";
import { CodeProjectPullRequestSwitchService } from "../code/codeProjectPullRequestSwitchService";
import { createGhCommandPort } from "../code/ghPullRequestPort";
import { GhPullRequestSwitchPort } from "../code/ghPullRequestSwitchPort";
import { ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";
import { INHERITED_MARK_REFUSAL } from "../context/inheritedExternalContentMark";
import {
  createCodeProfileSkillResolver,
  createStoredCodeProfileSkillTextLoader,
} from "../code/codeProfileSkillResolver";
import { MAX_CODE_OPERATION_REPLAY_LIMIT } from "../code/codeOperationEventStore";
import { CodeThreadMetadataService } from "../code/codeThreadMetadataService";
import {
  boardRuntimeActivityFromWorks,
  type CodeBoardThread,
  CodeThreadBoardService,
} from "../code/codeThreadBoardService";
import { CodeFollowUpService } from "../code/codeFollowUpService";
import { FailingChecksFollowUps } from "../code/failingChecksFollowUps";
import { RepositoryTestProcessPort } from "../code/repositoryTestProcessPort";
import { TerminalProcessPort } from "../code/terminalProcessPort";
import { defaultTerminalShell } from "../code/terminalShell";
import type { CodeRouteService } from "../codeRoutes";
import { GitMutationPort } from "../code/gitMutationPort";
import { codeThreadTurns } from "../code/codeForkPoint";
import { seedCodeForkHarnessSession } from "../harness/nativeHarnessFork";
import { githubReadToolSetIfEffective } from "../github/githubIntegrationEffective";
import { TerminalBrowserGrantService } from "../code/terminalBrowserGrantService";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import {
  createCodeThreadMentionDirectory,
  threadMentionContextResolver,
  ThreadMentionService,
} from "../chat/threadMentionService";
import { fileMentionContextBlocks, FileMentionService } from "../fileMentionService";
import { createAgentMessageTools } from "../agentMessage/agentMessageTools";
import { codeSiblingThreadSource } from "../siblingThreads/codeSiblingThreadSource";
import { createSiblingThreadTools } from "../siblingThreads/siblingThreadTools";
import { readThreadExternalContentTaint } from "../context/externalContentTaintProjection";
import { CodeTurnDecisions } from "../turnDecisions/codeTurnDecisions";
import { createSideTaskTools } from "../sideTasks/sideTaskTools";
import { isReplayedAndroidEvidence } from "../android/androidToolchainService";
import { isNativeHarnessDriverKind } from "@octant/domain";
import { createCanvasAgentTools } from "../canvas/canvasAgentTools";
import { type CodeWiring, stableCodeFileId } from "./code";
import { makeConfiguredProviderDriver, type ProvidersWiring } from "./providers";
import type { ServerStart } from "./serverShape";
import type { HarnessWiring } from "./harness";
import type { AuthorityWiring } from "./authority";
import type { FoundationsWiring } from "./foundations";
import type { AgentRunsWiring } from "./agentRuns";
import type { IntegrationsWiring } from "./integrations";
import type { ComputerUseWiring } from "./computerUse";
import type { WorkspaceWiring } from "./workspace";
import type { WorkRequestStateWiring } from "./workRequestState";
import type { HarnessStateWiring } from "./harnessState";
import type { DevicesWiring } from "./devices";
import type { BrowserWiring } from "./browser";
import type { CanvasWiring } from "./canvas";
import { sessionNativeSetup } from "../providers/providerNativeSetup";

function withCodeOperationRuntime(
  service: CodeRouteService,
  runtime: CodeOperationRuntime,
): CodeRouteService {
  const readEvidenceBatch = runtime.readEvidenceBatch?.bind(runtime);
  return {
    bootstrap: (windowId) => service.bootstrap(windowId),
    navigation: (windowId) => service.navigation(windowId),
    read: (windowId, threadId) => service.read(windowId, threadId),
    execute: (windowId, command) => service.execute(windowId, command),
    executeOperation: (windowId, command, options) => runtime.execute(windowId, command, options),
    inspectTerminal: (windowId, input) => runtime.inspectTerminal(windowId, input),
    watchTerminal: (windowId, input) => runtime.watchTerminal(windowId, input),
    subscribe: (windowId, threadId, afterSequence, signal) =>
      service.subscribe(windowId, threadId, afterSequence, signal),
    subscribeOperation: async function* (windowId, threadId, operationId, afterCursor) {
      const frames = await runtime.subscribe(windowId, threadId, operationId, afterCursor, 100);
      yield* frames;
    },
    conversation: (windowId, threadId, afterCursor, limit) =>
      runtime.conversation(windowId, threadId, afterCursor, limit),
    conversationWindow: (windowId, threadId, request) =>
      runtime.conversationWindow(windowId, threadId, request),
    readContent: (windowId, contentId) => service.readContent(windowId, contentId),
    readOperationContent: (windowId, threadId, operationId, contentId) =>
      runtime.readEvidence(windowId, threadId, operationId, decodeCodeEvidenceContentId(contentId)),
    ...(readEvidenceBatch === undefined
      ? {}
      : { readOperationContents: (windowId, input) => readEvidenceBatch(windowId, input) }),
    saveFile: (windowId, input) => service.saveFile(windowId, input),
    openFile: (windowId, input) => service.openFile(windowId, input),
    ...(service.readGitHistory === undefined
      ? {}
      : { readGitHistory: service.readGitHistory.bind(service) }),
    ...(service.listFiles === undefined ? {} : { listFiles: service.listFiles.bind(service) }),
    ...(service.readFile === undefined ? {} : { readFile: service.readFile.bind(service) }),
    ...(service.listTests === undefined ? {} : { listTests: service.listTests.bind(service) }),
    readRepositoryTestStatus: (windowId, input) =>
      runtime.readRepositoryTestStatus(windowId, input.threadId, input.checkoutId),
    ...(service.watchFiles === undefined ? {} : { watchFiles: service.watchFiles.bind(service) }),
    ...(service.searchFiles === undefined
      ? {}
      : { searchFiles: service.searchFiles.bind(service) }),
    ...(service.stageEvidence === undefined
      ? {}
      : { stageEvidence: service.stageEvidence.bind(service) }),
    ...(service.stageAttachment === undefined
      ? {}
      : { stageAttachment: service.stageAttachment.bind(service) }),
    ...(service.readAttachment === undefined
      ? {}
      : { readAttachment: service.readAttachment.bind(service) }),
    ...(service.discardAttachment === undefined
      ? {}
      : { discardAttachment: service.discardAttachment.bind(service) }),
    ...(service.mergeProjectPullRequest === undefined
      ? {}
      : { mergeProjectPullRequest: service.mergeProjectPullRequest.bind(service) }),
  };
}

function withCodeBoard(
  service: CodeRouteService,
  queryBoard: NonNullable<CodeRouteService["queryBoard"]>,
): CodeRouteService {
  return {
    bootstrap: (windowId) => service.bootstrap(windowId),
    navigation: (windowId) => service.navigation(windowId),
    read: (windowId, threadId) => service.read(windowId, threadId),
    execute: (windowId, command, signal) => service.execute(windowId, command, signal),
    subscribe: (windowId, threadId, afterSequence, signal) =>
      service.subscribe(windowId, threadId, afterSequence, signal),
    readContent: (windowId, contentId) => service.readContent(windowId, contentId),
    saveFile: (windowId, input) => service.saveFile(windowId, input),
    openFile: (windowId, input) => service.openFile(windowId, input),
    ...(service.readGitHistory === undefined
      ? {}
      : { readGitHistory: service.readGitHistory.bind(service) }),
    ...(service.listFiles === undefined ? {} : { listFiles: service.listFiles.bind(service) }),
    ...(service.readFile === undefined ? {} : { readFile: service.readFile.bind(service) }),
    ...(service.listTests === undefined ? {} : { listTests: service.listTests.bind(service) }),
    ...(service.readRepositoryTestStatus === undefined
      ? {}
      : { readRepositoryTestStatus: service.readRepositoryTestStatus.bind(service) }),
    ...(service.watchFiles === undefined ? {} : { watchFiles: service.watchFiles.bind(service) }),
    ...(service.searchFiles === undefined
      ? {}
      : { searchFiles: service.searchFiles.bind(service) }),
    queryBoard,
    ...(service.executeOperation === undefined
      ? {}
      : { executeOperation: service.executeOperation.bind(service) }),
    ...(service.inspectTerminal === undefined
      ? {}
      : { inspectTerminal: service.inspectTerminal.bind(service) }),
    ...(service.watchTerminal === undefined
      ? {}
      : { watchTerminal: service.watchTerminal.bind(service) }),
    ...(service.subscribeOperation === undefined
      ? {}
      : { subscribeOperation: service.subscribeOperation.bind(service) }),
    ...(service.conversation === undefined
      ? {}
      : { conversation: service.conversation.bind(service) }),
    ...(service.conversationWindow === undefined
      ? {}
      : { conversationWindow: service.conversationWindow.bind(service) }),
    ...(service.readOperationContent === undefined
      ? {}
      : { readOperationContent: service.readOperationContent.bind(service) }),
    ...(service.readOperationContents === undefined
      ? {}
      : { readOperationContents: service.readOperationContents.bind(service) }),
    ...(service.stageEvidence === undefined
      ? {}
      : { stageEvidence: service.stageEvidence.bind(service) }),
    ...(service.stageAttachment === undefined
      ? {}
      : { stageAttachment: service.stageAttachment.bind(service) }),
    ...(service.readAttachment === undefined
      ? {}
      : { readAttachment: service.readAttachment.bind(service) }),
    ...(service.discardAttachment === undefined
      ? {}
      : { discardAttachment: service.discardAttachment.bind(service) }),
    ...(service.mergeProjectPullRequest === undefined
      ? {}
      : { mergeProjectPullRequest: service.mergeProjectPullRequest.bind(service) }),
  };
}

export type CodeRuntimeDependencies = Pick<ServerStart, "options" | "persistence"> &
  Pick<
    AuthorityWiring,
    | "agentRunPersistence"
    | "androidInputGrants"
    | "codeActiveTurns"
    | "codeApprovalStore"
    | "codeSessionAuthority"
    | "liveTurns"
    | "machineChangeFeed"
    | "onWindowRevoked"
    | "simulatorInputGrants"
  > &
  Pick<
    AgentRunsWiring,
    | "agentsManagedToolsFor"
    | "externalContentIngestionStore"
    | "runtimeOutsideContentMarks"
    | "sideTasks"
    | "spendCeiling"
    | "threadAwaitsHarnessApproval"
  > &
  Pick<
    IntegrationsWiring,
    | "agentMessageService"
    | "consumeCreateFromIssueFramed"
    | "githubExtensionSnapshot"
    | "githubReadToolService"
    | "peekCreateFromIssueFramed"
    | "siblingThreadsService"
    | "threadOutsideContentMarks"
  > &
  Pick<ComputerUseWiring, "computerToolsFor" | "computerUseTools" | "threadDesktopDestination"> &
  Pick<WorkspaceWiring, "codeBoardPlanProgressSource" | "contextHarness" | "projectService"> &
  Pick<WorkRequestStateWiring, "workRequestRuntime"> &
  Pick<HarnessStateWiring, "onHarnessQuestionAsked" | "onHarnessQuestionSettled"> &
  Pick<
    DevicesWiring,
    | "androidToolchainService"
    | "appleToolchainService"
    | "bindDeviceApprovals"
    | "recordAppleEvidence"
  > &
  Pick<
    CodeWiring,
    | "buildCodeService"
    | "canAccessCodeProject"
    | "codeAttachments"
    | "codeProjectAccess"
    | "codeTestDiscovery"
    | "isCodeProviderModelAllowed"
    | "onPullRequestSnapshotRefreshed"
    | "projectPullRequestCadence"
    | "projectPullRequestService"
    | "roots"
  > &
  Pick<
    ProvidersWiring,
    | "codeThreadDrivers"
    | "configuredDriverOptions"
    | "extensionApiService"
    | "extensionPackageStore"
    | "nativeHarnessTranscripts"
    | "probeProviderForThreads"
    | "providerDataDirectory"
    | "resolveSelectedExtensions"
    | "pinnedExtensionIds"
  > &
  Pick<
    BrowserWiring,
    "browserAutomationService" | "browserToolApprovalService" | "productFeedbackService"
  > &
  Pick<CanvasWiring, "canvasAgentToolPort"> &
  Pick<
    HarnessWiring,
    "nativeHarnessComposition" | "nativeHarnessHooks" | "onHarnessRecoveryLifted"
  > & {
    /** Wired by wireChat; read only after startup. */
    readonly codeThreadMentionDirectory: () => ReturnType<typeof createCodeThreadMentionDirectory>;
    /** Wired by wireWork; read only after startup. */
    readonly fileMentionService: () => FileMentionService;
    /** Wired by wireChat; read only after startup. */
    readonly threadMentionService: () => ThreadMentionService;
  } & Pick<
    FoundationsWiring,
    | "browserAuthority"
    | "codeBoardEventStore"
    | "codeEvidence"
    | "providerRuntimeRegistry"
    | "selectCodeConversation"
  >;

export function wireCodeRuntime(deps: CodeRuntimeDependencies) {
  const {
    threadAwaitsHarnessApproval,
    agentMessageService,
    agentRunPersistence,
    agentsManagedToolsFor,
    androidInputGrants,
    androidToolchainService,
    appleToolchainService,
    bindDeviceApprovals,
    browserAuthority,
    browserAutomationService,
    browserToolApprovalService,
    buildCodeService,
    canAccessCodeProject,
    canvasAgentToolPort,
    codeActiveTurns,
    codeApprovalStore,
    codeAttachments,
    codeBoardEventStore,
    codeBoardPlanProgressSource,
    codeEvidence,
    codeProjectAccess,
    codeSessionAuthority,
    codeTestDiscovery,
    codeThreadDrivers,
    codeThreadMentionDirectory,
    computerToolsFor,
    computerUseTools,
    threadDesktopDestination,
    configuredDriverOptions,
    consumeCreateFromIssueFramed,
    contextHarness,
    extensionApiService,
    extensionPackageStore,
    externalContentIngestionStore,
    fileMentionService,
    githubExtensionSnapshot,
    githubReadToolService,
    isCodeProviderModelAllowed,
    liveTurns,
    machineChangeFeed,
    nativeHarnessComposition,
    nativeHarnessHooks,
    onHarnessQuestionAsked,
    onHarnessQuestionSettled,
    onHarnessRecoveryLifted,
    onPullRequestSnapshotRefreshed,
    onWindowRevoked,
    nativeHarnessTranscripts,
    options,
    peekCreateFromIssueFramed,
    persistence,
    probeProviderForThreads,
    productFeedbackService,
    projectPullRequestCadence,
    projectPullRequestService,
    projectService,
    providerDataDirectory,
    providerRuntimeRegistry,
    recordAppleEvidence,
    resolveSelectedExtensions,
    pinnedExtensionIds,
    roots,
    runtimeOutsideContentMarks,
    selectCodeConversation,
    siblingThreadsService,
    sideTasks,
    simulatorInputGrants,
    spendCeiling,
    threadMentionService,
    threadOutsideContentMarks,
    workRequestRuntime,
  } = deps;
  return Effect.gen(function* () {
    // A host started with its own runtime uses it; otherwise it is built below.
    let codeOperationRuntime: CodeOperationRuntime | undefined = options.codeOperationRuntime;
    // Areas built after this one add tools to a Code turn here, as they do to
    // a Chat thread, so the runtime never holds the services behind them.
    const codeToolContributors: Array<
      NonNullable<CodeOperationRuntimeOptions["contributedTools"]>
    > = [];
    const contributeCodeTools = (
      contributor: NonNullable<CodeOperationRuntimeOptions["contributedTools"]>,
    ): void => {
      codeToolContributors.push(contributor);
    };
    const {
      androidToolchainRoutes,
      appleToolchainRoutes,
      resolveAndroidContext,
      resolveAppleContext,
    } = bindDeviceApprovals({
      validateAppleApproval: (windowId, request) =>
        codeOperationRuntime?.validateAppleApproval(windowId, request),
      validateAndroidApproval: (windowId, request) =>
        codeOperationRuntime?.validateAndroidApproval(windowId, request),
    });
    let terminalProcessPort: TerminalProcessPort | undefined;
    if (codeOperationRuntime === undefined && options.codeService === undefined) {
      terminalProcessPort = new TerminalProcessPort({
        receiptDirectory: join(providerDataDirectory, "code", "terminal-receipts"),
        shellStateDirectory: join(providerDataDirectory, "code", "terminal-shell"),
      });
      const repositoryTestProcessPort = new RepositoryTestProcessPort({
        receiptDirectory: join(providerDataDirectory, "code", "test-receipts"),
      });
      // A scaffold generator downloads what it writes, so it gets its own
      // private work directory and is pointed at it for every package cache.
      // Nothing it fetches lands in the user's own caches, and the confinement
      // still writes only the checkout and this directory.
      const scaffoldWorkDirectory = join(providerDataDirectory, "code", "scaffold-work");
      const scaffoldProcessPort = new RepositoryTestProcessPort({
        receiptDirectory: join(providerDataDirectory, "code", "scaffold-receipts"),
        temporaryDirectory: scaffoldWorkDirectory,
      });
      const rootProbePath = decodeCodeRelativePath("package.json");
      // A confined commit cannot read the user's global gitconfig, so the
      // host's own profile is the identity a checkout without local config
      // falls back to. Read it per call: the profile is editable while the
      // server runs, and a restart is too high a price for a name.
      const gitMutationPort = new GitMutationPort(undefined, {
        commitIdentity: () => {
          const profile = persistence.readShellSettings()?.settings.userProfile;
          // The profile's fields are independent: a name without an address
          // still completes a checkout that has an address but no name. The
          // port merges per field and refuses only when the combination
          // cannot name an author at all.
          return {
            ...(profile?.displayName === undefined ? {} : { name: profile.displayName }),
            ...(profile?.email === undefined ? {} : { email: profile.email }),
          };
        },
      });
      // A grant lets a provider CLI the person types into one thread terminal
      // drive that thread's Browser. It is served from this host's memory only,
      // through the same Browser, approval, and authority services a managed
      // turn uses, and the terminal's own running state is read live.
      const grants = new TerminalBrowserGrantService({
        readThread: persistence.readCodeThread,
        canAccessProject: canAccessCodeProject,
        terminalIsRunning: (terminalId) => {
          try {
            return codeOperationRuntime?.terminals?.attach(String(terminalId)).status === "running";
          } catch {
            return false;
          }
        },
        browser: {
          resolveAuthority: (threadId, mode) => browserAuthority.resolve(threadId, mode),
          automation: {
            inspectThread: (windowId, threadId) =>
              browserAutomationService.inspectThread(windowId, threadId),
            create: (input) => browserAutomationService.create(input),
            act: (input) => browserAutomationService.act(input),
            releaseThread: (windowId, threadId) =>
              browserAutomationService.releaseThread(windowId, threadId),
          },
          approvals: browserToolApprovalService,
        },
        ...(options.terminalLauncher === undefined ? {} : { launcher: options.terminalLauncher }),
        journal: persistence.journal,
        personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
        hostActor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
        uuid: randomUUID,
        clock: () => new Date().toISOString(),
      });
      onWindowRevoked((windowId) => grants.revokeWindow(windowId));
      onWindowRevoked((windowId) => codeOperationRuntime?.revokeTerminalStreams(windowId));
      const unsubscribeTerminalBrowserGrants = persistence.journal.subscribeCommitted((append) => {
        for (const event of append.events) {
          if (
            event.eventName === "code.thread-updated@1" &&
            event.aggregateType === "code-thread"
          ) {
            // An archive or completion ends the grants a thread holds at once;
            // the next call would find it too, but the record should not wait.
            const thread = persistence.readCodeThread(decodeCodeThreadId(event.aggregateId));
            if (thread?.lifecycle !== "active") {
              grants.threadSettled(event.aggregateId, "thread-archived");
            } else if (thread.completedAt !== undefined) {
              grants.threadSettled(event.aggregateId, "thread-completed");
            }
          } else if (event.eventName === THREAD_RETENTION_EVENT_NAMES.threadPurged) {
            const purged = event.payload as {
              readonly mode?: unknown;
              readonly threadId?: unknown;
            };
            if (purged.mode === "code" && typeof purged.threadId === "string") {
              grants.threadSettled(purged.threadId, "thread-deleted");
            }
          }
        }
      });
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          unsubscribeTerminalBrowserGrants();
          await grants.close();
        }),
      );
      codeOperationRuntime = createCodeOperationRuntime({
        liveTurns,
        activeTurns: codeActiveTurns,
        terminalBrowserGrants: grants,
        onPendingRequestWithdrawn: () => machineChangeFeed.publish(["code-navigation"]),
        gitMutationPort,
        agentRuns: agentRunPersistence,
        resolveSelectedExtensions,
        pinnedExtensionIds,
        threadDesktopDestination,
        computerUseTools: ({ windowId, thread, destination, ask }) =>
          computerToolsFor(
            decodeComputerUseOwner({
              windowId,
              threadId: thread.id,
              mode: "code",
              providerInstanceId: thread.providerInstanceId,
              modelId: thread.modelId,
              executionPolicy: thread.executionPolicy,
              ...(destination === undefined ? {} : { leaseId: destination.leaseId }),
            }),
            ask,
          ),
        spendCeiling,
        terminalProcessPort,
        repositoryTestProcessPort,
        scaffoldProcess: {
          execute: (input, signal) => scaffoldProcessPort.execute(input, signal),
          environment: {
            BUN_INSTALL_CACHE_DIR: join(scaffoldWorkDirectory, "bun-cache"),
            npm_config_cache: join(scaffoldWorkDirectory, "npm-cache"),
            TMPDIR: scaffoldWorkDirectory,
          },
        },
        repositoryTestDiscovery: codeTestDiscovery,
        attachments: codeAttachments,
        persistence: {
          journal: persistence.journal,
          readCodeThread: persistence.readCodeThread,
          readCodeCheckout: persistence.readCodeCheckout,
          readCodeRuntimeWorkAggregateVersion: persistence.readCodeRuntimeWorkAggregateVersion,
          readReviewFinding: persistence.readCodeReviewFinding,
          readReviewFindings: persistence.readCodeReviewFindings,
        },
        probeProvider: (instanceId) => probeProviderForThreads(instanceId),
        isProviderModelAllowed: (thread) =>
          isCodeProviderModelAllowed({
            projectId: thread.projectId,
            providerInstanceId: thread.providerInstanceId,
            modelId: thread.modelId,
          }),
        windowAccess: {
          canAccessProject: canAccessCodeProject,
          standingAuthority: (run) => codeProjectAccess.standingAuthority(run),
          retainProjectAccess: (windowId) => codeProjectAccess.retain(windowId),
        },
        resolveCheckoutRoot: async (windowId, thread, checkout) => {
          // A remote root names a folder on another machine, never one here.
          if (checkout.kind === "remote-root") return undefined;
          const root = await roots.resolve(windowId, thread, checkout, rootProbePath);
          if (root === undefined) return undefined;
          const workingDirectory = await resolveThreadWorkingDirectory(
            root.rootPath,
            thread.workingDirectory ?? decodeThreadWorkingDirectory("."),
          );
          return {
            checkoutRoot: root.rootPath,
            workingDirectory,
            shell: defaultTerminalShell(),
            credentialReferences: [],
            environment: {},
          };
        },
        resolveProviderDriver: (thread) => {
          const instance = persistence.readProviderInstance(thread.providerInstanceId);
          if (instance === undefined || !instance.enabled) return undefined;
          try {
            const key = String(thread.id);
            const retained = codeThreadDrivers.get(key);
            if (
              retained?.instanceId === String(instance.id) &&
              retained.version === instance.version
            )
              return retained.driver;
            const driver = attachWorkRequestRuntime(
              makeConfiguredProviderDriver(instance, configuredDriverOptions),
              () => workRequestRuntime,
            );
            codeThreadDrivers.set(key, {
              instanceId: String(instance.id),
              version: instance.version,
              driver,
            });
            return driver;
          } catch {
            return undefined;
          }
        },
        agents: (input) =>
          agentsManagedToolsFor({
            windowId: String(input.windowId),
            parentThreadId: String(input.thread.id),
            mode: "code",
            projectId: input.thread.projectId,
          }),
        nativeHarnessTools: (input) => nativeHarnessComposition.forCode(input),
        nativeHarness: nativeHarnessHooks,
        onProviderTurnRequested: (threadId) => {
          if (codeService instanceof CodeService) codeService.noteProviderTurnRequested(threadId);
        },
        supportsAppManagedTools: (thread) => {
          const observed = providerRuntimeRegistry.observedState(thread.providerInstanceId);
          return (
            observed?.capabilities.appManagedTools === "supported" ||
            observed?.verifiedToolModelIds?.some(
              (candidate) => String(candidate) === String(thread.modelId),
            ) === true
          );
        },
        supportsAcpClientCapabilities: (thread) =>
          providerRuntimeRegistry.observedState(thread.providerInstanceId)?.capabilities
            .acpClientCapabilities === "supported",
        supportsModelSwitch: (thread) =>
          providerRuntimeRegistry.observedState(thread.providerInstanceId)?.capabilities
            .modelSwitch === "supported",
        compactionRunning: (threadId) =>
          contextHarness.compactionRunning(
            decodeContextSubjectRef({ aggregateType: "code-thread", aggregateId: threadId }),
          ),
        sessionCompactions: {
          record: ({ threadId, ...input }) => {
            contextHarness.recordAutomaticCompaction({
              subject: decodeContextSubjectRef({
                aggregateType: "code-thread",
                aggregateId: threadId,
              }),
              ...input,
            });
          },
          compactedAfter: (threadId, globalSequence) =>
            contextHarness.sessionCompactedAfter(
              decodeContextSubjectRef({ aggregateType: "code-thread", aggregateId: threadId }),
              globalSequence,
            ),
        },
        providerSwitchContext: ({ thread, excludeOperationId, inheritedFrom }) =>
          selectCodeConversation(thread.id, {
            purpose: "provider-switch",
            excludeOperationId: String(excludeOperationId),
            ...(inheritedFrom === undefined
              ? {}
              : {
                  inherited: {
                    threadId: inheritedFrom.source.id,
                    throughOperationId: inheritedFrom.throughOperationId,
                    externalContentIngested: readThreadExternalContentTaint(
                      persistence.connection,
                      String(inheritedFrom.source.id),
                    ).externalContentIngested,
                  },
                }),
          }),
        supportsAttachments: (thread) => {
          const observed = providerRuntimeRegistry.observedState(thread.providerInstanceId);
          if (observed?.capabilities.nativeAttachments !== "supported") return false;
          // Provider-level support only says some model reads images. A turn
          // goes to one model, so the thread's own model has to be that one.
          return observed.models.some(
            (model) =>
              String(model.id) === String(thread.modelId) &&
              model.inputModalities.includes("image"),
          );
        },
        browserAutomation: {
          resolveAuthority: (threadId, mode) => browserAuthority.resolve(threadId, mode),
          inspectThread: (windowId, threadId) =>
            browserAutomationService.inspectThread(windowId, threadId),
          create: (input) => browserAutomationService.create(input),
          act: (input) => browserAutomationService.act(input),
          releaseThread: (windowId, threadId) =>
            browserAutomationService.releaseThread(windowId, threadId),
        },
        isBrowserOriginRemembered: (origin) => browserToolApprovalService.isRemembered(origin),
        // The agent's Apple capability resolves its execution context through
        // exactly the resolver the workbench route uses, so a tool call and a
        // click are the same request to the same policy.
        appleToolchain: {
          resolveAuthority: (_windowId, thread) => ({
            hostId: LOCAL_TOOL_HOST_ID,
            mode: "code" as const,
            projectId: thread.projectId,
            providerInstanceId: thread.providerInstanceId,
            extension: { kind: "core" as const },
          }),
          discover: async (windowId, request) => {
            const context = await resolveAppleContext(
              windowId,
              {
                authority: request.authority,
                threadId: request.threadId,
                checkoutId: request.checkoutId,
              },
              { kind: "apple-discovery-request", request },
            );
            if (context === undefined) return undefined;
            return await appleToolchainService.discover(request, context);
          },
          execute: async (windowId, request) => {
            const startedAt = new Date().toISOString();
            const context = await resolveAppleContext(
              windowId,
              {
                authority: request.authority,
                threadId: request.threadId,
                checkoutId: request.checkoutId,
              },
              { kind: "apple-action-request", request },
            );
            if (context === undefined) return undefined;
            const evidence = await appleToolchainService.execute(request, context);
            // An agent's shutdown closes a Simulator to every thread, and its
            // input keeps a live grant open, the same as the pane's.
            simulatorInputGrants.settle(String(windowId), request, evidence, context);
            await recordAppleEvidence(evidence, startedAt);
            return evidence;
          },
          readScreenshot: async (windowId, scope, reference) => {
            const context = await resolveAppleContext(windowId, scope, {
              kind: "apple-snapshot-request",
              authority: scope.authority,
              threadId: scope.threadId,
              checkoutId: scope.checkoutId,
            });
            if (context === undefined) return undefined;
            const artifact = await appleToolchainService.readScreenshotArtifact(reference, context);
            return artifact.kind === "found" ? artifact.bytes : undefined;
          },
          snapshot: async (windowId, scope) => {
            const context = await resolveAppleContext(windowId, scope, {
              kind: "apple-snapshot-request",
              authority: scope.authority,
              threadId: scope.threadId,
              checkoutId: scope.checkoutId,
            });
            return context === undefined ? undefined : appleToolchainService.snapshot(context);
          },
          requestPaneOpen: async (windowId, scope, simulatorId) => {
            const context = await resolveAppleContext(windowId, scope, {
              kind: "apple-snapshot-request",
              authority: scope.authority,
              threadId: scope.threadId,
              checkoutId: scope.checkoutId,
            });
            if (context === undefined) return undefined;
            return appleToolchainService.requestPaneOpen(context, simulatorId);
          },
          inputGrantIsOpen: (windowId, threadId, simulatorId) =>
            simulatorInputGrants.isOpen({
              windowId: String(windowId),
              threadId: String(threadId),
              simulatorId: String(simulatorId),
            }),
        },
        androidToolchain: {
          resolveAuthority: (_windowId, thread) => ({
            hostId: LOCAL_TOOL_HOST_ID,
            mode: "code" as const,
            projectId: thread.projectId,
            providerInstanceId: thread.providerInstanceId,
            extension: { kind: "core" as const },
          }),
          discover: async (windowId, request) => {
            const context = await resolveAndroidContext(
              windowId,
              {
                authority: request.authority,
                threadId: request.threadId,
                checkoutId: request.checkoutId,
              },
              { kind: "android-discovery-request", request },
            );
            if (context === undefined) return undefined;
            return await androidToolchainService.discover(request, context);
          },
          execute: async (windowId, request) => {
            const context = await resolveAndroidContext(
              windowId,
              {
                authority: request.authority,
                threadId: request.threadId,
                checkoutId: request.checkoutId,
              },
              { kind: "android-action-request", request },
            );
            if (context === undefined) return undefined;
            const evidence = await androidToolchainService.execute(request, context);
            if (!isReplayedAndroidEvidence(evidence)) {
              androidInputGrants.settle(
                String(windowId),
                { kind: request.kind, simulatorId: request.emulatorId },
                evidence,
                context,
              );
            }
            return evidence;
          },
          readScreenshot: async (windowId, scope, reference) => {
            const context = await resolveAndroidContext(windowId, scope, {
              kind: "android-snapshot-request",
              authority: scope.authority,
              threadId: scope.threadId,
              checkoutId: scope.checkoutId,
            });
            if (context === undefined) return undefined;
            const artifact = await androidToolchainService.readScreenshotArtifact(
              reference,
              context,
            );
            return artifact.kind === "found" ? artifact.bytes : undefined;
          },
          snapshot: async (windowId, scope) => {
            const context = await resolveAndroidContext(windowId, scope, {
              kind: "android-snapshot-request",
              authority: scope.authority,
              threadId: scope.threadId,
              checkoutId: scope.checkoutId,
            });
            return context === undefined ? undefined : androidToolchainService.snapshot(context);
          },
          requestPaneOpen: async (windowId, scope, emulatorId) => {
            const context = await resolveAndroidContext(windowId, scope, {
              kind: "android-snapshot-request",
              authority: scope.authority,
              threadId: scope.threadId,
              checkoutId: scope.checkoutId,
            });
            if (context === undefined) return undefined;
            return androidToolchainService.requestPaneOpen(context, emulatorId);
          },
          inputGrantIsOpen: (windowId, threadId, emulatorId) =>
            androidInputGrants.isOpen({
              windowId: String(windowId),
              threadId: String(threadId),
              simulatorId: String(emulatorId),
            }),
        },
        credentialResolver: { resolve: async () => undefined },
        resolveThreadMentionContext: threadMentionContextResolver(
          () => threadMentionService(),
          threadOutsideContentMarks,
        ),
        resolveFileMentionContext: async ({ fileMentionPaths, windowId, threadId, checkoutId }) =>
          fileMentionContextBlocks(fileMentionService(), {
            windowId,
            scope: { mode: "code", threadId, checkoutId },
            paths: fileMentionPaths,
          }),
        takeProductFeedbackForTurn: createProductFeedbackTurnPort({
          service: productFeedbackService,
        }),
        peekIssueContextFramed: peekCreateFromIssueFramed,
        consumeIssueContextFramed: consumeCreateFromIssueFramed,
        // Where a run comes home to: the directory the thread's Project binds.
        // A run on a managed worktree works in a sibling tree; the merge lands
        // in the person's own checkout, and only the Project knows where that
        // is.
        resolveBaseCheckoutRoot: async (thread) => {
          const project = persistence.readProject(thread.projectId);
          return project?.type === "code" && project.lifecycle === "active"
            ? project.binding.canonicalRoot
            : undefined;
        },
        forkContext: ({ source, throughOperationId, targetContextLimitTokens }) =>
          selectCodeConversation(source.id, {
            purpose: "fork",
            throughOperationId,
            ...(targetContextLimitTokens === undefined ? {} : { targetContextLimitTokens }),
          }),
        forkMergeBackContext: ({ fork, afterOperationId, throughOperationId }) =>
          selectCodeConversation(fork.id, {
            purpose: "fork-merge-back",
            throughOperationId,
            ...(afterOperationId === undefined ? {} : { afterOperationId }),
          }),
        forkProviderSession: (input) =>
          seedCodeForkHarnessSession(
            {
              transcripts: nativeHarnessTranscripts,
              harnessDriverKind: (instanceId) => {
                const instance = persistence.readProviderInstance(instanceId);
                return instance !== undefined && isNativeHarnessDriverKind(instance.driverKind)
                  ? instance.driverKind
                  : undefined;
              },
              sourceTurns: (threadId) =>
                codeThreadTurns((page) => codeBoardEventStore.conversation(page), threadId),
              sourceConversations: (threadId) =>
                codeBoardEventStore.providerConversationsOfTurns(threadId),
            },
            input,
          ),
        resolveProfileSkills: createCodeProfileSkillResolver({
          snapshot: () => extensionApiService.snapshot(),
          loadSkillText: createStoredCodeProfileSkillTextLoader({
            snapshot: () => extensionApiService.snapshot(),
            readVerifiedComponentText: async (target) =>
              extensionPackageStore.readVerifiedComponentText(target, target.componentId),
          }),
        }),
        githubReadTools: ({ windowId, thread, readThread }) =>
          githubReadToolSetIfEffective(githubExtensionSnapshot.read(), () =>
            githubReadToolService.createToolSet({ windowId, thread, readThread }),
          ),
        agentMessages: ({ thread, readPosture }) =>
          createAgentMessageTools({
            service: agentMessageService,
            senderThreadId: String(thread.id),
            toolConstraints: thread.toolConstraints ?? [],
            profileDisplayName: thread.profileDisplayName ?? "the bound profile",
            readPosture,
          }),
        contributedTools: (input) =>
          codeToolContributors.length === 0
            ? undefined
            : combineAppManagedToolSets(
                ...codeToolContributors.map((contribute) => contribute(input)),
              ),
        // The facts come from the host's own records on every call. The
        // Code runtime, the decision reader, and the mention directory are
        // declared later in this startup; a turn runs only after they exist.
        siblingThreads: ({ windowId, thread }) =>
          createSiblingThreadTools({
            service: siblingThreadsService,
            source: codeSiblingThreadSource(
              {
                threads: () => persistence.readCodeThreads(),
                thread: (threadId) => persistence.readCodeThread(threadId),
                runtimeWorks: (threadId) => persistence.readCodeRuntimeWorks(threadId),
                turnAwaitsPerson: (threadId) =>
                  codeOperationRuntime?.turnAwaitsPerson?.(String(threadId)) === true ||
                  threadAwaitsHarnessApproval(String(threadId)),
                decisionPending: (candidate) =>
                  codeTurnDecisions.forThread(candidate) !== undefined,
                mentions: {
                  readTranscript: async (readerWindowId, threadId, options) =>
                    await codeThreadMentionDirectory().readTranscript(
                      readerWindowId,
                      threadId,
                      options,
                    ),
                },
              },
              windowId,
            ),
            callerThreadId: String(thread.id),
            toolConstraints: thread.toolConstraints ?? [],
            profileDisplayName: thread.profileDisplayName ?? "the bound profile",
          }),
        carryAgentMessages: (threadId) => agentMessageService.carryIntoTurn(threadId),
        confirmAgentMessagesDelivered: (messageIds) =>
          agentMessageService.confirmDelivered(messageIds),
        sideTasks: ({ thread }) =>
          createSideTaskTools({
            store: sideTasks,
            threadId: String(thread.id),
            mode: "code",
            projectId: thread.projectId,
            suggestedBy: thread,
            uuid: randomUUID,
            clock: () => new Date().toISOString(),
          }),
        canvas: ({ windowId, thread }) =>
          createCanvasAgentTools({
            windowId,
            mode: "code",
            thread: {
              id: String(thread.id),
              projectId: String(thread.projectId),
              providerInstanceId: thread.providerInstanceId,
              modelId: thread.modelId,
            },
            port: canvasAgentToolPort,
          }),
        recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
        outsideContentMarks: runtimeOutsideContentMarks,
        readThreadExternalContentTaint: (threadId) =>
          readThreadExternalContentTaint(persistence.connection, String(threadId)),
        resolveProviderCapabilities: (thread) =>
          providerRuntimeRegistry.observedState(thread.providerInstanceId)?.capabilities,
        resolveProviderNativeSetup: (thread) =>
          sessionNativeSetup(persistence, {
            providerInstanceId: thread.providerInstanceId,
            projectId: thread.projectId,
            mode: "code",
            executionPolicy: thread.executionPolicy,
          }),
        // Planner tools resolve their designation on every call through the
        // services declared after this runtime; the closures run only once a
        // turn is live, well after startup finishes wiring them.
        planner: {
          isPlannerThread: (threadId) => codePlannerService.isPlannerThread(threadId),
          board: async (windowId, threadId) => {
            const scope = codePlannerService.boardScope(threadId);
            if (scope.status === "refused") return scope;
            const queryBoard = routeCodeService.queryBoard;
            if (queryBoard === undefined) {
              return {
                status: "refused",
                reason: "planner-unavailable",
                message: "The Code Thread Board is unavailable on this host.",
              };
            }
            // The planner reads the same server-authoritative board read-model
            // the UI queries, scoped strictly to its own Project. No GitHub
            // call happens here; cached PR facts arrive with their freshness.
            const board = await queryBoard(windowId, {
              version: 1,
              projectIds: [scope.projectId],
            });
            return { status: "ok", board };
          },
          propose: async (_windowId, threadId, draft) =>
            codePlannerService.propose(threadId, draft),
        },
        resolvePullRequestTarget: async (threadId) => {
          const thread = persistence.readCodeThread(threadId);
          if (thread === undefined) return undefined;
          const owner = thread.deliveryTarget.proposedBaseRepository.split("/")[0];
          if (owner === undefined || owner.length === 0) return undefined;
          return {
            authorization: "confirmed-delivery-target",
            baseRepository: thread.deliveryTarget.proposedBaseRepository,
            baseBranch: thread.deliveryTarget.proposedBaseBranch,
            head: `${owner}:${thread.deliveryTarget.branchIntent}`,
          };
        },
        reviewFiles: {
          resolve: (input) => {
            const reference = persistence.readCodeFileReference(input.fileId);
            if (
              reference === undefined ||
              reference.id !== stableCodeFileId(input.threadId, input.checkoutId, input.path) ||
              reference.threadId !== input.threadId ||
              reference.checkoutId !== input.checkoutId ||
              reference.digest !== input.digest
            ) {
              return undefined;
            }
            return {
              threadId: input.threadId,
              checkoutId: input.checkoutId,
              path: input.path,
              digest: input.digest,
            };
          },
        },
        evidence: {
          put: (content, metadata) => codeEvidence.put(content, metadata),
          read: async (reference) => codeEvidence.read(reference),
        },
        actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
        clock: () => new Date().toISOString(),
        uuid: randomUUID,
        approvalStore: codeApprovalStore,
        sessionAuthority: codeSessionAuthority,
        ...(options.ghExecutable === undefined ? {} : { ghExecutable: options.ghExecutable }),
      });
    }
    const { codeCompletedThreadSource, codeService } = buildCodeService(codeOperationRuntime);
    yield* Effect.promise(() => codeOperationRuntime?.reconcile?.() ?? Promise.resolve());
    // Code threads already have an inline question surface; the same question
    // shows there so the answer can come from the thread itself.
    onHarnessQuestionAsked(({ threadId, mode, question }) => {
      if (mode !== "code" || question.source !== undefined) return;
      codeOperationRuntime?.raiseHarnessQuestion?.({
        threadId,
        questionId: String(question.id),
        prompt: question.prompt,
        options: question.options,
      });
    });
    // Settled anywhere (another surface, expiry, cancellation): the inline
    // copy goes too, so Code never lists or accepts an answer to it.
    // Recovery settles its orphaned turns before a continuation can be queued.
    onHarnessRecoveryLifted(({ threadId, mode }) => {
      if (mode === "code") codeOperationRuntime?.settleCutOffTurns?.(threadId);
    });
    onHarnessQuestionSettled((input) => codeOperationRuntime?.withdrawHarnessQuestion?.(input));
    const baseRouteCodeService: CodeRouteService =
      codeOperationRuntime === undefined
        ? codeService
        : withCodeOperationRuntime(codeService, codeOperationRuntime);
    // A finished Code turn that closed with an ask, read back from the journal
    // so the board and every attention surface agree after a restart.
    const codeTurnDecisions = new CodeTurnDecisions({
      threads: async (windowId) => (await baseRouteCodeService.navigation(windowId)).threads,
      admitsTurn: async (windowId, thread) =>
        (await codeOperationRuntime?.admitsTurn?.(windowId, thread)) === true,
      runtimeWorks: (threadId) => persistence.readCodeRuntimeWorks(threadId),
      replay: (input) => {
        try {
          const replay = codeBoardEventStore.replay({
            ...input,
            limit: MAX_CODE_OPERATION_REPLAY_LIMIT,
          });
          return replay.status === "ok" ? replay.frames : undefined;
        } catch {
          return undefined;
        }
      },
      readEvidence: (reference) => codeEvidence.read(reference),
    });
    // The Code Thread Board composes the journal-rebuildable operational
    // metadata projection with live runtime works. Local Git worktree
    // observation still degrades to unavailable here when the checkout cannot
    // be observed; GitHub is never called. Cached PR evidence comes from the
    // operation journal, labeled with freshness, and cannot independently
    // satisfy a delivery target when stale.
    const codeThreadMetadataService = new CodeThreadMetadataService({
      git: { observe: () => ({ status: "unavailable" }) },
      history: {
        read: (threadId) => codeBoardEventStore.historyForThread(threadId),
      },
    });
    // Persistent Code follow-up. Follow-up is a durable user
    // obligation independent of unread and runtime status; it reuses the
    // mode-neutral `thread-follow-up` aggregate so a single normalized model
    // spans Chat, Work, and Code.
    const codeFollowUpService = new CodeFollowUpService({
      persistence,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    // The Project planner: one designated Code thread per Code Project that
    // may read the Project's board and propose work. A confirmed proposal
    // creates its thread through the ordinary creation command path below;
    // the planner has no creation authority of its own. Only the host's own
    // CodeService takes the host-only mark a thread confirmed from a marked
    // planner starts with; a route service a host was given instead has no
    // such input, so a confirm that needs the mark is refused there rather
    // than creating the thread unmarked.
    const codePlannerService = new CodePlannerService({
      persistence,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      canAccessProject: canAccessCodeProject,
      createThread: async (windowId, creation, signal, executionContext) => {
        if (codeService instanceof CodeService) {
          return codeService.execute(windowId, creation, signal, executionContext);
        }
        if (executionContext.inheritedMark !== undefined) {
          throw new CodeServiceError(
            decodeCodeFailure({ category: "unavailable", message: INHERITED_MARK_REFUSAL }),
          );
        }
        return codeService.execute(windowId, creation, signal);
      },
      isMarkedWithOutsideContent: (threadId) =>
        readThreadExternalContentTaint(persistence.connection, threadId).externalContentIngested,
    });
    // A linked pull request's checks turning red is a user obligation, not an
    // agent event: every snapshot refresh feeds the durable follow-up marker on
    // the owning thread. Read-only toward GitHub; only an explicit completion
    // clears the marker.
    const failingChecksFollowUps = new FailingChecksFollowUps({
      followUps: codeFollowUpService,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    onPullRequestSnapshotRefreshed((rows) => {
      void failingChecksFollowUps.observe(rows);
    });
    const boardRouteCodeService: CodeRouteService = withCodeBoard(
      baseRouteCodeService,
      async (windowId, query) => {
        const bootstrap = await baseRouteCodeService.bootstrap(windowId);
        const projects = await projectService.bootstrap(windowId);
        const projectById = new Map(
          projects.active.map((project) => [String(project.id), project] as const),
        );
        const checkoutById = new Map(
          bootstrap.checkouts.map((checkout) => [String(checkout.id), checkout] as const),
        );
        const boardThreads: CodeBoardThread[] = bootstrap.threads
          .filter((thread) => thread.lifecycle !== "archived" && thread.completedAt === undefined)
          .map((thread) => {
            const project = projectById.get(String(thread.projectId));
            return {
              thread,
              project: { id: thread.projectId, name: project?.name ?? thread.title },
              checkout: checkoutById.get(String(thread.checkoutId)),
              // A temporarily missing Project projection keeps the thread visible
              // in a recovery state instead of dropping the card.
              projectProjectionPresent: project !== undefined,
              // Follow-up is the durable, journal-rebuildable obligation.
              // Client unread is overlaid by each renderer and never stored on
              // the server card.
              followUp: codeFollowUpService.read(thread.id).followUp?.state === "open",
            };
          });
        const board = new CodeThreadBoardService({
          threads: { list: () => boardThreads },
          metadata: codeThreadMetadataService,
          runtime: {
            observe: (threadId) => {
              const thread = persistence.readCodeThread(threadId);
              return {
                ...boardRuntimeActivityFromWorks(persistence.readCodeRuntimeWorks(threadId), {
                  turnParkedOnPerson:
                    codeOperationRuntime?.turnAwaitsPerson?.(String(threadId)) === true ||
                    threadAwaitsHarnessApproval(String(threadId)),
                }),
                decisionPending:
                  thread !== undefined && codeTurnDecisions.forThread(thread) !== undefined,
              };
            },
          },
          pullRequests: {
            snapshot: () => projectPullRequestService.boardSnapshot(windowId),
          },
          planProgress: codeBoardPlanProgressSource,
          clock: () => new Date().toISOString(),
        });
        return board.query(query);
      },
    );
    // Merge when ready and Auto-fix. The forge calls run through the host's
    // own `gh`; with none installed every switch answers unavailable.
    const pullRequestSwitchForge = (() => {
      if (options.ghExecutable === undefined) return undefined;
      try {
        return new GhPullRequestSwitchPort({
          command: createGhCommandPort({ ghPath: options.ghExecutable }),
        });
      } catch {
        return undefined;
      }
    })();
    const pullRequestSwitchService = new CodeProjectPullRequestSwitchService({
      authority: projectPullRequestService,
      forge: pullRequestSwitchForge ?? {
        readAutoMergeSettings: async () => ({ status: "unavailable", reason: "unavailable" }),
        enableAutoMerge: async () => ({ status: "unavailable", reason: "unavailable" }),
        disableAutoMerge: async () => ({ status: "unavailable", reason: "unavailable" }),
        observe: async () => ({ status: "unavailable" }),
      },
      threads: {
        inspect: (threadId) => {
          const thread = persistence.readCodeThread(threadId);
          if (
            thread === undefined ||
            thread.lifecycle !== "active" ||
            thread.completedAt !== undefined
          ) {
            return { status: "gone" };
          }
          const compacting = contextHarness.compactionRunning(
            decodeContextSubjectRef({ aggregateType: "code-thread", aggregateId: threadId }),
          );
          return {
            status: "available",
            turnActive:
              compacting ||
              persistence
                .readCodeRuntimeWorks(threadId)
                .some(
                  ({ work }) =>
                    work.kind === "provider-turn" &&
                    (work.state === "running" ||
                      work.state === "waiting" ||
                      work.state === "ambiguous"),
                ),
          };
        },
        markOutsideContent: (threadId, contentReference) => {
          const marked = externalContentIngestionStore.record({
            threadId,
            provenance: { origin: "external-content", sourceLabel: "pull-request-auto-fix" },
            contentReference,
            correlationId: randomUUID(),
            authorized: true,
          });
          return marked.kind === "recorded" || marked.kind === "already-recorded";
        },
        // The same host path a routine's follow-up and a child's result take:
        // the thread's own access level and approvals apply to the turn.
        startTurn: async (threadId, text) => {
          const thread = persistence.readCodeThread(threadId);
          const stage = boardRouteCodeService.stageEvidence;
          const execute = boardRouteCodeService.executeOperation;
          if (thread === undefined || stage === undefined || execute === undefined) return false;
          const prompt = await stage(ROUTINE_HOST_SCOPE_ID, threadId, text);
          const result = await execute(ROUTINE_HOST_SCOPE_ID, {
            kind: "start-provider-turn",
            operationId: decodeCodeOperationId(randomUUID()),
            threadId,
            checkoutId: thread.checkoutId,
            sessionId: decodeProviderSessionId(randomUUID()),
            prompt,
          });
          return (
            result.kind === "provider-turn-state" &&
            (result.state === "running" ||
              result.state === "waiting" ||
              result.state === "completed")
          );
        },
        notifyPerson: async (threadId, reason) => {
          const view = codeFollowUpService.read(threadId);
          await codeFollowUpService.observeTrigger({
            threadId,
            sourceEventId: randomUUID(),
            sourceSequence:
              Math.max(
                view.followUp?.triggerSequence ?? 0,
                view.followUp?.acknowledgedThroughSequence ?? 0,
              ) + 1,
            reason,
            origin: "automatic",
            triggeredAt: new Date().toISOString(),
          });
        },
      },
      journal: persistence.journal,
      uuid: randomUUID,
    });
    // Host-local and idle-free: the forge is read only while a switch is on.
    const pullRequestSwitchAbort = new AbortController();
    const pullRequestSwitchTimer = setInterval(() => {
      if (!pullRequestSwitchService.watching) return;
      pullRequestSwitchService
        .tick(pullRequestSwitchAbort.signal)
        .catch((error: unknown) => console.error("[pull-request-switches] pass failed", error));
    }, 60_000);
    pullRequestSwitchTimer.unref?.();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        clearInterval(pullRequestSwitchTimer);
        pullRequestSwitchAbort.abort();
      }),
    );
    const routeCodeService: CodeRouteService = {
      ...boardRouteCodeService,
      readFollowUp: (_windowId, threadId) => codeFollowUpService.read(threadId),
      executeFollowUp: (_windowId, command) => codeFollowUpService.execute(command),
      readPlanner: (windowId, projectId) => codePlannerService.readView(windowId, projectId),
      executePlanner: (windowId, command) => codePlannerService.execute(windowId, command),
      executePlannerProposal: (windowId, command, signal) =>
        codePlannerService.resolveProposal(windowId, command, signal),
      queryProjectPullRequests: (windowId, query) =>
        projectPullRequestService.query(windowId, query),
      refreshProjectPullRequests: async (windowId, command, signal) => {
        const view = await projectPullRequestService.refresh(
          windowId,
          command,
          signal ?? new AbortController().signal,
        );
        // A fresh explicit refresh proves gh works again; it is one of the
        // two documented signals that restart a cadence stopped by an
        // unauthorized observation.
        if (view.freshness.status === "fresh") {
          projectPullRequestCadence.noteExplicitRefreshSucceeded();
        }
        return view;
      },
      queryProjectPullRequestDetail: (windowId, query) =>
        projectPullRequestService.queryDetail(windowId, query),
      refreshProjectPullRequestDetail: (windowId, command, signal) =>
        projectPullRequestService.refreshDetail(
          windowId,
          command,
          signal ?? new AbortController().signal,
        ),
      mergeProjectPullRequest: (windowId, command, signal, initiator) => {
        if (initiator !== "user")
          return Promise.resolve({ status: "refused", reason: "not-authorized" });
        return projectPullRequestService.merge(
          windowId,
          command,
          signal ?? new AbortController().signal,
        );
      },
      queryProjectPullRequestSwitches: (windowId, target) =>
        pullRequestSwitchService.query(windowId, target),
      setProjectPullRequestMergeWhenReady: (windowId, command, signal, initiator) =>
        pullRequestSwitchService.setMergeWhenReady(windowId, command, initiator, signal),
      setProjectPullRequestAutoFix: (windowId, command, initiator) =>
        pullRequestSwitchService.setAutoFix(windowId, command, initiator),
      noteComposerActivity: (_windowId, activity) =>
        pullRequestSwitchService.noteComposerActivity(activity.threadId),
    };
    return {
      androidToolchainRoutes,
      appleToolchainRoutes,
      baseRouteCodeService,
      codeCompletedThreadSource,
      codeOperationRuntime,
      codeService,
      codeTurnDecisions,
      contributeCodeTools,
      routeCodeService,
      terminalProcessPort,
    };
  });
}

export type CodeRuntimeWiring = Effect.Effect.Success<ReturnType<typeof wireCodeRuntime>>;
