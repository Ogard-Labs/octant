import { describe, expect, it } from "vitest";
import {
  decodePendingRequest,
  decodePendingRequestList,
  MAX_PENDING_REQUESTS,
} from "./pendingRequests";

const ids = {
  project: "22222222-2222-4222-8222-222222222222",
  workThread: "33333333-3333-4333-8333-333333333333",
  workRequest: "11111111-1111-4111-8111-111111111111",
  codeThread: "44444444-4444-4444-8444-444444444444",
  otherCodeThread: "44444444-4444-4444-8444-444444444445",
  checkout: "55555555-5555-4555-8555-555555555555",
  approval: "66666666-6666-4666-8666-666666666666",
  chatThread: "77777777-7777-4777-8777-777777777777",
  turn: "88888888-8888-4888-8888-888888888888",
  attempt: "99999999-9999-4999-8999-999999999999",
  operation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workTurn: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  binding: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
} as const;
const requestedAt = "2026-10-06T08:00:00.000Z";

const workApproval = {
  mode: "work",
  kind: "approval",
  projectId: ids.project,
  threadId: ids.workThread,
  threadTitle: "Quarterly report",
  text: "Run `bun install`.",
  requestedAt,
  answer: { requestId: ids.workRequest, expectedVersion: 1 },
} as const;

const codeQuestion = {
  mode: "code",
  kind: "question",
  projectId: ids.project,
  threadId: ids.codeThread,
  threadTitle: "Fix the parser",
  text: "Which branch should I base this on?",
  options: [{ label: "main" }, { label: "release" }],
  requestedAt,
  answer: { threadId: ids.codeThread, checkoutId: ids.checkout, requestId: "question-1" },
} as const;

const chatQuestion = {
  mode: "chat",
  kind: "question",
  threadId: ids.chatThread,
  threadTitle: "Trip plan",
  text: "How should I proceed?",
  options: [{ label: "Yes", description: "Book it now." }, { label: "No" }],
  requestedAt,
  answer: {
    threadId: ids.chatThread,
    expectedVersion: 4,
    turnId: ids.turn,
    attemptId: ids.attempt,
    requestId: "q-first",
  },
} as const;

const codeDecision = {
  mode: "code",
  kind: "decision",
  projectId: ids.project,
  threadId: ids.codeThread,
  threadTitle: "Fix the parser",
  text: "The fix is ready. Should I open the pull request now?",
  options: [
    { label: "Open it", recommended: true },
    { label: "Wait for review", recommended: false },
  ],
  requestedAt,
  answer: { threadId: ids.codeThread, checkoutId: ids.checkout, operationId: ids.operation },
} as const;

const workDecision = {
  mode: "work",
  kind: "decision",
  projectId: ids.project,
  threadId: ids.workThread,
  threadTitle: "Quarterly report",
  text: "Which chart should lead the summary?",
  options: [{ label: "Revenue", recommended: true }],
  requestedAt,
  answer: {
    threadId: ids.workThread,
    turnId: ids.workTurn,
    authority: {
      hostId: "local",
      projectId: ids.project,
      bindingRevisionId: ids.binding,
      workingDirectory: ".",
      confinementPosture: "project-root-confined",
      providerInstanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      modelId: "gpt-5",
    },
  },
} as const;

