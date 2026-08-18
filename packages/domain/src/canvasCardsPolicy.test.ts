import { describe, expect, it } from "vitest";
import type { CanvasWorkspaceScope } from "@octant/contracts/canvas-cards";
import {
  CanvasCardsPolicyRejected,
  admitCanvasCreate,
  authorizeCanvasCreateRequest,
  buildCreateVersion,
  canvasCreateDenialReason,
  clampCanvasAuthority,
  validateCanvasThreadReferenceCard,
} from "./canvasCardsPolicy";

const requestId = "20000000-0000-4000-8000-000000000000";
const threadId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const otherProjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const rootId = "33333333-3333-4333-8333-333333333333";
const bindingRevisionId = "44444444-4444-4444-8444-444444444444";
const checkoutId = "55555555-5555-4555-8555-555555555555";
const repositoryId = `repo_${"a".repeat(64)}`;
const creatorId = "66666666-6666-4666-8666-666666666666";
const canvasId = "77777777-7777-4777-8777-777777777777";
const versionId = "88888888-8888-4888-8888-888888888888";
const actorId = "99999999-9999-4999-8999-999999999999";
const providerInstanceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const safeAuthority = {
  filesystem: false,
  shell: false,
  git: false,
  network: false,
  tools: true,
  subagents: false,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
} as const;

function chatRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "canvas-create",
    requestId,
    intent: "blank",
    hostId: "local",
    mode: "chat",
    workspace: { kind: "chat-virtual", projectId: null },
    originThreadId: threadId,
    title: "Chat canvas",
    sourceManifest: [],
    requestedAuthority: safeAuthority,
    ...overrides,
  };
}

function workRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...chatRequest(),
    mode: "work",
    workspace: { kind: "work-root", projectId, rootId },
    ...overrides,
  };
}

function codeRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...chatRequest(),
    mode: "code",
    workspace: {
      kind: "code-worktree",
      projectId,
      repositoryId,
      bindingRevisionId,
      checkoutId,
      verified: true,
    },
    ...overrides,
  };
}

