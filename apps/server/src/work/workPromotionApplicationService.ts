import {
  type WorkPromotionCommand,
  type WorkPromotionCommandResult,
  type WorkPromotionList,
  type WorkPromotionProposal,
  decodeProjectId,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import type { WorkPromotionProjection } from "./workPromotionProjection";
import { WorkPromotionService, type WorkPromotionServiceResult } from "./workPromotionService";
import { loadAccessiblePromotionProjects, projectIsAccessible } from "./workPromotionProjectPort";
import type { WorkPromotionProjectPort } from "./workPromotionService";

export class WorkPromotionApplicationError extends Error {
  readonly failure: { readonly code: "unauthorized" | "not-found"; readonly message: string };

  constructor(code: "unauthorized" | "not-found", message: string) {
    super(message);
    this.name = "WorkPromotionApplicationError";
    this.failure = { code, message };
  }
}

export interface WorkPromotionApplicationServiceOptions {
  readonly promotion: WorkPromotionService;
  readonly projection: WorkPromotionProjection;
  readonly projects: Pick<Parameters<typeof loadAccessiblePromotionProjects>[0], "bootstrap"> &
    Partial<Pick<WorkPromotionProjectPort, "listArtifactRefs" | "resolveDeliveryTarget">>;
  readonly windowScope: { current: WindowId | undefined };
}

/**
 * Window-scoped Work promotion application service. Enforces Project access
 * before delegating to the authoritative promotion service and never exposes
 * Work canonical roots or binding receipts through list responses.
 */
export class WorkPromotionApplicationService {
  readonly #promotion: WorkPromotionService;
  readonly #projection: WorkPromotionProjection;
  readonly #projects: WorkPromotionApplicationServiceOptions["projects"];
  readonly #windowScope: WorkPromotionApplicationServiceOptions["windowScope"];

  constructor(options: WorkPromotionApplicationServiceOptions) {
    this.#promotion = options.promotion;
    this.#projection = options.projection;
    this.#projects = options.projects;
    this.#windowScope = options.windowScope;
  }

  async list(windowId: WindowId, originProjectId?: ProjectId): Promise<WorkPromotionList> {
    const accessible = await loadAccessiblePromotionProjects(this.#projects, windowId);
    if (originProjectId !== undefined && !projectIsAccessible(accessible.work, originProjectId)) {
      throw new WorkPromotionApplicationError(
        "unauthorized",
        "Work promotion list is unauthorized for this Project.",
      );
    }
    const proposals: Array<WorkPromotionProposal> = [];
    for (const entry of this.#projection.snapshot().values()) {
      const proposal = entry.proposal;
      if (
        originProjectId !== undefined &&
        String(proposal.originProjectId) !== String(originProjectId)
      ) {
        continue;
      }
      if (!projectIsAccessible(accessible.work, proposal.originProjectId)) continue;
      if (!projectIsAccessible(accessible.code, proposal.targetCodeProjectId)) continue;
      proposals.push(proposal);
    }
    proposals.sort((left, right) => right.proposedAt.localeCompare(left.proposedAt));
    const artifactRefs =
      originProjectId === undefined
        ? []
        : (this.#projects.listArtifactRefs?.(originProjectId) ?? []).slice(0, 32);
    const deliveryTargets = this.#projects.resolveDeliveryTarget
      ? (
          await Promise.all(
            [...accessible.code].map(async (projectId) => {
              try {
                const decodedProjectId = decodeProjectId(projectId);
                const deliveryTarget =
                  await this.#projects.resolveDeliveryTarget?.(decodedProjectId);
                return deliveryTarget === undefined
                  ? undefined
                  : { projectId: decodedProjectId, deliveryTarget };
              } catch {
                return undefined;
              }
            }),
          )
        ).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      : [];
    return { proposals, artifactRefs, deliveryTargets };
  }

  async execute(
    windowId: WindowId,
    command: WorkPromotionCommand,
  ): Promise<WorkPromotionCommandResult> {
    await this.#assertCommandAccess(windowId, command);
    const previous = this.#windowScope.current;
    this.#windowScope.current = windowId;
    try {
      return unwrap(await this.#promotion.execute(command));
    } finally {
      this.#windowScope.current = previous;
    }
  }

  async #assertCommandAccess(windowId: WindowId, command: WorkPromotionCommand): Promise<void> {
    const accessible = await loadAccessiblePromotionProjects(this.#projects, windowId);
    if (command.kind === "propose-work-promotion") {
      if (
        !projectIsAccessible(accessible.work, command.originProjectId) ||
        !projectIsAccessible(accessible.code, command.targetCodeProjectId)
      ) {
        throw new WorkPromotionApplicationError(
          "unauthorized",
          "Work promotion proposal is unauthorized for these Projects.",
        );
      }
      return;
    }
    const entry = this.#projection.lookup(command.proposalId);
    if (entry === undefined) {
      throw new WorkPromotionApplicationError("not-found", "Promotion proposal was not found.");
    }
    if (!projectIsAccessible(accessible.work, entry.proposal.originProjectId)) {
      throw new WorkPromotionApplicationError(
        "unauthorized",
        "Work promotion command is unauthorized for this Project.",
      );
    }
    if (
      command.kind === "approve-work-promotion" &&
      !projectIsAccessible(accessible.code, entry.proposal.targetCodeProjectId)
    ) {
      throw new WorkPromotionApplicationError(
        "unauthorized",
        "Work promotion approval is unauthorized for the target Code Project.",
      );
    }
  }
}

function unwrap(result: WorkPromotionServiceResult): WorkPromotionCommandResult {
  if (result.status === "ok") return result.result;
  const error = new Error(result.failure.message) as Error & {
    failure: typeof result.failure;
  };
  error.failure = result.failure;
  throw error;
}
