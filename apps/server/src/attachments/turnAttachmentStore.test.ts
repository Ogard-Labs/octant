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
  type CodeAttachmentMediaType,
  type CodeAttachmentReference,
  type CodeThreadId,
} from "@octant/contracts";
import {
  MAX_WORK_ATTACHMENT_BYTES,
  MAX_WORK_TURN_ATTACHMENTS,
  decodeWorkAttachmentId,
  decodeWorkThreadId,
  type WorkAttachmentId,
  type WorkAttachmentMediaType,
  type WorkAttachmentReference,
  type WorkThreadId,
} from "@octant/contracts";
import {
  CodeAttachmentInvalid,
  CodeAttachmentStore,
  CodeAttachmentTooLarge,
} from "../code/codeAttachmentStore";
import {
  WorkAttachmentInvalid,
  WorkAttachmentStore,
  WorkAttachmentTooLarge,
} from "../work/workAttachmentStore";
import type { TurnAttachmentReferenceShape, TurnAttachmentStore } from "./turnAttachmentStore";

/**
 * One suite drives both modes' stores through the same scenarios: Code and
 * Work staged their attachments through two byte-identical implementations,
 * and a behavior fixed for one was fixed for the other only by luck. The
 * fixture names what differs — the branded ids, the limits, the error
 * classes, the scopes directory — and every scenario below runs for each.
 */
function turnAttachmentSuite<
  ThreadId extends string,
  AttachmentId extends string,
  MediaType,
  Reference extends TurnAttachmentReferenceShape<AttachmentId, MediaType>,
