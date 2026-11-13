import { notifyWindowRevocations } from "../windowRevocations";
import { randomUUID } from "node:crypto";
import {
  type AgentRun,
  decodeChatThreadId,
  decodeProjectId,
  decodeWindowId,
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
import { ProcessAuthorityClock } from "../processAuthorityClock";
import { readDeviceRegistration } from "../persistence/remoteAccessProjection";
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
import { PersonMemoryStore } from "../personMemory/personMemoryStore";
import { ProtectedFilesService } from "../protectedFilesService";
import { createProtectedFilesRouteHandler } from "../protectedFilesRoutes";
import { ExtensionToolApprovalService } from "../extensions/extensionToolApprovalService";
import { AutomationEventStore } from "../automation/automationEventStore";
import { RoutineProposalService } from "../automation/routineProposalService";
import { ImageGenerationOfferService } from "../image/imageGenerationOfferService";
import {
  chatThreadStandsInProject,
  isDeviceRegistrationCurrent,
} from "../extensions/pairedDeviceApprovalAuthority";
import type { BrowserModelBinding } from "../browser/browserAppManagedTools";
import { BrowserCaptureService } from "../browser/browserCaptureService";
import { BrowserCaptureStore } from "../browser/browserCaptureStore";
import { SimulatorInputGrants } from "../apple/simulatorInputGrants";
import { threadsArchivedBy } from "../threadArchiveWatch";
import type { ServerStart } from "./serverShape";
import type { FoundationsWiring } from "./foundations";

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
  Pick<FoundationsWiring, "browserAuthority">;

export function wireAuthority(deps: AuthorityDependencies) {
  const { browserAuthority, options, persistence } = deps;

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
  // Person memory is hydrated before any turn runs, so the first turn after
  // a start already carries what the person was remembered by.
  const personMemory = new PersonMemoryStore({
    connection: persistence.connection,
    journal: persistence.journal,
    uuid: randomUUID,
    clock: () => decodeUtcTimestamp(new Date().toISOString()),
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
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
  const personMemoryAccess = createPersonMemoryAccess({
    store: personMemory,
    isPairedDeviceScope,
    isHostScope: isRoutineHostScope,
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
    // A usage-limit resume replays its stopped Work turn's extension
    // selections as the host, so that turn's tool prompts go to the windows
    // bound to the thread's Project, as a routine's browser prompts do.
    isHostScope: isRoutineHostScope,
    // Routed by the Project the prompt recorded, never by trying each mode:
    // Work and Code thread ids are separate namespaces, so a raw id alone
    // could match an unrelated thread another window may drive.
    windowCanReachThread: (windowId, threadId, projectId) => {
      if (projectId === undefined) return false;
      const project = persistence.readProject(decodeProjectId(projectId));
      if (project === undefined || (project.type !== "work" && project.type !== "code")) {
        return false;
      }
      const thread = decodeBrowserThreadId(threadId);
      const authority = browserAuthority.resolve(thread, project.type);
      return (
        authority !== undefined &&
        String(authority.projectId) === String(project.id) &&
        browserAuthority.canAccessWindow(windowId, thread, project.type)
      );
    },
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
  // Image generations an agent asked the person to start, answered from a
  // card in the thread. A prompt like the routine proposals above, so it
  // rides the same change topic.
  const imageGenerationOffers = new ImageGenerationOfferService({
    onAsked: onWaitingAsk,
    uuid: randomUUID,
    now: processAuthorityTime,
    onChanged: () => machineChangeFeed.publish(["tool-approvals"]),
  });
  // An ask waits with no expiry, so a thread archived while its turn is
  // still parked on one must give it up here. Later areas register the asks
  // they hold, as they register window revocations below.
  const threadArchivals: Array<(threadId: string) => void> = [
    (id) => extensionToolApprovalService.withdrawThread(id),
    (id) => routineProposalService.withdrawThread(id),
    (id) => imageGenerationOffers.withdrawThread(id),
  ];
  const onThreadArchived = (withdraw: (threadId: string) => void): void => {
    threadArchivals.push(withdraw);
  };
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
    });
  const browserCaptureStore = new BrowserCaptureStore(persistence.dataDirectory);
  const browserCaptures = new BrowserCaptureService({
    store: browserCaptureStore,
    journal: persistence.journal,
    connection: persistence.connection,
    personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
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
        (id) => imageGenerationOffers.revokeWindow(id),
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
  return {
    agentRunParentAuthority,
    agentRunPersistence,
    agentRunsCutOffByRestart,
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
    isPairedDeviceScope,
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
    protectedFilesRoutes,
    simulatorInputGrants,
    unsubscribeMachineChanges,
    unsubscribeThreadArchivals,
    windowAuthorityStore,
  };
}

export type AuthorityWiring = ReturnType<typeof wireAuthority>;
