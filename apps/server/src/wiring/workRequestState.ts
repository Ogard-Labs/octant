import { randomUUID } from "node:crypto";
import { WorkRequestEventStore } from "../work/workRequestEventStore";
import { WorkRequestProjection } from "../work/workRequestProjection";
import { WorkRequestRuntime } from "../work/workRequestRuntime";
import { WorkRequestService } from "../work/workRequestService";
import type { RunningWorkTurnAccess } from "../work/workTurnService";
import type { WorkAccess } from "@octant/contracts";
import type { ShieldReviewPort } from "../shield/octantShield";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import type { FoundationsWiring } from "./foundations";
import type { ServerStart } from "./serverShape";

export type WorkRequestStateDependencies = Pick<ServerStart, "persistence"> &
  Pick<FoundationsWiring, "workThreadProjection">;

/**
 * Pending Work requests and the runtime that answers them. Provider drivers in
 * every mode report requests here, so the pair is built before any driver is.
 *
 * It also holds the access each running Work turn holds. The Work turn service
 * records it and the native harness checks edits against it, and the harness
 * is built before Work, so the record lives here and the harness only reads.
 */
export function wireWorkRequestState(deps: WorkRequestStateDependencies) {
  const { persistence, workThreadProjection } = deps;

  const workRequestProjection = new WorkRequestProjection();
  const workRequestEventStore = new WorkRequestEventStore({
    journal: persistence.journal,
    uuid: randomUUID,
  });
  const workRequestService = new WorkRequestService({
    projects: {
      projectType: (projectId) => persistence.readProject(projectId)?.type ?? "unknown",
      isActiveWorkProject: (projectId) => {
        const project = persistence.readProject(projectId);
        return project?.type === "work" && project.lifecycle === "active";
      },
      workCanonicalRoot: (projectId) => {
        const project = persistence.readProject(projectId);
        if (project === undefined || project.type !== "work") return undefined;
        const root = project.binding.canonicalRoot;
        return root.length > 0 ? root : undefined;
      },
      threadProjectId: (threadId) => workThreadProjection.read(threadId)?.projectId,
      threadProviderInstanceId: (threadId) =>
        workThreadProjection.read(threadId)?.providerInstanceId,
    },
    projection: workRequestProjection,
    eventStore: workRequestEventStore,
    // The runtime wraps this service and answers through it, so the service
    // reaches the runtime only when a request is answered, never while it is
    // being built.
    providerSessions: {
      answerApproval: (input) => workRequestRuntime.answerApproval(input),
      answerUserInput: (input) => workRequestRuntime.answerUserInput(input),
      cancel: (input) => workRequestRuntime.cancel(input),
    },
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    clock: () => new Date().toISOString(),
  });
  // Octant Shield is built with the harness, after this runtime; a Work
  // thread's approval prompts go through it once it exists.
  const workShieldHolder: { port?: ShieldReviewPort } = {};
  const workRequestRuntime = new WorkRequestRuntime({
    requests: workRequestService,
    uuid: randomUUID,
    shield: () => workShieldHolder.port,
  });
  workRequestService.hydrate();
  workRequestService.interruptOnRestart();
  workRequestService.reconcileUnavailableRequests();
  const runningWorkTurns: RunningWorkTurnAccess = new Map();
  const runningWorkTurnAccess = (threadId: string): WorkAccess | undefined =>
    runningWorkTurns.get(threadId)?.access;
  return {
    runningWorkTurnAccess,
    runningWorkTurns,
    workRequestRuntime,
    workRequestService,
    workShieldHolder,
  };
}

export type WorkRequestStateWiring = ReturnType<typeof wireWorkRequestState>;
