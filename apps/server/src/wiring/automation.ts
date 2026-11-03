import { secretGuardRefusal } from "../process/secretGuard";
import { joinWorkPath } from "../work/workPathConfinement";
import { revalidateAutomationAuthority } from "../automation/automationAuthorityRevalidation";
import { randomUUID } from "node:crypto";
import { Schema } from "effect";
import { AutomationFileSources } from "../automation/automationFileSources";
import {
  prepareAutomationFileDefinition,
  resolveAutomationFileSourceAuthority,
} from "../automation/automationFileSourceAuthority";
import { captureAutomationDefinitionSnapshot } from "../automation/automationRunIdentity";
import { readAutomationFileSourceActivity } from "../automation/automationFileSourceActivity";
import { liveWorkFilesystem } from "../work/workFilesystemPort";
import { liveWorkFileWatchPort } from "../work/workFileWatchPort";
import type { HarnessWiring } from "./harness";
import {
  AutomationDefinitionSnapshot,
  decodeAutomationRunId,
  decodeAgentRunParentThreadId,
  type CapacityReservationId,
  type AutomationRun,
  type CodeThreadId,
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeWorkThreadId,
  LOCAL_HOST_ID,
  type UtcTimestamp,
  type WorkThreadId,
} from "@octant/contracts";
import {
  type CompletedThreadArchiveInput,
  CompletedThreadArchiveSweep,
} from "../completedThreadArchiveSweep";
import { AutomationCommandService } from "../automation/automationCommandService";
import {
  automationCodeEvidenceFromText,
  createAutomationCodeDispatchPort,
} from "../automation/automationCodeDispatchPort";
import { createAutomationChatDispatchPort } from "../automation/automationChatDispatchPort";
import { createAutomationWorkDispatchPort } from "../automation/automationWorkDispatchPort";
import { AutomationDispatchService } from "../automation/automationDispatchService";
import { AutomationEventStore } from "../automation/automationEventStore";
import { hydrateAutomationProjection } from "../automation/automationProjection";
import { createAutomationRouteHandler } from "../automation/automationRoutes";
import { AutomationSchedulerService } from "../automation/automationSchedulerService";
import { createRoutineProposalTools } from "../automation/routineProposalTools";
import { buildThreadRoutineDraft } from "../automation/threadRoutineDraft";
import { isRoutineHostScope } from "../routineHostScope";
import {
  resolveAutomationAuthorityLiveFacts,
  type ResolveAutomationAuthorityLiveFactsDeps,
} from "../automation/resolveAutomationAuthorityLiveFacts";
import { AutomationNotificationPreferencesStore } from "../automation/automationNotificationPreferencesStore";
import { AutomationNotificationDeliveryStore } from "../automation/automationNotificationDeliveryStore";
import { AutomationNotificationDeliveryService } from "../automation/automationNotificationDeliveryService";
import { createAutomationNotificationRouteHandler } from "../automation/automationNotificationRoutes";
import {
  createPushNotificationTokenStore,
  pushDestinationStands,
} from "../remote/pushNotificationTokenStore";
import { createHubPushDeliveryTransport, createHubPushHandoffSlot } from "../hub/hubPushTransport";
import { createGatewayPushDeliveryTransport } from "../remote/gatewayPushDeliveryTransport";
import {
  existingPrivateListenerSigning,
  privateListenerDisplayName,
} from "../remote/privateListenerHostIdentity";
import { createPushGatewaySetting } from "../remote/pushGatewaySetting";
import type { HostSigningPort } from "../remote/remoteProtocolService";
import { readDeviceRegistrations } from "../persistence/remoteAccessProjection";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import {
  defaultPermissionModeFor,
  defaultShellSettings,
  isAutomationRunLifecycleActive,
} from "@octant/domain";
import type { ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { FoundationsWiring } from "./foundations";
import type { AgentRunsWiring } from "./agentRuns";
import type { WorkspaceWiring } from "./workspace";
import type { CodeRuntimeWiring } from "./codeRuntime";
import type { ChatWiring } from "./chat";
import type { WorkWiring } from "./work";

export type AutomationDependencies = Pick<ServerStart, "persistence"> &
  Pick<AuthorityWiring, "liveTurns" | "routineProposalService" | "windowAuthorityStore"> &
  Pick<
    AgentRunsWiring,
    "capacityScheduler" | "agentRunOrchestration" | "externalContentIngestionStore"
  > &
  Pick<HarnessWiring, "readHarnessProcessReceipts"> &
  Pick<WorkspaceWiring, "projectService"> &
  Pick<
    CodeRuntimeWiring,
    "codeCompletedThreadSource" | "contributeCodeTools" | "routeCodeService"
  > &
  Pick<ChatWiring, "chatService"> &
  Pick<WorkWiring, "workThreadService" | "workThreadServiceWithWorkflows" | "workTurnService"> &
  Pick<FoundationsWiring, "workThreadProjection" | "workTurnProjection">;

export function wireAutomation(deps: AutomationDependencies) {
  const {
    capacityScheduler,
    agentRunOrchestration,
    externalContentIngestionStore,
    readHarnessProcessReceipts,
    chatService,
    codeCompletedThreadSource,
    contributeCodeTools,
    liveTurns,
    persistence,
    projectService,
    routeCodeService,
    routineProposalService,
    windowAuthorityStore,
    workThreadProjection,
    workTurnProjection,
    workThreadService,
    workThreadServiceWithWorkflows,
    workTurnService,
  } = deps;

  const automationEventStore = new AutomationEventStore({
    journal: persistence.journal,
    uuid: randomUUID,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
  });
  // The Automation projection is in-memory; rebuild it from the
  // authoritative journal on every startup. Hydration fails closed: a
  // hostile or undecodable frame, or history past the scan cap, leaves the
  // projection empty instead of trusting a partial stream. The host still
  // starts; the Automation list reports the degraded state and the
  // scheduler never starts, so nothing fires against history it never read.
  // A live rehydration that fails later revokes the same state.
  let automationHistoryAvailable =
    hydrateAutomationProjection({
      store: automationEventStore,
      projection: persistence.automationProjection,
    }) === "ok";
  // Shared device destinations, opt-in preferences, durable delivery
  // receipts. The host holds no platform push credential: it sends sealed
  // envelopes through the push gateway the Notifications setting names, and
  // reports delivery unavailable while that setting is off (the default).
  // Registrations are kept owner-only under the data directory and survive a
  // restart. One transport carries sealed envelopes for Automation runs and
  // ordinary threads alike.
  const pushNotificationTokenStore = createPushNotificationTokenStore({
    dataDirectory: persistence.dataDirectory,
    journal: persistence.journal,
    uuid: randomUUID,
    hostActorId: OCTANT_LOCAL_ACTOR_ID,
  });
  const pushGatewaySetting = createPushGatewaySetting(persistence.dataDirectory);
  // The key is read once it exists and kept: every send signs with it.
  let pushSigning: HostSigningPort | undefined;
  const signPush = () => {
    pushSigning ??= existingPrivateListenerSigning(persistence.dataDirectory);
    return pushSigning;
  };
  // Where this host's hub grant ticks Push, sealed envelopes go to the hub to
  // forward, and fall back to this host's own gateway when the hub cannot. The
  // remote wiring binds the hub's side once it exists; until then, and on a host
  // that is no hub's spoke, every delivery is the host's own.
  const hubPushHandoffSlot = createHubPushHandoffSlot();
  const pushDeliveryTransport = createHubPushDeliveryTransport({
    direct: createGatewayPushDeliveryTransport({
      settings: pushGatewaySetting.current,
      signing: signPush,
    }),
    settings: pushGatewaySetting.current,
    signing: signPush,
    handoff: hubPushHandoffSlot.current,
  });
  const hasPushStanding = (hostId: string, deviceId: string): boolean =>
    pushDestinationStands(readDeviceRegistrations(persistence.connection), {
      hostId,
      deviceId,
      now: new Date().toISOString(),
    });
  const pushComputerLabel = (): string => privateListenerDisplayName(persistence.connection);
  const automationNotificationPreferencesStore = new AutomationNotificationPreferencesStore({
    journal: persistence.journal,
    uuid: randomUUID,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    clock: () => new Date().toISOString(),
  });
  const automationNotificationDeliveryStore = new AutomationNotificationDeliveryStore({
    journal: persistence.journal,
    uuid: randomUUID,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    clock: () => new Date().toISOString(),
  });
  const automationNotificationDelivery = new AutomationNotificationDeliveryService({
    preferences: automationNotificationPreferencesStore,
    deliveries: automationNotificationDeliveryStore,
    tokens: pushNotificationTokenStore,
    hasStanding: hasPushStanding,
    computerLabel: pushComputerLabel,
    transport: pushDeliveryTransport,
    clock: () => new Date().toISOString() as UtcTimestamp,
    resolveAutomationProjectId: (automationId) => {
      const definition = persistence.automationProjection.getDefinition(automationId);
      return definition === undefined ? undefined : String(definition.projectId);
    },
    recordRunNotificationRef: ({ run, notificationRef, recordedAt }) => {
      const current = persistence.automationProjection.getRun(run.id);
      if (current === undefined) return;
      if (current.notificationRefs.includes(notificationRef as never)) return;
      try {
        automationEventStore.appendNotificationRefRecorded({
          automationId: current.automationId,
          runId: current.id,
          notificationRef,
          expectedVersion: current.version,
          recordedAt,
        });
      } catch {
        // Notification ref append failure never changes run lifecycle.
      }
    },
  });
  const automationNotificationRoutes = createAutomationNotificationRouteHandler({
    windowAuthorityStore,
    preferences: automationNotificationPreferencesStore,
    delivery: automationNotificationDelivery,
    pushGateway: pushGatewaySetting,
  });
  const automationCommandService = new AutomationCommandService({
    store: automationEventStore,
    projection: persistence.automationProjection,
    hostId: String(LOCAL_HOST_ID),
    clock: () => new Date().toISOString(),
  });
  // The one host-local durable scheduler (A3) plus the ordinary-thread
  // dispatcher (A4). Claims stay journaled; the dispatcher revalidates
  // authority, creates at most one Code/Work thread per occurrence, and
  // launches the first turn behind a durable intent/claim. Work uses the
  // provider-backed first-turn runtime through the ordinary thread
  // and turn services.
  const automationCodeDispatch = createAutomationCodeDispatchPort({
    codeService: {
      execute: async (windowId, command) =>
        routeCodeService.execute(windowId, command as never) as Promise<{
          readonly kind: string;
          readonly thread?: { readonly id: CodeThreadId; readonly checkoutId?: string };
        }>,
      bootstrap: async (windowId) => {
        const bootstrap = await routeCodeService.bootstrap(windowId);
        return {
          threads: bootstrap.threads.map((thread) => ({
            id: thread.id,
            checkoutId: String(thread.checkoutId),
          })),
        };
      },
    },
    operations: {
      execute: async (windowId, command) => {
        if (routeCodeService.executeOperation === undefined) {
          throw new Error("Code operation runtime is unavailable.");
        }
        return routeCodeService.executeOperation(windowId, command as never);
      },
    },
    evidence: automationCodeEvidenceFromText(),
    clock: () => new Date().toISOString() as UtcTimestamp,
    uuid: randomUUID,
    // Read at each run, so a routine opted into its Project's level runs at
    // the level that Project's new threads start at then.
    projectLevel: (projectId) => {
      const project = persistence.readProject(projectId);
      const settings = persistence.readCodeSettings()?.settings;
      return defaultPermissionModeFor({
        project: project?.type === "code" ? project : undefined,
        settings: {
          defaultExecutionPolicy: settings?.defaultExecutionPolicy ?? "approval-gated",
          defaultAutoApprove: settings?.defaultAutoApprove,
        },
      });
    },
  });
  const automationWorkDispatch = createAutomationWorkDispatchPort({
    fileInputCurrent: routineFileInputCurrent,
    markFileInput: ({ run, threadId, contentReference }) => {
      if (!routineFileInputCurrent(run)) return false;
      try {
        const marked = externalContentIngestionStore.record({
          threadId,
          provenance: { origin: "external-content", sourceLabel: "file-arrival-routine" },
          contentReference,
          correlationId: randomUUID(),
          authorized: true,
        });
        return marked.kind === "recorded" || marked.kind === "already-recorded";
      } catch {
        return false;
      }
    },
    threads: {
      execute: async (windowId, command) =>
        workThreadServiceWithWorkflows.execute(windowId, command as never) as Promise<{
          readonly kind: string;
          readonly thread?: { readonly id: WorkThreadId };
        }>,
      bootstrap: async (windowId) => {
        const bootstrap = await workThreadServiceWithWorkflows.bootstrap(windowId);
        return {
          threads: bootstrap.threads.map((thread) => ({
            id: thread.id,
            workingDirectory: thread.workingDirectory,
          })),
        };
      },
    },
    turns: {
      startFirstTurn: async (windowId, command, options) =>
        workTurnService.startFirstTurn(windowId, command, options),
    },
    clock: () => new Date().toISOString() as UtcTimestamp,
    uuid: randomUUID,
  });
  const automationChatDispatch = createAutomationChatDispatchPort({
    chat: {
      read: (threadId) => chatService.read(threadId),
      execute: async (command) => chatService.execute(command),
    },
    clock: () => new Date().toISOString() as UtcTimestamp,
  });
  const observeRunStatusChanged = (input: {
    readonly run: AutomationRun;
    readonly previousLifecycle: AutomationRun["lifecycle"];
  }) => {
    try {
      automationNotificationDelivery.observeRunStatusChanged(input);
    } catch {
      /* Notification failure never changes run lifecycle truth. */
    }
  };
  const automationAuthorityDeps: ResolveAutomationAuthorityLiveFactsDeps = {
    hostId: String(LOCAL_HOST_ID),
    readProject: (projectId) => persistence.readProject(projectId as never),
    readProviderInstance: (providerInstanceId) =>
      persistence.readProviderInstance(providerInstanceId as never),
    providerSupportsModel: (providerInstanceId, modelId) => {
      const instance = persistence.readProviderInstance(providerInstanceId as never);
      if (instance === undefined || !instance.enabled) return false;
      const catalog = persistence.readProviderCatalog?.(providerInstanceId as never);
      if (catalog === undefined) return true;
      const models = (catalog as { readonly models?: ReadonlyArray<{ readonly id: string }> })
        .models;
      return models?.some((model) => model.id === modelId) ?? true;
    },
    readExecutionProfileVersion: (profileId) => {
      const profile = persistence.readAgentProfile(profileId as never);
      if (profile === undefined) return undefined;
      return {
        version: profile.version,
        executionPolicy: profile.defaultExecutionPolicy,
      };
    },
    readCodeCheckoutAvailable: (input) => {
      const project = persistence.readProject(input.projectId as never);
      if (project === undefined || project.type !== "code") return false;
      const latest =
        "bindingHistory" in project ? project.bindingHistory.at(-1)?.revisionId : undefined;
      if (String(latest) !== input.bindingRevisionId) {
        return false;
      }
      const checkout = persistence.readCodeCheckout(input.checkoutId as never);
      return (
        checkout !== undefined &&
        checkout.availability === "available" &&
        String(checkout.repositoryId) === input.repositoryId
      );
    },
  };
  function routineFileInputCurrent(captured: AutomationRun): boolean {
    const definition = persistence.automationProjection.getDefinition(captured.automationId);
    const run = persistence.automationProjection.getRun(captured.id);
    if (
      definition?.lifecycle !== "enabled" ||
      run === undefined ||
      run.cancellationTombstone !== undefined ||
      !isAutomationRunLifecycleActive(run.lifecycle) ||
      run.occurrence.kind !== "file-arrival" ||
      run.definitionSnapshot.trigger.kind !== "file-arrival"
    )
      return false;
    const source = persistence.automationProjection.getFileSource(definition.id);
    if (
      source?.sourceIdentity !== run.occurrence.source.checkpoint.sourceIdentity ||
      source.armGeneration !== run.occurrence.source.checkpoint.armGeneration
    )
      return false;
    const facts = resolveAutomationAuthorityLiveFacts(automationAuthorityDeps, { definition, run });
    if (
      facts.project?.type !== "work" ||
      revalidateAutomationAuthority({ definition, run, facts }).kind !== "ok"
    )
      return false;
    const root = facts.project.binding.canonicalRoot;
    const input =
      run.definitionSnapshot.trigger.directory === "."
        ? root
        : joinWorkPath(root, run.definitionSnapshot.trigger.directory);
    return run.occurrence.source.files.every(
      (path) => secretGuardRefusal(joinWorkPath(input, path)) === undefined,
    );
  }
  const automationDispatch = new AutomationDispatchService({
    store: automationEventStore,
    projection: persistence.automationProjection,
    code: automationCodeDispatch,
    work: automationWorkDispatch,
    chat: automationChatDispatch,
    capacity: {
      admit: (input) => {
        try {
          const submission = capacityScheduler.submit({
            reservationId: input.reservationId as CapacityReservationId,
            subject: {
              aggregateType: "code-thread" as never,
              aggregateId: input.subjectThreadId as never,
            },
            providerInstanceId: input.providerInstanceId as never,
            modelId: input.modelId as never,
            estimatedTokens: 0,
            requests: 1,
            origin: "thread",
          });
          if (submission.status === "queued") {
            return {
              kind: "waiting",
              message: "Provider capacity is unavailable for Automation dispatch.",
            };
          }
          capacityScheduler.markRunning(input.reservationId as CapacityReservationId);
          return {
            kind: "admitted",
            release: () => {
              try {
                capacityScheduler.recordTerminal({
                  reservationId: input.reservationId as CapacityReservationId,
                  outcome: "completed",
                });
              } catch {
                // Capacity release is best-effort; the claim lease bounds retry.
              }
            },
          };
        } catch (error) {
          // No provider capacity facts yet: do not invent a limit, but do not
          // block Automation behind an unconfigured scheduler.
          if (
            error instanceof Error &&
            error.name === "ProviderCapacitySchedulerRejected" &&
            "code" in error &&
            (error as { readonly code?: string }).code === "invalid-configuration"
          ) {
            return { kind: "admitted", release: () => undefined };
          }
          return {
            kind: "waiting",
            message: "Provider capacity admission failed for Automation dispatch.",
          };
        }
      },
    },
    readFollowUpThread: ({ mode, threadId }) => {
      // Chat has no follow-ups: a Chat definition cannot target a thread.
      if (mode === "chat") return { kind: "missing" };
      if (mode === "work") {
        const thread = workThreadProjection.read(decodeWorkThreadId(String(threadId)));
        if (
          thread === undefined ||
          thread.lifecycle === "deleting" ||
          thread.lifecycle === "deleted"
        )
          return { kind: "missing" };
        return {
          kind: "present",
          projectId: String(thread.projectId),
          archived: thread.lifecycle === "archived",
          done: thread.completionConfirmed === true || thread.completedAt !== undefined,
          busy:
            liveTurns.read(String(thread.id)) !== undefined ||
            workTurnService.isTurnStarting(thread.id),
          providerInstanceId: String(thread.providerInstanceId),
          modelId: String(thread.modelId),
        };
      }
      const thread = persistence.readCodeThread(decodeCodeThreadId(String(threadId)));
      if (thread === undefined) return { kind: "missing" };
      return {
        kind: "present",
        projectId: String(thread.projectId),
        archived: thread.lifecycle === "archived",
        done: thread.completedAt !== undefined,
        busy: liveTurns.read(String(thread.id)) !== undefined,
        providerInstanceId: String(thread.providerInstanceId),
        modelId: String(thread.modelId),
        executionPolicy: thread.executionPolicy,
      };
    },
    resolveFacts: (input) => resolveAutomationAuthorityLiveFacts(automationAuthorityDeps, input),
    now: () => new Date().toISOString() as UtcTimestamp,
    onRunStatusChanged: observeRunStatusChanged,
  });
  const automationScheduler = new AutomationSchedulerService({
    reconcileFileSources: () => {
      void automationFileSources.reconcile().catch(() => undefined);
      return persistence.automationProjection
        .listDefinitions()
        .some(
          (definition) =>
            definition.lifecycle === "enabled" && definition.trigger.kind === "file-arrival",
        )
        ? 2_000
        : undefined;
    },
    stopFileSources: () => automationFileSources.close(),
    readWorkTurn: (requestId) => workTurnProjection.lookup(requestId),
    onRunStatusChanged: observeRunStatusChanged,
    store: automationEventStore,
    projection: persistence.automationProjection,
    dispatch: automationDispatch,
    now: () => new Date().toISOString() as UtcTimestamp,
    onHistoryUnavailable: () => {
      automationHistoryAvailable = false;
      void automationScheduler.stop();
    },
  });
  const automationFileSources = new AutomationFileSources({
    projection: persistence.automationProjection,
    scheduler: automationScheduler,
    filesystem: liveWorkFilesystem,
    watch: liveWorkFileWatchPort,
    authority: (definition) =>
      resolveAutomationFileSourceAuthority(
        automationAuthorityDeps,
        captureAutomationDefinitionSnapshot(definition),
        new Date().toISOString() as UtcTimestamp,
      ),
    activity: ({ definition, canonicalRoot, checkpoint }) =>
      readAutomationFileSourceActivity({
        canonicalRoot,
        activityWindow: checkpoint.activityWindow,
        activeRun: persistence.automationProjection.activeRun(definition.id),
        ports: {
          readRun: (id) => persistence.automationProjection.getRun(decodeAutomationRunId(id)),
          readChildren: (threadId) =>
            agentRunOrchestration.parentSummary(decodeAgentRunParentThreadId(threadId)),
          readProcessReceipts: readHarnessProcessReceipts,
        },
      }),
    now: () => new Date().toISOString() as UtcTimestamp,
    monotonic: () => performance.now(),
    wake: () => automationScheduler.poke(),
  });
  if (automationHistoryAvailable) automationScheduler.start();
  // The host's own timer for completed threads, fed by every mode's service
  // that can archive on the host's behalf.
  const completedThreadArchiveSweep = new CompletedThreadArchiveSweep({
    sources: [
      codeCompletedThreadSource,
      {
        mode: "chat" as const,
        threads: () => persistence.readChatThreads(),
        archive: (threadId: string, input: CompletedThreadArchiveInput) =>
          chatService.archiveCompletedThread(decodeChatThreadId(threadId), input),
      },
      {
        mode: "work" as const,
        threads: () => workThreadProjection.list(),
        archive: (threadId: string, input: CompletedThreadArchiveInput) =>
          workThreadService.archiveCompletedThread(decodeWorkThreadId(threadId), input),
      },
    ].flatMap((source) => (source === undefined ? [] : [source])),
    archiveAfterDays: () =>
      (persistence.readShellSettings()?.settings ?? defaultShellSettings())
        .completedThreadArchiveAfterDays,
  });
  // A Code turn's routine proposals ride the seam later areas use to add
  // tools to a Code turn; the Work turn adds the same tool where it composes
  // its own. Each run's own turn, which acts as the host, is refused it.
  contributeCodeTools(({ windowId, thread, readThread }) =>
    createRoutineProposalTools({
      windowId,
      thread: { id: String(thread.id), mode: "code", projectId: String(thread.projectId) },
      readPosture: () => readThread()?.executionPolicy ?? thread.executionPolicy,
      isAutomationOrigin: isRoutineHostScope(windowId),
      proposals: routineProposalService,
      now: Date.now,
    }),
  );
  const automationRoutes = createAutomationRouteHandler({
    projection: persistence.automationProjection,
    commands: {
      // Every authenticated command wakes the scheduler so pause/resume/
      // run-now/cancel re-arm timers immediately instead of at the next poll.
      execute: (command, provenance, source) => {
        const result = automationCommandService.execute(command, provenance, source);
        automationScheduler.poke();
        return result;
      },
    },
    windowAuthorityStore,
    projects: projectService,
    hostId: String(LOCAL_HOST_ID),
    historyAvailable: () => automationHistoryAvailable,
    prepareFileRearm: (input) => automationFileSources.prepareRearm(input),
    prepareFileSource: async ({ command, current, signal }) => {
      const previous = persistence.automationProjection.getDefinition(command.automationId);
      const snapshot = Schema.decodeUnknownSync(AutomationDefinitionSnapshot)({
        ...command.definition,
        automationId: command.automationId,
        definitionRevision: previous === undefined ? 1 : previous.definitionRevision + 1,
      });
      const authority = resolveAutomationFileSourceAuthority(
        automationAuthorityDeps,
        snapshot,
        new Date().toISOString() as UtcTimestamp,
      );
      if (authority === undefined) throw new Error("File source authority is unavailable.");
      return prepareAutomationFileDefinition({
        automationId: command.automationId,
        expectedVersion: command.expectedVersion,
        filesystem: liveWorkFilesystem,
        authority,
        definition: command.definition,
        current,
        signal,
        now: () => new Date().toISOString() as UtcTimestamp,
      });
    },
    proposals: {
      service: routineProposalService,
      draft: (proposal) =>
        buildThreadRoutineDraft(
          {
            hostId: String(LOCAL_HOST_ID),
            actorId: OCTANT_LOCAL_ACTOR_ID,
            readThread: (mode, threadId) => {
              if (mode === "work") {
                const thread = workThreadProjection.read(decodeWorkThreadId(threadId));
                return thread === undefined
                  ? undefined
                  : {
                      projectId: String(thread.projectId),
                      active: thread.lifecycle === "active",
                      providerInstanceId: String(thread.providerInstanceId),
                      modelId: String(thread.modelId),
                    };
              }
              const thread = persistence.readCodeThread(decodeCodeThreadId(threadId));
              return thread === undefined
                ? undefined
                : {
                    projectId: String(thread.projectId),
                    active: thread.lifecycle !== "archived",
                    providerInstanceId: String(thread.providerInstanceId),
                    modelId: String(thread.modelId),
                    executionPolicy: thread.executionPolicy,
                    permissionPersistence: thread.permissionPersistence,
                    ...(thread.profileId === undefined
                      ? {}
                      : { profileId: String(thread.profileId) }),
                    checkout: {
                      repositoryId: String(thread.repositoryId),
                      checkoutId: String(thread.checkoutId),
                    },
                  };
            },
            readProject: (projectId) => {
              const project = persistence.readProject(projectId as never);
              if (project === undefined || (project.type !== "work" && project.type !== "code")) {
                return undefined;
              }
              return {
                name: project.name,
                mode: project.type,
                active: project.lifecycle === "active",
                version: project.version,
                bindingRevisionId:
                  project.bindingHistory.at(-1)?.revisionId === undefined
                    ? undefined
                    : String(project.bindingHistory.at(-1)?.revisionId),
              };
            },
            checkoutAvailable: (checkoutId, repositoryId) => {
              const checkout = persistence.readCodeCheckout(checkoutId as never);
              return (
                checkout !== undefined &&
                checkout.availability === "available" &&
                String(checkout.repositoryId) === repositoryId
              );
            },
            profiles: () => persistence.readAgentProfiles(),
            uuid: randomUUID,
            clock: () => new Date().toISOString(),
          },
          proposal,
        ),
    },
  });
  return {
    automationCommandService,
    automationNotificationRoutes,
    automationRoutes,
    automationScheduler,
    completedThreadArchiveSweep,
    hasPushStanding,
    hubPushHandoffSlot,
    pushComputerLabel,
    pushDeliveryTransport,
    pushGatewaySetting,
    pushNotificationTokenStore,
  };
}

export type AutomationWiring = ReturnType<typeof wireAutomation>;
