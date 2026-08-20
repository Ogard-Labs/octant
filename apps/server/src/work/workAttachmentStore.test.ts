import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_WORK_ATTACHMENT_BYTES,
  MAX_WORK_TURN_ATTACHMENTS,
  decodeWorkAttachmentId,
  decodeWorkThreadId,
  type WorkAttachmentId,
  type WorkThreadId,
} from "@octant/contracts";
import {
  WorkAttachmentInvalid,
  WorkAttachmentStore,
  WorkAttachmentTooLarge,
} from "./workAttachmentStore";

let root: string;
let store: WorkAttachmentStore;

const threadId = (n: number): WorkThreadId =>
  decodeWorkThreadId(`20000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`);
const attachmentId = (n: number): WorkAttachmentId =>
  decodeWorkAttachmentId(`30000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "octant-work-attachment-test-"));
  store = new WorkAttachmentStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("WorkAttachmentStore", () => {
  it("measures what it accepted and reads the same bytes back by that reference", async () => {
    const thread = threadId(1);
    const id = attachmentId(1);
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    const reference = await store.stage({
      threadId: thread,
      attachmentId: id,
      // A renderer-chosen name never becomes a path segment.
      displayName: "../../etc/passwd.png",
      mediaType: "image/png",
      bytes,
    });

    expect(reference.attachmentId).toBe(id);
    expect(reference.byteLength).toBe(bytes.byteLength);
    expect(reference.displayName).not.toContain("/");
    expect(reference.digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(store.read(thread, reference)).resolves.toEqual(bytes);
  });

  it("refuses an image the turn never staged, and only spends an id once", async () => {
    const thread = threadId(2);
    const staged = attachmentId(2);
    const never = attachmentId(3);
    const reference = await store.stage({
      threadId: thread,
      attachmentId: staged,
      displayName: "shot.png",
      mediaType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(store.peek(thread, [never])).toEqual({ status: "unknown", attachmentId: never });
    // Another thread cannot reach it either, even naming the right id.
    expect(store.peek(threadId(9), [staged])).toEqual({ status: "unknown", attachmentId: staged });
    expect(store.peek(thread, [staged])).toEqual({ status: "ok", attachments: [reference] });

    store.release(thread, [staged]);
    expect(store.peek(thread, [staged])).toEqual({ status: "unknown", attachmentId: staged });
    // Releasing frees the staging slot but keeps the bytes the turn was sent.
    await expect(store.read(thread, reference)).resolves.toHaveLength(3);
  });

  it("refuses an oversized image and a discarded one", async () => {
    const thread = threadId(4);
    const id = attachmentId(4);

    await expect(
      store.stage({
        threadId: thread,
        attachmentId: id,
        displayName: "huge.png",
        mediaType: "image/png",
        bytes: new Uint8Array(MAX_WORK_ATTACHMENT_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(WorkAttachmentTooLarge);

    const reference = await store.stage({
      threadId: thread,
      attachmentId: id,
      displayName: "shot.png",
      mediaType: "image/png",
      bytes: new Uint8Array([4, 5, 6]),
    });
    await store.discard(thread, id);
    expect(store.peek(thread, [id])).toEqual({ status: "unknown", attachmentId: id });
    await expect(store.read(thread, reference)).rejects.toThrow();
  });

  it("holds the per-thread staging bound against concurrent uploads", async () => {
    const thread = threadId(5);
    const limit = MAX_WORK_TURN_ATTACHMENTS * 2;
    const uploads = Array.from({ length: limit + 3 }, (_, index) =>
      store.stage({
        threadId: thread,
        attachmentId: attachmentId(100 + index),
        displayName: `shot-${index}.png`,
        mediaType: "image/png",
        bytes: new Uint8Array([index]),
      }),
    );
    const settled = await Promise.allSettled(uploads);
    const accepted = settled.filter((result) => result.status === "fulfilled");
    const refused = settled.filter(
      (result) => result.status === "rejected" && result.reason instanceof WorkAttachmentInvalid,
    );
    expect(accepted).toHaveLength(limit);
    expect(refused).toHaveLength(3);
  });
});
