import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeChatAttachment,
  decodeChatAttachmentId,
  decodeChatThreadId,
  decodeCodeAttachmentId,
  decodeCodeThreadId,
  decodeThreadMessageQueuePayload,
  decodeThreadMessageQueueScope,
  decodeThreadQueueMessageId,
  decodeWorkAttachmentId,
  decodeWorkThreadId,
  type ChatAttachment,
} from "@octant/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatAttachmentStore } from "../chat/chatAttachmentStore";
import { CodeAttachmentStore } from "../code/codeAttachmentStore";
import { WorkAttachmentStore } from "../work/workAttachmentStore";
import { createThreadMessageQueueAttachments } from "./threadMessageQueueAttachments";
import {
  MAX_THREAD_MESSAGE_QUEUE_PRIVATE_CONTEXT_BYTES,
  type ThreadMessageQueueResource,
} from "./threadMessageQueuePort";

const thread = "40000000-0000-4000-8000-000000000001";
const attachment = "50000000-0000-4000-8000-000000000001";
const messageId = decodeThreadQueueMessageId("60000000-0000-4000-8000-000000000001");
const modes = ["chat", "work", "code"] as const;
type Mode = (typeof modes)[number];
let root: string;
let chatMetadata: ChatAttachment[];
let turnOwned: boolean;
let failTurnLookup: boolean;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "octant-queue-attachments-"));
  chatMetadata = [];
  turnOwned = false;
  failTurnLookup = false;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function stores() {
  const chatStore = new ChatAttachmentStore(root);
  const workStore = new WorkAttachmentStore(root);
  const codeStore = new CodeAttachmentStore(root);
  const adapter = createThreadMessageQueueAttachments({
    chatStore,
    codeStore,
    workStore,
    readChatAttachment: (threadId, attachmentId) =>
      chatMetadata.find(
        (ref) =>
          String(ref.threadId) === String(threadId) && String(ref.id) === String(attachmentId),
      ),
    isTurnOwned: () => {
      if (failTurnLookup) throw new Error("Turn projection unavailable.");
      return turnOwned;
    },
  });
  return { chatStore, codeStore, workStore, adapter };
}

function resource(mode: Mode): ThreadMessageQueueResource {
  return {
    scope: decodeThreadMessageQueueScope({ mode, threadId: thread }),
    messageId,
    payload: decodeThreadMessageQueuePayload({
      mode,
      prompt: "Inspect the attached bytes",
      attachmentIds: [attachment],
    }),
  };
}

async function staged(mode: Mode) {
  const current = stores();
  const bytes = new Uint8Array([1, 2, 3]);
  const input = resource(mode);
  const reference =
    mode === "chat"
      ? await current.chatStore.finalize(
          await current.chatStore.stage({
            chatThreadId: decodeChatThreadId(thread),
            chatAttachmentId: decodeChatAttachmentId(attachment),
            displayName: "queued.txt",
            bytes,
          }),
        )
      : mode === "code"
        ? await current.codeStore.stage({
            threadId: decodeCodeThreadId(thread),
            attachmentId: decodeCodeAttachmentId(attachment),
            displayName: "queued.png",
            mediaType: "image/png",
            bytes,
          })
        : await current.workStore.stage({
            threadId: decodeWorkThreadId(thread),
            attachmentId: decodeWorkAttachmentId(attachment),
            displayName: "queued.png",
            mediaType: "image/png",
            bytes,
          });
  if ("chatAttachmentId" in reference) {
    chatMetadata.push(
      decodeChatAttachment({
        id: reference.chatAttachmentId,
        threadId: reference.chatThreadId,
        displayName: reference.displayName,
        mediaType: "text/plain",
        byteLength: reference.size,
        digest: reference.hash,
        status: "finalized",
        createdAt: reference.finalizedAt,
      }),
    );
  }
  const bytesPath = join(
    root,
    mode === "chat" ? "threads" : `${mode}-threads`,
    thread,
    attachment,
    "finalized.bin",
  );
  const retained = current.adapter.retain({ ...input, reason: "enqueue" });
  expect(retained.status).toBe("retained");
  if (retained.status !== "retained" || retained.privateContextJson === undefined)
    throw new Error("Expected retained attachment context.");
  return {
    ...current,
    reference,
    bytesPath,
    input: { ...input, privateContextJson: retained.privateContextJson },
  };
}

function pinned(current: ReturnType<typeof stores>, mode: Mode): boolean {
  return mode === "chat"
    ? current.chatStore.isQueued(decodeChatThreadId(thread), decodeChatAttachmentId(attachment))
    : mode === "code"
      ? current.codeStore.isQueued(decodeCodeThreadId(thread), decodeCodeAttachmentId(attachment))
      : current.workStore.isQueued(decodeWorkThreadId(thread), decodeWorkAttachmentId(attachment));
}

async function discard(current: ReturnType<typeof stores>, mode: Mode) {
  if (mode === "chat")
    await current.chatStore.remove(decodeChatThreadId(thread), decodeChatAttachmentId(attachment));
  else if (mode === "code")
    await current.codeStore.discard(decodeCodeThreadId(thread), decodeCodeAttachmentId(attachment));
  else
    await current.workStore.discard(decodeWorkThreadId(thread), decodeWorkAttachmentId(attachment));
}

