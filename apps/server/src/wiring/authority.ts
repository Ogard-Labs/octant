import { randomUUID } from "node:crypto";
import {
  type AgentRun,
  decodeChatThreadId,
  decodeProjectId,
  decodeWindowId,
  type WindowId,
} from "@octant/contracts";
import { boundAgentRunLiveAuthority } from "../agentRun/authorizeAgentRunCreation";
import { DurableBindingReceiptStore } from "../bindingReceiptStore";
import { MachineChangeFeed } from "../machineChangeFeed";
import { decodeBrowserThreadId } from "@octant/contracts/browser-automation";
import { LiveTurnRegistry } from "../liveTurn/liveTurnRegistry";
import { CodeOperationApprovalStore } from "../code/codeOperationApprovalStore";
import { CodeSessionAuthorityStore } from "../code/codeSessionAuthorityStore";
import { ProcessAuthorityClock } from "../processAuthorityClock";
import { readDeviceRegistration } from "../persistence/remoteAccessProjection";
import { AgentRunEventStore } from "../agentRun/agentRunEventStore";
import { AgentRunPersistenceService } from "../agentRun/agentRunPersistenceService";
import type { AgentRunControlAdmissionDependencies } from "../agentRun/agentRunControlAdmission";
import { isRoutineHostScope } from "../routineHostScope";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { ExtensionToolApprovalService } from "../extensions/extensionToolApprovalService";
import {
  chatThreadStandsInProject,
  isDeviceRegistrationCurrent,
} from "../extensions/pairedDeviceApprovalAuthority";
import type { BrowserModelBinding } from "../browser/browserAppManagedTools";
import { BrowserCaptureService } from "../browser/browserCaptureService";
import { BrowserCaptureStore } from "../browser/browserCaptureStore";
import { ServerBrowserAuthorityResolver } from "../browser/browserAuthorityResolver";
import { SimulatorInputGrants } from "../apple/simulatorInputGrants";
import type { ServerStart } from "./serverShape";

export type AuthorityDependencies = Pick<ServerStart, "persistence"> & {
  /** Wired by wireBrowser; read only after startup. */
  readonly browserAuthority: () => ServerBrowserAuthorityResolver;
};

export function wireAuthority(deps: AuthorityDependencies) {
  const { browserAuthority, persistence } = deps;

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
  const extensionToolApprovalService = new ExtensionToolApprovalService({
    uuid: randomUUID,
    now: Date.now,
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
      const authority = browserAuthority().resolve(decodeBrowserThreadId(threadId), project.type);
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
      const authority = browserAuthority().resolve(thread, project.type);
      return (
        authority !== undefined &&
        String(authority.projectId) === String(project.id) &&
        browserAuthority().canAccessWindow(windowId, thread, project.type)
      );
    },
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
    if (run.routingReceipt.mode !== "code") return;
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
  const agentRunParentAuthority = (run: AgentRun) =>
    boundAgentRunLiveAuthority({
      persistence,
      run,
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
      codeApprovalStore.revokeWindow(windowId);
      simulatorInputGrants.revokeWindow(String(windowId));
      androidInputGrants.revokeWindow(String(windowId));
      extensionToolApprovalService.revokeWindow(windowId);
      codeSessionAuthority.revokeWindow(windowId);
      for (const [requestId, binding] of agentRunExecutionWindows) {
        if (String(binding.windowId) === String(windowId))
          agentRunExecutionWindows.delete(requestId);
      }
      for (const revoke of windowRevocations) revoke(windowId);
    },
    {
      clampNow: processAuthorityNow,
    },
  );
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
  agentRunPersistence.reconcileAfterRestart();
  return {
    agentRunParentAuthority,
    agentRunPersistence,
    androidInputGrants,
    bindingReceiptStore,
    browserCaptureStore,
    browserCaptures,
    browserModelBindings,
    codeApprovalStore,
    codeSessionAuthority,
    extensionToolApprovalService,
    isPairedDeviceScope,
    liveTurns,
    machineChangeFeed,
    onAgentRunExecutionAccepted,
    processAuthorityNow,
    onWindowRevoked,
    simulatorInputGrants,
    unsubscribeMachineChanges,
    windowAuthorityStore,
  };
}

export type AuthorityWiring = ReturnType<typeof wireAuthority>;
