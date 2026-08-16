import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeContentSha256 } from "@octant/contracts/previews";
import {
  decodeWorkArtifactId,
  decodeWorkArtifactMutationFrame,
  decodeWorkArtifactVersionId,
  decodeWorkMutationRequestId,
} from "@octant/contracts/work-artifacts";
import { decodeWorkArtifactRef, decodeProjectId } from "@octant/contracts";
import { WorkArtifactProjection } from "./workArtifactProjection";
import { createWorkPromotionProjectPort } from "./workPromotionProjectPort";

const originProjectId = decodeProjectId("00000000-0000-4000-8000-000000000901");
const targetProjectId = decodeProjectId("00000000-0000-4000-8000-000000000903");
const artifactId = decodeWorkArtifactId("11111111-1111-4111-8111-111111111111");
const versionId = decodeWorkArtifactVersionId("22222222-2222-4222-8222-222222222222");
const requestId = decodeWorkMutationRequestId("33333333-3333-4333-8333-333333333333");
const occurredAt = "2026-07-22T08:00:00.000Z";

function createPort(
  artifacts: WorkArtifactProjection,
  options: {
    readonly codeProject?: boolean;
    readonly gitObservation?: { observe: () => Promise<unknown> };
  } = {},
) {
  return createWorkPromotionProjectPort({
    persistence: {
      readProject: (id) =>
        id === originProjectId
          ? ({
              id: originProjectId,
              type: "work",
              name: "Workspace",
              lifecycle: "active",
              pinned: false,
              rank: "0/1" as never,
              version: 1 as never,
              createdAt: "2026-07-22T08:00:00.000Z" as never,
              updatedAt: "2026-07-22T08:00:00.000Z" as never,
              binding: { canonicalRoot: "/secret/work/root" },
            } as never)
          : options.codeProject && id === targetProjectId
            ? ({
                id: targetProjectId,
                type: "code",
                name: "Repository",
                lifecycle: "active",
                pinned: false,
                rank: "0/1" as never,
                version: 1 as never,
                createdAt: occurredAt as never,
                updatedAt: occurredAt as never,
                binding: { canonicalRoot: "/repo" },
                bindingHistory: [],
                codeAccessPersistence: "current-session",
              } as never)
            : undefined,
    },
    projects: { bootstrap: async () => ({ active: [], archived: [] }) as never },
    artifacts,
    ...(options.gitObservation === undefined
      ? {}
      : { gitObservation: options.gitObservation as never }),
    clock: () => occurredAt,
  });
}

function seedArtifact(projection: WorkArtifactProjection, artifactRef: string): void {
  const byteSize = 12;
  const contentSha256 = decodeContentSha256(
    createHash("sha256").update(new Uint8Array(byteSize)).digest("hex"),
  );
  projection.apply(
    decodeWorkArtifactMutationFrame({
      requestId,
      projectId: originProjectId,
      sequence: 1,
      occurredAt,
      outcome: {
        kind: "created",
        artifact: {
          artifactId,
          projectId: originProjectId,
          format: "markdown",
          artifactRef,
          displayName: "notes.md",
          createdAt: occurredAt,
        },
        version: {
          versionId,
          artifactId,
          projectId: originProjectId,
          format: "markdown",
          sourceVersion: { contentSha256, byteSize, observedAt: occurredAt },
          createdBy: { kind: "local-user", actorId: "55555555-5555-4555-8555-555555555555" },
          createdAt: occurredAt,
          sequence: 1,
        },
        previewTarget: {
          targetId: "66666666-6666-4666-8666-666666666666",
          projectId: originProjectId,
          hostId: "77777777-7777-4777-8777-777777777777",
          kind: "artifact-version",
          opaqueRef: artifactRef,
          displayName: "notes.md",
        },
      },
    }),
  );
}

describe("createWorkPromotionProjectPort", () => {
  it("rejects unknown artifact refs when the live projection is empty", () => {
    const port = createPort(new WorkArtifactProjection());
    expect(
      port.resolveArtifactRefs(originProjectId, [decodeWorkArtifactRef("artifact-token-a")]),
    ).toEqual([]);
  });

  it("resolves artifact refs against the live projection after artifacts appear", () => {
    const artifacts = new WorkArtifactProjection();
    const port = createPort(artifacts);
    expect(
      port.resolveArtifactRefs(originProjectId, [decodeWorkArtifactRef("artifact-token-a")]),
    ).toEqual([]);

    seedArtifact(artifacts, "artifact-token-a");
    const resolved = port.resolveArtifactRefs(originProjectId, [
      decodeWorkArtifactRef("artifact-token-a"),
      decodeWorkArtifactRef("phantom-ref"),
    ]);
    expect(resolved).toEqual([decodeWorkArtifactRef("artifact-token-a")]);
    expect(JSON.stringify(resolved)).not.toContain("/secret");
    expect(port.listArtifactRefs?.(originProjectId)).toEqual([
      decodeWorkArtifactRef("artifact-token-a"),
    ]);
  });

  it("never exposes canonical roots through resolveArtifactRefs", () => {
    const artifacts = new WorkArtifactProjection();
    seedArtifact(artifacts, "artifact-token-a");
    const port = createPort(artifacts);
    expect(port.workCanonicalRoot(originProjectId)).toBe("/secret/work/root");
    const resolved = port.resolveArtifactRefs(originProjectId, [
      decodeWorkArtifactRef("artifact-token-a"),
    ]);
    expect(resolved).toEqual([decodeWorkArtifactRef("artifact-token-a")]);
    expect(JSON.stringify(resolved)).not.toContain("/secret");
  });

  it("derives a fresh Code Project target from its Git checkout", async () => {
    const port = createPort(new WorkArtifactProjection(), {
      codeProject: true,
      gitObservation: {
        observe: async () =>
          ({
            status: "ready",
            head: {
              oid: "a".repeat(40),
              branch: { kind: "named", name: "feature/work-promotion" },
            },
            remotes: [
              {
                name: "origin",
                fetchUrl: "git@github.com:octocat/octant.git",
                pushUrl: "git@github.com:octocat/octant.git",
              },
            ],
          }) as never,
      },
    });

    await expect(port.resolveDeliveryTarget?.(targetProjectId)).resolves.toMatchObject({
      branchIntent: "feature/work-promotion",
      remoteName: "origin",
      proposedBaseRepository: "octocat/octant",
      proposedBaseBranch: "feature/work-promotion",
      outcomeKind: "opened-pr",
      confirmedAt: occurredAt,
    });
  });
});
