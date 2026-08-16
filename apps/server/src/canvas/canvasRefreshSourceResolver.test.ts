import { describe, expect, it } from "vitest";
import { CANVAS_SCHEMA_VERSION } from "@octant/contracts";
import type { CanvasDefinition, CanvasSourceManifestEntry } from "@octant/contracts/canvas";
import type { CanvasRefreshRequest } from "@octant/contracts/canvas-refresh";
import {
  createCanvasRefreshSourceResolver,
  type CanvasRefreshArtifactState,
  type CanvasRefreshThreadState,
} from "./canvasRefreshSourceResolver";

const now = "2026-08-01T21:00:00.000Z";

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111",
  request: "44444444-4444-4444-8444-444444444444",
  recipe: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sourceA: "55555555-5555-4555-8555-555555555555",
  sourceB: "66666666-6666-4666-8666-666666666666",
  project: "77777777-7777-4777-8777-777777777777",
  thread: "88888888-8888-4888-8888-888888888888",
  provider: "99999999-9999-4999-8999-999999999999",
} as const;

const SHA_ZERO = "0000000000000000000000000000000000000000000000000000000000000000";
const SHA_ONE = "1111111111111111111111111111111111111111111111111111111111111111";
const SHA_TWO = "2222222222222222222222222222222222222222222222222222222222222222";

/** The object identity containment captured; the read proves it read that one. */
const resolvedIdentity = (byteLength: number) => ({ device: "1", inode: "7", byteLength });

function source(
  overrides: Partial<{
    sourceId: string;
    kind:
      | "artifact"
      | "file"
      | "attachment"
      | "image"
      | "preview"
      | "browser"
      | "evidence"
      | "thread";
    hostId: string;
    projectId: string;
    opaqueRef: string;
    displayName: string;
  }> = {},
) {
  return {
    sourceId: ids.sourceA,
    kind: "artifact" as const,
    hostId: "local",
    projectId: ids.project,
    opaqueRef: "artifact:source-a",
    displayName: "Source A",
    ...overrides,
  } as unknown as CanvasSourceManifestEntry;
}

function request(sourceManifest: unknown[] = [source()]): CanvasRefreshRequest {
  return {
    schemaVersion: 1,
    kind: "canvas-refresh",
    requestId: ids.request,
    canvasId: ids.canvas,
    recipe: {
      schemaVersion: 1,
      kind: "canvas-refresh-recipe",
      recipeId: ids.recipe,
      canvasId: ids.canvas,
      hostId: "local",
      mode: "chat",
      workspace: { kind: "chat-virtual", projectId: null },
      originThreadId: ids.thread,
      providerInstanceId: ids.provider,
      modelId: "octant-test-model",
      parameters: [],
      sourceManifest: sourceManifest as never,
    },
    expectedSequence: 1,
    hostId: "local",
    mode: "chat",
    workspace: { kind: "chat-virtual", projectId: null },
    originThreadId: ids.thread,
    actor: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000001" },
    providerInstanceId: ids.provider,
    modelId: "octant-test-model",
    requestedAuthority: {
      filesystem: false,
      shell: false,
      git: false,
      network: false,
      tools: true,
      subagents: false,
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    },
  } as unknown as CanvasRefreshRequest;
}

function artifactState(
  overrides: Partial<CanvasRefreshArtifactState> = {},
): CanvasRefreshArtifactState {
  return {
    displayName: "Artifact A",
    relativePath: "notes/artifact-a.md",
    contentSha256: SHA_ONE,
    deleted: false,
    ...overrides,
  };
}

function threadState(overrides: Partial<CanvasRefreshThreadState> = {}): CanvasRefreshThreadState {
  return {
    title: "Research thread",
    updatedAt: now,
    lifecycle: "active",
    ...overrides,
  };
}

