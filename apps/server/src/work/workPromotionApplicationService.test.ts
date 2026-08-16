import { describe, expect, it } from "vitest";
import {
  decodeWorkArtifactRef,
  decodeWorkPromotionProposalId,
  decodeProjectId,
  decodeWindowId,
  EventActor,
  type WorkPromotionFrame,
} from "@octant/contracts";
import { Schema } from "effect";
import { WorkPromotionProjection } from "./workPromotionProjection";
import { WorkPromotionService } from "./workPromotionService";
import { WorkPromotionApplicationService } from "./workPromotionApplicationService";
import type { ProjectService } from "../projectService";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000801");
const originProjectId = decodeProjectId("00000000-0000-4000-8000-000000000901");
const targetProjectId = decodeProjectId("00000000-0000-4000-8000-000000000903");
const proposalId = decodeWorkPromotionProposalId("00000000-0000-4000-8000-000000000902");

describe("WorkPromotionApplicationService", () => {
  it("rehydrates journaled proposals for list after hydrate", async () => {
    const replayFrames: Array<WorkPromotionFrame> = [];
    const projects = {
      bootstrap: async () =>
        ({
          active: [
            { id: originProjectId, type: "work", lifecycle: "active" },
            { id: targetProjectId, type: "code", lifecycle: "active" },
          ],
          archived: [],
        }) as unknown as Awaited<ReturnType<ProjectService["bootstrap"]>>,
    };
    const windowScope = { current: undefined as typeof windowId | undefined };

    function createPromotionService(projection: WorkPromotionProjection) {
      return new WorkPromotionService({
        projects: {
          projectType: (id) =>
            String(id) === String(originProjectId)
              ? "work"
              : String(id) === String(targetProjectId)
                ? "code"
                : "unknown",
          workCanonicalRoot: () => "/work",
          resolveArtifactRefs: (_origin, refs) => refs,
        },
        codeThreads: {
          async createApprovalGatedThread() {
            return { codeThreadId: proposalId as never };
          },
          async cancelCodeThread() {},
        },
        projection,
        eventStore: {
          append: (input) => {
            replayFrames.push(input.frame);
            projection.apply(input.frame);
            return input.frame;
          },
          replayAll: () => ({ status: "ok" as const, frames: replayFrames }),
        },
        actor: Schema.decodeUnknownSync(EventActor)({
          kind: "local-user",
          actorId: "00000000-0000-4000-8000-000000000001",
        }),
        clock: () => "2026-07-22T08:00:00.000Z",
        authenticatedWindowId: () => windowScope.current,
      });
    }

    const liveProjection = new WorkPromotionProjection();
    const livePromotion = createPromotionService(liveProjection);
    const liveApplication = new WorkPromotionApplicationService({
      promotion: livePromotion,
      projection: liveProjection,
      projects,
      windowScope,
    });

    windowScope.current = windowId;
    await liveApplication.execute(windowId, {
      kind: "propose-work-promotion",
      proposalId,
      originProjectId,
      targetCodeProjectId: targetProjectId,
      selectedContext: {
        summary: "Promote the report generator into a CLI",
        artifactRefs: [decodeWorkArtifactRef("artifact-token-a")],
      },
      proposedCodePermissionPersistence: "current-session",
    });

    const restartedProjection = new WorkPromotionProjection();
    const restartedPromotion = createPromotionService(restartedProjection);
    restartedPromotion.hydrate();
    const restartedApplication = new WorkPromotionApplicationService({
      promotion: restartedPromotion,
      projection: restartedProjection,
      projects,
      windowScope: { current: undefined },
    });

    const list = await restartedApplication.list(windowId, originProjectId);
    expect(list.proposals).toHaveLength(1);
    expect(JSON.stringify(list)).not.toMatch(/canonicalRoot|bindingReceipt|file:|\\\\/);
  });

  it("rejects approve when the target Code Project is no longer accessible", async () => {
    const replayFrames: Array<WorkPromotionFrame> = [];
    let codeAccessible = true;
    const projects = {
      bootstrap: async () =>
        ({
          active: [
            { id: originProjectId, type: "work", lifecycle: "active" },
            ...(codeAccessible ? [{ id: targetProjectId, type: "code", lifecycle: "active" }] : []),
          ],
          archived: [],
        }) as unknown as Awaited<ReturnType<ProjectService["bootstrap"]>>,
    };
    const windowScope = { current: undefined as typeof windowId | undefined };
    const projection = new WorkPromotionProjection();
    const promotion = new WorkPromotionService({
      projects: {
        projectType: (id) =>
          String(id) === String(originProjectId)
            ? "work"
            : String(id) === String(targetProjectId)
              ? "code"
              : "unknown",
        workCanonicalRoot: () => "/work",
        resolveArtifactRefs: (_origin, refs) => refs,
      },
      codeThreads: {
        async createApprovalGatedThread() {
          return { codeThreadId: proposalId as never };
        },
        async cancelCodeThread() {},
      },
      projection,
      eventStore: {
        append: (input) => {
          replayFrames.push(input.frame);
          projection.apply(input.frame);
          return input.frame;
        },
        replayAll: () => ({ status: "ok" as const, frames: replayFrames }),
      },
      actor: Schema.decodeUnknownSync(EventActor)({
        kind: "local-user",
        actorId: "00000000-0000-4000-8000-000000000001",
      }),
      clock: () => "2026-07-22T08:00:00.000Z",
      authenticatedWindowId: () => windowScope.current,
    });
    const application = new WorkPromotionApplicationService({
      promotion,
      projection,
      projects,
      windowScope,
    });

    windowScope.current = windowId;
    await application.execute(windowId, {
      kind: "propose-work-promotion",
      proposalId,
      originProjectId,
      targetCodeProjectId: targetProjectId,
      selectedContext: {
        summary: "Promote the report generator into a CLI",
        artifactRefs: [decodeWorkArtifactRef("artifact-token-a")],
      },
      proposedCodePermissionPersistence: "current-session",
    });

    codeAccessible = false;
    await expect(
      application.execute(windowId, {
        kind: "approve-work-promotion",
        proposalId,
        expectedVersion: 1 as never,
        providerInstanceId: "10000000-0000-4000-8000-000000000001" as never,
        modelId: "model-a" as never,
        deliveryTarget: {
          branchIntent: "feature/work-promotion",
          remoteName: "origin",
          proposedBaseRepository: "octocat/octant",
          proposedBaseBranch: "development",
          outcomeKind: "opened-pr",
          confirmedAt: "2026-07-22T08:05:00.000Z" as never,
        },
      }),
    ).rejects.toMatchObject({
      failure: {
        code: "unauthorized",
        message: "Work promotion approval is unauthorized for the target Code Project.",
      },
    });
  });
});
