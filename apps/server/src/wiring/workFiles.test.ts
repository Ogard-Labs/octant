import { expect, it } from "vitest";
import {
  decodeProject,
  decodeWorkArtifactMutationFrame,
  type WorkProject,
} from "@octant/contracts";
import { approvedWorkingFolderChoices } from "../approvedWorkingFolders";
import { WorkArtifactProjection } from "../work/workArtifactProjection";
import { workArtifactPreviewSource } from "./workFiles";

const now = "2026-11-06T12:00:00.000Z";
const actor = { kind: "local-user", actorId: "11111111-1111-4111-8111-111111111111" };
function project(extraRevision: number | null = 1, bindingRevision = 1): WorkProject {
  const root = bindingRevision === 1 ? "/work" : "/relocated";
  const value = decodeProject({
    id: "22222222-2222-4222-8222-222222222222",
    type: "work",
    name: "Notes",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: now,
    updatedAt: now,
    binding: { canonicalRoot: root },
    bindingHistory: [
      {
        revisionId:
          bindingRevision === 1
            ? "33333333-3333-4333-8333-333333333333"
            : "44444444-4444-4444-8444-444444444444",
        revision: bindingRevision,
        currentBinding: { canonicalRoot: root },
        actor,
        changedAt: now,
      },
    ],
    extraFolders:
      extraRevision === null
        ? []
        : [
            {
              canonicalRoot: "/approved/notes",
              addedAt: now,
              addedBy: actor,
              addedRevision: extraRevision,
            },
          ],
  });
  if (value.type !== "work") throw new Error("Expected Work Project");
  return value;
}

it("replays an artifact's folder identity and refuses previews after its folder is removed and re-added", () => {
  const current = project();
  const folder = approvedWorkingFolderChoices(current).find((choice) => choice.kind === "extra");
  if (folder === undefined) throw new Error("Expected an approved extra folder");
  const artifactId = "55555555-5555-4555-8555-555555555555";
  const frame = decodeWorkArtifactMutationFrame({
    requestId: "66666666-6666-4666-8666-666666666666",
    projectId: current.id,
    sequence: 1,
    occurredAt: now,
    outcome: {
      kind: "created",
      artifact: {
        artifactId,
        projectId: current.id,
        format: "markdown",
        artifactRef: "opaque-note",
        displayName: "brief.md",
        directory: "drafts",
        workingFolderId: folder.id,
        createdAt: now,
      },
      version: {
        versionId: "77777777-7777-4777-8777-777777777777",
        artifactId,
        projectId: current.id,
        format: "markdown",
        sourceVersion: { contentSha256: "a".repeat(64), byteSize: 1, observedAt: now },
        createdBy: actor,
        createdAt: now,
        sequence: 1,
      },
      previewTarget: {
        targetId: "88888888-8888-4888-8888-888888888888",
        projectId: current.id,
        hostId: "99999999-9999-4999-8999-999999999999",
        kind: "artifact-version",
        opaqueRef: "opaque-note",
        displayName: "brief.md",
      },
    },
  });
  const restored = new WorkArtifactProjection();
  restored.apply(decodeWorkArtifactMutationFrame(JSON.parse(JSON.stringify(frame))));
  if (frame.outcome.kind !== "created") throw new Error("Expected creation frame");
  const entry = restored.lookup(frame.outcome.artifact.artifactId);
  if (entry === undefined) throw new Error("Expected replayed artifact");
  expect(entry.workingFolderId).toBe(folder.id);
  expect(workArtifactPreviewSource(current, entry)).toMatchObject({
    ok: true,
    folder: "/approved/notes",
    relativePath: "drafts/brief.md",
  });
  expect(workArtifactPreviewSource(project(null), entry)).toEqual({
    ok: false,
    code: "not-found",
  });
  expect(workArtifactPreviewSource(project(2), entry)).toEqual({ ok: false, code: "not-found" });
  const main = approvedWorkingFolderChoices(current).find((choice) => choice.kind === "main");
  if (main === undefined) throw new Error("Expected main folder");
  expect(workArtifactPreviewSource(project(1, 2), { ...entry, workingFolderId: main.id })).toEqual({
    ok: false,
    code: "not-found",
  });
  const { workingFolderId: _recorded, ...legacy } = entry;
  expect(workArtifactPreviewSource(current, legacy)).toMatchObject({ ok: true, folder: "/work" });
  expect(workArtifactPreviewSource(current, { ...entry, deleted: true })).toEqual({
    ok: false,
    code: "not-found",
  });
});
