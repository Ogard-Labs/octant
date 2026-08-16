import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { decodeContentSha256 } from "@octant/contracts/previews";
import {
  decodeWorkArtifactId,
  decodeWorkArtifactMutationFrame,
  decodeWorkArtifactVersionId,
  decodeWorkMutationRequestId,
  type WorkArtifactMutationFrame,
} from "@octant/contracts/work-artifacts";
import { decodeProjectId } from "@octant/contracts/projects";
import { WorkArtifactProjection } from "./workArtifactProjection";

const ids = {
  artifact: decodeWorkArtifactId("11111111-1111-4111-8111-111111111111"),
  version: decodeWorkArtifactVersionId("22222222-2222-4222-8222-222222222222"),
  request: decodeWorkMutationRequestId("33333333-3333-4333-8333-333333333333"),
  project: decodeProjectId("44444444-4444-4444-8444-444444444444"),
  actor: "55555555-5555-4555-8555-555555555555",
} as const;

const occurredAt = "2026-07-22T08:00:00.000Z";
const actor = { kind: "local-user" as const, actorId: ids.actor };

function shaFor(byteSize: number) {
  return decodeContentSha256(createHash("sha256").update(new Uint8Array(byteSize)).digest("hex"));
}

function sourceVersion(byteSize: number) {
  return { contentSha256: shaFor(byteSize), byteSize, observedAt: occurredAt };
}

function createdFrame(sequence: number, displayName = "notes.md"): WorkArtifactMutationFrame {
  return decodeWorkArtifactMutationFrame({
    requestId: ids.request,
    projectId: ids.project,
    sequence,
    occurredAt,
    outcome: {
      kind: "created",
      artifact: {
        artifactId: ids.artifact,
        projectId: ids.project,
        format: "markdown",
        artifactRef: "opaque-token-1",
        displayName,
        createdAt: occurredAt,
      },
      version: {
        versionId: ids.version,
        artifactId: ids.artifact,
        projectId: ids.project,
        format: "markdown",
        sourceVersion: sourceVersion(12),
        createdBy: actor,
        createdAt: occurredAt,
        sequence,
      },
      previewTarget: {
        targetId: "66666666-6666-4666-8666-666666666666",
        projectId: ids.project,
        hostId: "77777777-7777-4777-8777-777777777777",
        kind: "artifact-version",
        opaqueRef: "opaque-token-1",
        displayName,
      },
    },
  });
}

function revisedFrame(
  sequence: number,
  overrides: { format?: "markdown" | "csv"; displayName?: string; byteSize?: number } = {},
): WorkArtifactMutationFrame {
  const format = overrides.format ?? "markdown";
  const displayName = overrides.displayName ?? "notes.md";
  const byteSize = overrides.byteSize ?? 20;
  return decodeWorkArtifactMutationFrame({
    requestId: ids.request,
    projectId: ids.project,
    sequence,
    occurredAt,
    outcome: {
      kind: "revised",
      artifact: {
        artifactId: ids.artifact,
        projectId: ids.project,
        format,
        artifactRef: "opaque-token-1",
        displayName,
        createdAt: occurredAt,
      },
      version: {
        versionId: ids.version,
        artifactId: ids.artifact,
        projectId: ids.project,
        format,
        sourceVersion: sourceVersion(byteSize),
        createdBy: actor,
        createdAt: occurredAt,
        sequence,
      },
      previewTarget: {
        targetId: "66666666-6666-4666-8666-666666666666",
        projectId: ids.project,
        hostId: "77777777-7777-4777-8777-777777777777",
        kind: "artifact-version",
        opaqueRef: "opaque-token-1",
        displayName,
      },
    },
  });
}

function externalHandoffFrame(sequence: number): WorkArtifactMutationFrame {
  return decodeWorkArtifactMutationFrame({
    requestId: ids.request,
    projectId: ids.project,
    sequence,
    occurredAt,
    outcome: {
      kind: "exported",
      handoff: {
        requestId: ids.request,
        artifactId: ids.artifact,
        exportFormat: "pdf",
        handoffKind: "external-handoff",
        exportRef: "opaque-token-1",
        producedAt: occurredAt,
      },
    },
  });
}

function deletedFrame(sequence: number): WorkArtifactMutationFrame {
  return decodeWorkArtifactMutationFrame({
    requestId: ids.request,
    projectId: ids.project,
    sequence,
    occurredAt,
    outcome: {
      kind: "deleted",
      artifactId: ids.artifact,
      projectId: ids.project,
      lastVersion: {
        versionId: ids.version,
        artifactId: ids.artifact,
        projectId: ids.project,
        format: "markdown",
        sourceVersion: sourceVersion(12),
        createdBy: actor,
        createdAt: occurredAt,
        sequence,
      },
    },
  });
}