describe("pending request contract", () => {
  it("carries a decision from Code and Work with what each mode's send command takes", () => {
    const list = decodePendingRequestList({
      requests: [codeDecision, workDecision],
      truncated: false,
    });
    expect(list.requests.map((request) => `${request.mode}:${request.kind}`)).toEqual([
      "code:decision",
      "work:decision",
    ]);
  });

  it("refuses a decision without exactly one recommended option", () => {
    expect(() =>
      decodePendingRequest({
        ...codeDecision,
        options: codeDecision.options.map((option) => ({ ...option, recommended: false })),
      }),
    ).toThrow();
    expect(() =>
      decodePendingRequest({
        ...codeDecision,
        options: codeDecision.options.map((option) => ({ ...option, recommended: true })),
      }),
    ).toThrow();
  });

  it("bounds a decision's ask, its options, and their length", () => {
    expect(() => decodePendingRequest({ ...codeDecision, text: "x".repeat(111) })).toThrow();
    expect(() => decodePendingRequest({ ...codeDecision, options: [] })).toThrow();
    expect(() =>
      decodePendingRequest({
        ...codeDecision,
        options: ["a", "b", "c", "d", "e"].map((label, index) => ({
          label,
          recommended: index === 0,
        })),
      }),
    ).toThrow();
    expect(() =>
      decodePendingRequest({
        ...workDecision,
        options: [{ label: "y".repeat(61), recommended: true }],
      }),
    ).toThrow();
  });

  it("refuses a decision whose send handle names another thread or mode", () => {
    expect(() =>
      decodePendingRequest({
        ...codeDecision,
        answer: { ...codeDecision.answer, threadId: ids.otherCodeThread },
      }),
    ).toThrow();
    expect(() => decodePendingRequest({ ...codeDecision, mode: "chat" })).toThrow();
  });

  it("carries a request from each mode with the handle its answer command takes", () => {
    const list = decodePendingRequestList({
      requests: [
        workApproval,
        codeQuestion,
        chatQuestion,
        {
          mode: "code",
          kind: "approval",
          projectId: ids.project,
          threadId: ids.codeThread,
          threadTitle: "Fix the parser",
          text: "Allow `bun test`?",
          requestedAt,
          answer: { threadId: ids.codeThread, checkoutId: ids.checkout, approvalId: ids.approval },
        },
      ],
      truncated: false,
    });
    expect(list.requests.map((request) => `${request.mode}:${request.kind}`)).toEqual([
      "work:approval",
      "code:question",
      "chat:question",
      "code:approval",
    ]);
  });

  it("names the site a Code Browser ask waits on, and only on a Code approval", () => {
    const browserAsk = {
      mode: "code",
      kind: "approval",
      projectId: ids.project,
      threadId: ids.codeThread,
      threadTitle: "Fix the docs site",
      text: "Allow this thread to use an isolated browser session at https://example.com?",
      browserOrigin: "https://example.com",
      requestedAt,
      answer: { threadId: ids.codeThread, checkoutId: ids.checkout, approvalId: ids.approval },
    } as const;
    expect(decodePendingRequest(browserAsk)).toMatchObject({
      browserOrigin: "https://example.com",
    });
    expect(() => decodePendingRequest({ ...browserAsk, browserOrigin: " " })).toThrow();
    expect(() =>
      decodePendingRequest({ ...codeQuestion, browserOrigin: "https://example.com" }),
    ).toThrow();
    expect(() =>
      decodePendingRequest({ ...workApproval, browserOrigin: "https://example.com" }),
    ).toThrow();
  });

  it("keeps a Work request as sanitized as the Work record it came from", () => {
    expect(() =>
      decodePendingRequest({ ...workApproval, text: "Open /Users/me/.ssh/id" }),
    ).toThrow();
    expect(() =>
      decodePendingRequest({ ...workApproval, text: "See https://example.com/token" }),
    ).toThrow();
    expect(() =>
      decodePendingRequest({
        ...workApproval,
        kind: "question",
        options: [{ label: "file:secrets" }],
      }),
    ).toThrow();
  });

  it("refuses an answer handle that names another thread", () => {
    expect(() =>
      decodePendingRequest({
        ...codeQuestion,
        answer: { ...codeQuestion.answer, threadId: ids.otherCodeThread },
      }),
    ).toThrow();
  });

  it("refuses an approval that carries options or a handle from another mode", () => {
    expect(() => decodePendingRequest({ ...workApproval, options: [{ label: "Yes" }] })).toThrow();
    expect(() => decodePendingRequest({ ...chatQuestion, kind: "approval" })).toThrow();
    expect(() =>
      decodePendingRequest({ ...workApproval, answer: { ...workApproval.answer, extra: true } }),
    ).toThrow();
  });

  it("bounds the list and requires the truncation flag", () => {
    expect(() => decodePendingRequestList({ requests: [workApproval] })).toThrow();
    expect(() =>
      decodePendingRequestList({
        requests: Array.from({ length: MAX_PENDING_REQUESTS + 1 }, () => workApproval),
        truncated: true,
      }),
    ).toThrow();
  });
});
