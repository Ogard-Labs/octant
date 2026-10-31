import { randomUUID } from "node:crypto";
import {
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeProjectId,
  decodeWorkThreadId,
  type ProviderInstance,
  type WindowId,
} from "@octant/contracts";
import { resolveThreadWorkingDirectory } from "../threadWorkingDirectoryAuthority";
import { chatImageScopeAllowedForWindow } from "../image/imageScopeAuthority";
import { SessionCompactionService } from "../context/sessionCompaction";
import { createContextRouteHandler } from "../contextRoutes";
import { windowCanOpenProject } from "../projectOpenAuthority";
import { createBrowserAutomationRouteHandler } from "../browserAutomationRoutes";
import { createAgentMessageRouteHandler } from "../agentMessage/agentMessageRoutes";
import { defaultShellSettings, enabledModes, providerKeepsConversation } from "@octant/domain";
import { runtimeAnsweredCapabilities } from "@octant/domain/provider-runtime-integration";
import { makeConfiguredProviderDriver, type ProvidersWiring } from "./providers";
import { MAX_JSON_REQUEST_BODY_SIZE, type ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { FoundationsWiring } from "./foundations";
import type { AgentRunsWiring } from "./agentRuns";
import type { IntegrationsWiring } from "./integrations";
import type { WorkspaceWiring } from "./workspace";
import type { CodeWiring } from "./code";
import type { BrowserWiring } from "./browser";
import type { CodeRuntimeWiring } from "./codeRuntime";
import type { ChatWiring } from "./chat";
import type { WorkWiring } from "./work";
import type { HarnessWiring } from "./harness";

export type ContextDependencies = Pick<ServerStart, "persistence"> &
  Pick<AuthorityWiring, "browserCaptures" | "windowAuthorityStore"> &
  Pick<AgentRunsWiring, "capacityScheduler"> &
  Pick<HarnessWiring, "nativeHarnessHooks"> &
  Pick<IntegrationsWiring, "agentMessageProjection"> &
  Pick<WorkspaceWiring, "contextHarness" | "projectService" | "spendCeilingService"> &
  Pick<CodeWiring, "canAccessCodeProject"> &
  Pick<ProvidersWiring, "configuredDriverOptions"> &
  Pick<
    BrowserWiring,
    | "browserAutomationService"
    | "browserExtensionService"
    | "browserProfileService"
    | "browserToolApprovalService"
    | "liveProjectBrowsers"
  > &
  Pick<CodeRuntimeWiring, "codeOperationRuntime" | "routeCodeService"> &
  Pick<ChatWiring, "chatService"> &
  Pick<WorkWiring, "workThreadService" | "workTurnService"> &
  Pick<
    FoundationsWiring,
    "providerRuntimeRegistry" | "workThreadProjection" | "workTurnProjection"
  > &
  Pick<FoundationsWiring, "browserAuthority">;

export function wireContext(deps: ContextDependencies) {
  const {
    agentMessageProjection,
    browserAuthority,
    browserAutomationService,
    browserCaptures,
    browserToolApprovalService,
    canAccessCodeProject,
    capacityScheduler,
    chatService,
    codeOperationRuntime,
    configuredDriverOptions,
    contextHarness,
    liveProjectBrowsers,
    browserExtensionService,
    browserProfileService,
    nativeHarnessHooks,
    persistence,
    projectService,
    providerRuntimeRegistry,
    routeCodeService,
    spendCeilingService,
    windowAuthorityStore,
    workThreadProjection,
    workThreadService,
    workTurnProjection,
    workTurnService,
  } = deps;

  // Which threads a window can open, archived ones included. What a thread
  // kept (generated images, Browser captures) is read under this rather than
  // under a live tool authority, which an archived thread no longer has.
  const windowCanOpenThread = async (
    windowId: WindowId,
    threadKind: "chat-thread" | "work-thread" | "code-thread",
    threadId: string,
  ): Promise<boolean> => {
    try {
      if (threadKind === "chat-thread") {
        const view = chatService.read(decodeChatThreadId(threadId));
        const workspace = persistence.readWindowWorkspace(windowId)?.workspace;
        return chatImageScopeAllowedForWindow({
          chatContext: workspace?.contextByMode.chat,
          thread: view?.thread,
        });
      }
      if (threadKind === "work-thread") {
        const bootstrap = await workThreadService.bootstrap(windowId);
        return bootstrap.threads.some((thread) => String(thread.id) === threadId);
      }
      const view = await routeCodeService.read(windowId, decodeCodeThreadId(threadId));
      return view !== undefined;
    } catch {
      return false;
    }
  };
  // The same rule for a caller that holds only a thread id (a capture, an
  // agent message). The projections say which kind of thread it is, so one
  // check runs instead of all three on every read.
  const windowCanOpenThreadById = async (
    windowId: WindowId,
    threadId: string,
  ): Promise<boolean> => {
    const id = String(threadId);
    let threadKind: "chat-thread" | "work-thread" | "code-thread" | undefined;
    try {
      if (persistence.readChatThread(decodeChatThreadId(id)) !== undefined) {
        threadKind = "chat-thread";
      } else if (persistence.readCodeThread(decodeCodeThreadId(id)) !== undefined) {
        threadKind = "code-thread";
      } else if (workThreadProjection.read(decodeWorkThreadId(id)) !== undefined) {
        threadKind = "work-thread";
      }
    } catch {
      return false;
    }
    return threadKind !== undefined && (await windowCanOpenThread(windowId, threadKind, id));
  };
  // Which Projects a window can open, by the rule its threads are opened by.
  const windowCanOpenProjectById = async (
    windowId: WindowId,
    projectId: string,
  ): Promise<boolean> => {
    try {
      return windowCanOpenProject({
        project: persistence.readProject(decodeProjectId(projectId)),
        chatContext: persistence.readWindowWorkspace(windowId)?.workspace.contextByMode.chat,
        canAccessCodeProject: (id) => canAccessCodeProject(windowId, id),
      });
    } catch {
      return false;
    }
  };
  // No route serves yet, so any compaction still running belongs to a host
  // process that has gone. A journal it cannot read must not keep the host
  // from starting: the compaction stays running, which refuses another one
  // on that thread, and every other surface still serves. The error is not
  // logged because a parse failure can quote the payload, which holds the
  // thread's identifiers.
  try {
    contextHarness.closeInterruptedCompactions();
  } catch {
    console.error("[context-compaction] Interrupted compactions could not be closed.");
  }
  const modeEnabled = (mode: "chat" | "work") =>
    enabledModes(persistence.readShellSettings()?.settings ?? defaultShellSettings()).includes(
      mode,
    );
  const modelSwitchSupported = (providerInstanceId: ProviderInstance["id"]) =>
    providerRuntimeRegistry.observedState(providerInstanceId)?.capabilities.modelSwitch ===
    "supported";
  // The native session a Chat or Work thread's next turn would resume, read
  // as that turn's admission reads it: the thread's provider, its model or one
  // the provider can carry the session on to, and a cursor to resume from.
  const chatRuntimeSession = (threadId: string) => {
    const id = decodeChatThreadId(threadId);
    const thread = persistence.readChatThread(id);
    const attempt = persistence.readChatThreadView(id)?.turns.at(-1)?.attempts.at(-1);
    const resumeCursor = attempt?.resumeCursor;
    if (
      thread === undefined ||
      attempt === undefined ||
      resumeCursor === undefined ||
      String(attempt.providerInstanceId) !== String(thread.providerInstanceId) ||
      (String(attempt.modelId) !== String(thread.modelId) &&
        !modelSwitchSupported(thread.providerInstanceId))
    ) {
      return undefined;
    }
    return { thread, sessionId: attempt.providerSessionId, resumeCursor };
  };
  const workRuntimeSession = (threadId: string) => {
    const id = decodeWorkThreadId(threadId);
    const thread = workThreadProjection.read(id);
    const latest = workTurnProjection.latestForThread(id);
    const sessionId = latest?.providerSessionId;
    const resumeCursor = latest?.resumeCursor;
    if (
      thread === undefined ||
      latest === undefined ||
      sessionId === undefined ||
      resumeCursor === undefined ||
      String(latest.authority.providerInstanceId) !== String(thread.providerInstanceId) ||
      latest.authority.bindingRevisionId !== thread.bindingRevisionId ||
      (String(latest.authority.modelId) !== String(thread.modelId) &&
        !modelSwitchSupported(thread.providerInstanceId))
    ) {
      return undefined;
    }
    return {
      thread,
      workingDirectory: latest.authority.workingDirectory,
      sessionId,
      resumeCursor,
    };
  };
  const codeCompactionSessions = codeOperationRuntime?.compactionSessions;
  const sessionCompaction = new SessionCompactionService({
    harness: contextHarness,
    threads: {
      "chat-thread": {
        read: (threadId) => {
          const thread = persistence.readChatThread(decodeChatThreadId(threadId));
          return thread === undefined ||
            thread.lifecycle === "deleting" ||
            thread.lifecycle === "deleted"
            ? undefined
            : {
                mode: "chat",
                ...(thread.projectId === undefined ? {} : { projectId: String(thread.projectId) }),
                providerInstanceId: thread.providerInstanceId,
                modelId: thread.modelId,
                ...(thread.modelOptionValues === undefined
                  ? {}
                  : { modelOptionValues: thread.modelOptionValues }),
              };
        },
        turnRunning: (threadId) =>
          chatService.isTurnActive(decodeChatThreadId(threadId)) ||
          chatService.isTurnStarting(decodeChatThreadId(threadId)),
        // The check every Chat turn makes first: the thread must be active.
        turnRefusal: (threadId) => chatService.turnStandingRefusal(decodeChatThreadId(threadId)),
        conversation: (threadId) =>
          chatService.sessionCompactionConversation(decodeChatThreadId(threadId)),
        scratchRoot: (threadId) => chatService.scratchRoot(decodeChatThreadId(threadId)),
        runtimeSessions: {
          exists: (threadId) => chatRuntimeSession(threadId) !== undefined,
          open: async (threadId) => {
            const session = chatRuntimeSession(threadId);
            if (session === undefined) return undefined;
            const { thread } = session;
            return {
              acquire: {
                instanceId: thread.providerInstanceId,
                projectRoot: await chatService.scratchRoot(thread.id),
                mode: "chat",
              },
              resume: {
                sessionId: session.sessionId,
                resumeCursor: session.resumeCursor,
                // The posture every Chat turn runs under; the compaction
                // offers no tool at all.
                executionPolicy: "approval-gated",
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
      },
      "work-thread": {
        read: (threadId) => {
          const thread = workThreadProjection.read(decodeWorkThreadId(threadId));
          if (
            thread === undefined ||
            thread.lifecycle === "deleting" ||
            thread.lifecycle === "deleted"
          ) {
            return undefined;
          }
          // The policy a Work turn on this thread is admitted under. A thread
          // whose Project cannot be read has no policy to check, so it has no
          // session to compact: an unreadable Project never reads as "no
          // policy, allowed".
          const project = persistence.readProject(thread.projectId);
          if (project === undefined || project.type !== "work") return undefined;
          const providerPolicy = project.providerPolicy;
          return {
            mode: "work",
            projectId: String(thread.projectId),
            providerInstanceId: thread.providerInstanceId,
            modelId: thread.modelId,
            ...(providerPolicy === undefined ? {} : { providerPolicy }),
            ...(thread.modelOptionValues === undefined
              ? {}
              : { modelOptionValues: thread.modelOptionValues }),
          };
        },
        // The decision a Work turn passes for its Project and binding.
        turnRefusal: (threadId) => {
          const thread = workThreadProjection.read(decodeWorkThreadId(threadId));
          return thread === undefined ? undefined : workTurnService.turnStandingRefusal(thread);
        },
        turnRunning: (threadId) =>
          workTurnService.isTurnActive(decodeWorkThreadId(threadId)) ||
          workTurnService.isTurnStarting(decodeWorkThreadId(threadId)),
        conversation: (threadId) =>
          workTurnService.sessionCompactionConversation(decodeWorkThreadId(threadId)),
        // The Work stream is fed in process; the Chat stream reads the
        // journaled outcome itself.
        settled: (threadId, compaction) =>
          workTurnService.compactionSettled(decodeWorkThreadId(threadId), compaction),
        // A Work turn's provider session starts in the bound root; the
        // tool-free summary request starts there too and gains nothing.
        scratchRoot: async (threadId) => {
          const thread = workThreadProjection.read(decodeWorkThreadId(threadId));
          const project =
            thread === undefined ? undefined : persistence.readProject(thread.projectId);
          if (project === undefined || !("binding" in project)) {
            throw new Error("Work project is unavailable.");
          }
          return project.binding.canonicalRoot;
        },
        runtimeSessions: {
          exists: (threadId) => workRuntimeSession(threadId) !== undefined,
          open: async (threadId) => {
            const session = workRuntimeSession(threadId);
            if (session === undefined) return undefined;
            const { thread } = session;
            const project = persistence.readProject(thread.projectId);
            if (project?.type !== "work") return undefined;
            return {
              acquire: {
                instanceId: thread.providerInstanceId,
                // The folder the session's turns ran in, inside the bound root.
                projectRoot: await resolveThreadWorkingDirectory(
                  project.binding.canonicalRoot,
                  session.workingDirectory,
                ),
                mode: "work",
              },
              resume: {
                sessionId: session.sessionId,
                resumeCursor: session.resumeCursor,
                // Never the thread's auto-accept: the compaction edits nothing.
                executionPolicy: "approval-gated",
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
      },
      ...(codeCompactionSessions === undefined
        ? {}
        : {
            "code-thread": {
              read: (threadId) => {
                const thread = persistence.readCodeThread(decodeCodeThreadId(threadId));
                if (thread === undefined || thread.lifecycle !== "active") return undefined;
                // A Code turn passes its Project's provider policy, so the
                // compaction passes the same one.
                const project = persistence.readProject(thread.projectId);
                if (project?.type !== "code") return undefined;
                const providerPolicy = project.providerPolicy;
                return {
                  mode: "code",
                  projectId: String(thread.projectId),
                  providerInstanceId: thread.providerInstanceId,
                  modelId: thread.modelId,
                  ...(providerPolicy === undefined ? {} : { providerPolicy }),
                  ...(thread.modelOptionValues === undefined
                    ? {}
                    : { modelOptionValues: thread.modelOptionValues }),
                };
              },
              turnRunning: (threadId) => codeOperationRuntime?.turnInProgress?.(threadId) === true,
              // A Code turn's Project access holds only for an active Code
              // Project, the rule its window check applies.
              turnRefusal: (threadId) => {
                const thread = persistence.readCodeThread(decodeCodeThreadId(threadId));
                return thread !== undefined &&
                  !projectService.hasActiveProject(thread.projectId, "code")
                  ? "project-unavailable"
                  : undefined;
              },
              runtimeSessions: {
                exists: codeCompactionSessions.exists,
                occupancy: codeCompactionSessions.occupancy,
                open: codeCompactionSessions.open,
              },
            },
          }),
    },
    modeEnabled,
    // The admission every Chat, Work and Code turn asks of the harness.
    harnessAdmission: (scope) =>
      nativeHarnessHooks.admitTurn({
        threadId: scope.threadId,
        mode: scope.mode,
        providerInstanceId: scope.providerInstanceId,
        modelId: scope.modelId,
        ...(scope.projectId === undefined ? {} : { projectId: decodeProjectId(scope.projectId) }),
      }).kind === "paused"
        ? "paused"
        : "admitted",
    conversationOwner: (providerInstanceId) => {
      const instance = persistence.readProviderInstance(providerInstanceId);
      if (instance === undefined) return undefined;
      return providerKeepsConversation(instance.driverKind) ? "runtime" : "host";
    },
    // What the adapter reported for this install; an instance the host has
    // not observed yet, or one not ready to report (a signed-out Claude lists
    // no capabilities), is undefined, so it reads as unavailable, not unable.
    runtimeCompaction: (providerInstanceId, mode) => {
      const observed = providerRuntimeRegistry.observedState(providerInstanceId);
      if (observed === undefined) return undefined;
      const answer = observed.capabilities.sessionCompaction?.[mode];
      if (answer !== undefined) return answer;
      return runtimeAnsweredCapabilities(observed.readiness) ? "unsupported" : undefined;
    },
    providerFacts: (providerInstanceId, modelId) => {
      const provider = persistence.readProviderInstance(providerInstanceId);
      if (provider === undefined) return undefined;
      const model = persistence
        .readProviderCatalog?.(providerInstanceId)
        ?.models.find((candidate) => String(candidate.id) === String(modelId));
      return { provider, ...(model === undefined ? {} : { model }) };
    },
    availableDriver: (providerInstanceId) => {
      const instance = persistence.readProviderInstance(providerInstanceId);
      if (instance === undefined || !instance.enabled) return undefined;
      const readiness = providerRuntimeRegistry.observedState(providerInstanceId)?.readiness;
      if (
        readiness === "unavailable" ||
        readiness === "unauthenticated" ||
        readiness === "incompatible"
      ) {
        return undefined;
      }
      try {
        return makeConfiguredProviderDriver(instance, configuredDriverOptions);
      } catch {
        return undefined;
      }
    },
    capacity: capacityScheduler,
    spendCeiling: spendCeilingService,
    uuid: randomUUID,
  });
  const contextRoutes = createContextRouteHandler({
    service: {
      inspect: (subject, afterSequence, principal) =>
        sessionCompaction.inspect(subject, afterSequence, principal),
      execute: (command, principal, windowId) =>
        command.kind === "compact-session"
          ? sessionCompaction.start(command, principal, windowId)
          : contextHarness.execute(command),
      compactionState: (subject, principal) => sessionCompaction.state(subject, principal),
    },
    windowCanOpenThread,
    windowCanOpenProject: windowCanOpenProjectById,
    windowAuthorityStore,
    maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
  });
  const browserAutomationRoutes = createBrowserAutomationRouteHandler({
    service: browserAutomationService,
    captures: browserCaptures,
    windowCanOpenThread: windowCanOpenThreadById,
    projectBrowsers: liveProjectBrowsers,
    profiles: browserProfileService,
    extensions: browserExtensionService,
    authority: browserAuthority,
    approvals: browserToolApprovalService,
    windowAuthorityStore,
    maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
  });
  const agentMessageRoutes = createAgentMessageRouteHandler({
    windowAuthorityStore,
    projection: agentMessageProjection,
    windowCanOpenThread: windowCanOpenThreadById,
  });
  return {
    agentMessageRoutes,
    browserAutomationRoutes,
    contextRoutes,
    windowCanOpenThread,
  };
}

export type ContextWiring = ReturnType<typeof wireContext>;
