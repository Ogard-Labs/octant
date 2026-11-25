import {
  isAuthenticatedPairedDeviceSessionCurrent as checkAuthenticatedPairedDeviceSessionCurrent,
  isPairedDeviceSessionCurrent as checkPairedDeviceSessionCurrent,
} from "../remoteRequestProofService";
import type { ClientPrincipal } from "../clientPrincipal";
import { ThreadNarration } from "../speech/narrationTool";
import { ThreadTranscription } from "../speech/transcriptionTool";
import { createSpeechGates } from "../speech/speechGates";
import { workThreadAccessOf, threadAccessOf } from "@octant/domain/guardrail-policy";
import { decodeWorkThreadId } from "@octant/contracts";
import { decodeCodeThreadId } from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts";
import { notifyWindowRevocations } from "../windowRevocations";
import { createHash, randomUUID } from "node:crypto";
import { defaultShellSettings } from "@octant/domain";
import {
  type AgentRun,
  decodeChatThreadId,
  decodeProjectId,
  decodeWindowId,
  MAX_PENDING_IMAGE_GENERATION_OFFERS,
  type ServiceOffer,
  type WindowId,
} from "@octant/contracts";
import {
  boundAgentRunLiveAuthority,
  type CodeParentActiveTurn,
} from "../agentRun/authorizeAgentRunCreation";
import { DurableBindingReceiptStore } from "../bindingReceiptStore";
import { MachineChangeFeed } from "../machineChangeFeed";
import { decodeBrowserThreadId } from "@octant/contracts/browser-automation";
import { LiveTurnRegistry } from "../liveTurn/liveTurnRegistry";
import { CodeOperationApprovalStore } from "../code/codeOperationApprovalStore";
import { CodeSessionAuthorityStore } from "../code/codeSessionAuthorityStore";
import {
  type CodeActiveTurns,
  type CodeOperationRuntime,
  threadWithActiveTurnPosture,
} from "../code/codeOperationRuntime";
import { createRestrictedDeviceScope } from "../hostPersonScope";
import { ProcessAuthorityClock } from "../processAuthorityClock";
import {
  readDeviceAccessLevel,
  readDeviceApprovedByPerson,
  readDeviceRegistration,
  readRemoteSessionInvalidation,
} from "../persistence/remoteAccessProjection";
import { AgentRunEventStore } from "../agentRun/agentRunEventStore";
import { AgentRunPersistenceService } from "../agentRun/agentRunPersistenceService";
import type { AgentRunControlAdmissionDependencies } from "../agentRun/agentRunControlAdmission";
import { isRoutineHostScope } from "../routineHostScope";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { homedir } from "node:os";
import { decodeUtcTimestamp } from "@octant/contracts";
import {
  applyProtectedFilesChoice,
  configureSecretGuardLocations,
  secretGuardPlatform,
} from "../process/secretGuard";
import { createPersonMemoryAccess } from "../personMemory/personMemoryAccess";
import { createPersonMemoryRouteHandler } from "../personMemory/personMemoryRoutes";
import { readReceivedDelegationThreadIds } from "../hub/delegationJournal";
import { createTodoRouteHandler } from "../todos/todoRoutes";
import { privateListenerHostId } from "../remote/privateListenerHostIdentity";
import { TodoStore } from "../todos/todoStore";
import { PersonMemoryStore } from "../personMemory/personMemoryStore";
import { SandboxRestrictionsService } from "../sandboxRestrictionsService";
import { createSandboxRestrictionsRoutes } from "../sandboxRestrictionsRoutes";
import { configureSandboxRestrictionsAuthority } from "../process/sandboxRuntimePolicy";
import { OctantInstructionsStore } from "../octantInstructions/octantInstructionsStore";
import { createOctantInstructionsRouteHandler } from "../octantInstructions/octantInstructionsRoutes";
import { ProtectedFilesService } from "../protectedFilesService";
import { createProtectedFilesRouteHandler } from "../protectedFilesRoutes";
import { ExtensionToolApprovalService } from "../extensions/extensionToolApprovalService";
import { AutomationEventStore } from "../automation/automationEventStore";
import { RoutineProposalService } from "../automation/routineProposalService";
import { VideoOfferService } from "../video/videoOfferService";
import { ImageGenerationOfferService } from "../image/imageGenerationOfferService";
import type { ServiceOfferAnswer } from "../offers/serviceOfferDecision";
import { ServiceOfferService } from "../offers/serviceOfferService";
import {
  chatThreadStandsInProject,
  isDeviceRegistrationCurrent,
  windowReachesPromptThread,
} from "../extensions/pairedDeviceApprovalAuthority";
import type { BrowserModelBinding } from "../browser/browserAppManagedTools";
import { BrowserCaptureService } from "../browser/browserCaptureService";
import { BrowserCaptureStore } from "../browser/browserCaptureStore";
import { SimulatorInputGrants } from "../apple/simulatorInputGrants";
import { threadsArchivedBy } from "../threadArchiveWatch";
import type { ServerStart } from "./serverShape";
import type { FoundationsWiring } from "./foundations";
import { ToolEffectLedger } from "../toolEffects/toolEffectLedger";

