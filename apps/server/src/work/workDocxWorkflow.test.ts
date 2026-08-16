import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  decodeWorkArtifactId,
  decodeWorkMutationRequestId,
  type WorkMutationRequest,
} from "@octant/contracts/work-artifacts";
import { EventActor } from "@octant/contracts/events";
import { decodeProjectId } from "@octant/contracts/projects";
import { decodePreviewHostId } from "@octant/contracts/previews";
import { WorkResolutionService, type WorkRootBinding } from "./workResolutionService";
import { WorkArtifactProjection } from "./workArtifactProjection";
import { WorkMutationService } from "./workMutationService";
import type { WorkFilesystemPort } from "./workFilesystemPort";
import { workFilesystemFixture } from "./workFilesystemFixture";

const ids = {
  artifact: decodeWorkArtifactId("11111111-1111-4111-8111-111111111111"),
  request: decodeWorkMutationRequestId("33333333-3333-4333-8333-333333333333"),
  project: decodeProjectId("44444444-4444-4444-8444-444444444444"),
  host: decodePreviewHostId("55555555-5555-4555-8555-555555555555"),
  actor: "66666666-6666-4666-8666-666666666666",
} as const;

const actor = Schema.decodeUnknownSync(EventActor)({ kind: "local-user", actorId: ids.actor });

const availableBinding: WorkRootBinding = {
  canonicalRoot: "/work",
  knownCanonicalRoot: "/work",
  availability: "available",
  bindingSuperseded: false,
};

function createService(filesystem: WorkFilesystemPort = workFilesystemFixture()) {
  const resolution = new WorkResolutionService(filesystem);
  const projection = new WorkArtifactProjection();
  let counter = 0;
  const uuid = () => {
    counter += 1;
    const suffix = counter.toString(16).padStart(12, "0");
    return `aaaaaaaa-aaaa-4aaa-8aaa-${suffix}`;
  };
  const clock = () => "2026-07-22T08:00:00.000Z";
  const eventStore = {
    append: (input: { readonly frame: import("@octant/contracts").WorkArtifactMutationFrame }) =>
      input.frame,
    replay: () => ({ status: "ok" as const, frames: [], nextCursor: 0 }),
  };
  const service = new WorkMutationService({
    filesystem,
    resolution,
    projection,
    eventStore,
    uuid,
    clock,
    actor,
    hostId: ids.host,
  });
  return { service, projection, filesystem };
}

const fullContext = {
  binding: availableBinding,
  posture: "full" as const,
  approved: true,
};

const textDecoder = new TextDecoder("utf-8", { fatal: false });