function currentDefinition(): CanvasDefinition {
  return {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    title: "Test canvas",
    provenance: {
      mode: "chat",
      hostId: "local",
      projectId: ids.project,
      threadId: ids.thread,
      actor: { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000001" },
      providerInstanceId: ids.provider,
      modelId: "octant-test-model",
      createdAt: now,
    },
    sourceManifest: [],
    blocks: [
      {
        blockId: "heading-1",
        schemaVersion: CANVAS_SCHEMA_VERSION,
        kind: "heading",
        level: 1,
        text: "Original heading",
      },
    ],
  } as unknown as CanvasDefinition;
}

describe("createCanvasRefreshSourceResolver", () => {
  it("fails closed with missing when no authoritative artifact exists", async () => {
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      artifactState: () => undefined,
    });
    const result = await resolver(source(), request(), currentDefinition());
    expect(result).toEqual({
      sourceId: ids.sourceA,
      status: "missing",
      message: "Artifact source is no longer present in this Project.",
    });
  });

  it("fails closed before source work when the recorded provider is offline", async () => {
    let artifactCalls = 0;
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      providerObserved: () => false,
      artifactState: () => {
        artifactCalls += 1;
        return artifactState();
      },
    });
    const result = await resolver(source(), request(), currentDefinition());
    expect(result).toMatchObject({ status: "offline" });
    expect(artifactCalls).toBe(0);
  });

  it("fails closed with missing when the artifact was deleted", async () => {
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      artifactState: () => artifactState({ deleted: true }),
    });
    const result = await resolver(source(), request(), currentDefinition());
    expect(result).toMatchObject({ status: "missing", message: "Artifact source was deleted." });
  });

  it("fails closed with unauthorized when the source host leaves the recipe", async () => {
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      artifactState: () => artifactState(),
    });
    const result = await resolver(source({ hostId: "other-host" }), request(), currentDefinition());
    expect(result).toMatchObject({ status: "unauthorized" });
  });

  it("fails closed with offline when the thread provider is not observed", async () => {
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      threadState: () => threadState(),
      providerObserved: () => false,
    });
    const result = await resolver(
      source({ kind: "thread", opaqueRef: ids.thread, displayName: "Thread" }),
      request([source({ kind: "thread", opaqueRef: ids.thread, displayName: "Thread" })]),
      currentDefinition(),
    );
    expect(result).toMatchObject({ status: "offline" });
  });

  it("fails closed with revoked when the thread is deleted", async () => {
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      threadState: () => threadState({ lifecycle: "deleted" }),
      providerObserved: () => true,
    });
    const result = await resolver(
      source({ kind: "thread", opaqueRef: ids.thread, displayName: "Thread" }),
      request([source({ kind: "thread", opaqueRef: ids.thread, displayName: "Thread" })]),
      currentDefinition(),
    );
    expect(result).toMatchObject({ status: "revoked" });
  });

  it("fails closed with failed for kinds without an authoritative port", async () => {
    const resolver = createCanvasRefreshSourceResolver({ clock: () => now as never });
    const browserSource = source({ kind: "browser" });
    const evidenceSource = source({ kind: "evidence" });
    const browser = await resolver(browserSource, request([browserSource]), currentDefinition());
    const evidence = await resolver(evidenceSource, request([evidenceSource]), currentDefinition());
    expect(browser).toMatchObject({ status: "failed" });
    expect(evidence).toMatchObject({ status: "failed" });
  });

  it("regenerates a ready definition from authoritative artifact state", async () => {
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      artifactState: (projectId, opaqueRef) => {
        expect(projectId).toBe(ids.project);
        expect(opaqueRef).toBe("artifact:source-a");
        return artifactState();
      },
    });
    const result = await resolver(source(), request(), currentDefinition());
    expect(result).toMatchObject({
      sourceId: ids.sourceA,
      status: "ready",
      observedVersion: { contentSha256: SHA_ONE, observedAt: now },
    });
    expect(result.observedVersion).toMatchObject({ contentSha256: SHA_ONE, observedAt: now });
    if (result.status !== "ready") return;
    expect(result.refreshedDefinition?.title).toBe("Test canvas");
    expect(result.refreshedDefinition?.blocks).toHaveLength(2);
    expect(result.refreshedDefinition?.blocks[0]).toMatchObject({
      kind: "heading",
      text: "Original heading",
    });
    expect(result.refreshedDefinition?.blocks[1]).toEqual({
      blockId: `ref:artifact:${ids.sourceA}`,
      schemaVersion: CANVAS_SCHEMA_VERSION,
      kind: "artifact-reference",
      sourceId: ids.sourceA,
      label: "Artifact A",
      detail: "notes/artifact-a.md",
    });
  });

  it("regenerates a file-reference block with the real content digest", async () => {
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      fileState: {
        resolve: (projectId, opaqueRef) => {
          expect(projectId).toBe(ids.project);
          expect(opaqueRef).toBe("file:source-b");
          return {
            absolutePath: "/projects/demo/notes/plan.md",
            displayName: "plan.md",
            relativePath: "notes/plan.md",
            identity: resolvedIdentity(4),
          };
        },
        read: async (file) => {
          expect(file.absolutePath).toBe("/projects/demo/notes/plan.md");
          return { kind: "content", byteLength: 4, contentSha256: SHA_TWO };
        },
      },
    });
    const result = await resolver(
      source({ kind: "file", opaqueRef: "file:source-b" }),
      request([source({ kind: "file", opaqueRef: "file:source-b" })]),
      currentDefinition(),
    );
    expect(result).toMatchObject({
      status: "ready",
      observedVersion: { contentSha256: SHA_TWO },
    });
    if (result.status !== "ready") return;
    expect(result.refreshedDefinition?.blocks[1]).toMatchObject({
      kind: "file-reference",
      label: "plan.md",
      detail: "notes/plan.md",
    });
  });

  it("returns oversized for a file beyond the refresh budget", async () => {
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      fileState: {
        resolve: () => ({
          absolutePath: "/projects/demo/notes/large.md",
          displayName: "large.md",
          relativePath: "notes/large.md",
          identity: resolvedIdentity(11),
        }),
        read: async () => ({ kind: "oversized" }),
      },
    });
    const file = source({ kind: "file", opaqueRef: "file:source-b" });
    const result = await resolver(file, request([file]), currentDefinition());
    expect(result).toMatchObject({ status: "oversized" });
  });

  it("fails closed when the resolved file cannot be read", async () => {
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      fileState: {
        resolve: () => ({
          absolutePath: "/projects/demo/notes/plan.md",
          displayName: "plan.md",
          relativePath: "notes/plan.md",
          identity: resolvedIdentity(4),
        }),
        read: async () => ({ kind: "unreadable" }),
      },
    });
    const file = source({ kind: "file", opaqueRef: "file:source-b" });
    const result = await resolver(file, request([file]), currentDefinition());
    expect(result).toMatchObject({ status: "failed" });
  });

  it("fails when projected file metadata does not match the resolved bytes", async () => {
    let reads = 0;
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      fileState: {
        resolve: () => ({
          absolutePath: "/projects/demo/notes/plan.md",
          displayName: "plan.md",
          relativePath: "notes/plan.md",
          identity: resolvedIdentity(4),
          expectedDigest: SHA_ONE,
          expectedByteLength: 4,
        }),
        read: async () => {
          reads += 1;
          return { kind: "content", byteLength: 4, contentSha256: SHA_TWO };
        },
      },
    });
    const file = source({ kind: "file", opaqueRef: "file:source-b" });
    const result = await resolver(file, request([file]), currentDefinition());
    expect(result).toMatchObject({ status: "failed" });
    expect(reads).toBe(1);
  });

  it("serializes manifest file reads to bound aggregate source memory", async () => {
    let active = 0;
    let maximumActive = 0;
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      fileState: {
        resolve: (_projectId, opaqueRef) => ({
          absolutePath: `/projects/demo/${opaqueRef}.md`,
          displayName: opaqueRef,
          relativePath: `${opaqueRef}.md`,
          identity: resolvedIdentity(4),
        }),
        read: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 0));
          active -= 1;
          return { kind: "content", byteLength: 4, contentSha256: SHA_ONE };
        },
      },
    });
    const sources = [
      source({ kind: "file", opaqueRef: "file:one" }),
      source({ sourceId: ids.sourceB, kind: "file", opaqueRef: "file:two" }),
    ];
    const result = await resolver(sources[0]!, request(sources), currentDefinition());
    expect(result.status).toBe("ready");
    expect(maximumActive).toBe(1);
  });

  it("stops resolving the manifest after cancellation", async () => {
    let artifactCalls = 0;
    let cancellationChecks = 0;
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      artifactState: () => {
        artifactCalls += 1;
        return artifactState();
      },
    });
    const sources = [source(), source({ sourceId: ids.sourceB, opaqueRef: "artifact:source-b" })];
    const result = await resolver(
      sources[0]!,
      request(sources),
      currentDefinition(),
      () => cancellationChecks++ > 0,
    );
    expect(result).toMatchObject({ status: "interrupted" });
    expect(artifactCalls).toBe(1);
  });

  it("regenerates an image block for image sources", async () => {
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      fileState: {
        resolve: () => ({
          absolutePath: "/projects/demo/notes/diagram.png",
          displayName: "diagram.png",
          relativePath: "notes/diagram.png",
          identity: resolvedIdentity(4),
        }),
        read: async () => ({ kind: "content", byteLength: 4, contentSha256: SHA_ONE }),
      },
    });
    const result = await resolver(
      source({ kind: "image", opaqueRef: "image:diagram" }),
      request([source({ kind: "image", opaqueRef: "image:diagram" })]),
      currentDefinition(),
    );
    expect(result).toMatchObject({ status: "ready" });
    if (result.status !== "ready") return;
    expect(result.refreshedDefinition?.blocks[1]).toMatchObject({
      kind: "image",
      alt: "diagram.png",
    });
  });

  it("returns a thread reference for an active observed thread", async () => {
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      threadState: () => threadState(),
      providerObserved: (instanceId) => instanceId === ids.provider,
    });
    const thread = source({ kind: "thread", opaqueRef: ids.thread, displayName: "Thread" });
    const result = await resolver(thread, request([thread]), currentDefinition());
    expect(result).toMatchObject({ status: "ready" });
    if (result.status !== "ready") return;
    expect(result.refreshedDefinition?.blocks[1]).toMatchObject({
      kind: "source-reference",
      label: "Research thread",
    });
    expect(result.observedVersion?.contentSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses ready when another approved source is unresolvable", async () => {
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      artifactState: (projectId, opaqueRef) =>
        opaqueRef === "artifact:source-a" ? artifactState() : undefined,
    });
    const result = await resolver(
      source(),
      request([source(), source({ sourceId: ids.sourceB, opaqueRef: "artifact:source-b" })]),
      currentDefinition(),
    );
    expect(result).toMatchObject({
      sourceId: ids.sourceA,
      status: "failed",
    });
  });

  it("produces the identical regenerated definition for every ready source", async () => {
    let artifactCalls = 0;
    let providerCalls = 0;
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      providerObserved: () => {
        providerCalls += 1;
        return true;
      },
      artifactState: () => {
        artifactCalls += 1;
        return artifactState();
      },
    });
    const sources = [
      source(),
      source({
        sourceId: ids.sourceB,
        opaqueRef: "artifact:source-b",
        displayName: "Source B",
      }),
    ];
    const requestWithSources = request(sources);
    const [first, second] = await Promise.all([
      resolver(sources[0] as never, requestWithSources, currentDefinition()),
      resolver(sources[1] as never, requestWithSources, currentDefinition()),
    ]);
    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    expect(artifactCalls).toBe(2);
    expect(providerCalls).toBe(1);
    if (first.status !== "ready" || second.status !== "ready") return;
    expect(JSON.stringify(first.refreshedDefinition)).toBe(
      JSON.stringify(second.refreshedDefinition),
    );
    expect(first.refreshedDefinition?.blocks).toHaveLength(3);
    expect(first.refreshedDefinition?.blocks[0]).toMatchObject({
      kind: "heading",
      text: "Original heading",
    });
  });

  it("refreshes every block bound to one source", async () => {
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      artifactState: () => artifactState(),
    });
    const current = {
      ...currentDefinition(),
      blocks: [
        {
          blockId: "source-ref-1",
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "source-reference",
          sourceId: ids.sourceA,
          label: "Old reference",
        },
        {
          blockId: "source-ref-2",
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "source-reference",
          sourceId: ids.sourceA,
          label: "Another old reference",
        },
      ],
    } as unknown as CanvasDefinition;
    const result = await resolver(source(), request([source()]), current);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.refreshedDefinition?.blocks).toHaveLength(2);
    expect(result.refreshedDefinition?.blocks[0]).toMatchObject({
      kind: "artifact-reference",
      blockId: "source-ref-1",
    });
    expect(result.refreshedDefinition?.blocks[1]).toMatchObject({
      kind: "artifact-reference",
      blockId: "source-ref-2",
    });
    expect(result.refreshedDefinition?.blocks[0]?.blockId).not.toBe(
      result.refreshedDefinition?.blocks[1]?.blockId,
    );
  });

  it("refuses ready when a citation cannot be regenerated from the refreshed source", async () => {
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      artifactState: () => artifactState(),
    });
    const current = {
      ...currentDefinition(),
      blocks: [
        {
          blockId: "citation-1",
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "citation",
          sourceId: ids.sourceA,
          label: "Stale citation",
        },
      ],
    } as unknown as CanvasDefinition;
    const result = await resolver(source(), request([source()]), current);
    expect(result).toMatchObject({ status: "incompatible" });
  });

  it("preserves static derived blocks that are not bound to a source", async () => {
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      artifactState: () => artifactState(),
    });
    const current = {
      ...currentDefinition(),
      blocks: [
        {
          blockId: "rich-text-1",
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "rich-text",
          text: "Derived from the artifact",
        },
      ],
    } as unknown as CanvasDefinition;
    const result = await resolver(source(), request([source()]), current);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.refreshedDefinition?.blocks[0]).toMatchObject({
      kind: "rich-text",
      text: "Derived from the artifact",
    });
  });

  it("allocates a unique ID when an unbound source block collides with existing content", async () => {
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      artifactState: () => artifactState(),
    });
    const current = {
      ...currentDefinition(),
      blocks: [
        {
          blockId: `ref:artifact:${ids.sourceA}`,
          schemaVersion: CANVAS_SCHEMA_VERSION,
          kind: "heading",
          level: 2,
          text: "Existing content",
        },
      ],
    } as unknown as CanvasDefinition;
    const result = await resolver(source(), request([source()]), current);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.refreshedDefinition?.blocks[1]?.blockId).toBe(`ref:artifact:${ids.sourceA}:1`);
  });

  it("never accepts renderer-supplied state and resolves by the canonical project", async () => {
    const resolver = createCanvasRefreshSourceResolver({
      clock: () => now as never,
      artifactState: (projectId, opaqueRef) => {
        expect(projectId).toBe(ids.project);
        expect(opaqueRef).toBe("artifact:source-a");
        return artifactState();
      },
    });
    const result = await resolver(source(), request(), currentDefinition());
    expect(result).toMatchObject({ status: "ready" });
    if (result.status !== "ready") return;
    expect(result.observedVersion?.contentSha256).toBe(SHA_ONE);
  });
});
