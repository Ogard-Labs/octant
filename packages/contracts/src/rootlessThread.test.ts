import { describe, expect, it } from "vitest";
import {
  ROOTLESS_EVENT_NAMES,
  MAX_ROOTLESS_TURN_FAILURE_BYTES,
  MAX_ROOTLESS_TURN_RESPONSE_BYTES,
  decodeRootlessThreadWorkspace,
  decodeProjectBackedThreadWorkspace,
  decodeThreadWorkspaceVariant,
  decodeRootlessThreadCreationContext,
  decodeCreateRootlessThreadCommand,
  decodeRootlessThreadCreateResult,
  decodeFolderAttachmentRequest,
  decodeFolderAttachmentResult,
  decodeComposerFolderEntry,
  decodeComposerFolderSelection,
  decodeRootlessThreadCreated,
  decodeRootlessFolderAttached,
  decodeRootlessFolderAttachmentDenied,
  decodeRootlessThreadSummary,
  decodeRootlessThreadListResult,
  decodeRootlessTurnLookupResult,
  decodeRootlessTurnUpdated,
  decodeStartRootlessThreadTurnCommand,
} from "./rootlessThread";

describe("rootlessThread contracts", () => {
  it("decodes an atomic rootless first-turn command and accepted lookup", () => {
    const command = decodeStartRootlessThreadTurnCommand({
      kind: "start-rootless-thread-turn",
      requestId: "00000000-0000-4000-8000-000000000020",
      threadId: "00000000-0000-4000-8000-000000000021",
      turnId: "00000000-0000-4000-8000-000000000022",
      title: "Unfiled brief",
      prompt: "Draft a launch brief",
      context: {
        hostId: "local",
        mode: "work",
        providerInstanceId: "00000000-0000-4000-8000-000000000003",
        modelId: "model-a",
        workspace: { kind: "rootless" },
      },
    });
    expect(command).toMatchObject({
      kind: "start-rootless-thread-turn",
      prompt: "Draft a launch brief",
    });

    const lookup = decodeRootlessTurnLookupResult({
      kind: "accepted",
      turn: {
        requestId: "00000000-0000-4000-8000-000000000020",
        threadId: "00000000-0000-4000-8000-000000000021",
        turnId: "00000000-0000-4000-8000-000000000022",
        status: "running",
        prompt: "Draft a launch brief",
        capabilities: {
          workspace: "rootless",
          rootBackedTools: {
            availability: "unavailable",
            reason:
              "Attach a folder to use filesystem, shell, Git, worktree, test, preview, office mutation, external editor, or delivery tools.",
          },
        },
        acceptedAt: "2026-07-29T10:00:00.000Z",
        updatedAt: "2026-07-29T10:00:00.000Z",
      },
    });
    expect(lookup.kind).toBe("accepted");
  });

  it("decodes ambiguous and non-created result lookup outcomes", () => {
    expect(
      decodeRootlessTurnLookupResult({
        kind: "ambiguous",
        requestId: "00000000-0000-4000-8000-000000000020",
        threadId: "00000000-0000-4000-8000-000000000021",
        turnId: "00000000-0000-4000-8000-000000000022",
        prompt: "Draft a launch brief",
        capabilities: {
          workspace: "rootless",
          rootBackedTools: {
            availability: "unavailable",
            reason:
              "Attach a folder to use filesystem, shell, Git, worktree, test, preview, office mutation, external editor, or delivery tools.",
          },
        },
        message: "The provider turn was accepted but its terminal outcome is unknown.",
        acceptedAt: "2026-07-29T10:00:00.000Z",
        updatedAt: "2026-07-29T10:01:00.000Z",
      }),
    ).toMatchObject({ kind: "ambiguous" });
    expect(
      decodeRootlessTurnLookupResult({
        kind: "not-created",
        requestId: "00000000-0000-4000-8000-000000000099",
        message: "No rootless turn was accepted for this request.",
      }),
    ).toMatchObject({ kind: "not-created" });
  });

  it("rejects renderer-supplied scratch paths for atomic first turns", () => {
    expect(() =>
      decodeStartRootlessThreadTurnCommand({
        kind: "start-rootless-thread-turn",
        requestId: "00000000-0000-4000-8000-000000000020",
        threadId: "00000000-0000-4000-8000-000000000021",
        turnId: "00000000-0000-4000-8000-000000000022",
        title: "Unfiled brief",
        prompt: "Draft a launch brief",
        context: {
          hostId: "local",
          mode: "code",
          providerInstanceId: "00000000-0000-4000-8000-000000000003",
          modelId: "model-a",
          workspace: { kind: "rootless", scratchDirectory: "/Users/example/project" },
        },
      }),
    ).toThrow();
  });

  it("rejects rootless turn responses and failures beyond persistence byte budgets", () => {
    const turn = {
      requestId: "00000000-0000-4000-8000-000000000020",
      threadId: "00000000-0000-4000-8000-000000000021",
      turnId: "00000000-0000-4000-8000-000000000022",
      status: "completed",
      prompt: "Draft a launch brief",
      capabilities: {
        workspace: "rootless",
        rootBackedTools: {
          availability: "unavailable",
          reason:
            "Attach a folder to use filesystem, shell, Git, worktree, test, preview, office mutation, external editor, or delivery tools.",
        },
      },
      acceptedAt: "2026-07-29T10:00:00.000Z",
      updatedAt: "2026-07-29T10:01:00.000Z",
    } as const;

    expect(() =>
      decodeRootlessTurnLookupResult({
        kind: "accepted",
        turn: { ...turn, response: "a".repeat(MAX_ROOTLESS_TURN_RESPONSE_BYTES + 1) },
      }),
    ).toThrow();
    expect(() =>
      decodeRootlessTurnUpdated({
        kind: "turn-updated",
        requestId: turn.requestId,
        threadId: turn.threadId,
        turnId: turn.turnId,
        status: "failed",
        failure: {
          category: "failed",
          message: "x".repeat(MAX_ROOTLESS_TURN_FAILURE_BYTES + 1),
        },
        updatedAt: turn.updatedAt,
      }),
    ).toThrow();
  });

  it("decodes a rootless workspace", () => {
    const ws = decodeRootlessThreadWorkspace({ kind: "rootless" });
    expect(ws.kind).toBe("rootless");
    expect(ws.scratchDirectory).toBeUndefined();
  });

  it("decodes a rootless workspace with scratch directory", () => {
    const ws = decodeRootlessThreadWorkspace({
      kind: "rootless",
      scratchDirectory: "/tmp/octant-scratch-abc",
    });
    expect(ws.scratchDirectory).toBe("/tmp/octant-scratch-abc");
  });

  it("decodes a project-backed workspace", () => {
    const ws = decodeProjectBackedThreadWorkspace({
      kind: "project-backed",
      projectId: "00000000-0000-0000-0000-000000000001",
    });
    expect(ws.kind).toBe("project-backed");
  });

  it("decodes workspace variant union", () => {
    expect(decodeThreadWorkspaceVariant({ kind: "rootless" }).kind).toBe("rootless");
    expect(
      decodeThreadWorkspaceVariant({
        kind: "project-backed",
        projectId: "00000000-0000-0000-0000-000000000001",
      }).kind,
    ).toBe("project-backed");
  });

  it("decodes rootless thread creation context", () => {
    const ctx = decodeRootlessThreadCreationContext({
      hostId: "local",
      mode: "work",
      providerInstanceId: "00000000-0000-0000-0000-000000000003",
      modelId: "model-a",
      workspace: { kind: "rootless" },
    });
    expect(ctx.mode).toBe("work");
    expect(ctx.workspace.kind).toBe("rootless");
  });

  it("rejects rootless context with chat mode", () => {
    expect(() =>
      decodeRootlessThreadCreationContext({
        hostId: "local",
        mode: "chat",
        providerInstanceId: "00000000-0000-0000-0000-000000000003",
        modelId: "model-a",
        workspace: { kind: "rootless" },
      }),
    ).toThrow();
  });

  it("decodes the authoritative rootless creation command and result", () => {
    const command = decodeCreateRootlessThreadCommand({
      kind: "create-rootless-thread",
      threadId: "00000000-0000-0000-0000-000000000011",
      title: "Unfiled brief",
      context: {
        hostId: "local",
        mode: "code",
        providerInstanceId: "00000000-0000-0000-0000-000000000003",
        modelId: "model-a",
        workspace: { kind: "rootless" },
      },
    });
    expect(command.kind).toBe("create-rootless-thread");
    expect(
      decodeRootlessThreadCreateResult({
        kind: "thread-created",
        threadId: command.threadId,
        mode: command.context.mode,
        title: command.title,
        workspace: command.context.workspace,
        createdAt: "2026-07-25T10:00:00.000Z",
      }).workspace.kind,
    ).toBe("rootless");
  });

  it("decodes folder attachment request", () => {
    const req = decodeFolderAttachmentRequest({
      attachmentId: "00000000-0000-0000-0000-000000000010",
      threadId: "00000000-0000-0000-0000-000000000011",
      projectId: "00000000-0000-0000-0000-000000000012",
      requestedAt: "2026-07-25T10:00:00.000Z",
    });
    expect(req.threadId).toBeDefined();
  });

  it("decodes folder attachment result - attached", () => {
    const result = decodeFolderAttachmentResult({
      kind: "attached",
      attachmentId: "00000000-0000-0000-0000-000000000010",
      threadId: "00000000-0000-0000-0000-000000000011",
      projectId: "00000000-0000-0000-0000-000000000012",
      attachedAt: "2026-07-25T10:00:00.000Z",
    });
    expect(result.kind).toBe("attached");
  });

  it("decodes folder attachment result - denied", () => {
    const result = decodeFolderAttachmentResult({
      kind: "denied",
      attachmentId: "00000000-0000-0000-0000-000000000010",
      threadId: "00000000-0000-0000-0000-000000000011",
      reason: "concurrent-turn",
      message: "Cannot attach during an active turn.",
    });
    expect(result.kind).toBe("denied");
  });

  it("decodes composer folder entries", () => {
    expect(
      decodeComposerFolderEntry({
        kind: "saved-project",
        projectId: "00000000-0000-0000-0000-000000000001",
        displayName: "My Project",
        rootPath: "/home/user/project",
      }).kind,
    ).toBe("saved-project");
    expect(decodeComposerFolderEntry({ kind: "add-folder" }).kind).toBe("add-folder");
    expect(decodeComposerFolderEntry({ kind: "no-folder" }).kind).toBe("no-folder");
  });

  it("decodes composer folder selection", () => {
    expect(
      decodeComposerFolderSelection({
        kind: "project",
        projectId: "00000000-0000-0000-0000-000000000001",
        displayName: "My Project",
      }).kind,
    ).toBe("project");
    expect(decodeComposerFolderSelection({ kind: "no-folder" }).kind).toBe("no-folder");
  });

  describe("rootless thread events", () => {
    const ids = {
      thread: "00000000-0000-4000-8000-000000000011",
      attachment: "00000000-0000-4000-8000-000000000010",
      project: "00000000-0000-4000-8000-000000000012",
      provider: "00000000-0000-4000-8000-000000000003",
    } as const;
    const now = "2026-07-25T10:00:00.000Z";

    it("exposes ROOTLESS_EVENT_NAMES with the expected entries", () => {
      expect(ROOTLESS_EVENT_NAMES).toContain("rootless.thread-created@1");
      expect(ROOTLESS_EVENT_NAMES).toContain("rootless.folder-attached@1");
      expect(ROOTLESS_EVENT_NAMES).toContain("rootless.folder-attachment-denied@1");
    });

    it("decodes rootless.thread-created", () => {
      const event = decodeRootlessThreadCreated({
        kind: "thread-created",
        threadId: ids.thread,
        title: "Unfiled brief",
        mode: "work",
        hostId: "local",
        providerInstanceId: ids.provider,
        modelId: "model-a",
        workspace: { kind: "rootless" },
        createdAt: now,
      });
      expect(event.kind).toBe("thread-created");
      expect(event.workspace.kind).toBe("rootless");
    });

    it("rejects thread-created with chat mode", () => {
      expect(() =>
        decodeRootlessThreadCreated({
          kind: "thread-created",
          threadId: ids.thread,
          mode: "chat",
          hostId: "local",
          providerInstanceId: ids.provider,
          modelId: "model-a",
          workspace: { kind: "rootless" },
          createdAt: now,
        }),
      ).toThrow();
    });

    it("decodes rootless.folder-attached", () => {
      const event = decodeRootlessFolderAttached({
        kind: "folder-attached",
        attachmentId: ids.attachment,
        threadId: ids.thread,
        projectId: ids.project,
        attachedAt: now,
      });
      expect(event.kind).toBe("folder-attached");
      expect(String(event.projectId)).toBe(ids.project);
    });

    it("decodes rootless.folder-attachment-denied for every typed reason", () => {
      const reasons = [
        "wrong-mode",
        "unavailable",
        "archived",
        "stale-binding",
        "disconnected-host",
        "concurrent-turn",
        "cancelled",
        "policy-denied",
      ] as const;
      for (const reason of reasons) {
        const event = decodeRootlessFolderAttachmentDenied({
          kind: "folder-attachment-denied",
          attachmentId: ids.attachment,
          threadId: ids.thread,
          reason,
          message: "Denied.",
          deniedAt: now,
        });
        expect(event.kind).toBe("folder-attachment-denied");
        expect(event.reason).toBe(reason);
      }
    });

    it("rejects folder-attachment-denied with an unknown reason", () => {
      expect(() =>
        decodeRootlessFolderAttachmentDenied({
          kind: "folder-attachment-denied",
          attachmentId: ids.attachment,
          threadId: ids.thread,
          reason: "unknown",
          message: "Denied.",
          deniedAt: now,
        }),
      ).toThrow();
    });
  });

  describe("rootless thread summary and list", () => {
    const threadId = "00000000-0000-4000-8000-000000000011";
    const projectId = "00000000-0000-4000-8000-000000000012";
    const now = "2026-07-25T10:00:00.000Z";

    it("decodes a rootless thread summary without projectId", () => {
      const summary = decodeRootlessThreadSummary({
        threadId,
        title: "Unfiled brief",
        mode: "work",
        hostId: "local",
        providerInstanceId: "00000000-0000-4000-8000-000000000003",
        modelId: "model-a",
        workspaceKind: "rootless",
        createdAt: now,
        updatedAt: now,
      });
      expect(summary.workspaceKind).toBe("rootless");
      expect(summary.hostId).toBe("local");
      expect(summary.projectId).toBeUndefined();
    });

    it("decodes a project-backed thread summary with projectId", () => {
      const summary = decodeRootlessThreadSummary({
        threadId,
        title: "Unfiled change",
        mode: "code",
        hostId: "local",
        providerInstanceId: "00000000-0000-4000-8000-000000000003",
        modelId: "model-a",
        workspaceKind: "project-backed",
        projectId,
        createdAt: now,
        updatedAt: now,
      });
      expect(summary.workspaceKind).toBe("project-backed");
      expect(String(summary.projectId)).toBe(projectId);
    });

    it("rejects a summary with chat mode", () => {
      expect(() =>
        decodeRootlessThreadSummary({
          threadId,
          title: "Invalid",
          mode: "chat",
          hostId: "local",
          providerInstanceId: "00000000-0000-4000-8000-000000000003",
          modelId: "model-a",
          workspaceKind: "rootless",
          createdAt: now,
          updatedAt: now,
        }),
      ).toThrow();
    });

    it("decodes a rootless thread list result with all three groups", () => {
      const result = decodeRootlessThreadListResult({
        recents: [
          {
            threadId,
            title: "Unfiled brief",
            mode: "work",
            hostId: "local",
            providerInstanceId: "00000000-0000-4000-8000-000000000003",
            modelId: "model-a",
            workspaceKind: "rootless",
            createdAt: now,
            updatedAt: now,
          },
        ],
        all: [
          {
            threadId,
            title: "Unfiled brief",
            mode: "work",
            hostId: "local",
            providerInstanceId: "00000000-0000-4000-8000-000000000003",
            modelId: "model-a",
            workspaceKind: "rootless",
            createdAt: now,
            updatedAt: now,
          },
        ],
        unfiled: [
          {
            threadId,
            title: "Unfiled brief",
            mode: "work",
            hostId: "local",
            providerInstanceId: "00000000-0000-4000-8000-000000000003",
            modelId: "model-a",
            workspaceKind: "rootless",
            createdAt: now,
            updatedAt: now,
          },
        ],
      });
      expect(result.recents).toHaveLength(1);
      expect(result.all).toHaveLength(1);
      expect(result.unfiled).toHaveLength(1);
    });

    it("decodes an empty list result", () => {
      const result = decodeRootlessThreadListResult({
        recents: [],
        all: [],
        unfiled: [],
      });
      expect(result.recents).toHaveLength(0);
      expect(result.all).toHaveLength(0);
      expect(result.unfiled).toHaveLength(0);
    });
  });
});