describe("WorkArtifactProjection", () => {
  it("retains a bounded export history independently for each Project", () => {
    const projection = new WorkArtifactProjection();
    const quietProject = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    applySyntheticExport(projection, quietProject, 1);
    for (let index = 1; index <= 513; index += 1) {
      applySyntheticExport(projection, String(ids.project), index);
    }

    expect(projection.snapshotExports(quietProject as never)).toHaveLength(1);
    expect(projection.snapshotExports(ids.project)).toHaveLength(64);
  });

  it("registers an artifact on a created frame", () => {
    const projection = new WorkArtifactProjection();
    projection.apply(createdFrame(1));
    const entry = projection.lookup(ids.artifact);
    expect(entry?.format).toBe("markdown");
    expect(entry?.displayName).toBe("notes.md");
    expect(entry?.sequence).toBe(1);
    expect(entry?.deleted).toBe(false);
  });

  it("updates sequence and source version on a revised frame", () => {
    const projection = new WorkArtifactProjection();
    projection.apply(createdFrame(1));
    projection.apply(revisedFrame(2, { byteSize: 20 }));
    const entry = projection.lookup(ids.artifact);
    expect(entry?.sequence).toBe(2);
    expect(entry?.currentSourceVersion.byteSize).toBe(20);
  });

  it("updates format on a transform (revised with new format)", () => {
    const projection = new WorkArtifactProjection();
    projection.apply(createdFrame(1));
    projection.apply(revisedFrame(2, { format: "csv" }));
    const entry = projection.lookup(ids.artifact);
    expect(entry?.format).toBe("csv");
  });

  it("updates displayName and relative path on a rename (revised with new displayName)", () => {
    const projection = new WorkArtifactProjection();
    projection.apply(createdFrame(1));
    projection.apply(revisedFrame(2, { displayName: "renamed.md" }));
    const entry = projection.lookup(ids.artifact);
    expect(entry?.displayName).toBe("renamed.md");
    expect(entry?.relativePath).toBe("renamed.md");
  });

  it("advances sequence on an external-handoff export without minting a path", () => {
    const projection = new WorkArtifactProjection();
    projection.apply(createdFrame(1));
    projection.apply(externalHandoffFrame(2));
    const entry = projection.lookup(ids.artifact);
    // The per-artifact sequence advances in lockstep with the journal aggregate
    // so a following mutation's optimistic concurrency check stays consistent,
    // while the opaque ref / path / display name are unchanged (no parallel
    // path was minted for the handoff).
    expect(entry?.sequence).toBe(2);
    expect(entry?.artifactRef).toBe("opaque-token-1");
    expect(entry?.relativePath).toBe("notes.md");
    expect(entry?.displayName).toBe("notes.md");
    expect(entry?.format).toBe("markdown");
    expect(entry?.lastMutation).toBe("exported");
  });

  it("marks an artifact deleted on a deleted frame", () => {
    const projection = new WorkArtifactProjection();
    projection.apply(createdFrame(1));
    projection.apply(deletedFrame(2));
    const entry = projection.lookup(ids.artifact);
    expect(entry?.deleted).toBe(true);
    expect(entry?.sequence).toBe(2);
  });

  it("rebuilds state idempotently from a replayed frame sequence", () => {
    const frames = [
      createdFrame(1),
      revisedFrame(2, { byteSize: 20 }),
      revisedFrame(3, { displayName: "final.md" }),
    ];
    const projection = new WorkArtifactProjection();
    for (const frame of frames) projection.apply(frame);
    const entry = projection.lookup(ids.artifact);
    expect(entry?.sequence).toBe(3);
    expect(entry?.displayName).toBe("final.md");
    expect(entry?.currentSourceVersion.byteSize).toBe(20);

    const rebuilt = new WorkArtifactProjection();
    for (const frame of frames) rebuilt.apply(frame);
    expect(rebuilt.lookup(ids.artifact)).toEqual(entry);
  });

  it("returns undefined for an unknown artifact", () => {
    const projection = new WorkArtifactProjection();
    expect(projection.lookup(ids.artifact)).toBeUndefined();
  });
});

function applySyntheticExport(
  projection: WorkArtifactProjection,
  projectId: string,
  index: number,
): void {
  const token = createHash("sha256").update(`${projectId}:${index}`).digest("hex").slice(0, 12);
  const artifactId = `11111111-1111-4111-8111-${token}`;
  projection.apply({
    projectId,
    sequence: index * 2 - 1,
    outcome: {
      kind: "created",
      artifact: {
        artifactId,
        projectId,
        format: "markdown",
        artifactRef: `artifact-${index}`,
        displayName: `artifact-${index}.md`,
      },
      version: {
        sequence: index * 2 - 1,
        sourceVersion: sourceVersion(index),
      },
    },
  } as WorkArtifactMutationFrame);
  projection.apply({
    projectId,
    sequence: index * 2,
    outcome: {
      kind: "exported",
      handoff: {
        artifactId,
        exportFormat: "pdf",
        handoffKind: "external-handoff",
        producedAt: new Date(Date.parse(occurredAt) + index).toISOString(),
      },
    },
  } as WorkArtifactMutationFrame);
}