/**
 * Where a Code thread's running-turn posture is read from. A runtime the host
 * was started with never sees the host's registry, so it answers for its own
 * turns; otherwise the registry is the one the host-built runtime keeps its
 * running turns in. Either way one source answers, so a turn narrowed to Plan
 * stays Plan for every child admitted or resumed under it.
 */
export function codeParentActiveTurnFrom(
  startedRuntime: Pick<CodeOperationRuntime, "threadWithActiveTurnPosture"> | undefined,
  activeTurns: CodeActiveTurns,
): CodeParentActiveTurn {
  if (startedRuntime !== undefined) {
    return (thread) => startedRuntime.threadWithActiveTurnPosture?.(thread) ?? thread;
  }
  return (thread) => threadWithActiveTurnPosture(thread, activeTurns);
}

export type AuthorityDependencies = Pick<ServerStart, "options" | "persistence"> &
  Pick<FoundationsWiring, "browserAuthority" | "workThreadProjection">;

export function wireAuthority(deps: AuthorityDependencies) {
  const { browserAuthority, options, persistence, workThreadProjection } = deps;

  const bindingReceiptStore = new DurableBindingReceiptStore(persistence.connection);
  const processAuthorityClock = new ProcessAuthorityClock();
  const simulatorInputGrants = new SimulatorInputGrants(processAuthorityClock.now(), Date.now);
  const androidInputGrants = new SimulatorInputGrants(processAuthorityClock.now(), Date.now);
  const machineChangeFeed = new MachineChangeFeed();
  // What each running turn is doing, for the Chat, Work, and Code navigation
  // reads. Process-local by design: a restart interrupts every turn. A step
  // is not a journal event, so the registry tells the change feed when one
  // moves, and the navigation reads follow it as they do for any change.
  const liveTurns = new LiveTurnRegistry({
    onChanged: (topic) => machineChangeFeed.publish([topic]),
  });
  const unsubscribeMachineChanges = persistence.journal.subscribeCommitted((append) =>
    machineChangeFeed.publishCommitted(append),
  );
  const processAuthorityNow = (wallClockMs: number) => processAuthorityClock.clamp(wallClockMs);
  // Short-lived, in-process grants expire on this clock, so a wall clock set
  // back or a sleep cannot extend one (see the clock rule in Security and
  // authority). Durable grants, such as a paired device's, stay on wall time.
  const processAuthorityTime = processAuthorityClock.now();
  // The secret guard's list as the person changed it. Hydrated here, before
  // any runtime launches, so the first launch already carries the changes.
  configureSecretGuardLocations({ dataDirectory: persistence.dataDirectory });
  const protectedFiles = new ProtectedFilesService({
    journal: persistence.journal,
    locations: {
      platform: secretGuardPlatform(process.platform),
      home: homedir(),
      dataDirectory: persistence.dataDirectory,
    },
    apply: applyProtectedFilesChoice,
    uuid: randomUUID,
    clock: () => decodeUtcTimestamp(new Date().toISOString()),
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
  });
  const sandboxRestrictions = new SandboxRestrictionsService({
    strictPreferences: (scope) => {
      const code =
        scope.kind === "session"
          ? persistence.readCodeThread(decodeCodeThreadId(scope.threadId))
          : undefined;
      const work =
        scope.kind === "session" && code === undefined
          ? deps.workThreadProjection.read(decodeWorkThreadId(scope.threadId))
          : undefined;
      const thread = code ?? work;
      const projectId =
        scope.kind === "project" ? scope.projectId : (code?.projectId ?? work?.projectId);
      const project = projectId === undefined ? undefined : persistence.readProject(projectId);
      const mode =
        scope.kind === "settings"
          ? scope.mode
          : work !== undefined || project?.type === "work"
            ? "work"
            : "code";
      const codeSettings = persistence.readCodeSettings()?.settings;
      const workSettings = deps.workThreadProjection.settings();
      const settings = mode === "work" ? workSettings : codeSettings;
      const defaultExecutionPolicy =
        project?.type !== "chat" && project?.defaultPermissionMode !== undefined
          ? threadAccessOf(project.defaultPermissionMode).executionPolicy
          : mode === "work"
            ? workThreadAccessOf(workSettings?.defaultAccess ?? "ask-first").executionPolicy
            : (codeSettings?.defaultExecutionPolicy ?? "approval-gated");
      return {
        executionPolicy:
          code?.executionPolicy ??
          (work === undefined
            ? defaultExecutionPolicy
            : workThreadAccessOf(work.access).executionPolicy),
        ...(thread === undefined ? {} : { thread }),
        ...(project === undefined || project.type === "chat" ? {} : { project }),
        ...(settings === undefined ? {} : { settings }),
      };
    },
    enrollmentEnabled: process.env.OCTANT_SANDBOX_RESTRICTIONS_PREVIEW === "1",
    journal: persistence.journal,
    hostId: String(LOCAL_HOST_ID),
    dataDirectory: persistence.dataDirectory,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    project: (id) => persistence.readProject(decodeProjectId(id)),
    thread: (id) => {
      const code = persistence.readCodeThread(decodeCodeThreadId(id));
      if (code !== undefined) return { projectId: String(code.projectId), mode: "code" };
      const work = deps.workThreadProjection.read(decodeWorkThreadId(id));
      return work === undefined ? undefined : { projectId: String(work.projectId), mode: "work" };
    },
  });
  configureSandboxRestrictionsAuthority(sandboxRestrictions);
  // Person memory is hydrated before any turn runs, so the first turn after
  // a start already carries what the person was remembered by.
  const personMemory = new PersonMemoryStore({
    connection: persistence.connection,
    journal: persistence.journal,
    uuid: randomUUID,
    clock: () => decodeUtcTimestamp(new Date().toISOString()),
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
  });
  const todos = new TodoStore({
    defaultActor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
    journal: persistence.journal,
    uuid: randomUUID,
    clock: () => decodeUtcTimestamp(new Date().toISOString()),
    // Read when the list is first read, not at start: a host that never opens
    // To-dos provisions nothing for it.
    hostId: () =>
      privateListenerHostId({
        connection: persistence.connection,
        dataDirectory: persistence.dataDirectory,
        identityFiles: options.serverIdentityFiles,
      }),
  });
  // The person's own instructions for Octant, hydrated before any turn runs
  // so the first turn after a start already carries them.
  const octantInstructions = new OctantInstructionsStore({
    journal: persistence.journal,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
    projectExists: (projectId) => persistence.readProject(decodeProjectId(projectId)) !== undefined,
  });
  const codeApprovalStore = new CodeOperationApprovalStore({
    uuid: randomUUID,
    now: Date.now,
    clampNow: processAuthorityNow,
  });
  // A paired device's service scope is its device id. Only a device still
  // paired counts: a revoked or expired one's prompts are answered by
  // nobody else and run out.
  const isPairedDeviceScope = (scopeId: WindowId): boolean =>
    isDeviceRegistrationCurrent(
      readDeviceRegistration(persistence.connection, String(scopeId)),
      Date.now(),
    );
  // A device the host's own person paired at Full is that person, so its turns
  // are not held to what a hub-introduced device's turns are: its prompts may
  // be remembered and its turns carry the person's memory, as a local window's
  // do. A device paired below Full is not the person, whatever its approval.
  const isRestrictedDeviceScope = createRestrictedDeviceScope({
    isPairedDeviceScope,
    approvedByPerson: (deviceId) => readDeviceApprovedByPerson(persistence.connection, deviceId),
    hasFullAccess: (deviceId) => readDeviceAccessLevel(persistence.connection, deviceId) === "full",
  });
  const isPairedDeviceSessionCurrent = (
    principal: {
      readonly deviceId: unknown;
      readonly sessionId: unknown;
      readonly credentialGeneration: number;
    },
    sessionNow?: () => number,
  ): boolean =>
    checkPairedDeviceSessionCurrent(persistence.connection, principal, (sessionNow ?? Date.now)());
  const isAuthenticatedPairedDeviceSessionCurrent = (
    principal: Extract<ClientPrincipal, { kind: "remote-device" }>,
    sessionNow?: () => number,
  ): boolean =>
    checkAuthenticatedPairedDeviceSessionCurrent(
      persistence.connection,
      principal,
      (sessionNow ?? Date.now)(),
    );
  const isPersonPairedDeviceCurrent = (
    deviceId: string,
    credentialGeneration: number,
    sessionId?: string,
  ): boolean => {
    const registration = readDeviceRegistration(persistence.connection, deviceId);
    if (
      registration === undefined ||
      !isDeviceRegistrationCurrent(registration, Date.now()) ||
      registration.credentialGeneration !== credentialGeneration ||
      !readDeviceApprovedByPerson(persistence.connection, deviceId) ||
      // Lowered below Full while its request waited: no longer the person.
      readDeviceAccessLevel(persistence.connection, deviceId) !== "full"
    ) {
      return false;
    }
    if (sessionId !== undefined) {
      const digest = createHash("sha256").update(sessionId).digest("hex");
      if (readRemoteSessionInvalidation(persistence.connection, digest) !== undefined) {
        return false;
      }
    }
    return true;
  };
  // Peer-delegated Work threads run under the host scope for a peer granted
  // one Project, so host-wide person memory is withheld from those threads and
  // any subagent they spawn — live before the first turn starts and rebuilt
  // from the delegation journal after a restart.
  const peerDelegatedThreads = new Set<string>(
    readReceivedDelegationThreadIds(persistence.journal),
  );
  const withholdThreadFromPersonMemory = (threadId: string): void => {
    peerDelegatedThreads.add(threadId);
  };
  const personMemoryAccess = createPersonMemoryAccess({
    store: personMemory,
    isRestrictedDeviceScope,
    isThreadWithheld: (threadId) => peerDelegatedThreads.has(threadId),
    projectLabel: (projectId) => persistence.readProject(decodeProjectId(projectId))?.name,
  });
  // The asks these services hold are not journaled when raised, so each says
  // so here and the paired phones' notifications, wired later, listen.
  const waitingAskAnnouncement: {
    notify?: (ask: { readonly threadId: string; readonly askId: string }) => void;
  } = {};
  const onWaitingAsk = (ask: { readonly threadId: string; readonly askId: string }): void =>
    waitingAskAnnouncement.notify?.(ask);
  const extensionToolApprovalService = new ExtensionToolApprovalService({
    uuid: randomUUID,
    onAsked: onWaitingAsk,
    now: processAuthorityTime,
    isPairedDeviceScope,
    // The thread must still be active and in the Project the prompt
    // recorded, which is what a paired device's turn was admitted under. A
    // prompt with no Project is a Chat thread's, which must still have none.
    threadAuthorityIsCurrent: (threadId, projectId) => {
      const chatThread = () => {
        try {
          return persistence.readChatThread(decodeChatThreadId(threadId));
        } catch {
          return undefined;
        }
      };
      if (projectId === undefined) return chatThreadStandsInProject(chatThread(), undefined);
      const project = persistence.readProject(decodeProjectId(projectId));
      if (project === undefined || project.lifecycle !== "active") return false;
      if (project.type !== "work" && project.type !== "code") {
        return chatThreadStandsInProject(chatThread(), projectId);
      }
      const authority = browserAuthority.resolve(decodeBrowserThreadId(threadId), project.type);
      return authority !== undefined && String(authority.projectId) === String(project.id);
    },
    // A usage-limit resume replays its stopped turn's extension selections as
    // the host, and a Chat turn the host sends with no window runs its tools
    // under this scope, so those prompts go to the windows that may drive the
    // thread, as a routine's browser prompts do.
    isHostScope: isRoutineHostScope,
    windowCanReachThread: (windowId, threadId, projectId) =>
      windowReachesPromptThread(
        { threadId, projectId },
        {
          readChatThread: (id) => {
            try {
              return persistence.readChatThread(decodeChatThreadId(id));
            } catch {
              return undefined;
            }
          },
          readProject: (id) => persistence.readProject(decodeProjectId(id)),
          windowDrivesProjectThread: (id, type, project) => {
            const thread = decodeBrowserThreadId(id);
            const authority = browserAuthority.resolve(thread, type);
            return (
              authority !== undefined &&
              String(authority.projectId) === project &&
              browserAuthority.canAccessWindow(windowId, thread, type)
            );
          },
        },
      ),
    onChanged: () => machineChangeFeed.publish(["tool-approvals"]),
  });
  // Routines a Work or Code thread's agent proposed, waiting for the window
  // whose turn raised them. A prompt like the tool approvals above, so it
  // rides the same change topic.
  const routineProposalService = new RoutineProposalService({
    onAsked: onWaitingAsk,
    uuid: randomUUID,
    now: processAuthorityTime,
    onChanged: () => machineChangeFeed.publish(["tool-approvals"]),
  });
  const speechGates = createSpeechGates();
  const threadNarration = new ThreadNarration();
  const threadTranscription = new ThreadTranscription();
  const serviceOffers = new ServiceOfferService<ServiceOffer, ServiceOfferAnswer>(
    MAX_PENDING_IMAGE_GENERATION_OFFERS,
    {
      onAsked: onWaitingAsk,
      uuid: randomUUID,
      now: processAuthorityTime,
      onChanged: () => machineChangeFeed.publish(["tool-approvals"]),
    },
  );
  const imageGenerationOffers = new ImageGenerationOfferService(serviceOffers);
  const videoOffers = new VideoOfferService(serviceOffers);
  // An ask waits with no expiry, so a thread archived while its turn is
  // still parked on one must give it up here. Later areas register the asks
  // they hold, as they register window revocations below.
  const threadArchivals: Array<(threadId: string) => void> = [
    (id) => extensionToolApprovalService.withdrawThread(id),
    (id) => routineProposalService.withdrawThread(id),
    (id) => serviceOffers.withdrawThread(id),
    (id) => threadNarration.forget(id),
    (id) => threadTranscription.forget(id),
  ];
  const onThreadArchived = (withdraw: (threadId: string) => void): void => {
    threadArchivals.push(withdraw);
  };
  onThreadArchived((threadId) => sandboxRestrictions.revokeSession(threadId));
  const unsubscribeThreadArchivals = persistence.journal.subscribeCommitted((append) => {
    for (const threadId of threadsArchivedBy(append)) {
      for (const withdraw of threadArchivals) {
        try {
          withdraw(threadId);
        } catch {
          // One area that cannot give up its asks does not keep the others'.
        }
      }
    }
  });
  // One Automation event store for the host: the Automation area writes
  // definitions and runs through it, and a Work or Code run's own turn
  // reports its result through it, so both share one append path.
  const automationEventStore = new AutomationEventStore({
    journal: persistence.journal,
    uuid: randomUUID,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
  });
  const codeSessionAuthority = new CodeSessionAuthorityStore();
  const agentRunExecutionWindows = new Map<
    AgentRun["requestId"],
    {
      readonly windowId: WindowId;
      readonly parentThreadId: AgentRun["parentThreadId"];
    }
  >();
  const onAgentRunExecutionAccepted: NonNullable<
    AgentRunControlAdmissionDependencies["onExecutionAccepted"]
  > = ({ run, windowId, operation }) => {
    const previous = agentRunExecutionWindows.get(run.requestId);
    if (
      previous !== undefined &&
      (operation === "admission" || String(previous.parentThreadId) !== String(run.parentThreadId))
    )
      return;
    agentRunExecutionWindows.set(run.requestId, {
      windowId: decodeWindowId(windowId),
      parentThreadId: run.parentThreadId,
    });
  };
  // A child is admitted under the posture its parent's running turn holds, so
  // a turn narrowed to Plan cannot hand a child the thread's wider grant. The
  // Code runtime, built much later, keeps its running turns here; this area
  // only reads a turn's posture from them.
  const codeActiveTurns: CodeActiveTurns = new Map();
  const codeParentActiveTurn = codeParentActiveTurnFrom(
    options.codeOperationRuntime,
    codeActiveTurns,
  );
  const agentRunParentAuthority = (run: AgentRun) =>
    boundAgentRunLiveAuthority({
      persistence,
      run,
      activeTurn: codeParentActiveTurn,
      executionWindows: agentRunExecutionWindows,
      codeSessionAuthority,
      windowAuthorityStore,
      readWorkThread: (threadId) => workThreadProjection.read(threadId),
    });
  const browserCaptureStore = new BrowserCaptureStore(persistence.dataDirectory);
  const browserCaptures = new BrowserCaptureService({
    store: browserCaptureStore,
    journal: persistence.journal,
    connection: persistence.connection,
    personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
    capturesPerThread: () =>
      (persistence.readShellSettings()?.settings ?? defaultShellSettings())
        .browserCapturesPerThread,
  });
  const browserModelBindings = new Map<string, BrowserModelBinding>();
  // Each area that holds per-window state registers its revocation here when
  // it builds the service, so the window store never holds a later area's
  // service. A revocation that arrives before an area registers finds nothing
  // to revoke, as before.
  const windowRevocations: Array<(windowId: WindowId) => void> = [];
  const onWindowRevoked = (revoke: (windowId: WindowId) => void): void => {
    windowRevocations.push(revoke);
  };
  const windowAuthorityStore = new WindowAuthorityStore(
    (windowId) => {
      const notified = notifyWindowRevocations(windowId, [
        (id) => codeApprovalStore.revokeWindow(id),
        (id) => simulatorInputGrants.revokeWindow(String(id)),
        (id) => androidInputGrants.revokeWindow(String(id)),
        (id) => extensionToolApprovalService.revokeWindow(id),
        (id) => routineProposalService.revokeWindow(id),
        (id) => serviceOffers.revokeWindow(id),
        (id) => threadNarration.revokeWindow(id),
        (id) => threadTranscription.revokeWindow(id),
        (id) => codeSessionAuthority.revokeWindow(id),
        (id) => {
          for (const [requestId, binding] of agentRunExecutionWindows) {
            if (String(binding.windowId) === String(id)) agentRunExecutionWindows.delete(requestId);
          }
        },
        ...windowRevocations,
      ]);
      if (notified.kind === "failed")
        throw new Error("Octant could not notify every revoked window owner.");
    },
    {
      clampNow: processAuthorityNow,
    },
  );
  const personMemoryRoutes = createPersonMemoryRouteHandler({
    store: personMemory,
    windowAuthorityStore,
  });
  const sandboxRestrictionsRoutes = createSandboxRestrictionsRoutes({
    service: sandboxRestrictions,
    windowAuthorityStore,
  });
  const todoRoutes = createTodoRouteHandler({
    store: todos,
    feed: machineChangeFeed,
    windowAuthorityStore,
  });
  const octantInstructionsRoutes = createOctantInstructionsRouteHandler({
    store: octantInstructions,
    windowAuthorityStore,
  });
  const protectedFilesRoutes = createProtectedFilesRouteHandler({
    service: protectedFiles,
    windowAuthorityStore,
  });
  const agentRunEventStore = new AgentRunEventStore({
    journal: persistence.journal,
    uuid: randomUUID,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
  });
  const agentRunPersistence = new AgentRunPersistenceService({
    store: agentRunEventStore,
    projection: persistence.agentRunProjection,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
    connection: persistence.connection,
  });
  // Restart continuation decides, once the rest of the host is wired, which
  // of these the host resumes by itself (wiring/continuation.ts).
  const agentRunsCutOffByRestart = agentRunPersistence.reconcileAfterRestart();
  // Every tool call about to take effect, on every provider, so a restart
  // can tell a turn it cut off between calls from one it cut off inside one.
  const toolEffectLedger = new ToolEffectLedger({
    journal: persistence.journal,
    uuid: randomUUID,
    actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
    clock: () => new Date().toISOString(),
  });
  return {
    agentRunParentAuthority,
    agentRunPersistence,
    agentRunsCutOffByRestart,
    toolEffectLedger,
    androidInputGrants,
    automationEventStore,
    bindingReceiptStore,
    browserCaptureStore,
    browserCaptures,
    browserModelBindings,
    codeActiveTurns,
    codeApprovalStore,
    codeParentActiveTurn,
    codeSessionAuthority,
    extensionToolApprovalService,
    routineProposalService,
    imageGenerationOffers,
    videoOffers,
    serviceOffers,
    speechGates,
    threadNarration,
    threadTranscription,
    isPairedDeviceScope,
    isRestrictedDeviceScope,
    isPairedDeviceSessionCurrent,
    isAuthenticatedPairedDeviceSessionCurrent,
    isPersonPairedDeviceCurrent,
    liveTurns,
    machineChangeFeed,
    onAgentRunExecutionAccepted,
    agentRunRequestOwner: (run: AgentRun): string | undefined => {
      const binding = agentRunExecutionWindows.get(run.requestId);
      return binding !== undefined && String(binding.parentThreadId) === String(run.parentThreadId)
        ? String(binding.windowId)
        : undefined;
    },
    processAuthorityNow,
    onThreadArchived,
    onWaitingAsk,
    waitingAskAnnouncement,
    processAuthorityTime,
    onWindowRevoked,
    personMemory,
    personMemoryAccess,
    personMemoryRoutes,
    withholdThreadFromPersonMemory,
    octantInstructions,
    octantInstructionsRoutes,
    protectedFilesRoutes,
    sandboxRestrictions,
    sandboxRestrictionsRoutes,
    simulatorInputGrants,
    todoRoutes,
    todos,
    unsubscribeMachineChanges,
    unsubscribeThreadArchivals,
    windowAuthorityStore,
  };
}

export type AuthorityWiring = ReturnType<typeof wireAuthority>;
