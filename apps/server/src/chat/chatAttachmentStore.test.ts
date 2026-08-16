import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decodeChatAttachmentId,
  decodeChatThreadId,
  type ChatThreadId,
  type ChatAttachmentId,
} from "@octant/contracts";
import {
  ChatAttachmentStore,
  MAX_CHAT_ATTACHMENT_BYTES,
  sanitizeChatAttachmentDisplayName,
} from "./chatAttachmentStore";

let root: string;
let store: ChatAttachmentStore;

const makeThreadId = (n: number): ChatThreadId => {
  const hex = n.toString(16).padStart(12, "0");
  return decodeChatThreadId(`00000000-0000-4000-8000-${hex}`);
};

const makeAttachmentId = (n: number): ChatAttachmentId => {
  const hex = n.toString(16).padStart(12, "0");
  return decodeChatAttachmentId(`10000000-0000-4000-8000-${hex}`);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "octant-attachment-store-test-"));
  store = new ChatAttachmentStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("path traversal protection", () => {
  it("sanitizes traversal display names into bounded metadata only", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);

    const staged = await store.stage({
      chatThreadId: threadId,
      chatAttachmentId: attachmentId,
      displayName: "../../../etc/passwd",
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(staged.displayName).toBe(sanitizeChatAttachmentDisplayName("../../../etc/passwd"));
    expect(staged.displayName).not.toContain("/");
    expect(staged.displayName).not.toContain("..");
    expect(join(root, "threads", threadId, attachmentId, "staged.bin.tmp")).toContain(threadId);
  });

  it("rejects forged thread IDs before deriving managed paths", async () => {
    const attachmentId = makeAttachmentId(1);

    await expect(
      store.stage({
        chatThreadId: "../../../escape" as ChatThreadId,
        chatAttachmentId: attachmentId,
        displayName: "payload.bin",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow();
  });

  it("rejects forged attachment IDs before deriving managed paths", async () => {
    const threadId = makeThreadId(1);

    await expect(
      store.stage({
        chatThreadId: threadId,
        chatAttachmentId: "../../outside" as ChatAttachmentId,
        displayName: "payload.bin",
        bytes: new Uint8Array([1]),
      }),
    ).rejects.toThrow();
  });

  it("rejects empty display names", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);

    await expect(
      store.stage({
        chatThreadId: threadId,
        chatAttachmentId: attachmentId,
        displayName: "   ",
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toThrow("display name");
  });

  it("rejects a symlinked attachment directory before staging outside the managed root", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);
    const outside = await mkdtemp(join(tmpdir(), "octant-attachment-escape-"));
    const threadDir = join(root, "threads", threadId);
    const attachmentDir = join(threadDir, attachmentId);

    try {
      await mkdir(threadDir, { recursive: true });
      await symlink(outside, attachmentDir, "dir");

      await expect(
        store.stage({
          chatThreadId: threadId,
          chatAttachmentId: attachmentId,
          displayName: "escape.bin",
          bytes: new Uint8Array([1, 2, 3]),
        }),
      ).rejects.toThrow("managed attachment directory");

      await expect(access(join(outside, "staged.bin.tmp"))).rejects.toThrow();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects a symlink swap before finalizing outside the managed root", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);
    const payload = new Uint8Array([4, 5, 6]);
    const staged = await store.stage({
      chatThreadId: threadId,
      chatAttachmentId: attachmentId,
      displayName: "escape-finalize.bin",
      bytes: payload,
    });
    const outside = await mkdtemp(join(tmpdir(), "octant-attachment-finalize-escape-"));
    const attachmentDir = join(root, "threads", threadId, attachmentId);

    try {
      await rm(attachmentDir, { recursive: true, force: true });
      await writeFile(join(outside, "staged.bin.tmp"), payload);
      await symlink(outside, attachmentDir, "dir");

      await expect(store.finalize(staged)).rejects.toThrow("managed attachment directory");
      await expect(access(join(outside, "finalized.bin"))).rejects.toThrow();
      await expect(access(join(outside, "staged.bin.tmp"))).resolves.toBeUndefined();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("size enforcement", () => {
  it("rejects empty attachment bytes before creating managed storage", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);

    await expect(
      store.stage({
        chatThreadId: threadId,
        chatAttachmentId: attachmentId,
        displayName: "empty.txt",
        bytes: new Uint8Array(),
      }),
    ).rejects.toThrow("empty");
    await expect(access(join(root, "threads", threadId, attachmentId))).rejects.toThrow();
  });

  it("rejects attachments exceeding the maximum size with a typed too-large failure", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);
    const oversized = new Uint8Array(MAX_CHAT_ATTACHMENT_BYTES + 1);

    await expect(
      store.stage({
        chatThreadId: threadId,
        chatAttachmentId: attachmentId,
        displayName: "oversize.bin",
        bytes: oversized,
      }),
    ).rejects.toMatchObject({ category: "too-large" });
  });

  it("accepts attachments at exactly the maximum size", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);
    const exact = new Uint8Array(MAX_CHAT_ATTACHMENT_BYTES);
    exact[0] = 0xab;

    const staged = await store.stage({
      chatThreadId: threadId,
      chatAttachmentId: attachmentId,
      displayName: "exact.bin",
      bytes: exact,
    });

    expect(staged.size).toBe(MAX_CHAT_ATTACHMENT_BYTES);
  });
});

describe("stage, finalize, and read lifecycle", () => {
  it("stages, finalizes, and reads back with matching content", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

    const staged = await store.stage({
      chatThreadId: threadId,
      chatAttachmentId: attachmentId,
      displayName: "payload.bin",
      bytes: payload,
    });

    expect(staged.size).toBe(4);
    expect(staged.displayName).toBe("payload.bin");

    const finalized = await store.finalize(staged);
    expect(finalized.size).toBe(4);
    expect(finalized.displayName).toBe("payload.bin");
    expect(finalized.hash).toBe(staged.hash);

    const read = await store.read(finalized);
    expect(read).toEqual(payload);
  });

  it("refuses to overwrite an existing staged attachment", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);

    await store.stage({
      chatThreadId: threadId,
      chatAttachmentId: attachmentId,
      displayName: "first.bin",
      bytes: new Uint8Array([1]),
    });

    await expect(
      store.stage({
        chatThreadId: threadId,
        chatAttachmentId: attachmentId,
        displayName: "second.bin",
        bytes: new Uint8Array([2]),
      }),
    ).rejects.toThrow();
  });

  it("preserves the first staged attachment when a duplicate stage is rejected", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);
    const payload = new Uint8Array([1, 2, 3]);

    const staged = await store.stage({
      chatThreadId: threadId,
      chatAttachmentId: attachmentId,
      displayName: "first.bin",
      bytes: payload,
    });

    await expect(
      store.stage({
        chatThreadId: threadId,
        chatAttachmentId: attachmentId,
        displayName: "second.bin",
        bytes: new Uint8Array([9]),
      }),
    ).rejects.toThrow();

    const finalized = await store.finalize(staged);
    expect(await store.read(finalized)).toEqual(payload);
  });

  it("rejects staging when the attachment is already finalized", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);
    const payload = new Uint8Array([7, 8, 9]);

    const staged = await store.stage({
      chatThreadId: threadId,
      chatAttachmentId: attachmentId,
      displayName: "final.bin",
      bytes: payload,
    });
    const finalized = await store.finalize(staged);
    const tmpPath = join(root, "threads", threadId, attachmentId, "staged.bin.tmp");

    await expect(
      store.stage({
        chatThreadId: threadId,
        chatAttachmentId: attachmentId,
        displayName: "retry.bin",
        bytes: new Uint8Array([0]),
      }),
    ).rejects.toThrow();

    await expect(access(tmpPath)).rejects.toThrow();
    expect(await store.read(finalized)).toEqual(payload);
  });

  it("removes only its own temporary artifact when staging aborts", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);
    const controller = new AbortController();
    controller.abort(new Error("staging cancelled"));

    const stagedPath = join(root, "threads", threadId, attachmentId, "staged.bin.tmp");

    await expect(
      store.stage({
        chatThreadId: threadId,
        chatAttachmentId: attachmentId,
        displayName: "abort.bin",
        bytes: new Uint8Array([1, 2, 3]),
        signal: controller.signal,
      }),
    ).rejects.toThrow("staging cancelled");

    await expect(access(stagedPath)).rejects.toThrow();
  });

  it("removes only its own temporary artifact when staging aborts after the byte write", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);
    const stagedPath = join(root, "threads", threadId, attachmentId, "staged.bin.tmp");
    let abortChecks = 0;
    const signal = {
      get aborted() {
        abortChecks += 1;
        return abortChecks >= 4;
      },
      reason: new Error("post-write cancelled"),
    } as unknown as AbortSignal;

    await expect(
      store.stage({
        chatThreadId: threadId,
        chatAttachmentId: attachmentId,
        displayName: "abort-after-write.bin",
        bytes: new Uint8Array([1, 2, 3]),
        signal,
      }),
    ).rejects.toThrow("post-write cancelled");

    await expect(access(stagedPath)).rejects.toThrow();
  });

  it("finalized reference carries decoded IDs for verification", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);

    const staged = await store.stage({
      chatThreadId: threadId,
      chatAttachmentId: attachmentId,
      displayName: "ref.bin",
      bytes: new Uint8Array([1]),
    });

    const finalized = await store.finalize(staged);

    const decodedThread = decodeChatThreadId(finalized.chatThreadId);
    const decodedAtt = decodeChatAttachmentId(finalized.chatAttachmentId);

    expect(decodedThread).toBe(finalized.chatThreadId);
    expect(decodedAtt).toBe(finalized.chatAttachmentId);
    expect(finalized.chatThreadId).toBe(threadId);
    expect(finalized.chatAttachmentId).toBe(attachmentId);
  });

  it("read rejects a reference with tampered hash", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);

    const staged = await store.stage({
      chatThreadId: threadId,
      chatAttachmentId: attachmentId,
      displayName: "tamper.bin",
      bytes: new Uint8Array([1, 2, 3]),
    });

    const finalized = await store.finalize(staged);

    await expect(
      store.read({
        ...finalized,
        hash: "0000000000000000000000000000000000000000000000000000000000000000",
      }),
    ).rejects.toThrow("corrupt");
  });

  it("read rejects a reference with tampered size", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);

    const staged = await store.stage({
      chatThreadId: threadId,
      chatAttachmentId: attachmentId,
      displayName: "tamper-size.bin",
      bytes: new Uint8Array([1, 2, 3]),
    });

    const finalized = await store.finalize(staged);

    await expect(store.read({ ...finalized, size: 999 })).rejects.toThrow("corrupt");
  });

  it("read rejects forged IDs before reading managed bytes", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);

    const staged = await store.stage({
      chatThreadId: threadId,
      chatAttachmentId: attachmentId,
      displayName: "forged.bin",
      bytes: new Uint8Array([1]),
    });

    const finalized = await store.finalize(staged);

    await expect(
      store.read({
        ...finalized,
        chatThreadId: "../../../escape" as ChatThreadId,
      }),
    ).rejects.toThrow();
  });

  it("read rejects a reference pointing to a non-existent file", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);

    const staged = await store.stage({
      chatThreadId: threadId,
      chatAttachmentId: attachmentId,
      displayName: "missing.bin",
      bytes: new Uint8Array([1]),
    });

    const finalized = await store.finalize(staged);

    await rm(join(root, "threads", threadId, attachmentId, "finalized.bin"), {
      force: true,
    });

    await expect(store.read(finalized)).rejects.toThrow("not found");
  });

  it("finalizing an already-finalized attachment is idempotent", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);

    const staged = await store.stage({
      chatThreadId: threadId,
      chatAttachmentId: attachmentId,
      displayName: "idempotent.bin",
      bytes: new Uint8Array([42]),
    });

    const finalized1 = await store.finalize(staged);
    const finalized2 = await store.finalize(staged);

    expect(finalized2.size).toBe(1);
    expect(finalized2.hash).toBe(finalized1.hash);

    const read = await store.read(finalized2);
    expect(read).toEqual(new Uint8Array([42]));
  });
});

