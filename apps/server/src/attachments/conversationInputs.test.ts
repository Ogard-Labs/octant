import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prepareConversationInputs } from "./conversationInputs";

const bytes = new TextEncoder().encode("immutable screenshot");
const input = {
  source: {
    mode: "work" as const,
    threadId: "20000000-0000-4000-8000-000000000001",
    attachmentId: "30000000-0000-4000-8000-000000000001",
  },
  displayName: "Screenshot.png",
  mediaType: "image/png",
  byteLength: bytes.length,
  digest: createHash("sha256").update(bytes).digest("hex"),
};

describe("selected conversation inputs", () => {
  it("preserves the exact bytes and provenance or requires an explicit reduced-input choice", async () => {
    const base = {
      purpose: "provider-switch" as const,
      inputs: [input],
      current: () => true,
      read: async () => bytes,
    };
    expect(await prepareConversationInputs({ ...base, supports: () => true })).toMatchObject({
      status: "ready",
      attachments: [{ displayName: "Screenshot.png", bytes }],
      manifest: { items: [{ status: "included", input }] },
    });
    expect(await prepareConversationInputs({ ...base, supports: () => false })).toMatchObject({
      status: "refused",
      items: [{ reason: "unsupported" }],
    });
    const reduced = await prepareConversationInputs({
      ...base,
      supports: () => false,
      policy: "text-only",
    });
    expect(reduced).toMatchObject({
      status: "ready",
      attachments: [],
      manifest: { items: [{ status: "omitted", reason: "person-excluded", input }] },
    });
  });
  it("applies the documented mode boundary to every handoff purpose before reading source bytes", async () => {
    for (const purpose of [
      "child-delegation",
      "provider-switch",
      "rewind",
      "fork",
      "branch",
      "fork-merge-back",
    ] as const) {
      for (const mode of ["chat", "work", "code"] as const) {
        let reads = 0;
        const result = await prepareConversationInputs({
          purpose,
          inputs: [{ ...input, source: { ...input.source, mode } }],
          current: () => true,
          supports: () => true,
          read: async () => {
            reads++;
            return bytes;
          },
        });
        const permitted =
          purpose === "branch"
            ? mode === "chat"
            : purpose === "fork"
              ? mode !== "chat"
              : purpose === "fork-merge-back"
                ? mode === "code"
                : true;
        expect(result.status).toBe(permitted ? "ready" : "refused");
        expect(reads).toBe(permitted ? 1 : 0);
      }
    }
  });
  it("refuses a replaced input or revoked source instead of sending the remaining prompt alone", async () => {
    const base = {
      purpose: "child-delegation" as const,
      inputs: [input],
      supports: () => true,
      current: () => true,
    };
    expect(
      await prepareConversationInputs({
        ...base,
        read: async () => new TextEncoder().encode("replacement"),
      }),
    ).toMatchObject({ status: "refused", items: [{ reason: "changed" }] });
    let current = true;
    expect(
      await prepareConversationInputs({
        ...base,
        current: () => current,
        read: async () => {
          current = false;
          return bytes;
        },
      }),
    ).toMatchObject({ status: "refused", items: [{ reason: "source-unavailable" }] });
  });
});
