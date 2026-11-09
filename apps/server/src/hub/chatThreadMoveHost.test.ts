import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatThread, ChatThreadView, ThreadMoveId, ThreadMoveOffer } from "@octant/contracts";
import type { MovedChatThreadImport } from "../chat/chatService";
import { createChatThreadMoveHost } from "./chatThreadMoveHost";
import { noThreadParts } from "./movedThreadParts.test-support";
import { createThreadMoveHolds } from "./threadMoveHolds";

const THREAD = "77777777-7777-4777-8777-777777777777";
const BRANCH_SOURCE = "66666666-6666-4666-8666-666666666666";
const SOURCE_PROJECT = "55555555-5555-4555-8555-555555555555";
const OTHER_PROJECT = "44444444-4444-4444-8444-444444444444";
const ARRIVING = "88888888-8888-4888-8888-888888888888";
const MOVE = "99999999-9999-4999-8999-999999999999" as ThreadMoveId;
const SENT = "aaaaaaaa-0000-4000-8000-000000000001";
const GONE = "aaaaaaaa-0000-4000-8000-000000000002";
const DRAFT = "aaaaaaaa-0000-4000-8000-000000000003";
const ADMITTED = "aaaaaaaa-0000-4000-8000-000000000004";
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const files: Record<string, string> = {
  [`${THREAD}/${SENT}`]: "Lisbon, then Porto.",
  [`${THREAD}/${DRAFT}`]: "Not sent yet.",
  [`${BRANCH_SOURCE}/${ADMITTED}`]: "The original map.",
};
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const attachment = (id: string, displayName: string, turnId?: string) => ({
  id,
  threadId: THREAD,
  ...(turnId === undefined ? {} : { turnId }),
  displayName,
  mediaType: "text/plain",
  byteLength: 1,
  digest: sha256(files[`${THREAD}/${id}`] ?? "the bytes that were lost"),
  status: "finalized",
  createdAt: "2026-11-08T10:00:00.000Z",
});

// A thread branched from another: its one turn sent two attachments (one of
// which can no longer be read) and admitted an input from the branch's source.
const view = {
  thread: { id: THREAD, title: "Read the itinerary", lifecycle: "active" },
  contents: [{ contentId: "content-1", body: "What does this say?" }],
  turns: [
    {
      userMessageRef: { contentId: "content-1" },
      createdAt: "2026-11-08T10:00:00.000Z",
      attachmentIds: [SENT, GONE],
      originalInputs: [
        {
          source: {
            mode: "chat",
            threadId: BRANCH_SOURCE,
            attachmentId: ADMITTED,
            projectId: SOURCE_PROJECT,
          },
          displayName: "map.txt",
          mediaType: "text/plain",
          byteLength: 17,
          digest: sha256("The original map."),
        },
      ],
      attempts: [],
    },
  ],
  attachments: [
    attachment(SENT, "itinerary.txt", "turn-1"),
    attachment(GONE, "scan.txt", "turn-1"),
    attachment(DRAFT, "draft.txt"),
  ],
} as unknown as ChatThreadView;

/** The Project the branch's source thread is in now; an input is readable only from its recorded one. */
function host(sourceThreadProject = SOURCE_PROJECT) {
  const imports: MovedChatThreadImport[] = [];
  const asked: string[] = [];
  const moveHost = createChatThreadMoveHost({
    readView: (threadId) => (String(threadId) === THREAD ? view : undefined),
    isBusy: () => false,
    externalContentIngested: () => false,
    importMovedThread: async (input) => {
      imports.push(input);
      return { id: input.threadId } as unknown as ChatThread;
    },
    readAttachment: async (threadId, attachmentId) => {
      // Only the moving thread's own attachments are read this way.
      asked.push(threadId);
      const text = files[`${threadId}/${attachmentId}`];
      return text === undefined ? undefined : new TextEncoder().encode(text);
    },
    // As the conversation-input reader does: the recorded Project must still be the source's.
    readOriginalInput: async (reference) => {
      if (reference.source.projectId !== sourceThreadProject) return undefined;
      const text = files[`${reference.source.threadId}/${reference.source.attachmentId}`];
      return text === undefined ? undefined : new TextEncoder().encode(text);
    },
    parts: noThreadParts(),
    activeChatProject: () => true,
    purge: async () => {},
    holds: createThreadMoveHolds(),
  });
  return { moveHost, imports, asked };
}

describe("moving a Chat thread", () => {
  it("carries the attachments its turns sent, the inputs they admitted, and the unsent ones, and names the unreadable one", async () => {
    const { moveHost, imports, asked } = host();
    const folder = mkdtempSync(join(tmpdir(), "octant-chat-move-"));
    folders.push(folder);
    const packed = await moveHost.source.pack({ mode: "chat", threadId: THREAD }, folder, MOVE);
    if (packed.status !== "packed") throw new Error("Nothing was packed.");
    expect(packed.parts.map((part) => [part.partId, part.kind])).toEqual([
      ["thread", "thread-bundle"],
      ["attachment-1", "attachment"],
      ["input-2", "original-input"],
      ["attachment-3", "attachment"],
    ]);
    expect(packed.partsLeftBehind).toEqual([{ kind: "attachment", name: "scan.txt" }]);

    const offer = {
      moveId: MOVE,
      source: { mode: "chat", threadId: THREAD },
      title: "Read the itinerary",
      manifest: {
        parts: packed.parts.map((part) => ({ ...part, bytes: 1, sha256: "a".repeat(64) })),
      },
    } as unknown as ThreadMoveOffer;
    const arrived = await moveHost.destination.arrive({
      thread: { mode: "chat", threadId: ARRIVING },
      offer,
      parts: new Map(packed.parts.map((part) => [part.partId, part.path])),
      origin: { memberId: "x" as never, thread: { mode: "chat", threadId: THREAD } },
      ownerMemberId: "y" as never,
    });
    expect(arrived.status).toBe("arrived");

    const [imported] = imports;
    const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    // The admitted input's thread stays on the source, so the moved turn owns its bytes.
    expect(
      imported?.turns[0]?.attachments?.map((carried) => [carried.displayName, text(carried.bytes)]),
    ).toEqual([
      ["itinerary.txt", "Lisbon, then Porto."],
      ["map.txt", "The original map."],
    ]);
    expect(imported?.unsentAttachments?.map((carried) => carried.displayName)).toEqual([
      "draft.txt",
    ]);
    const ids = [
      ...(imported?.turns[0]?.attachments ?? []),
      ...(imported?.unsentAttachments ?? []),
    ].map((carried) => String(carried.attachmentId));
    expect(ids.some((id) => [SENT, DRAFT, ADMITTED].includes(id))).toBe(false);
    expect(asked.every((threadId) => threadId === THREAD)).toBe(true);
  });

  it("leaves behind, and names, an admitted input whose source thread has moved to another Project", async () => {
    const { moveHost } = host(OTHER_PROJECT);
    const folder = mkdtempSync(join(tmpdir(), "octant-chat-move-"));
    folders.push(folder);
    const packed = await moveHost.source.pack({ mode: "chat", threadId: THREAD }, folder, MOVE);
    if (packed.status !== "packed") throw new Error("Nothing was packed.");
    // The input is no longer readable where it was admitted from, so nothing of it travels.
    expect(packed.parts.map((part) => part.kind)).not.toContain("original-input");
    expect(packed.partsLeftBehind).toEqual([
      { kind: "attachment", name: "scan.txt" },
      { kind: "original-input", name: "map.txt" },
    ]);
  });
});
