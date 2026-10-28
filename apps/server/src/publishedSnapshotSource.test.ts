import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it } from "vitest";

import { makePublishedSnapshotSource } from "./publishedSnapshotSource";

const windowId = decodeWindowId("abababab-abab-4bab-8bab-000000000801");
const threadId = "abababab-abab-4bab-8bab-000000000802";
const snapshot = { format: "html", content: "<h1>Report</h1>" } as const;
const published = { url: "https://claude.ai/artifact/a", snapshot };

describe("a thread's published page snapshot", () => {
  it("is found only in the asked thread's own steps, read through its authority", async () => {
    const reads: string[] = [];
    const find = makePublishedSnapshotSource({
      workTurns: async (_window, thread) => {
        reads.push(`work:${String(thread)}`);
        return [{ toolSteps: [{ toolCallId: "tool-1", published }] }] as never;
      },
      codeConversation: async (_window, thread, cursor) => {
        reads.push(`code:${String(thread)}:${String(cursor)}`);
        return cursor === 0
          ? ({ turns: [{ steps: [] }], nextCursor: 4, hasMore: true } as never)
          : ({
              turns: [{ steps: [{ kind: "tool", toolCallId: "tool-2", published }] }],
              nextCursor: 8,
              hasMore: false,
            } as never);
      },
    });
    await expect(find(windowId, { mode: "work", threadId, toolCallId: "tool-1" })).resolves.toEqual(
      snapshot,
    );
    await expect(
      find(windowId, { mode: "work", threadId, toolCallId: "tool-2" }),
    ).resolves.toBeUndefined();
    await expect(find(windowId, { mode: "code", threadId, toolCallId: "tool-2" })).resolves.toEqual(
      snapshot,
    );
    expect(reads).toEqual([
      `work:${threadId}`,
      `work:${threadId}`,
      `code:${threadId}:0`,
      `code:${threadId}:4`,
    ]);
  });
});
