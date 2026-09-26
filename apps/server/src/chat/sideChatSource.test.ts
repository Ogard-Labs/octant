import { describe, expect, it, vi } from "vitest";
import {
  MAX_SIDE_CHAT_SOURCE_CHANGED_PATHS,
  decodeCodeEnvironmentObservation,
  decodeMentionableThreadId,
  decodeWindowId,
  type ProjectId,
  type SideChatSidecar,
  type UtcTimestamp,
} from "@octant/contracts";
import { createSideChatSourceStateReader, resolveSideChatSourceContext } from "./sideChatSource";

const windowId = decodeWindowId("00000000-0000-4000-8000-000000000001");
const codeThreadId = decodeMentionableThreadId("00000000-0000-4000-8000-000000000301");
const projectId = "00000000-0000-4000-8000-000000000501" as ProjectId;

function changedTurn(paths: ReadonlyArray<string>, truncated = false) {
  return {
    changedFiles: {
      files: paths.map((path) => ({ path, insertions: 3, deletions: 1 })),
      total: paths.length,
      truncated,
    },
  } as never;
}

function codePorts(turns: ReadonlyArray<never>) {
  return {
    readThread: vi.fn(async () => ({
      projectId,
      workingDirectory: "apps/web",
      deliveryTarget: {
        outcomeKind: "opened-pr",
        branchIntent: "feature/picker",
        remoteName: "origin",
        proposedBaseRepository: "octant/octant",
        proposedBaseBranch: "main",
      },
    })),
    observeCheckout: vi.fn(async () => ({
      observation: decodeCodeEnvironmentObservation({
        status: "ready",
        projectId,
        projectName: "Octant",
        observedAt: "2026-09-26T10:00:00.000Z",
        repositoryRoot: "/repo",
        worktreeRoot: "/repo",
        branch: { kind: "named", name: "feature/picker" },
        changes: "dirty",
        insertions: 42,
        deletions: 7,
      }),
      changedFiles: {
        files: [
          { path: "README.md", change: "modified", insertions: 1, deletions: 0 },
          { path: "NOTES.md", change: "untracked" },
        ],
        total: 2,
      },
    })),
    conversation: vi.fn(async () => ({ turns, nextCursor: 0, hasMore: false })),
  };
}

describe("Side Chat source state", () => {
  it("describes a Code source's branch, diff stat, changed files, delivery target, and subagent results", async () => {
    const reader = createSideChatSourceStateReader({
      code: codePorts([changedTurn(["src/old.ts"]), changedTurn(["src/picker.ts", "src/old.ts"])]),
      subagents: () => [
        {
          role: "research",
          task: "Find where the picker registers directories",
          lifecycleStatus: "completed",
          result: { reference: "r1" },
          resultText: "The directory is registered in server.ts.",
          updatedAt: "2026-09-26T09:00:00.000Z",
        },
      ],
    });

    const text = await contextFor(reader);

    expect(text).toContain("Checkout: branch feature/picker, uncommitted changes (+42 -7");
    expect(text).toContain("Working folder: apps/web.");
    // What Git sees now, including a file no turn touched and one nobody added.
    expect(text).toContain("Uncommitted files from Git (2):");
    expect(text).toContain("- README.md (modified, +1 -0)");
    expect(text).toContain("- NOTES.md (untracked)");
    expect(text).toContain("Delivery target: opened-pr on branch feature/picker");
    // Newest turn first, each path once.
    expect(text.indexOf("- src/picker.ts (+3 -1)")).toBeLessThan(text.indexOf("- src/old.ts"));
    expect(text.match(/- src\/old\.ts/g)).toHaveLength(1);
    expect(text).toContain("research, completed: Find where the picker registers directories");
    expect(text).toContain("Result: The directory is registered in server.ts.");
  });

  it("caps the changed-file list and says it was truncated", async () => {
    const paths = Array.from({ length: 80 }, (_, index) => `src/file-${index}.ts`);
    const reader = createSideChatSourceStateReader({ code: codePorts([changedTurn(paths)]) });

    const text = await contextFor(reader);

    expect(text.match(/^- src\/file-/gm)).toHaveLength(MAX_SIDE_CHAT_SOURCE_CHANGED_PATHS);
    expect(text).toContain("the list is truncated");
  });

  it("says the checkout could not be observed instead of calling it clean", async () => {
    const ports = codePorts([]);
    ports.observeCheckout.mockRejectedValue(new Error("git unavailable"));
    const reader = createSideChatSourceStateReader({ code: ports });

    const text = await contextFor(reader);

    expect(text).toContain("Checkout: could not be observed");
    expect(text).toContain("Uncommitted files: Git could not list them");
    expect(text).not.toContain("no uncommitted changes");
  });

  it("refuses the turn when the source transcript is unreadable, whatever the state says", async () => {
    const readState = vi.fn();
    const result = await resolveSideChatSourceContext(
      {
        findSidecar: () => sidecar(),
        resolveSource: async () => ({ kind: "unreadable" }),
        readState,
      },
      { sidecarThreadId: "sidecar", windowId, readToolNames: [] },
    );

    expect(result).toEqual({ kind: "unreadable" });
    expect(readState).not.toHaveBeenCalled();
  });
});

function sidecar(): SideChatSidecar {
  return {
    sourceThreadId: codeThreadId,
    sourceMode: "code",
    sidecarThreadId: "00000000-0000-4000-8000-000000000201" as never,
    title: "Side Chat about Fix the picker",
    createdAt: "2026-09-26T08:00:00.000Z" as UtcTimestamp,
  };
}

async function contextFor(
  reader: ReturnType<typeof createSideChatSourceStateReader>,
): Promise<string> {
  const result = await resolveSideChatSourceContext(
    {
      findSidecar: () => sidecar(),
      resolveSource: async () => ({
        kind: "resolved",
        source: {
          threadId: codeThreadId,
          mode: "code",
          title: "Fix the picker",
          placement: { kind: "project", label: "Octant" },
          transcript: [],
          truncated: false,
        },
      }),
      readState: reader,
    },
    { sidecarThreadId: "sidecar", windowId, readToolNames: [] },
  );
  if (result?.kind !== "resolved") throw new Error("expected resolved context");
  return result.text;
}
