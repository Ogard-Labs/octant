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
import { baseWorkCapabilityReport } from "./workCapabilityCatalog";
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

const deckContent = "# Intro\n- point one\n---\n# Demo\n- point two";

describe("WorkMutationService pptx workflow", () => {
  it("creates a pptx artifact and writes ZIP bytes to the in-memory filesystem", async () => {
    const fs = workFilesystemFixture();
    const { service } = createService(fs);
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "pptx",
        displayName: "deck.pptx",
        content: deckContent,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("created");
    if (reply.outcome.kind !== "created") return;
    expect(reply.outcome.artifact.format).toBe("pptx");
    expect(reply.outcome.version.sequence).toBe(1);
    const bytes = fs.readBytes("/work/deck.pptx");
    expect(bytes).not.toBeUndefined();
    if (bytes === undefined) return;
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it("revises the pptx artifact and increments the version sequence", async () => {
    const { service } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "pptx",
        displayName: "deck.pptx",
        content: deckContent,
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
        content: "# Revised\n- new point",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("revised");
    if (reply.outcome.kind !== "revised") return;
    expect(reply.outcome.version.sequence).toBe(2);
  });

  it("transforms pptx to markdown-deck and writes UTF-8 deck text", async () => {
    const fs = workFilesystemFixture();
    const { service } = createService(fs);
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "pptx",
        displayName: "deck.pptx",
        content: deckContent,
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
        targetFormat: "markdown-deck",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("revised");
    if (reply.outcome.kind !== "revised") return;
    expect(reply.outcome.artifact.format).toBe("markdown-deck");
    expect(reply.outcome.artifact.displayName).toBe("deck.md");
    // Cross-format transform renames to the target format extension; the
    // markdown-deck bytes are written to the new path and the old .pptx file
    // is removed.
    const bytes = fs.readBytes("/work/deck.md");
    expect(bytes).not.toBeUndefined();
    if (bytes === undefined) return;
    const text = new TextDecoder().decode(bytes);
    expect(text).toBe(deckContent);
  });

  it("exports pptx to markdown-deck as an in-app-version handoff", async () => {
    const { service, projection, filesystem } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "pptx",
        displayName: "deck.pptx",
        content: deckContent,
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
        exportFormat: "markdown-deck",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("exported");
    if (reply.outcome.kind !== "exported") return;
    expect(reply.outcome.handoff.handoffKind).toBe("in-app-version");
    if (reply.outcome.handoff.handoffKind !== "in-app-version") return;
    expect(reply.outcome.handoff.previewTarget.displayName).toBe("deck.md");
    expect(reply.outcome.handoff.producedVersion.format).toBe("markdown-deck");
    const entry = projection.lookup(created.outcome.artifact.artifactId);
    expect(entry?.relativePath).toBe("deck.md");
    expect(entry?.format).toBe("markdown-deck");
    const bytes = await filesystem.readFile("/work/deck.md");
    expect(new TextDecoder().decode(bytes)).toBe(deckContent);
  });

  it("fails closed as stale when revising against a superseded version", async () => {
    const { service } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "pptx",
        displayName: "deck.pptx",
        content: deckContent,
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
        content: "# Revised\n- new point",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    if (revised.outcome.kind !== "revised") throw new Error("revise failed");
    const stale = await service.mutate(
      {
        kind: "revise-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: created.outcome.artifact.artifactId,
        content: "# Stale\n- stale point",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(stale.outcome.kind).toBe("stale");
  });

  it("fails closed as unauthorized in approval-gated posture when not approved", async () => {
    const { service } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "pptx",
        displayName: "deck.pptx",
        content: deckContent,
      } satisfies WorkMutationRequest,
      { ...fullContext, posture: "approval-gated", approved: false },
    );
    expect(reply.outcome.kind).toBe("unauthorized");
  });

  it("creates a pptx artifact in approval-gated posture when approved", async () => {
    const { service } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "pptx",
        displayName: "deck.pptx",
        content: deckContent,
      } satisfies WorkMutationRequest,
      { ...fullContext, posture: "approval-gated", approved: true },
    );
    expect(reply.outcome.kind).toBe("created");
  });

  it("reports canRead, canRoundTrip false, and markdown-deck export for the slide-navigation viewer state contract", () => {
    const report = baseWorkCapabilityReport("pptx");
    expect(report.capabilities.canRead).toBe(true);
    expect(report.capabilities.canRoundTrip).toBe(false);
    expect(report.exportFormats).toContain("markdown-deck");
  });
});