describe("WorkMutationService DOCX workflow", () => {
  it("creates a docx artifact that materializes a valid OOXML container", async () => {
    const { service, projection, filesystem } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "docx",
        displayName: "report.docx",
        content: "# Hello\nWorld",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("created");
    if (reply.outcome.kind !== "created") return;
    expect(reply.outcome.artifact.format).toBe("docx");
    expect(reply.outcome.version.sequence).toBe(1);
    expect(reply.outcome.previewTarget.kind).toBe("artifact-version");
    const entry = projection.lookup(reply.outcome.artifact.artifactId);
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const bytes = await filesystem.readFile(`/work/${entry.relativePath}`);
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it("revises a docx artifact and increments the version sequence", async () => {
    const { service } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "docx",
        displayName: "report.docx",
        content: "# Hello\nWorld",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    if (created.outcome.kind !== "created") throw new Error("create failed");
    const reply = await service.mutate(
      {
        kind: "revise-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: created.outcome.artifact.artifactId,
        content: "# Updated\nContent",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("revised");
    if (reply.outcome.kind !== "revised") return;
    expect(reply.outcome.version.sequence).toBe(2);
  });

  it("transforms a docx artifact into markdown and writes decoded text", async () => {
    const { service, projection, filesystem } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "docx",
        displayName: "report.docx",
        content: "# Hello\nWorld",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    if (created.outcome.kind !== "created") throw new Error("create failed");
    const revised = await service.mutate(
      {
        kind: "revise-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: created.outcome.artifact.artifactId,
        content: "# Hello\nWorld",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    if (revised.outcome.kind !== "revised") throw new Error("revise failed");
    const reply = await service.mutate(
      {
        kind: "transform-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: created.outcome.artifact.artifactId,
        targetFormat: "markdown",
        expectedArtifactVersion: 2,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("revised");
    if (reply.outcome.kind !== "revised") return;
    expect(reply.outcome.artifact.format).toBe("markdown");
    expect(reply.outcome.artifact.displayName).toBe("report.md");
    const entry = projection.lookup(created.outcome.artifact.artifactId);
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    expect(entry.relativePath).toBe("report.md");
    const bytes = await filesystem.readFile(`/work/${entry.relativePath}`);
    expect(textDecoder.decode(bytes)).toBe("# Hello\nWorld");
  });

  it("exports a docx artifact to markdown as an in-app-version handoff", async () => {
    const { service, filesystem, projection } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "docx",
        displayName: "report.docx",
        content: "# Hello\nWorld",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    if (created.outcome.kind !== "created") throw new Error("create failed");
    const reply = await service.mutate(
      {
        kind: "export-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: created.outcome.artifact.artifactId,
        exportFormat: "markdown",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("exported");
    if (reply.outcome.kind !== "exported") return;
    expect(reply.outcome.handoff.handoffKind).toBe("in-app-version");
    if (reply.outcome.handoff.handoffKind !== "in-app-version") return;
    expect(reply.outcome.handoff.previewTarget.displayName).toBe("report.md");
    expect(reply.outcome.handoff.producedVersion.format).toBe("markdown");
    const entry = projection.lookup(created.outcome.artifact.artifactId);
    expect(entry?.relativePath).toBe("report.md");
    expect(entry?.format).toBe("markdown");
    const bytes = await filesystem.readFile("/work/report.md");
    expect(textDecoder.decode(bytes)).toBe("# Hello\nWorld");
  });

  it("fails closed as stale on an optimistic concurrency mismatch", async () => {
    const { service } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "docx",
        displayName: "report.docx",
        content: "# Hello\nWorld",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    if (created.outcome.kind !== "created") throw new Error("create failed");
    const revised = await service.mutate(
      {
        kind: "revise-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: created.outcome.artifact.artifactId,
        content: "# Updated\nContent",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    if (revised.outcome.kind !== "revised") throw new Error("revise failed");
    const reply = await service.mutate(
      {
        kind: "revise-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: created.outcome.artifact.artifactId,
        content: "# Stale\nContent",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("stale");
  });

  it("fails closed as unauthorized in approval-gated posture without approval", async () => {
    const { service } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "docx",
        displayName: "report.docx",
        content: "# Hello\nWorld",
      } satisfies WorkMutationRequest,
      { ...fullContext, posture: "approval-gated", approved: false },
    );
    expect(reply.outcome.kind).toBe("unauthorized");
  });

  it("creates a docx artifact in approval-gated posture when approved", async () => {
    const { service } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "docx",
        displayName: "report.docx",
        content: "# Hello\nWorld",
      } satisfies WorkMutationRequest,
      { ...fullContext, posture: "approval-gated", approved: true },
    );
    expect(reply.outcome.kind).toBe("created");
  });

  it("requires approval for a lossy docx-to-markdown transform in full posture", async () => {
    const { service } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "docx",
        displayName: "report.docx",
        content: "# Hello\nWorld",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    if (created.outcome.kind !== "created") throw new Error("create failed");
    const reply = await service.mutate(
      {
        kind: "transform-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: created.outcome.artifact.artifactId,
        targetFormat: "markdown",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      { ...fullContext, approved: false },
    );
    expect(reply.outcome.kind).toBe("unauthorized");
  });

  it("succeeds at a lossy docx-to-markdown transform in full posture when approved", async () => {
    const { service } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "docx",
        displayName: "report.docx",
        content: "# Hello\nWorld",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    if (created.outcome.kind !== "created") throw new Error("create failed");
    const reply = await service.mutate(
      {
        kind: "transform-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: created.outcome.artifact.artifactId,
        targetFormat: "markdown",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      { ...fullContext, approved: true },
    );
    expect(reply.outcome.kind).toBe("revised");
    if (reply.outcome.kind !== "revised") return;
    expect(reply.outcome.artifact.format).toBe("markdown");
  });

  it("refuses an export whose target path became a link out of the approved folder", async () => {
    // The retry check reads whatever already sits at the export path. Reading it
    // through the name lets a link answer for it, and the write that follows the
    // same name then lands outside the bound Project root.
    const filesystem = workFilesystemFixture();
    const { service } = createService(filesystem);
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "docx",
        displayName: "report.docx",
        content: "# Hello\nWorld",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    if (created.outcome.kind !== "created") throw new Error("create failed");
    await filesystem.mkdir("/outside", { recursive: true });
    filesystem.putSymlink("/work/report.md", "/outside/leak.md");

    const reply = await service.mutate(
      {
        kind: "export-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: created.outcome.artifact.artifactId,
        exportFormat: "markdown",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );

    expect(filesystem.readBytes("/outside/leak.md")).toBeUndefined();
    expect(reply.outcome.kind).toBe("failed");
    if (reply.outcome.kind !== "failed") return;
    expect(reply.outcome.reason).toBe("write-failed");
  });
});