describe.each(modes)("queued %s attachments", (mode) => {
  it("retains before acknowledgement, restores after restart, and deletes only after queue removal", async () => {
    const initial = await staged(mode);
    expect(pinned(initial, mode)).toBe(true);
    await expect(discard(initial, mode)).rejects.toThrow("queued");
    initial.adapter.commit(initial.input);
    const restarted = stores();
    expect(restarted.adapter.retain({ ...initial.input, reason: "restore" })).toMatchObject({
      status: "retained",
    });
    expect(restarted.adapter.retain({ ...initial.input, reason: "restore" })).toMatchObject({
      status: "retained",
    });
    await restarted.chatStore.recover({ isFinalizedAttachmentReferenced: () => false });
    await restarted.codeStore.recover();
    await restarted.workStore.recover();
    await expect(discard(restarted, mode)).rejects.toThrow("queued");
    expect(await restarted.adapter.prepare(initial.input)).toBe(true);
    expect(await restarted.adapter.release({ ...initial.input, reason: "removed" })).toEqual({
      status: "released",
    });
    expect(await restarted.adapter.release({ ...initial.input, reason: "removed" })).toEqual({
      status: "released",
    });
    expect(pinned(restarted, mode)).toBe(false);
    await expect(access(initial.bytesPath)).rejects.toThrow();
  });

  it("returns an unacknowledged reservation to the draft without deleting its bytes", async () => {
    const initial = await staged(mode);
    expect(await initial.adapter.release({ ...initial.input, reason: "rollback" })).toEqual({
      status: "released",
    });
    expect(pinned(initial, mode)).toBe(false);
    await expect(access(initial.bytesPath)).resolves.toBeUndefined();
    await discard(initial, mode);
    await expect(access(initial.bytesPath)).rejects.toThrow();
  });

  it.each(["accepted", "removed", "purged"] as const)(
    "preserves turn-owned bytes when the queue item is %s",
    async (reason) => {
      const initial = await staged(mode);
      initial.adapter.commit(initial.input);
      expect(await initial.adapter.prepare(initial.input)).toBe(true);
      turnOwned = true;
      expect(await initial.adapter.release({ ...initial.input, reason })).toEqual({
        status: "released",
      });
      expect(pinned(initial, mode)).toBe(false);
      await expect(access(initial.bytesPath)).resolves.toBeUndefined();
    },
  );

  it("holds a recovered corrupt attachment and keeps cleanup retryable", async () => {
    const initial = await staged(mode);
    initial.adapter.commit(initial.input);
    const restarted = stores();
    expect(restarted.adapter.retain({ ...initial.input, reason: "restore" })).toMatchObject({
      status: "retained",
    });
    await writeFile(initial.bytesPath, new Uint8Array([8, 8, 8]));
    expect(await restarted.adapter.prepare(initial.input)).toBe(false);
    expect(pinned(restarted, mode)).toBe(true);
    failTurnLookup = true;
    expect(await restarted.adapter.release({ ...initial.input, reason: "removed" })).toEqual({
      status: "refused",
    });
    expect(pinned(restarted, mode)).toBe(true);
    failTurnLookup = false;
    expect(await restarted.adapter.release({ ...initial.input, reason: "removed" })).toEqual({
      status: "released",
    });
    expect(pinned(restarted, mode)).toBe(false);
    await expect(access(initial.bytesPath)).rejects.toThrow();
  });
});

it("refuses private metadata with extra fields, mismatched mode, scope, owner, IDs, or size", async () => {
  const initial = await staged("code");
  const context = { mode: "code", threadId: thread, messageId, attachments: [initial.reference] };
  const badContexts = [
    { ...context, authority: "full-access" },
    { ...context, mode: "work" },
    { ...context, threadId: "40000000-0000-4000-8000-000000000002" },
    { ...context, messageId: "60000000-0000-4000-8000-000000000002" },
    { ...context, attachments: [] },
    {
      ...context,
      attachments: [{ ...initial.reference, attachmentId: "50000000-0000-4000-8000-000000000002" }],
    },
    { ...context, attachments: [{ ...initial.reference, path: "/untrusted" }] },
    { ...context, attachments: [initial.reference, initial.reference] },
  ].map((value) => JSON.stringify(value));
  badContexts.push(
    "{",
    initial.input.privateContextJson + " ".repeat(MAX_THREAD_MESSAGE_QUEUE_PRIVATE_CONTEXT_BYTES),
  );
  for (const privateContextJson of badContexts) {
    const restarted = stores();
    const input = { ...initial.input, privateContextJson };
    expect(restarted.adapter.retain({ ...input, reason: "restore" })).toMatchObject({
      status: "refused",
    });
    expect(await restarted.adapter.prepare(input)).toBe(false);
    expect(await restarted.adapter.release({ ...input, reason: "removed" })).toEqual({
      status: "refused",
    });
    expect(pinned(restarted, "code")).toBe(false);
    await expect(access(initial.bytesPath)).resolves.toBeUndefined();
  }
});

it("refuses Chat references belonging to another thread before acquiring ownership", async () => {
  const initial = await staged("chat");
  const input = {
    ...initial.input,
    privateContextJson: JSON.stringify({
      mode: "chat",
      threadId: thread,
      messageId,
      attachments: [{ ...initial.reference, chatThreadId: "40000000-0000-4000-8000-000000000002" }],
    }),
  };
  const restarted = stores();
  expect(restarted.adapter.retain({ ...input, reason: "restore" })).toMatchObject({
    status: "refused",
  });
  expect(pinned(restarted, "chat")).toBe(false);
});
