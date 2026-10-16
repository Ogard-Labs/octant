import { randomUUID } from "node:crypto";
import {
  type CapacityReservationId,
  type CodeThreadId,
  decodeChatThreadId,
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
import { createAutomationWorkDispatchPort } from "../automation/automationWorkDispatchPort";
import { AutomationDispatchService } from "../automation/automationDispatchService";
import { AutomationEventStore } from "../automation/automationEventStore";
import { hydrateAutomationProjection } from "../automation/automationProjection";
import { createAutomationRouteHandler } from "../automation/automationRoutes";
import { AutomationSchedulerService } from "../automation/automationSchedulerService";
import { resolveAutomationAuthorityLiveFacts } from "../automation/resolveAutomationAuthorityLiveFacts";
import { AutomationNotificationPreferencesStore } from "../automation/automationNotificationPreferencesStore";
import { AutomationNotificationDeliveryStore } from "../automation/automationNotificationDeliveryStore";
import { AutomationNotificationDeliveryService } from "../automation/automationNotificationDeliveryService";
import { createAutomationNotificationRouteHandler } from "../automation/automationNotificationRoutes";
import { createUnavailablePushDeliveryTransport } from "../automation/pushDeliveryTransport";
import { createPushNotificationTokenStore } from "../remote/pushNotificationTokenStore";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { defaultShellSettings } from "@octant/domain";
import type { ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { AgentRunsWiring } from "./agentRuns";
import type { WorkspaceWiring } from "./workspace";
import type { CodeWiring } from "./code";
import type { CodeRuntimeWiring } from "./codeRuntime";
import type { ChatWiring } from "./chat";
import type { WorkWiring } from "./work";

export type AutomationDependencies = Pick<ServerStart, "persistence"> &
  Pick<AuthorityWiring, "windowAuthorityStore"> &
  Pick<AgentRunsWiring, "capacityScheduler"> &
  Pick<WorkspaceWiring, "projectService" | "workThreadProjection"> &
  Pick<CodeWiring, "codeCompletedThreadSource"> &
  Pick<CodeRuntimeWiring, "routeCodeService"> &
  Pick<ChatWiring, "chatService"> &
  Pick<WorkWiring, "workThreadService" | "workThreadServiceWithWorkflows" | "workTurnService">;

export function wireAutomation(deps: AutomationDependencies) {
  const {
    capacityScheduler,
    chatService,
    codeCompletedThreadSource,
    persistence,
    projectService,
    routeCodeService,
    windowAuthorityStore,
    workThreadProjection,
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
  // A6: shared device destinations, opt-in preferences, durable delivery
  // receipts. Credentialed APNs/FCM remains a named validation residual —
  // the default transport reports unavailable honestly.
  const pushNotificationTokenStore = createPushNotificationTokenStore();
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
    hostId: String(LOCAL_HOST_ID),
    preferences: automationNotificationPreferencesStore,
    deliveries: automationNotificationDeliveryStore,
    tokens: pushNotificationTokenStore,
    transport: createUnavailablePushDeliveryTransport(),
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
  });
  const automationWorkDispatch = createAutomationWorkDispatchPort({
    threads: {
      execute: async (windowId, command) =>
        workThreadServiceWithWorkflows.execute(windowId, command as never) as Promise<{
          readonly kind: string;
          readonly thread?: { readonly id: WorkThreadId };
        }>,
      bootstrap: async (windowId) => {
        const bootstrap = await workThreadServiceWithWorkflows.bootstrap(windowId);
        return {
          threads: bootstrap.threads.map((thread) => ({ id: thread.id })),
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
  const automationDispatch = new AutomationDispatchService({
    store: automationEventStore,
    projection: persistence.automationProjection,
    code: automationCodeDispatch,
    work: automationWorkDispatch,
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
    resolveFacts: ({ definition, run }) =>
      resolveAutomationAuthorityLiveFacts(
        {
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
        },
        { definition, run },
      ),
    now: () => new Date().toISOString() as UtcTimestamp,
    onRunStatusChanged: (input) => {
      try {
        automationNotificationDelivery.observeRunStatusChanged(input);
      } catch {
        // Notification failure never changes run lifecycle truth.
      }
    },
  });
  const automationScheduler = new AutomationSchedulerService({
    store: automationEventStore,
    projection: persistence.automationProjection,
    dispatch: automationDispatch,
    now: () => new Date().toISOString() as UtcTimestamp,
    onHistoryUnavailable: () => {
      automationHistoryAvailable = false;
      void automationScheduler.stop();
    },
  });
  if (automationHistoryAvailable) automationScheduler.start();
  // The host's own timer for completed threads, fed by every mode's service
  // that can archive on the host's behalf (decision 0088).
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
  const automationRoutes = createAutomationRouteHandler({
    projection: persistence.automationProjection,
    commands: {
      // Every authenticated command wakes the scheduler so pause/resume/
      // run-now/cancel re-arm timers immediately instead of at the next poll.
      execute: (command) => {
        const result = automationCommandService.execute(command);
        automationScheduler.poke();
        return result;
      },
    },
    windowAuthorityStore,
    projects: projectService,
    hostId: String(LOCAL_HOST_ID),
    historyAvailable: () => automationHistoryAvailable,
  });
  return {
    automationNotificationRoutes,
    automationRoutes,
    automationScheduler,
    completedThreadArchiveSweep,
    pushNotificationTokenStore,
  };
}

export type AutomationWiring = ReturnType<typeof wireAutomation>;
