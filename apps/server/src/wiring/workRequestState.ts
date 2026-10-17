import { randomUUID } from "node:crypto";
import { WorkRequestEventStore } from "../work/workRequestEventStore";
import { WorkRequestProjection } from "../work/workRequestProjection";
import { WorkRequestRuntime } from "../work/workRequestRuntime";
import { WorkRequestService } from "../work/workRequestService";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import type { FoundationsWiring } from "./foundations";
import type { ServerStart } from "./serverShape";

export type WorkRequestStateDependencies = Pick<ServerStart, "persistence"> &
  Pick<FoundationsWiring, "workThreadProjection">;

/**
 * Pending Work requests and the runtime that answers them. Provider drivers in
 * every mode report requests here, so the pair is built before any driver is.
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
  const workRequestRuntime = new WorkRequestRuntime({
    requests: workRequestService,
    uuid: randomUUID,
  });
  workRequestService.hydrate();
  workRequestService.interruptOnRestart();
  workRequestService.reconcileUnavailableRequests();
  return { workRequestRuntime, workRequestService };
}

export type WorkRequestStateWiring = ReturnType<typeof wireWorkRequestState>;