describe("recovery", () => {
  it("removes staged temp when finalized bytes already exist", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);
    const payload = new Uint8Array([4, 5, 6]);

    const staged = await store.stage({
      chatThreadId: threadId,
      chatAttachmentId: attachmentId,
      displayName: "both.bin",
      bytes: payload,
    });
    const finalized = await store.finalize(staged);
    const tmpPath = join(root, "threads", threadId, attachmentId, "staged.bin.tmp");

    await writeFile(tmpPath, new Uint8Array([99]));

    expect(await store.hasTemporaryFiles()).toBe(true);

    await store.recover();

    expect(await store.hasTemporaryFiles()).toBe(false);
    await expect(access(tmpPath)).rejects.toThrow();
    expect(await store.read(finalized)).toEqual(payload);
  });

  it("removes incomplete temporary files without deleting finalized attachments", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);

    const staged = await store.stage({
      chatThreadId: threadId,
      chatAttachmentId: attachmentId,
      displayName: "incomplete.bin",
      bytes: new Uint8Array([1, 2, 3]),
    });

    const attachmentId2 = makeAttachmentId(2);
    const staged2 = await store.stage({
      chatThreadId: threadId,
      chatAttachmentId: attachmentId2,
      displayName: "complete.bin",
      bytes: new Uint8Array([4, 5, 6]),
    });
    const finalized = await store.finalize(staged2);

    expect(await store.hasTemporaryFiles()).toBe(true);

    await store.recover();

    expect(await store.hasTemporaryFiles()).toBe(false);

    const read = await store.read(finalized);
    expect(read).toEqual(new Uint8Array([4, 5, 6]));

    const tmpPath = join(root, "threads", threadId, attachmentId, "staged.bin.tmp");
    await expect(access(tmpPath)).rejects.toThrow();

    await expect(store.finalize(staged)).rejects.toThrow();
  });

  it("removes finalized attachments that are no longer referenced by a projection", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);
    const finalized = await store
      .stage({
        chatThreadId: threadId,
        chatAttachmentId: attachmentId,
        displayName: "orphan.bin",
        bytes: new Uint8Array([7, 8, 9]),
      })
      .then((staged) => store.finalize(staged));

    await store.recover({
      isFinalizedAttachmentReferenced: () => false,
    });

    await expect(store.read(finalized)).rejects.toThrow("Attachment not found");
  });

  it("ignores invalid thread and attachment directory entries", async () => {
    const threadId = makeThreadId(1);
    const attachmentId = makeAttachmentId(1);

    await mkdir(join(root, "threads", "not-a-thread-id"), { recursive: true });
    await mkdir(join(root, "threads", threadId, "not-an-attachment-id"), { recursive: true });
    await writeFile(join(root, "threads", "rogue-file.txt"), "ignore me");

    const staged = await store.stage({
      chatThreadId: threadId,
      chatAttachmentId: attachmentId,
      displayName: "valid.bin",
      bytes: new Uint8Array([9]),
    });
    const finalized = await store.finalize(staged);

    await store.recover();

    expect(await store.read(finalized)).toEqual(new Uint8Array([9]));
  });

  it("recover is safe when called with no attachments", async () => {
    await store.recover();
  });
});

describe("purgeThread", () => {
  it("removes only the purged thread's attachments", async () => {
    const threadA = makeThreadId(1);
    const threadB = makeThreadId(2);

    const attA = makeAttachmentId(1);
    const attB = makeAttachmentId(2);

    const finalizedA = await store
      .stage({
        chatThreadId: threadA,
        chatAttachmentId: attA,
        displayName: "a.bin",
        bytes: new Uint8Array([1]),
      })
      .then((s) => store.finalize(s));

    const finalizedB = await store
      .stage({
        chatThreadId: threadB,
        chatAttachmentId: attB,
        displayName: "b.bin",
        bytes: new Uint8Array([2]),
      })
      .then((s) => store.finalize(s));

    await store.purgeThread(threadA);

    await expect(store.read(finalizedA)).rejects.toThrow("not found");

    const readB = await store.read(finalizedB);
    expect(readB).toEqual(new Uint8Array([2]));
  });

  it("rejects forged thread IDs before purge", async () => {
    await expect(store.purgeThread("../../../escape" as ChatThreadId)).rejects.toThrow();
  });

  it("purgeThread is safe when called for a non-existent thread", async () => {
    const nonExistent = makeThreadId(9999);
    await store.purgeThread(nonExistent);
  });
});
