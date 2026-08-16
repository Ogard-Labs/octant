import { describe, expect, it } from "vitest";
import {
  CANVAS_REFRESH_MAX_PARAMETERS,
  decodeCanvasRefreshCancelRequest,
  decodeCanvasRefreshRequest,
  decodeCanvasRefreshResult,
} from "./canvasRefresh";

const ids = {
  canvas: "11111111-1111-4111-8111-111111111111",
  request: "22222222-2222-4222-8222-222222222222",
  recipe: "33333333-3333-4333-8333-333333333333",
  thread: "44444444-4444-4444-8444-444444444444",
  provider: "55555555-5555-4555-8555-555555555555",
  actor: "66666666-6666-4666-8666-666666666666",
  source: "77777777-7777-4777-8777-777777777777",
} as const;

const request = {
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
    parameters: [{ key: "range", value: "opaque:current" }],
    sourceManifest: [
      {
        sourceId: ids.source,
        kind: "artifact",
        hostId: "local",
        projectId: "88888888-8888-4888-8888-888888888888",
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
} as const;

describe("Canvas refresh contracts", () => {
  it("round-trips a bounded recipe and request without credentials", () => {
    expect(decodeCanvasRefreshRequest(request)).toEqual(request);
  });

  it("requires the canonical qualified skill identity", () => {
    const qualifiedId =
      "agents-skills-directory:project:review:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const withSkill = {
      ...request,
      recipe: { ...request.recipe, skill: { qualifiedId, version: "1.0.0" } },
    } as const;
    expect(decodeCanvasRefreshRequest(withSkill).recipe.skill).toEqual({
      qualifiedId,
      version: "1.0.0",
    });
    expect(
      decodeCanvasRefreshRequest({
        ...request,
        recipe: { ...request.recipe, skill: { qualifiedId } },
      }).recipe.skill,
    ).toEqual({ qualifiedId });
    expect(() =>
      decodeCanvasRefreshRequest({
        ...request,
        recipe: {
          ...request.recipe,
          skill: {
            extensionId: "10000000-0000-4000-8000-000000000001",
            version: "1.0.0",
          },
        },
      }),
    ).toThrow();
  });

  it("rejects secret-shaped fields and oversized parameter lists", () => {
    expect(() => decodeCanvasRefreshRequest({ ...request, secret: "never" })).toThrow();
    expect(() =>
      decodeCanvasRefreshRequest({
        ...request,
        recipe: {
          ...request.recipe,
          parameters: Array.from({ length: CANVAS_REFRESH_MAX_PARAMETERS + 1 }, (_, index) => ({
            key: `key-${index}`,
            value: "value",
          })),
        },
      }),
    ).toThrow();
  });

  it("round-trips cancellation and typed source outcomes", () => {
    const cancel = {
      schemaVersion: 1,
      kind: "canvas-refresh-cancel",
      requestId: ids.request,
      recipeId: ids.recipe,
      canvasId: ids.canvas,
    } as const;
    expect(decodeCanvasRefreshCancelRequest(cancel)).toEqual(cancel);
    expect(
      decodeCanvasRefreshResult({
        kind: "accepted",
        receipt: {
          schemaVersion: 1,
          kind: "canvas-refresh-receipt",
          requestId: ids.request,
          recipeId: ids.recipe,
          canvasId: ids.canvas,
          outcome: "partial",
          sources: [{ sourceId: ids.source, status: "stale", message: "Source changed." }],
          completedAt: "2026-08-03T10:01:00.000Z",
        },
      }),
    ).toMatchObject({ kind: "accepted", receipt: { outcome: "partial" } });
  });
});
