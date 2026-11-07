import { describe, expect, it } from "vitest";
import {
  decodeOwnerApprovalAction,
  decodeOwnerApprovalAnswer,
  decodeOwnerApprovalAuditRecord,
} from "./ownerApprovals";
const answer = {
  ownerMemberId: "50000000-0000-4000-8000-000000000005",
  hostMemberId: "50000000-0000-4000-8000-000000000001",
  mode: "code",
  threadId: "50000000-0000-4000-8000-000000000002",
  projectId: "50000000-0000-4000-8000-000000000003",
  requestId: "50000000-0000-4000-8000-000000000004",
  targetVersion: "a".repeat(64),
  actionDigest: "b".repeat(64),
  approved: true,
};
describe("one-use owner approval contracts", () => {
  it("binds one Code or Work answer and refuses remembered grants, raw action bodies and non-owner audit attribution", () => {
    expect(decodeOwnerApprovalAnswer(answer).mode).toBe("code");
    expect(decodeOwnerApprovalAnswer({ ...answer, mode: "work" }).mode).toBe("work");
    for (const extra of [
      { remember: true },
      { action: { input: "private" } },
      { scope: "session" },
    ])
      expect(() => decodeOwnerApprovalAnswer({ ...answer, ...extra })).toThrow();
    expect(() =>
      decodeOwnerApprovalAuditRecord({
        ...answer,
        phase: "admitted",
        actingPrincipal: { kind: "local-user", actorId: answer.hostMemberId },
      }),
    ).toThrow();
  });
  it("requires complete JSON facts within a UTF-8 byte bound, without cutting consent", () => {
    const action = {
      kind: "file-write",
      tool: "Write",
      input: JSON.stringify({ file_path: "/fixture/a", content: "full content" }),
    };
    expect(decodeOwnerApprovalAction(action)).toEqual(action);
    expect(() => decodeOwnerApprovalAction({ ...action, input: "not-json" })).toThrow();
    expect(() =>
      decodeOwnerApprovalAction({
        ...action,
        input: JSON.stringify({ content: "界".repeat(23_000) }),
      }),
    ).toThrow();
    expect(() => decodeOwnerApprovalAction({ ...action, truncated: true })).toThrow();
  });
});
