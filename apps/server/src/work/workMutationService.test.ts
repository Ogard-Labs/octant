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
import { workFilesystemFixture, type WorkFilesystemFixture } from "./workFilesystemFixture";
import { MAX_WORK_INPUT_BYTES } from "./workBudget";

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
  return { service, projection };
}

const fullContext = {
  binding: availableBinding,
  posture: "full" as const,
  approved: true,
};

describe("WorkMutationService", () => {
  it("creates a markdown artifact and returns a created reply with a preview target", async () => {
    const { service } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "markdown",
        displayName: "notes.md",
        content: "# Hello",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("created");
    if (reply.outcome.kind !== "created") return;
    expect(reply.outcome.artifact.displayName).toBe("notes.md");
    expect(reply.outcome.previewTarget.kind).toBe("artifact-version");
    expect(reply.outcome.previewTarget.projectId).toBe(ids.project);
    expect(reply.outcome.version.sequence).toBe(1);
  });

  it("uses production-registered format adapters for document creation", async () => {
    const { service } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "docx",
        displayName: "report.docx",
        content: "binary",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("created");
    if (reply.outcome.kind !== "created") return;
    expect(reply.outcome.artifact.format).toBe("docx");
  });

  it("revises an existing artifact and increments the version sequence", async () => {
    const { service } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "markdown",
        displayName: "notes.md",
        content: "# Hello",
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
        content: "# Updated",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("revised");
    if (reply.outcome.kind !== "revised") return;
    expect(reply.outcome.version.sequence).toBe(2);
  });

  it("fails closed as stale on an optimistic concurrency mismatch", async () => {
    const { service } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "markdown",
        displayName: "notes.md",
        content: "# Hello",
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
        content: "# Stale",
        expectedArtifactVersion: 99,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("stale");
  });

  it("fails closed as unauthorized when the root has been revoked", async () => {
    const { service } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "markdown",
        displayName: "notes.md",
        content: "# Hello",
      } satisfies WorkMutationRequest,
      { ...fullContext, binding: { ...availableBinding, availability: "unavailable" } },
    );
    expect(reply.outcome.kind).toBe("unauthorized");
  });

  it("fails closed as unauthorized when the root has moved", async () => {
    const { service } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "markdown",
        displayName: "notes.md",
        content: "# Hello",
      } satisfies WorkMutationRequest,
      { ...fullContext, binding: { ...availableBinding, canonicalRoot: "/work-moved" } },
    );
    expect(reply.outcome.kind).toBe("unauthorized");
  });

  it("fails closed as unauthorized on a traversal display name", async () => {
    const { service } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "markdown",
        displayName: "../secret.md",
        content: "# Hello",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("unauthorized");
  });

  it("fails closed as oversize when the input content exceeds the budget", async () => {
    const { service } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "markdown",
        displayName: "big.md",
        content: "x".repeat(20 * 1024 * 1024),
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("failed");
    if (reply.outcome.kind !== "failed") return;
    expect(reply.outcome.reason).toBe("oversize");
  });

  it("requires approval for a destructive delete and fails closed when not approved", async () => {
    const { service } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "markdown",
        displayName: "notes.md",
        content: "# Hello",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    if (created.outcome.kind !== "created") throw new Error("create failed");
    const reply = await service.mutate(
      {
        kind: "delete-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: created.outcome.artifact.artifactId,
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      { ...fullContext, approved: false },
    );
    expect(reply.outcome.kind).toBe("unauthorized");
  });

  it("deletes an artifact when the destructive change is approved", async () => {
    const { service } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "markdown",
        displayName: "notes.md",
        content: "# Hello",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    if (created.outcome.kind !== "created") throw new Error("create failed");
    const reply = await service.mutate(
      {
        kind: "delete-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: created.outcome.artifact.artifactId,
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      { ...fullContext, approved: true },
    );
    expect(reply.outcome.kind).toBe("deleted");
    if (reply.outcome.kind !== "deleted") return;
    expect(reply.outcome.artifactId).toBe(created.outcome.artifact.artifactId);
  });

  it("returns interrupted when the abort signal is already aborted", async () => {
    const { service } = createService();
    const controller = new AbortController();
    controller.abort();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "markdown",
        displayName: "notes.md",
        content: "# Hello",
      } satisfies WorkMutationRequest,
      { ...fullContext, signal: controller.signal },
    );
    expect(reply.outcome.kind).toBe("interrupted");
  });

  it("never leaks a host path into the reply outcome", async () => {
    const { service } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "markdown",
        displayName: "notes.md",
        content: "# Hello",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    const serialized = JSON.stringify(reply);
    expect(serialized).not.toContain("/work");
    expect(serialized).not.toContain("/Users");
  });

  it("renames an artifact and updates the display name", async () => {
    const { service } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "markdown",
        displayName: "notes.md",
        content: "# Hello",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    if (created.outcome.kind !== "created") throw new Error("create failed");
    const reply = await service.mutate(
      {
        kind: "rename-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: created.outcome.artifact.artifactId,
        displayName: "renamed.md",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("revised");
    if (reply.outcome.kind !== "revised") return;
    expect(reply.outcome.artifact.displayName).toBe("renamed.md");
    expect(reply.outcome.version.sequence).toBe(2);
  });

  it("versions an artifact as a snapshot revision", async () => {
    const { service } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "markdown",
        displayName: "notes.md",
        content: "# Hello",
      } satisfies WorkMutationRequest,
      fullContext,
    );
    if (created.outcome.kind !== "created") throw new Error("create failed");
    const reply = await service.mutate(
      {
        kind: "version-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: created.outcome.artifact.artifactId,
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("revised");
    if (reply.outcome.kind !== "revised") return;
    expect(reply.outcome.version.sequence).toBe(2);
  });

  it("exports an artifact as an in-app-version handoff for the same format", async () => {
    const { service } = createService();
    const created = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "markdown",
        displayName: "notes.md",
        content: "# Hello",
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
  });

  it("fails closed as unauthorized for an unknown artifact id on revise", async () => {
    const { service } = createService();
    const reply = await service.mutate(
      {
        kind: "revise-artifact",
        requestId: ids.request,
        projectId: ids.project,
        artifactId: ids.artifact,
        content: "# Hello",
        expectedArtifactVersion: 1,
      } satisfies WorkMutationRequest,
      fullContext,
    );
    expect(reply.outcome.kind).toBe("unauthorized");
  });

  it("requires approval for every side effect in approval-gated posture", async () => {
    const { service } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "markdown",
        displayName: "notes.md",
        content: "# Hello",
      } satisfies WorkMutationRequest,
      { ...fullContext, posture: "approval-gated", approved: false },
    );
    expect(reply.outcome.kind).toBe("unauthorized");
  });

  it("creates an artifact in approval-gated posture when approved", async () => {
    const { service } = createService();
    const reply = await service.mutate(
      {
        kind: "create-artifact",
        requestId: ids.request,
        projectId: ids.project,
        format: "markdown",
        displayName: "notes.md",
        content: "# Hello",
      } satisfies WorkMutationRequest,
      { ...fullContext, posture: "approval-gated", approved: true },
    );
    expect(reply.outcome.kind).toBe("created");
  });

  describe("a source swapped while the mutation was deciding whether it may run", () => {
    /**
     * A mutation resolves the artifact, evaluates authority, and only then
     * reads. That evaluation is the window: a process inside the Project can
     * change what the resolved name means while it runs. The race is armed on
     * the second `openFile` because resolution's own read is the first.
     */
    function racingFixture(swap: (fixture: WorkFilesystemFixture) => void) {
      const fixture = workFilesystemFixture();
      let opens = 0;
      const racing: WorkFilesystemPort = {
        ...fixture,
        openFile: async (path) => {
          opens += 1;
          if (opens === 2) swap(fixture);
          return fixture.openFile(path);
        },
      };
      return { fixture, racing };
    }

    async function createdNotes(service: ReturnType<typeof createService>["service"]) {
      const created = await service.mutate(
        {
          kind: "create-artifact",
          requestId: ids.request,
          projectId: ids.project,
          format: "markdown",
          displayName: "notes.md",
          content: "# Hello",
        } satisfies WorkMutationRequest,
        fullContext,
      );
      if (created.outcome.kind !== "created") throw new Error("create failed");
      return created.outcome.artifact.artifactId;
    }

    it("refuses to version an artifact swapped for an escaping symlink", async () => {
      const { fixture, racing } = racingFixture((fs) => {
        fs.putFile("/outside/secret.md", new TextEncoder().encode("host credentials"));
        fs.putSymlink("/work/notes.md", "/outside/secret.md");
      });
      const { service } = createService(racing);
      const artifactId = await createdNotes(service);

      const reply = await service.mutate(
        {
          kind: "version-artifact",
          requestId: ids.request,
          projectId: ids.project,
          artifactId,
          expectedArtifactVersion: 1,
        } satisfies WorkMutationRequest,
        fullContext,
      );

      expect(reply.outcome.kind).toBe("failed");
      if (reply.outcome.kind !== "failed") return;
      expect(reply.outcome.reason).toBe("read-failed");
      // The recorded version must never describe bytes from outside the root.
      expect(fixture.readBytes("/outside/secret.md")).toBeDefined();
    });

    it("refuses to version an artifact swapped for a different object", async () => {
      // Same length as the artifact it replaces, so only its identity betrays it.
      const { racing } = racingFixture((fs) => {
        fs.putFile("/work/notes.md", new TextEncoder().encode("# Hello"));
      });
      const { service } = createService(racing);
      const artifactId = await createdNotes(service);

      const reply = await service.mutate(
        {
          kind: "version-artifact",
          requestId: ids.request,
          projectId: ids.project,
          artifactId,
          expectedArtifactVersion: 1,
        } satisfies WorkMutationRequest,
        fullContext,
      );

      expect(reply.outcome.kind).toBe("failed");
      if (reply.outcome.kind !== "failed") return;
      expect(reply.outcome.reason).toBe("read-failed");
    });

    it("refuses to version an artifact grown past the ceiling after it was measured", async () => {
      // A rewrite in place keeps the object's identity, so nothing but the
      // ceiling can refuse the bytes it gained.
      const { racing } = racingFixture((fs) => {
        void fs.writeFile("/work/notes.md", new Uint8Array(MAX_WORK_INPUT_BYTES + 1));
      });
      const { service } = createService(racing);
      const artifactId = await createdNotes(service);

      const reply = await service.mutate(
        {
          kind: "version-artifact",
          requestId: ids.request,
          projectId: ids.project,
          artifactId,
          expectedArtifactVersion: 1,
        } satisfies WorkMutationRequest,
        fullContext,
      );

      expect(reply.outcome.kind).toBe("failed");
      if (reply.outcome.kind !== "failed") return;
      expect(reply.outcome.reason).toBe("read-failed");
    });
  });
});
