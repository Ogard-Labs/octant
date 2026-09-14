import { describe, expect, it } from "vitest";
import { decodeCodeOperationApprovalChallenge } from "@octant/contracts";
import { decodeChallenge } from "./codeOperationApprovalChallengeView";

describe("native approval challenge decoding", () => {
  it.each([
    { kind: "none" },
    { kind: "branch", name: "main", oid: "a".repeat(40) },
    { kind: "detached", oid: "a".repeat(40) },
  ])("renders a valid approval for a $kind checkout head", (checkoutHead) => {
    const challenge = decodeCodeOperationApprovalChallenge({
      challengeId: "11111111-1111-4111-8111-111111111111",
      effectDigest: "a".repeat(64),
      contextDigest: "b".repeat(64),
      projectId: "11111111-1111-4111-8111-111111111111",
      threadId: "11111111-1111-4111-8111-111111111111",
      threadTitle: "QA",
      checkoutId: "11111111-1111-4111-8111-111111111111",
      repositoryId: "repo_" + "c".repeat(64),
      checkoutHead,
      message: "Run repository test?",
      detail: "npm run test",
    });
    expect(decodeChallenge(challenge)).toMatchObject({
      checkoutHead,
      message: challenge.message,
      detail: challenge.detail,
    });
  });
});
