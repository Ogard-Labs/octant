import { describe, expect, it } from "vitest";
import { decodeChatThreadView } from "@octant/contracts";
import {
  chatAttemptStatusLabel,
  latestActiveChatAttempt,
  latestRetryableChatAttempt,
} from "./mobileChatAttempt";

const threadId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const contentId = "44444444-4444-4444-8444-444444444444";
const providerInstanceId = "55555555-5555-4555-8555-555555555555";
const modelId = "model-a";
const digest = "a".repeat(64);
const now = "2026-08-06T12:00:00.000Z";

function viewWithAttempt(outcome: "streaming" | "failed" | "completed") {
  return decodeChatThreadView({
    thread: {
      id: threadId,
      title: "Live",
      lifecycle: "active",
      providerInstanceId,
      modelId,
      researchEnabled: false,
      researchRouting: "automatic",
      personalityInstructions: "Be brief.",
      version: 3,
      createdAt: now,
      updatedAt: now,
    },
    turns: [
      {
        id: turnId,
        threadId,
        sequence: 1,
        userMessageRef: { contentId, digest, byteLength: 4 },
        attachmentIds: [],
        attempts: [
          {
            id: attemptId,
            turnId,
            threadId,
            providerInstanceId,
            providerSessionId: "66666666-6666-4666-8666-666666666666",
            modelId,
            contextManifestId: "77777777-7777-4777-8777-777777777777",
            outcome,
            responseRefs: [],
            citationIds: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      },
    ],
    lastSequence: 1,
    contents: [],
    attachments: [],
    citations: [],
    workItems: [],
    workListVersion: 1,
    followUpVersion: 1,
  });
}

describe("mobileChatAttempt helpers", () => {
  it("finds the latest active attempt", () => {
    const view = viewWithAttempt("streaming");
    expect(latestActiveChatAttempt(view)?.id).toBe(attemptId);
    expect(latestRetryableChatAttempt(view)).toBeUndefined();
  });

  it("finds the latest retryable attempt", () => {
    const view = viewWithAttempt("failed");
    expect(latestActiveChatAttempt(view)).toBeUndefined();
    expect(latestRetryableChatAttempt(view)?.outcome).toBe("failed");
  });

  it("labels attempt outcomes", () => {
    expect(chatAttemptStatusLabel("streaming")).toBe("Streaming");
    expect(chatAttemptStatusLabel("failed")).toBe("Failed");
  });
});
