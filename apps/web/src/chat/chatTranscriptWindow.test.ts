import { decodeChatThreadView, type ChatThreadView } from "@octant/contracts/chat";
import { describe, expect, it } from "vitest";
import {
  canvasCardsForShownRun,
  joinChatViews,
  joinDetachedRange,
  refreshChatTail,
} from "./chatTranscriptWindow";

const now = "2026-07-20T08:00:00.000Z";
const threadId = "00000000-0000-4000-8000-000000000801";
const pad = (index: number) => String(index).padStart(12, "0");
const turnId = (index: number) => `00000000-0000-4000-8000-${pad(index)}`;
const contentId = (index: number) => `10000000-0000-4000-8000-${pad(index)}`;
const attachmentId = (index: number) => `40000000-0000-4000-8000-${pad(index)}`;

function turn(index: number) {
  return {
    id: turnId(index),
    threadId,
    sequence: index + 1,
    userMessageRef: { contentId: contentId(index), digest: "a".repeat(64), byteLength: 1 },
    attachmentIds: [],
    attempts: [],
    createdAt: now,
  };
}

function attachment(index: number, turnIndex: number | undefined) {
  return {
    id: attachmentId(index),
    threadId,
    ...(turnIndex === undefined ? {} : { turnId: turnId(turnIndex) }),
    displayName: "notes.txt",
    mediaType: "text/plain",
    byteLength: 1,
    digest: "c".repeat(64),
    status: turnIndex === undefined ? "pending" : "finalized",
    createdAt: now,
  };
}

const candidate = (modelId: string) => ({
  hostId: "local",
  providerInstanceId: "10000000-0000-4000-8000-000000000001",
  modelId,
});

function receipt(forTurn: string) {
  return {
    threadId,
    turnId: forTurn,
    decidedAt: now,
    decision: {
      kind: "waiting",
      request: {
        pool: {
          candidates: [candidate("model-a"), candidate("model-b")],
          mixedVendorEnabled: false,
          fallbackAllowed: false,
          higherCostFallbackAllowed: false,
        },
        requiredCapabilities: [],
      },
      mode: "chat",
      activeHostId: "local",
      parentCandidate: candidate("model-a"),
      eligibility: [
        { candidate: candidate("model-a"), eligible: false, reasons: ["provider-not-ready"] },
        { candidate: candidate("model-b"), eligible: false, reasons: ["provider-not-ready"] },
      ],
      reason: "no-eligible-candidate",
      message: "No model in the pool is ready.",
    },
  };
}

