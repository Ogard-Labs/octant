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
import { baseWorkCapabilityReport } from "./workCapabilityCatalog";

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

describe("Work PDF and image artifact workflow", () => {
  it("creates a pdf artifact and writes valid PDF bytes", async () => {
    const { service, filesystem } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "pdf",
        displayName: "report.pdf",
        content: "Line one\nLine two",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("created");
    if (reply.outcome.kind !== "created") return;
    expect(reply.outcome.artifact.format).toBe("pdf");
    expect(reply.outcome.version.sequence).toBe(1);
    const bytes = await filesystem.readFile("/work/report.pdf");
    const header = new TextDecoder().decode(bytes.subarray(0, 8));
    expect(header).toBe("%PDF-1.4");
  });

  it("rejects PDF content that the declared encoding cannot preserve", async () => {
    const { service } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "pdf",
        displayName: "report.pdf",
        content: "日本語",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("unsupported");
  });

  it("allows revise on a pdf artifact (canMutate true, full-content replace)", async () => {
    const { service } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "pdf",
        displayName: "report.pdf",
        content: "Line one\nLine two",
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
        content: "Updated content",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("revised");
  });

  it("creates an image artifact and writes valid PNG bytes", async () => {
    const { service, filesystem } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "image",
        displayName: "logo.png",
        content: "PNG 4 4 #00ff00",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("created");
    if (reply.outcome.kind !== "created") return;
    expect(reply.outcome.artifact.format).toBe("image");
    expect(reply.outcome.version.sequence).toBe(1);
    const bytes = await filesystem.readFile("/work/logo.png");
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
  });

  it("allows revise on an image artifact (canMutate true, full-content replace)", async () => {
    const { service } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "image",
        displayName: "logo.png",
        content: "PNG 4 4 #00ff00",
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
        content: "PNG 4 4 #ff0000",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("revised");
  });

  it("exports a pdf artifact same-format as an external-handoff with an opaque ref", async () => {
    const { service } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "pdf",
        displayName: "report.pdf",
        content: "Line one\nLine two",
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
        exportFormat: "pdf",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("exported");
    if (reply.outcome.kind !== "exported") return;
    expect(reply.outcome.handoff.handoffKind).toBe("external-handoff");
    if (reply.outcome.handoff.handoffKind !== "external-handoff") return;
    // The export ref is opaque: no path separator, no file: scheme, so the
    // native handoff must resolve it server-side.
    expect(reply.outcome.handoff.exportRef).not.toMatch(/[\\/]/);
    expect(reply.outcome.handoff.exportRef).not.toMatch(/^file:/);
    expect("previewTarget" in reply.outcome.handoff).toBe(false);
  });

  it("exports an image artifact same-format as an external-handoff with an opaque ref", async () => {
    const { service } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "image",
        displayName: "logo.png",
        content: "PNG 4 4 #00ff00",
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
        exportFormat: "image",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("exported");
    if (reply.outcome.kind !== "exported") return;
    expect(reply.outcome.handoff.handoffKind).toBe("external-handoff");
    if (reply.outcome.handoff.handoffKind !== "external-handoff") return;
    expect(reply.outcome.handoff.exportRef).not.toMatch(/[\\/]/);
    expect(reply.outcome.handoff.exportRef).not.toMatch(/^file:/);
    expect("previewTarget" in reply.outcome.handoff).toBe(false);
  });

  it("keeps the artifact mutable after an external-handoff same-format export", async () => {
    const { service } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "pdf",
        displayName: "report.pdf",
        content: "Line one\nLine two",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    if (created.outcome.kind !== "created") throw new Error("create failed");
    // Same-format pdf export is an external-handoff: the projection must still
    // advance the per-artifact sequence in lockstep with the committed frame so
    // the following mutation's expectedArtifactVersion check passes instead of
    // failing as stale (the P1 projection/journal divergence regression).
    const exported = await service.mutate(
      {
        kind: "export-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: created.outcome.artifact.artifactId,
        exportFormat: "pdf",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(exported.outcome.kind).toBe("exported");
    if (exported.outcome.kind !== "exported") return;
    expect(exported.outcome.handoff.handoffKind).toBe("external-handoff");
    const revised = await service.mutate(
      {
        kind: "revise-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: created.outcome.artifact.artifactId,
        content: "Page one\nPage two\nRevised",
        expectedArtifactVersion: 2,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(revised.outcome.kind).toBe("revised");
  });

  it("returns unsupported when transforming a pdf to image (no derived export format)", async () => {
    const { service } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "pdf",
        displayName: "report.pdf",
        content: "Line one\nLine two",
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
        targetFormat: "image",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("unsupported");
    if (reply.outcome.kind !== "unsupported") return;
    expect(reply.outcome.format).toBe("image");
  });

  it("fails closed as parse-failed when an image spec is garbage", async () => {
    const { service } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "image",
        displayName: "broken.png",
        content: "garbage",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("failed");
    if (reply.outcome.kind !== "failed") return;
    expect(reply.outcome.reason).toBe("parse-failed");
  });

  it("requires approval for a pdf create in approval-gated posture", async () => {
    const { service } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "pdf",
        displayName: "report.pdf",
        content: "Line one\nLine two",
      } satisfies WorkMutationRequest,
      { ...fullContext, posture: "approval-gated", approved: false },
    );
    expect(reply.outcome.kind).toBe("unauthorized");
  });

  it("creates a pdf in approval-gated posture when approved", async () => {
    const { service } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "pdf",
        displayName: "report.pdf",
        content: "Line one\nLine two",
      } satisfies WorkMutationRequest,
      { ...fullContext, posture: "approval-gated", approved: true },
    );
    expect(reply.outcome.kind).toBe("created");
  });

  it("fails closed as oversize when the pdf input exceeds the budget", async () => {
    const { service } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "pdf",
        displayName: "big.pdf",
        content: "x".repeat(17 * 1024 * 1024),
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("failed");
    if (reply.outcome.kind !== "failed") return;
    expect(reply.outcome.reason).toBe("oversize");
  });

  it("fails closed as oversize when an image spec exceeds the adapter budget (not parse-failed)", async () => {
    const { service } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "image",
        displayName: "huge.png",
        content: "PNG 50000 50000 #000000",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("failed");
    if (reply.outcome.kind !== "failed") return;
    expect(reply.outcome.reason).toBe("oversize");
  });

  it("reports honest capabilities for pdf (active-content non-goal, external-app handoff)", () => {
    const report = baseWorkCapabilityReport("pdf");
    expect(report.capabilities.canRoundTrip).toBe(false);
    expect(report.capabilities.canMutate).toBe(true);
    expect(report.exportFormats).toEqual([]);
  });

  it("reports honest capabilities for image (no round-trip, external-app handoff)", () => {
    const report = baseWorkCapabilityReport("image");
    expect(report.capabilities.canRoundTrip).toBe(false);
    expect(report.capabilities.canMutate).toBe(true);
    expect(report.exportFormats).toEqual([]);
  });
});
