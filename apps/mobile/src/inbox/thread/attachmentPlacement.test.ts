import type { ChatAttachment } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { placeAttachments } from "./attachmentPlacement";

function attachment(id: string, turnId?: string): ChatAttachment {
  return {
    id,
    threadId: "thread-1",
    ...(turnId === undefined ? {} : { turnId }),
    displayName: `${id}.png`,
    mediaType: "image/png",
    byteLength: 10,
    digest: "sha256:0",
    status: "finalized",
    createdAt: "2026-11-14T10:00:00.000Z",
  } as ChatAttachment;
}

const turns = [
  { id: "turn-1", userMessageRef: { contentId: "message-1" } },
  { id: "turn-2", userMessageRef: { contentId: "message-2" } },
];

describe("where a thread's attachments are drawn", () => {
  it("puts an attachment under the message it was sent with", () => {
    const placed = placeAttachments({
      attachments: [attachment("a", "turn-2")],
      turns,
      shownMessageIds: ["message-1", "message-2"],
    });
    expect(placed.get("message-2")?.map((entry) => entry.id)).toEqual(["a"]);
    expect(placed.get("")).toBeUndefined();
  });

  it("keeps an attachment above the transcript when it names no turn or its message is hidden", () => {
    const placed = placeAttachments({
      attachments: [attachment("loose"), attachment("rewound", "turn-1")],
      turns,
      shownMessageIds: ["message-2"],
    });
    expect(placed.get("")?.map((entry) => entry.id)).toEqual(["loose", "rewound"]);
  });
});