function view(
  indexes: ReadonlyArray<number>,
  extra: {
    readonly attachments?: ReadonlyArray<ReturnType<typeof attachment>>;
    readonly receipts?: ReadonlyArray<string>;
    readonly lastSequence?: number;
  } = {},
): ChatThreadView {
  return decodeChatThreadView({
    thread: {
      id: threadId,
      title: "Windowed",
      lifecycle: "active",
      providerInstanceId: "10000000-0000-4000-8000-000000000001",
      modelId: "model-a",
      researchEnabled: false,
      researchRouting: "automatic",
      personalityInstructions: "Be calm.",
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    turns: indexes.map(turn),
    lastSequence: extra.lastSequence ?? 1,
    contents: indexes.map((index) => ({
      contentId: contentId(index),
      role: "user",
      body: `Message ${String(index)}`,
      digest: "a".repeat(64),
      byteLength: 1,
    })),
    attachments: extra.attachments ?? [],
    citations: [],
    workItems: [],
    workListVersion: 0,
    followUpVersion: 0,
    ...(extra.receipts === undefined ? {} : { routeDecisions: extra.receipts.map(receipt) }),
  });
}

const ids = (joined: ChatThreadView) => joined.turns.map((entry) => String(entry.id));

describe("joining Chat thread pages", () => {
  it("keeps each turn's body, attachments, and route receipt when pages join", () => {
    const newest = view([3, 4], { attachments: [attachment(4, 4)], receipts: [turnId(4)] });
    const earlier = view([1, 2], { attachments: [attachment(1, 1)], receipts: [turnId(1)] });

    const joined = joinChatViews(newest, earlier, [...earlier.turns, ...newest.turns]);

    expect(ids(joined)).toEqual([1, 2, 3, 4].map(turnId));
    expect(joined.contents.map((content) => content.body)).toEqual([
      "Message 3",
      "Message 4",
      "Message 1",
      "Message 2",
    ]);
    expect(joined.attachments.map((entry) => entry.id)).toEqual([4, 1].map(attachmentId));
    expect(joined.routeDecisions?.map((entry) => entry.turnId)).toEqual([4, 1].map(turnId));
  });

  it("takes what belongs to no turn yet from the newest read alone", () => {
    const neverAccepted = "88000000-0000-4000-8000-000000000001";
    const sentSince = "88000000-0000-4000-8000-000000000002";
    const held = view([1, 2], {
      attachments: [attachment(9, undefined)],
      receipts: [sentSince],
      lastSequence: 4,
    });
    const newest = view([2, 3], {
      attachments: [attachment(8, undefined)],
      receipts: [neverAccepted],
      lastSequence: 9,
    });

    const refreshed = refreshChatTail(held, true, {
      version: 1,
      view: newest,
      hasEarlier: true,
      hasLater: false,
      supersededTurnCount: 0,
    });

    expect(ids(refreshed.view)).toEqual([1, 2, 3].map(turnId));
    expect(refreshed.hasEarlier).toBe(true);
    expect(refreshed.view.lastSequence).toBe(9);
    expect(refreshed.view.attachments.map((entry) => entry.id)).toEqual([attachmentId(8)]);
    expect(refreshed.view.routeDecisions?.map((entry) => entry.turnId)).toEqual([neverAccepted]);
  });

  it("lets go of the bodies of turns the newest read no longer holds", () => {
    const held = view([1, 2, 3, 4]);
    const refreshed = refreshChatTail(held, false, {
      version: 1,
      view: view([2, 7]),
      hasEarlier: true,
      hasLater: false,
      supersededTurnCount: 2,
    });

    expect(ids(refreshed.view)).toEqual([1, 2, 7].map(turnId));
    expect(refreshed.view.contents.map((content) => content.body).toSorted()).toEqual([
      "Message 1",
      "Message 2",
      "Message 7",
    ]);
  });

  it("joins a jumped-to run onto the newest turns only once the two share a turn", () => {
    const detached = (indexes: ReadonlyArray<number>) => ({
      view: view(indexes),
      hasEarlier: true,
      hasLater: true,
      earlier: "idle" as const,
      later: "idle" as const,
      verifiedAtSupersededCount: 0,
    });
    const tail = view([6, 7, 8]);

    expect(joinDetachedRange(tail, true, detached([2, 3, 4, 5]))).toBeUndefined();
    const joined = joinDetachedRange(tail, true, detached([3, 4, 5, 6]));
    expect(joined === undefined ? [] : ids(joined.view)).toEqual([3, 4, 5, 6, 7, 8].map(turnId));
    expect(joined?.hasEarlier).toBe(true);
  });

  it("places on a jumped-to run only the Canvases written by the time its last turn settled", () => {
    const run = view([3, 4]);
    const cards = [
      { canvasId: "during", canvasCreatedAt: now },
      { canvasId: "later", canvasCreatedAt: "2026-07-20T09:00:00.000Z" },
      { canvasId: "undated" },
    ];

    expect(canvasCardsForShownRun(cards, run, true).map((card) => card.canvasId)).toEqual([
      "during",
    ]);
    // The newest turns end the thread, so every card may land on them.
    expect(canvasCardsForShownRun(cards, run, false)).toBe(cards);
  });
});
