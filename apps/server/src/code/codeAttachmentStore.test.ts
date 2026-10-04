import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_CODE_ATTACHMENT_BYTES,
  MAX_CODE_TURN_ATTACHMENTS,
  decodeCodeAttachmentId,
  decodeCodeThreadId,
  type CodeAttachmentId,
  type CodeThreadId,
} from "@octant/contracts";
import {
  CodeAttachmentInvalid,
  CodeAttachmentStore,
  CodeAttachmentTooLarge,
} from "./codeAttachmentStore";

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

  it("holds the per-thread staging bound against concurrent uploads", async () => {
    const thread = threadId(5);
    const limit = MAX_CODE_TURN_ATTACHMENTS * 2;
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
      (result) => result.status === "rejected" && result.reason instanceof CodeAttachmentInvalid,
    );
    expect(accepted).toHaveLength(limit);
    expect(refused).toHaveLength(3);
  });
});

describe("queued attachment ownership", () => {
  const owner = "queued-message-1";
  const upload = (thread: CodeThreadId, id: CodeAttachmentId) =>
    store.stage({
      threadId: thread,
      attachmentId: id,
      displayName: "queued.png",
      mediaType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    });

  it("pins accepted images idempotently and frees the draft budget only after acknowledgement", async () => {
    const thread = threadId(20);
    const refs = await Promise.all(
      Array.from({ length: MAX_CODE_TURN_ATTACHMENTS * 2 }, (_, i) =>
        upload(thread, attachmentId(200 + i)),
      ),
    );
    const ids = refs.map((ref) => ref.attachmentId);
    expect(store.claimQueued(thread, owner, ids)).toEqual({ status: "ok", attachments: refs });
    expect(store.claimQueued(thread, owner, ids)).toEqual({ status: "ok", attachments: refs });
    expect(store.claimQueued(thread, "another-message", ids)).toMatchObject({ status: "refused" });
    await expect(upload(thread, attachmentId(299))).rejects.toBeInstanceOf(CodeAttachmentInvalid);
    const first = refs[0];
    if (first === undefined) throw new Error("Fixture is missing an attachment.");
    await expect(store.discard(thread, first.attachmentId)).rejects.toThrow("queued");
    await expect(upload(thread, first.attachmentId)).rejects.toThrow();
    expect(store.commitQueued(thread, owner)).toEqual({ status: "ok" });
    expect(store.peek(thread, ids)).toMatchObject({ status: "unknown" });
    await expect(upload(thread, attachmentId(299))).resolves.toBeDefined();
    expect(store.claimQueued(thread, owner, ids)).toEqual({ status: "ok", attachments: refs });
    expect(
      await store.releaseQueued(thread, owner, {
        disposition: "removed",
        isTurnOwned: () => false,
      }),
    ).toEqual({ status: "ok" });
    expect(store.isQueued(thread, first.attachmentId)).toBe(false);
    await expect(store.read(thread, first)).rejects.toThrow();
  });

  it("restores durable pins before serving clients and verifies bytes before restoring dispatch metadata", async () => {
    const thread = threadId(21);
    const id = attachmentId(310);
    const ref = await upload(thread, id);
    store = new CodeAttachmentStore(root);
    expect(store.restoreQueuedOwnership(thread, owner, [ref])).toEqual({ status: "ok" });
    await store.recover();
    expect(store.peek(thread, [id])).toEqual({ status: "unknown", attachmentId: id });
    await expect(store.discard(thread, id)).rejects.toThrow("queued");
    expect(await store.prepareQueued(thread, owner)).toEqual({ status: "ok", attachments: [ref] });
    expect(store.peek(thread, [id])).toEqual({ status: "ok", attachments: [ref] });
    store.release(thread, [id]);
    expect(await store.releaseQueued(thread, owner, { disposition: "turn" })).toEqual({
      status: "ok",
    });
    await store.discard(thread, id);
    await expect(store.read(thread, ref)).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it.each([new Uint8Array([8, 9, 0]), new Uint8Array([1, 2])])(
    "holds corrupt bytes instead of restoring them for dispatch",
    async (bytes) => {
      const thread = threadId(22);
      const id = attachmentId(320);
      const ref = await upload(thread, id);
      store = new CodeAttachmentStore(root);
      expect(store.restoreQueuedOwnership(thread, owner, [ref])).toEqual({ status: "ok" });
      await writeFile(join(root, "code-threads", thread, id, "finalized.bin"), bytes);
      expect(await store.prepareQueued(thread, owner)).toMatchObject({
        status: "refused",
        reason: "unavailable",
      });
      expect(store.peek(thread, [id])).toEqual({ status: "unknown", attachmentId: id });
      await expect(store.discard(thread, id)).rejects.toThrow("queued");
    },
  );

  it("preserves turn-owned bytes when removing a recovered queue item", async () => {
    const thread = threadId(23);
    const ref = await upload(thread, attachmentId(330));
    store = new CodeAttachmentStore(root);
    expect(store.restoreQueuedOwnership(thread, owner, [ref])).toEqual({ status: "ok" });
    expect(
      await store.releaseQueued(thread, owner, {
        disposition: "removed",
        isTurnOwned: (id) => id === ref.attachmentId,
      }),
    ).toEqual({ status: "ok" });
    await expect(store.read(thread, ref)).resolves.toHaveLength(3);
  });

  it("refuses a queue claim while deletion is already in flight", async () => {
    const thread = threadId(24);
    const ref = await upload(thread, attachmentId(340));
    const discarded = store.discard(thread, ref.attachmentId);
    expect(store.peek(thread, [ref.attachmentId])).toMatchObject({ status: "unknown" });
    expect(store.claimQueued(thread, owner, [ref.attachmentId])).toMatchObject({
      status: "refused",
    });
    await discarded;
    expect(store.isQueued(thread, ref.attachmentId)).toBe(false);
  });

  it("rolls an unacknowledged reservation back to the draft without deleting bytes", async () => {
    const thread = threadId(25);
    const ref = await upload(thread, attachmentId(350));
    expect(store.claimQueued(thread, owner, [ref.attachmentId])).toMatchObject({ status: "ok" });
    expect(await store.releaseQueued(thread, owner, { disposition: "draft" })).toEqual({
      status: "ok",
    });
    expect(store.peek(thread, [ref.attachmentId])).toEqual({ status: "ok", attachments: [ref] });
    await store.discard(thread, ref.attachmentId);
    await expect(store.read(thread, ref)).rejects.toThrow();
  });
});

it("refuses ownership changes while dispatch verification or removal is in flight", async () => {
  const thread = threadId(26);
  const id = attachmentId(360);
  const ref = await store.stage({
    threadId: thread,
    attachmentId: id,
    displayName: "race.png",
    mediaType: "image/png",
    bytes: new Uint8Array([1]),
  });
  expect(store.claimQueued(thread, "owner", [id])).toMatchObject({ status: "ok" });
  store.commitQueued(thread, "owner");
  const preparing = store.prepareQueued(thread, "owner");
  expect(
    await store.releaseQueued(thread, "owner", {
      disposition: "removed",
      isTurnOwned: () => false,
    }),
  ).toMatchObject({ status: "refused", reason: "busy" });
  expect(store.commitQueued(thread, "owner")).toMatchObject({ status: "refused", reason: "busy" });
  expect(await preparing).toMatchObject({ status: "ok" });
  const removing = store.releaseQueued(thread, "owner", {
    disposition: "removed",
    isTurnOwned: () => false,
  });
  expect(store.claimQueued(thread, "owner", [id])).toMatchObject({
    status: "refused",
    reason: "busy",
  });
  expect(store.restoreQueuedOwnership(thread, "owner", [ref])).toMatchObject({
    status: "refused",
    reason: "busy",
  });
  expect(await removing).toEqual({ status: "ok" });
  expect(store.peek(thread, [id])).toMatchObject({ status: "unknown" });
  expect(store.isQueued(thread, id)).toBe(false);
});
