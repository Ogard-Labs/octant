import { decodePendingRequest, type PendingRequest } from "@octant/contracts/pending-requests";
import type { ApprovalPendingRequest } from "./needsYouCommands";

export const pendingIds = {
  project: "22222222-2222-4222-8222-222222222222",
  workThread: "33333333-3333-4333-8333-333333333333",
  workRequest: "11111111-1111-4111-8111-111111111111",
  codeThread: "44444444-4444-4444-8444-444444444444",
  checkout: "55555555-5555-4555-8555-555555555555",
  approval: "66666666-6666-4666-8666-666666666666",
  chatThread: "77777777-7777-4777-8777-777777777777",
  turn: "88888888-8888-4888-8888-888888888888",
  attempt: "99999999-9999-4999-8999-999999999999",
} as const;

export function workApproval(): ApprovalPendingRequest {
  return decodePendingRequest({
    mode: "work",
    kind: "approval",
    projectId: pendingIds.project,
    threadId: pendingIds.workThread,
    threadTitle: "Quarterly report",
    text: "Run `bun install`.",
    requestedAt: "2026-10-06T08:00:00.000Z",
    answer: { requestId: pendingIds.workRequest, expectedVersion: 3 },
  }) as ApprovalPendingRequest;
}

export function codeApproval(): ApprovalPendingRequest {
  return decodePendingRequest({
    mode: "code",
    kind: "approval",
    projectId: pendingIds.project,
    threadId: pendingIds.codeThread,
    threadTitle: "Fix the parser",
    text: "Allow `bun test`?",
    requestedAt: "2026-10-06T08:01:00.000Z",
    answer: {
      threadId: pendingIds.codeThread,
      checkoutId: pendingIds.checkout,
      approvalId: pendingIds.approval,
    },
  }) as ApprovalPendingRequest;
}

export function codeQuestion(): PendingRequest {
  return decodePendingRequest({
    mode: "code",
    kind: "question",
    projectId: pendingIds.project,
    threadId: pendingIds.codeThread,
    threadTitle: "Fix the parser",
    text: "Which branch should I base this on?",
    options: [{ label: "main" }, { label: "release" }],
    requestedAt: "2026-10-06T08:02:00.000Z",
    answer: {
      threadId: pendingIds.codeThread,
      checkoutId: pendingIds.checkout,
      requestId: "question-1",
    },
  });
}

export function chatQuestion(): PendingRequest {
  return decodePendingRequest({
    mode: "chat",
    kind: "question",
    threadId: pendingIds.chatThread,
    threadTitle: "Trip plan",
    text: "How should I proceed?",
    options: [{ label: "Yes", description: "Book it now." }, { label: "No" }],
    requestedAt: "2026-10-06T08:03:00.000Z",
    answer: {
      threadId: pendingIds.chatThread,
      expectedVersion: 4,
      turnId: pendingIds.turn,
      attemptId: pendingIds.attempt,
      requestId: "q-first",
    },
  });
}
