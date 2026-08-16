import { describe, expect, it } from "vitest";
import {
  decodeCanvasRefreshRequest,
  decodeCanvasVersion,
  decodeCanvasVersionId,
  type CanvasRefreshRequest,
} from "@octant/contracts";
import {
  CanvasRefreshPolicyRejected,
  buildCanvasRefreshVersion,
  classifyCanvasRefreshOutcome,
  validateCanvasRefreshRequest,
} from "./canvasRefreshPolicy";

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111",
  version: "22222222-2222-4222-8222-222222222222",
  nextVersion: "33333333-3333-4333-8333-333333333333",
  request: "44444444-4444-4444-8444-444444444444",
  recipe: "55555555-5555-4555-8555-555555555555",
  source: "66666666-6666-4666-8666-666666666666",
  thread: "77777777-7777-4777-8777-777777777777",
  project: "88888888-8888-4888-8888-888888888888",
  provider: "99999999-9999-4999-8999-999999999999",
  actor: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
} as const;

const request = decodeCanvasRefreshRequest({
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
    modelId: "model",
    parameters: [],
    sourceManifest: [
      {
        sourceId: ids.source,
        kind: "artifact",
        hostId: "local",
        projectId: ids.project,
        opaqueRef: "artifact:one",
        displayName: "Artifact",
        sourceVersion: {
          contentSha256: "0000000000000000000000000000000000000000000000000000000000000000",
          observedAt: "2026-08-03T10:00:00.000Z",
        },
      },
    ],
  },
  expectedSequence: 1,
  hostId: "local",
  mode: "chat",
  workspace: { kind: "chat-virtual", projectId: null },
  originThreadId: ids.thread,
  actor: { kind: "local-user", actorId: ids.actor },
  providerInstanceId: ids.provider,
  modelId: "model",
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
});

const current = decodeCanvasVersion({
  schemaVersion: 1 as const,
  canvasId: ids.canvas,
  versionId: ids.version,
  sequence: 1,
  definition: {
    schemaVersion: 1 as const,
    title: "Refreshable",
    provenance: {
      mode: "chat" as const,
      hostId: "local",
      projectId: ids.project,
      threadId: ids.thread,
      actor: { kind: "local-user" as const, actorId: ids.actor },
      providerInstanceId: ids.provider,
      modelId: "model",
      createdAt: "2026-08-03T10:00:00.000Z",
    },
    sourceManifest: request.recipe.sourceManifest,
    blocks: [
      {
        blockId: "heading",
        schemaVersion: 1 as const,
        kind: "heading" as const,
        level: 1,
        text: "Refreshable",
      },
    ],
  },
  createdBy: { kind: "local-user" as const, actorId: ids.actor },
  createdAt: "2026-08-03T10:00:00.000Z",
});

describe("Canvas refresh policy", () => {
  it("reauthorizes the exact host, mode, Project, thread, provider, and workspace", () => {
    expect(() =>
      validateCanvasRefreshRequest({
        request,
        current,
        context: { mode: "chat", projectId: ids.project, hostId: "other-host" },
      }),
    ).toThrowError(CanvasRefreshPolicyRejected);
    expect(() =>
      validateCanvasRefreshRequest({
        request,
        current,
        context: { mode: "chat", projectId: ids.project, hostId: "local" },
      }),
    ).not.toThrow();
    expect(() =>
      validateCanvasRefreshRequest({
        request,
        current,
        context: {
          mode: "chat",
          projectId: ids.project,
          hostId: "local",
          workspace: {
            kind: "work-root",
            projectId: ids.project as never,
            rootId: ids.thread as never,
          },
        },
      }),
    ).toThrow(/server scope|workspace/i);
  });

  it("persists only server-owned opaque references, never free-form values", () => {
    // A raw/free-form value (even a secret-shaped one) cannot be represented as
    // a recipe parameter and is rejected before any receipt is journaled.
    expect(() =>
      validateCanvasRefreshRequest({
        request: {
          ...request,
          recipe: {
            ...request.recipe,
            parameters: [{ key: "api-key", value: "sk-secret-value" }],
          },
        } as unknown as CanvasRefreshRequest,
        current,
        context: { mode: "chat", projectId: ids.project, hostId: "local" },
      }),
    ).toThrow(/opaque|malformed/i);
    expect(() =>
      validateCanvasRefreshRequest({
        request: {
          ...request,
          recipe: {
            ...request.recipe,
            parameters: [{ key: "range", value: "opaque:renderer-forged" }],
          },
        } as unknown as CanvasRefreshRequest,
        current,
        context: { mode: "chat", projectId: ids.project, hostId: "local" },
      }),
    ).not.toThrow();
    expect(() =>
      validateCanvasRefreshRequest({
        request: {
          ...request,
          recipe: {
            ...request.recipe,
            parameters: [
              {
                key: "token",
                value: "literal:eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
              },
            ],
          },
        } as unknown as CanvasRefreshRequest,
        current,
        context: { mode: "chat", projectId: ids.project, hostId: "local" },
      }),
    ).toThrow(/opaque|malformed/i);
  });

  it("rejects source-free refresh requests before source work", () => {
    expect(() =>
      validateCanvasRefreshRequest({
        request: {
          ...request,
          recipe: { ...request.recipe, sourceManifest: [] },
        } as unknown as CanvasRefreshRequest,
        current,
        context: { mode: "chat", projectId: ids.project, hostId: "local" },
      }),
    ).toThrow(/malformed/i);
  });

  it("reports honest partial, cancelled, and failed outcomes", () => {
    expect(classifyCanvasRefreshOutcome([{ status: "ready" }])).toBe("ready");
    expect(classifyCanvasRefreshOutcome([{ status: "stale" }])).toBe("partial");
    expect(classifyCanvasRefreshOutcome([{ status: "interrupted" }])).toBe("cancelled");
    expect(classifyCanvasRefreshOutcome([{ status: "failed" }])).toBe("failed");
  });

  it("creates a new immutable version only from ready observations", () => {
    const next = buildCanvasRefreshVersion({
      canvasId: request.canvasId,
      current,
      nextVersionId: decodeCanvasVersionId(ids.nextVersion),
      request,
      sources: [
        {
          sourceId: request.recipe.sourceManifest[0]!.sourceId,
          status: "ready",
          observedVersion: {
            contentSha256: "1111111111111111111111111111111111111111111111111111111111111111",
            observedAt: "2026-08-03T10:01:00.000Z" as never,
          },
        },
      ],
      createdAt: "2026-08-03T10:01:00.000Z" as never,
    });
    expect(next.sequence).toBe(2);
    expect(next.versionId).toBe(ids.nextVersion);
    expect(next.definition.sourceManifest[0]?.sourceVersion?.contentSha256).toBe(
      "1111111111111111111111111111111111111111111111111111111111111111",
    );
  });

  it("rejects a source-free refresh without regenerated content", () => {
    expect(() =>
      buildCanvasRefreshVersion({
        canvasId: request.canvasId,
        current,
        nextVersionId: decodeCanvasVersionId(ids.nextVersion),
        request: { ...request, recipe: { ...request.recipe, sourceManifest: [] } },
        sources: [],
        createdAt: "2026-08-03T10:00:00.000Z" as never,
      }),
    ).toThrow(/source-free/i);
  });
});
