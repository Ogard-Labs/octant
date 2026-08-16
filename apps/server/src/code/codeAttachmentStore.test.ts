import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CODE_ATTACHMENT_BYTES,
  decodeCodeAttachmentId,
  decodeCodeThreadId,
  type CodeAttachmentId,
  type CodeThreadId,
} from "@octant/contracts";
import { CodeAttachmentStore, CodeAttachmentTooLarge } from "./codeAttachmentStore";

let root: string;
let store: CodeAttachmentStore;

const threadId = (n: number): CodeThreadId =>
  decodeCodeThreadId(`20000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`);
const attachmentId = (n: number): CodeAttachmentId =>
  decodeCodeAttachmentId(`30000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "octant-code-attachment-test-"));
  store = new CodeAttachmentStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("CodeAttachmentStore", () => {
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
        bytes: new Uint8Array(MAX_CODE_ATTACHMENT_BYTES + 1),
      }),
    ).rejects.toBeInstanceOf(CodeAttachmentTooLarge);

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
});