>(mode: {
  readonly name: string;
  readonly scopesDirectory: string;
  readonly maxBytes: number;
  readonly maxTurnAttachments: number;
  readonly tooLarge: new (byteLength: number) => Error;
  readonly invalid: new (message: string) => Error;
  readonly makeStore: (
    root: string,
  ) => TurnAttachmentStore<ThreadId, AttachmentId, MediaType, Reference>;
  readonly threadId: (n: number) => ThreadId;
  readonly attachmentId: (n: number) => AttachmentId;
}): void {
  let root: string;
  let store: TurnAttachmentStore<ThreadId, AttachmentId, MediaType, Reference>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), `octant-${mode.name.toLowerCase()}-attachment-test-`));
    store = mode.makeStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe(`turn attachments (${mode.name})`, () => {
    it("measures what it accepted and reads the same bytes back by that reference", async () => {
      const thread = mode.threadId(1);
      const id = mode.attachmentId(1);
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

      const reference = await store.stage({
        threadId: thread,
        attachmentId: id,
        // A renderer-chosen name never becomes a path segment.
        displayName: "../../etc/passwd.png",
        mediaType: "image/png" as MediaType,
        bytes,
      });

      expect(reference.attachmentId).toBe(id);
      expect(reference.byteLength).toBe(bytes.byteLength);
      expect(reference.displayName).not.toContain("/");
      expect(reference.digest).toMatch(/^[a-f0-9]{64}$/);
      await expect(store.read(thread, reference)).resolves.toEqual(bytes);
    });

    it("refuses an image the turn never staged, and only spends an id once", async () => {
      const thread = mode.threadId(2);
      const staged = mode.attachmentId(2);
      const never = mode.attachmentId(3);
      const reference = await store.stage({
        threadId: thread,
        attachmentId: staged,
        displayName: "shot.png",
        mediaType: "image/png" as MediaType,
        bytes: new Uint8Array([1, 2, 3]),
      });

      expect(store.peek(thread, [never])).toEqual({ status: "unknown", attachmentId: never });
      // Another thread cannot reach it either, even naming the right id.
      expect(store.peek(mode.threadId(9), [staged])).toEqual({
        status: "unknown",
        attachmentId: staged,
      });
      expect(store.peek(thread, [staged])).toEqual({ status: "ok", attachments: [reference] });

      store.release(thread, [staged]);
      expect(store.peek(thread, [staged])).toEqual({ status: "unknown", attachmentId: staged });
      // Releasing frees the staging slot but keeps the bytes the turn was sent.
      await expect(store.read(thread, reference)).resolves.toHaveLength(3);
    });

    it("refuses an oversized image and a discarded one", async () => {
      const thread = mode.threadId(4);
      const id = mode.attachmentId(4);

      await expect(
        store.stage({
          threadId: thread,
          attachmentId: id,
          displayName: "huge.png",
          mediaType: "image/png" as MediaType,
          bytes: new Uint8Array(mode.maxBytes + 1),
        }),
      ).rejects.toBeInstanceOf(mode.tooLarge);

      const reference = await store.stage({
        threadId: thread,
        attachmentId: id,
        displayName: "shot.png",
        mediaType: "image/png" as MediaType,
        bytes: new Uint8Array([4, 5, 6]),
      });
      await store.discard(thread, id);
      expect(store.peek(thread, [id])).toEqual({ status: "unknown", attachmentId: id });
      await expect(store.read(thread, reference)).rejects.toThrow();
    });

    it("holds the per-thread staging bound against concurrent uploads", async () => {
      const thread = mode.threadId(5);
      const limit = mode.maxTurnAttachments * 2;
      const uploads = Array.from({ length: limit + 3 }, (_, index) =>
        store.stage({
          threadId: thread,
          attachmentId: mode.attachmentId(100 + index),
          displayName: `shot-${index}.png`,
          mediaType: "image/png" as MediaType,
          bytes: new Uint8Array([index]),
        }),
      );
      const settled = await Promise.allSettled(uploads);
      const accepted = settled.filter((result) => result.status === "fulfilled");
      const refused = settled.filter(
        (result) => result.status === "rejected" && result.reason instanceof mode.invalid,
      );
      expect(accepted).toHaveLength(limit);
      expect(refused).toHaveLength(3);
    });

    describe(`queued attachment ownership (${mode.name})`, () => {
      const owner = "queued-message-1";
      const upload = (thread: ThreadId, id: AttachmentId) =>
        store.stage({
          threadId: thread,
          attachmentId: id,
          displayName: "queued.png",
          mediaType: "image/png" as MediaType,
          bytes: new Uint8Array([1, 2, 3]),
        });

      it("pins accepted images idempotently and frees the draft budget only after acknowledgement", async () => {
        const thread = mode.threadId(20);
        const refs = await Promise.all(
          Array.from({ length: mode.maxTurnAttachments * 2 }, (_, i) =>
            upload(thread, mode.attachmentId(200 + i)),
          ),
        );
        const ids = refs.map((ref) => ref.attachmentId);
        expect(store.claimQueued(thread, owner, ids)).toEqual({ status: "ok", attachments: refs });
        expect(store.claimQueued(thread, owner, ids)).toEqual({ status: "ok", attachments: refs });
        expect(store.claimQueued(thread, "another-message", ids)).toMatchObject({
          status: "refused",
        });
        await expect(upload(thread, mode.attachmentId(299))).rejects.toBeInstanceOf(mode.invalid);
        const first = refs[0];
        if (first === undefined) throw new Error("Fixture is missing an attachment.");
        await expect(store.discard(thread, first.attachmentId)).rejects.toThrow("queued");
        await expect(upload(thread, first.attachmentId)).rejects.toThrow();
        expect(store.commitQueued(thread, owner)).toEqual({ status: "ok" });
        expect(store.peek(thread, ids)).toMatchObject({ status: "unknown" });
        await expect(upload(thread, mode.attachmentId(299))).resolves.toBeDefined();
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
        const thread = mode.threadId(21);
        const id = mode.attachmentId(310);
        const ref = await upload(thread, id);
        store = mode.makeStore(root);
        expect(store.restoreQueuedOwnership(thread, owner, [ref])).toEqual({ status: "ok" });
        await store.recover();
        expect(store.peek(thread, [id])).toEqual({ status: "unknown", attachmentId: id });
        await expect(store.discard(thread, id)).rejects.toThrow("queued");
        expect(await store.prepareQueued(thread, owner)).toEqual({
          status: "ok",
          attachments: [ref],
        });
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
          const thread = mode.threadId(22);
          const id = mode.attachmentId(320);
          const ref = await upload(thread, id);
          store = mode.makeStore(root);
          expect(store.restoreQueuedOwnership(thread, owner, [ref])).toEqual({ status: "ok" });
          await writeFile(
            join(root, mode.scopesDirectory, String(thread), String(id), "finalized.bin"),
            bytes,
          );
          expect(await store.prepareQueued(thread, owner)).toMatchObject({
            status: "refused",
            reason: "unavailable",
          });
          expect(store.peek(thread, [id])).toEqual({ status: "unknown", attachmentId: id });
          await expect(store.discard(thread, id)).rejects.toThrow("queued");
        },
      );

      it("preserves turn-owned bytes when removing a recovered queue item", async () => {
        const thread = mode.threadId(23);
        const ref = await upload(thread, mode.attachmentId(330));
        store = mode.makeStore(root);
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
        const thread = mode.threadId(24);
        const ref = await upload(thread, mode.attachmentId(340));
        const discarded = store.discard(thread, ref.attachmentId);
        expect(store.peek(thread, [ref.attachmentId])).toMatchObject({ status: "unknown" });
        expect(store.claimQueued(thread, owner, [ref.attachmentId])).toMatchObject({
          status: "refused",
        });
        await discarded;
        expect(store.isQueued(thread, ref.attachmentId)).toBe(false);
      });

      it("rolls an unacknowledged reservation back to the draft without deleting bytes", async () => {
        const thread = mode.threadId(25);
        const ref = await upload(thread, mode.attachmentId(350));
        expect(store.claimQueued(thread, owner, [ref.attachmentId])).toMatchObject({
          status: "ok",
        });
        expect(await store.releaseQueued(thread, owner, { disposition: "draft" })).toEqual({
          status: "ok",
        });
        expect(store.peek(thread, [ref.attachmentId])).toEqual({
          status: "ok",
          attachments: [ref],
        });
        await store.discard(thread, ref.attachmentId);
        await expect(store.read(thread, ref)).rejects.toThrow();
      });
    });

    it(`refuses ownership changes while dispatch verification or removal is in flight (${mode.name})`, async () => {
      const thread = mode.threadId(26);
      const id = mode.attachmentId(360);
      const ref = await store.stage({
        threadId: thread,
        attachmentId: id,
        displayName: "race.png",
        mediaType: "image/png" as MediaType,
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
      expect(store.commitQueued(thread, "owner")).toMatchObject({
        status: "refused",
        reason: "busy",
      });
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
  });
}

turnAttachmentSuite<
  CodeThreadId,
  CodeAttachmentId,
  CodeAttachmentMediaType,
  CodeAttachmentReference
>({
  name: "Code",
  scopesDirectory: "code-threads",
  maxBytes: MAX_CODE_ATTACHMENT_BYTES,
  maxTurnAttachments: MAX_CODE_TURN_ATTACHMENTS,
  tooLarge: CodeAttachmentTooLarge,
  invalid: CodeAttachmentInvalid,
  makeStore: (root) => new CodeAttachmentStore(root),
  threadId: (n) =>
    decodeCodeThreadId(`20000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`),
  attachmentId: (n) =>
    decodeCodeAttachmentId(`30000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`),
});

turnAttachmentSuite<
  WorkThreadId,
  WorkAttachmentId,
  WorkAttachmentMediaType,
  WorkAttachmentReference
>({
  name: "Work",
  scopesDirectory: "work-threads",
  maxBytes: MAX_WORK_ATTACHMENT_BYTES,
  maxTurnAttachments: MAX_WORK_TURN_ATTACHMENTS,
  tooLarge: WorkAttachmentTooLarge,
  invalid: WorkAttachmentInvalid,
  makeStore: (root) => new WorkAttachmentStore(root),
  threadId: (n) =>
    decodeWorkThreadId(`20000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`),
  attachmentId: (n) =>
    decodeWorkAttachmentId(`30000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`),
});
