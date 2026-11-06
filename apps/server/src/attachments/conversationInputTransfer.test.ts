import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeWorkThreadId } from "@octant/contracts";
import { WorkAttachmentStore } from "../work/workAttachmentStore";
import { ConversationInputTransfer } from "./conversationInputTransfer";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
const bytes = new TextEncoder().encode("original screenshot");
const original = {
  source: {
    mode: "work" as const,
    threadId: "11111111-1111-4111-8111-111111111111",
    attachmentId: "22222222-2222-4222-8222-222222222222",
  },
  displayName: "Original.png",
  mediaType: "image/png",
  byteLength: bytes.length,
  digest: createHash("sha256").update(bytes).digest("hex"),
};
const owner = { mode: "work" as const, threadId: "33333333-3333-4333-8333-333333333333" };

describe("durable conversation input transfer", () => {
  it("keeps a bounded explicit omission receipt for an over-limit selection and unavailable source metadata through restart", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-input-omissions-")));
    directories.push(directory);
    const make = () =>
      new ConversationInputTransfer({
        ownerCurrent: () => true,
        dataDirectory: directory,
        sourceCurrent: () => false,
        read: async () => {
          throw new Error("Text-only must not read original bytes");
        },
        supports: () => false,
      });
    const inputs = Array.from({ length: 12 }, (_, n) => ({
      ...original,
      source: {
        ...original.source,
        attachmentId: `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`,
      },
    }));
    const request = {
      owner,
      purpose: "provider-switch" as const,
      selection: { inputs, inputUnavailable: true },
      policy: "text-only" as const,
      target: { providerInstanceId: "provider", modelId: "text" },
      current: () => true,
    };
    const initial = await make().prepare(request);
    expect(initial).toMatchObject({
      status: "ready",
      attachments: [],
      manifest: { omittedUnlistedInputs: 4, sourceMetadataUnavailable: true },
      receipt: { included: 0, omitted: 12, sourceMetadataUnavailable: true },
    });
    if (initial.status !== "ready" || initial.receipt === undefined)
      throw new Error("Expected durable omissions");
    const replay = {
      owner,
      purpose: "provider-switch" as const,
      previous: initial.receipt,
      target: request.target,
      current: request.current,
    };
    expect(await make().prepare(replay)).toMatchObject({
      status: "ready",
      receipt: initial.receipt,
      manifest: { omittedUnlistedInputs: 4, sourceMetadataUnavailable: true },
    });
    expect(await make().prepare({ ...replay, policy: "preserve" })).toMatchObject({
      status: "refused",
    });
    expect(
      await make().prepare({ ...request, selection: { inputUnavailable: true } }),
    ).toMatchObject({
      status: "ready",
      receipt: { included: 0, omitted: 0, sourceMetadataUnavailable: true },
    });
  });

  it("restores the exact admitted input after restart and refuses changed bytes or a purged destination", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-input-transfer-")));
    directories.push(directory);
    let currentBytes = bytes;
    let sourceCurrent = true;
    const make = () =>
      new ConversationInputTransfer({
        ownerCurrent: () => true,
        dataDirectory: directory,
        sourceCurrent: () => sourceCurrent,
        read: async () => currentBytes,
        supports: () => true,
      });
    const initial = await make().prepare({
      owner,
      purpose: "provider-switch",
      selection: { inputs: [original] },
      target: { providerInstanceId: "provider", modelId: "vision" },
      current: () => true,
    });
    expect(initial.status).toBe("ready");
    if (initial.status !== "ready" || initial.receipt === undefined) return;
    const resumed = await make().prepare({
      owner,
      purpose: "provider-switch",
      previous: initial.receipt,
      selection: { inputs: [{ ...original, displayName: "Replacement.png" }] },
      target: { providerInstanceId: "provider", modelId: "vision" },
      current: () => true,
    });
    expect(resumed).toMatchObject({
      status: "ready",
      manifest: { items: [{ input: { displayName: "Original.png" } }] },
    });
    if (resumed.status !== "ready") throw new Error("Expected restored inputs");
    expect(resumed.inputsCurrent?.()).toBe(true);
    sourceCurrent = false;
    expect(resumed.inputsCurrent?.()).toBe(false);
    sourceCurrent = true;
    currentBytes = new TextEncoder().encode("replacement screenshot");
    expect(
      await make().prepare({
        owner,
        purpose: "provider-switch",
        previous: initial.receipt,
        target: { providerInstanceId: "provider", modelId: "vision" },
        current: () => true,
      }),
    ).toMatchObject({ status: "refused" });
    currentBytes = bytes;
    await new WorkAttachmentStore(directory).purgeThread(decodeWorkThreadId(owner.threadId));
    expect(
      await make().prepare({
        owner,
        purpose: "provider-switch",
        previous: initial.receipt,
        target: { providerInstanceId: "provider", modelId: "vision" },
        current: () => true,
      }),
    ).toMatchObject({ status: "refused" });
  });
  it("retains an explicit text-only receipt when the destination cannot receive an image", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-input-transfer-")));
    directories.push(directory);
    const transfer = new ConversationInputTransfer({
      ownerCurrent: () => true,
      dataDirectory: directory,
      sourceCurrent: () => true,
      read: async () => bytes,
      supports: () => false,
    });
    const request = {
      owner,
      purpose: "rewind" as const,
      selection: { inputs: [original] },
      target: { providerInstanceId: "provider", modelId: "text" },
      current: () => true,
    };
    expect(await transfer.prepare(request)).toMatchObject({ status: "refused" });
    expect(await transfer.prepare({ ...request, policy: "text-only" })).toMatchObject({
      status: "ready",
      attachments: [],
      manifest: { items: [{ status: "omitted", reason: "person-excluded" }] },
      receipt: { included: 0, omitted: 1, policy: "text-only" },
    });
  });
});