function expectDenial(action: () => unknown, code: string) {
  try {
    action();
    throw new Error(`expected denial ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CanvasCardsPolicyRejected);
    expect((error as CanvasCardsPolicyRejected).denialCode).toBe(code);
  }
}

describe("Canvas cards policy cross-mode denial", () => {
  it("admits a safe Chat, Work, and Code create request", () => {
    expect(canvasCreateDenialReason(chatRequest())).toBeNull();
    expect(canvasCreateDenialReason(workRequest())).toBeNull();
    expect(canvasCreateDenialReason(codeRequest())).toBeNull();
  });

  it("rejects a mode/workspace cross-match as fail-closed", () => {
    expect(
      canvasCreateDenialReason(
        chatRequest({ workspace: { kind: "work-root", projectId, rootId } }),
      ),
    ).toBe("malformed-request");
    expect(canvasCreateDenialReason(workRequest({ originThreadId: "not-a-valid-uuid" }))).toBe(
      "malformed-request",
    );
  });

  it("fails closed for malformed requests", () => {
    expect(canvasCreateDenialReason({})).toBe("malformed-request");
    expect(canvasCreateDenialReason(chatRequest({ intent: "prompt" }))).toBe("malformed-request");
  });

  it("denies a Chat Canvas implicit filesystem/shell/Git authority", () => {
    expectDenial(
      () =>
        clampCanvasAuthority({
          requestedAuthority: { ...safeAuthority, filesystem: true },
          scope: { kind: "chat-virtual", projectId: null } as CanvasWorkspaceScope,
        }),
      "chat-implicit-authority",
    );
    expectDenial(
      () =>
        clampCanvasAuthority({
          requestedAuthority: { ...safeAuthority, shell: true },
          scope: { kind: "chat-virtual", projectId: null } as CanvasWorkspaceScope,
        }),
      "chat-implicit-authority",
    );
    expectDenial(
      () =>
        clampCanvasAuthority({
          requestedAuthority: { ...safeAuthority, git: true },
          scope: { kind: "chat-virtual", projectId: null } as CanvasWorkspaceScope,
        }),
      "chat-implicit-authority",
    );
    expect(
      canvasCreateDenialReason(
        chatRequest({ requestedAuthority: { ...safeAuthority, filesystem: true } }),
      ),
    ).toBe("chat-implicit-authority");
  });

  it("denies a Work Canvas implicit shell/Git authority", () => {
    const scope = {
      kind: "work-root",
      projectId,
      rootId,
    } as const as unknown as CanvasWorkspaceScope;
    expectDenial(
      () => clampCanvasAuthority({ requestedAuthority: { ...safeAuthority, shell: true }, scope }),
      "work-implicit-authority",
    );
    expectDenial(
      () => clampCanvasAuthority({ requestedAuthority: { ...safeAuthority, git: true }, scope }),
      "work-implicit-authority",
    );
    expect(
      canvasCreateDenialReason(
        workRequest({ requestedAuthority: { ...safeAuthority, shell: true } }),
      ),
    ).toBe("work-implicit-authority");
  });

  it("requires a verified worktree for a Code Canvas", () => {
    expectDenial(
      () =>
        clampCanvasAuthority({
          requestedAuthority: safeAuthority,
          scope: {
            kind: "code-worktree",
            projectId,
            repositoryId,
            bindingRevisionId,
            checkoutId,
            verified: false,
          } as CanvasWorkspaceScope,
        }),
      "code-worktree-unverified",
    );
    expect(
      canvasCreateDenialReason(
        codeRequest({
          workspace: {
            kind: "code-worktree",
            projectId,
            repositoryId,
            bindingRevisionId,
            checkoutId,
            verified: false,
          },
        }),
      ),
    ).toBe("code-worktree-unverified");
  });
});

describe("Canvas create admission", () => {
  it("produces a ready receipt for a valid request", () => {
    const result = admitCanvasCreate({
      request: chatRequest({ intent: "prompt", prompt: "Make a plan" }),
      receiptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      canvasId,
      versionId,
      now: "2026-08-01T21:00:00.000Z" as never,
    });
    expect(result.kind).toBe("accepted");
    expect(result.receipt).toMatchObject({
      kind: "canvas-create-receipt",
      intent: "prompt",
      outcome: "ready",
      canvasId,
      scope: { hostId: "local", mode: "chat" },
    });
  });

  it("propagates a mode authority denial on admission", () => {
    expectDenial(
      () =>
        admitCanvasCreate({
          request: chatRequest({ requestedAuthority: { ...safeAuthority, filesystem: true } }),
          receiptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          canvasId,
          versionId,
          now: "2026-08-01T21:00:00.000Z" as never,
        }),
      "chat-implicit-authority",
    );
  });

  it("rejects an invalid version identity before receipt construction", () => {
    expectDenial(
      () =>
        admitCanvasCreate({
          request: chatRequest({ intent: "prompt", prompt: "Make a plan" }),
          receiptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          canvasId,
          versionId: "not-a-uuid",
          now: "2026-08-01T21:00:00.000Z" as never,
        }),
      "malformed-request",
    );
  });
});

describe("Canvas create version projection", () => {
  it("starts an unauthored canvas as its title, never as its prompt read back", () => {
    const request = authorizeCanvasCreateRequest({
      request: chatRequest({
        workspace: { kind: "chat-virtual", projectId },
        intent: "prompt",
        prompt: "Explain the release risk.",
      }),
      activeContext: { mode: "chat", projectId },
    });
    const admitted = admitCanvasCreate({
      request,
      receiptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      canvasId,
      versionId,
      now: "2026-08-01T21:00:00.000Z" as never,
    });
    const version = buildCreateVersion({
      request,
      admitted,
      canvasId: canvasId as never,
      versionId: versionId as never,
      projectId: projectId as never,
      actor: { kind: "local-user", actorId: actorId as never },
      providerInstanceId: providerInstanceId as never,
      modelId: "octant-test-model" as never,
      createdAt: "2026-08-01T21:00:00.000Z" as never,
    });
    expect(version.sequence).toBe(1);
    // A canvas nobody has written yet is its title, not its prompt read back:
    // the request that asked for it is provenance, and putting it on the page
    // would present the question as though it were the answer.
    expect(version.definition.blocks.map((block) => block.kind)).toEqual(["heading"]);
    expect(JSON.stringify(version.definition.blocks)).not.toContain("Explain the release risk.");
  });

  it("takes an author's blocks as the document itself", () => {
    const request = authorizeCanvasCreateRequest({
      request: chatRequest({
        workspace: { kind: "chat-virtual", projectId },
        intent: "prompt",
        prompt: "Draw how the host is put together.",
      }),
      activeContext: { mode: "chat", projectId },
    });
    const admitted = admitCanvasCreate({
      request,
      receiptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      canvasId,
      versionId,
      now: "2026-08-01T21:00:00.000Z" as never,
    });

    const version = buildCreateVersion({
      request,
      admitted,
      canvasId: canvasId as never,
      versionId: versionId as never,
      projectId: projectId as never,
      actor: { kind: "local-user", actorId: actorId as never },
      providerInstanceId: providerInstanceId as never,
      modelId: "octant-test-model" as never,
      createdAt: "2026-08-01T21:00:00.000Z" as never,
      blocks: [
        {
          blockId: "authored-heading" as never,
          schemaVersion: 1 as never,
          kind: "heading",
          level: 1,
          text: "How the host is put together",
        },
        {
          blockId: "authored-diagram" as never,
          schemaVersion: 1 as never,
          kind: "diagram",
          nodes: [
            { nodeId: "renderer" as never, label: "Renderer" },
            { nodeId: "server" as never, label: "Server" },
          ],
          edges: [
            { edgeId: "commands" as never, source: "renderer" as never, target: "server" as never },
          ],
        },
      ] as never,
    });

    expect(version.definition.blocks.map((block) => block.kind)).toEqual(["heading", "diagram"]);
  });

  it("rejects a create request bound to another active Project", () => {
    expectDenial(
      () =>
        authorizeCanvasCreateRequest({
          request: chatRequest({ workspace: { kind: "chat-virtual", projectId } }),
          activeContext: { mode: "chat", projectId: otherProjectId },
        }),
      "scope-mismatch",
    );
  });
});

describe("Canvas thread reference card validation", () => {
  function card(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      kind: "canvas-reference-card",
      cardId: creatorId,
      canvasId,
      versionId,
      title: "Canvas card",
      scope: {
        hostId: "local",
        mode: "chat",
        workspace: { kind: "chat-virtual", projectId: null },
      },
      originThreadId: threadId,
      status: "ready",
      authority: safeAuthority,
      actorId,
      providerInstanceId,
      modelId: "octant-test-model",
      createdAt: "2026-08-01T21:00:00.000Z",
      actionCount: 0,
      ...overrides,
    };
  }

  it("validates a well-formed card", () => {
    const validated = validateCanvasThreadReferenceCard(card());
    expect(validated.kind).toBe("canvas-reference-card");
    expect(validated.actionCount).toBe(0);
  });

  it("rejects an action budget overflow", () => {
    expectDenial(
      () => validateCanvasThreadReferenceCard(card({ actionCount: 17 })),
      "malformed-request",
    );
  });

  it("rejects a card whose authority exceeds its scope", () => {
    expectDenial(
      () =>
        validateCanvasThreadReferenceCard(
          card({ authority: { ...safeAuthority, filesystem: true } }),
        ),
      "chat-implicit-authority",
    );
  });

  it("rejects a malformed card", () => {
    expectDenial(() => validateCanvasThreadReferenceCard({}), "malformed-request");
  });
});
