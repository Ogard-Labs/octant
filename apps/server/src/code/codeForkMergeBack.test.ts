import {
  decodeCodeOperationId,
  decodeCodeThread,
  type CodeThread,
  type WindowId,
} from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_PENDING_FORK_MERGES,
  mergeForkConversation,
  type CodeForkMergeBackPorts,
} from "./codeForkMergeBack";

const sourceId = "90000000-0000-4000-8000-000000000001";
const forkId = "90000000-0000-4000-8000-000000000002";
const otherForkId = "90000000-0000-4000-8000-000000000003";
const through = "90000000-0000-4000-8000-000000000090";

function codeThread(id: string, forkedFrom?: CodeThread["forkedFrom"]): CodeThread {
  return decodeCodeThread({
    id,
    projectId: "90000000-0000-4000-8000-000000000006",
    bindingRevisionId: "90000000-0000-4000-8000-000000000007",
    repositoryId: `repo_${"a".repeat(64)}`,
    checkoutId: "90000000-0000-4000-8000-000000000009",
    title: "Runtime",
    lifecycle: "active",
    providerInstanceId: "90000000-0000-4000-8000-000000000008",
    modelId: "model-a",
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/runtime",
      remoteName: "origin",
      proposedBaseRepository: "octant/octant",
      proposedBaseBranch: "development",
      outcomeKind: "opened-pr",
      confirmedAt: "2026-10-12T00:00:00.000Z",
    },
    version: 1,
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    ...(forkedFrom === undefined ? {} : { forkedFrom }),
  });
}

function merge(n: number, fork = otherForkId) {
  return {
    operationId: `90000000-0000-4000-8000-${String(1000 + n).padStart(12, "0")}`,
    event: { kind: "fork-context-merged", forkThreadId: fork, throughOperationId: through },
  };
}

function ports(merges: ReturnType<CodeForkMergeBackPorts["events"]["forkContextMerges"]>) {
  const fork = codeThread(forkId, { threadId: sourceId as never, throughOperationId: through });
  const source = codeThread(sourceId);
  const append = vi.fn();
  const read = vi.fn();
  const value: CodeForkMergeBackPorts = {
    read,
    readThread: (id) =>
      String(id) === forkId ? fork : String(id) === sourceId ? source : undefined,
    canAccessProject: async () => true,
    forkTurns: () => [],
    events: { append, forkContextMerges: () => merges },
    putEvidence: vi.fn(),
    uuid: () => "90000000-0000-4000-8000-0000000000aa",
  };
  return { value, append, read };
}

const input = {
  windowId: "window" as unknown as WindowId,
  forkThreadId: forkId as never,
  throughOperationId: through,
};

describe("merging a fork back while the source has merges waiting", () => {
  it.each(["grant", "competing-merge"] as const)(
    "refuses a merge when %s changes during original-input preparation",
    async (changed) => {
      const fixture = ports({ merges: [], complete: true });
      let granted = true;
      let competing = false;
      const source = codeThread(sourceId);
      const original = {
        source: { mode: "code" as const, threadId: forkId, attachmentId: through },
        displayName: "Original.png",
        mediaType: "image/png",
        byteLength: 3,
        digest: "a".repeat(64),
      };
      fixture.read.mockReturnValue({
        status: "available",
        blocks: [
          { kind: "instructions", text: "Selected fork text" },
          { kind: "user-message", text: "Original prompt" },
        ],
        source: {
          mode: "code",
          threadId: forkId,
          projectId: String(source.projectId),
          threadVersion: 1,
          externalContentIngested: false,
          point: {},
        },
        omissions: {
          earlierMessages: 0,
          unfinishedReplies: 0,
          missingBodies: 0,
          oversizedBodies: 0,
          emptyBodies: 0,
          attachments: 1,
          truncatedMessages: 0,
          truncatedCharacters: 0,
          sourceTruncatedMessages: 0,
        },
        inputs: [original],
      });
      const result = await mergeForkConversation(
        {
          ...fixture.value,
          canAccessProject: async () => granted,
          forkTurns: () => [{ operationId: decodeCodeOperationId(through), status: "completed" }],
          events: {
            ...fixture.value.events,
            forkContextMerges: () => ({
              merges: competing ? ([merge(1)] as never) : [],
              complete: true,
            }),
          },
          conversationInputTransfer: {
            prepare: async () => {
              if (changed === "grant") granted = false;
              else competing = true;
              return {
                status: "ready",
                attachments: [],
                manifest: { version: 1, purpose: "fork-merge-back", items: [] },
              };
            },
          },
        },
        input,
      );
      expect(result).toMatchObject({
        status: "refused",
        reason: changed === "grant" ? "source-unauthorized" : "source-unavailable",
      });
      expect(fixture.append).not.toHaveBeenCalled();
    },
  );

  it("refuses once the source already has the most merges a source may hold waiting", async () => {
    const fixture = ports({
      merges: Array.from({ length: MAX_PENDING_FORK_MERGES }, (_, n) => merge(n)) as never,
      complete: true,
    });
    expect(await mergeForkConversation(fixture.value, input)).toEqual({
      status: "refused",
      reason: "merges-pending",
    });
    expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.append).not.toHaveBeenCalled();
  });

  it("refuses when an earlier merge of this fork could lie beyond the journal read", async () => {
    const fixture = ports({
      merges: [merge(1), merge(2)] as never,
      lastDeliveredOperationId: merge(2).operationId as never,
      complete: false,
    });
    expect(await mergeForkConversation(fixture.value, input)).toEqual({
      status: "refused",
      reason: "source-unavailable",
    });
    expect(fixture.append).not.toHaveBeenCalled();
  });
});
