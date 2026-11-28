import { expect, it } from "vitest";
import { PENDING_REQUEST_APPROVAL_SUBJECTS_MEDIA_TYPE } from "@octant/contracts/pending-requests";
import { answerCodeRequest, codeApprovalOpensThread, readCodeRequests } from "./agentCodeRequests";
import type { OpenedLocalControlSession, LocalControlRequest } from "./localControl";
const threadId = "00000000-0000-4000-8000-000000000001";
const checkoutId = "00000000-0000-4000-8000-000000000002";
const requestId = "00000000-0000-4000-8000-000000000003";
const common = {
  mode: "code",
  projectId: checkoutId,
  threadId,
  threadTitle: "Task",
  requestedAt: "2026-11-16T12:00:00.000Z",
  text: "Proceed?",
};
it("reads ordinary provider approvals and questions, and answers approvals once through the Code route", async () => {
  const seen: LocalControlRequest[] = [];
  const session: OpenedLocalControlSession = {
    kind: "opened",
    windowId: "test",
    close: async () => {},
    send: async (request) => {
      seen.push(request);
      if (request.method === "PUT")
        return {
          status: 200,
          body: { contentId: requestId, digest: "a".repeat(64), byteLength: 3 },
        };
      return request.method === "GET"
        ? {
            status: 200,
            body: {
              requests: [
                {
                  ...common,
                  kind: "approval",
                  approves: "tool-call",
                  answer: { threadId, checkoutId, approvalId: requestId },
                },
                {
                  ...common,
                  kind: "question",
                  options: [{ label: "Yes" }],
                  answer: { threadId, checkoutId, requestId },
                },
                {
                  ...common,
                  kind: "approval",
                  browserOrigin: "https://example.test",
                  answer: { threadId, checkoutId, approvalId: requestId },
                },
                { ...common, kind: "lead-approval", text: "Wait for the person." },
                {
                  ...common,
                  threadId: "00000000-0000-4000-8000-000000000004",
                  kind: "question",
                  options: [{ label: "No" }],
                  answer: {
                    threadId: "00000000-0000-4000-8000-000000000004",
                    checkoutId,
                    requestId,
                  },
                },
              ],
            },
          }
        : { status: 200, body: { kind: "provider-turn-state", state: "running" } };
    },
  };
  const result = await readCodeRequests(session, threadId);
  if (result.kind !== "ready") throw new Error("Code requests were unavailable");
  const requests = result.requests;
  expect(requests.map((request) => request.kind)).toEqual(["approval", "question"]);
  expect(seen[0]).toMatchObject({
    path: "/api/pending-requests",
    headers: { accept: PENDING_REQUEST_APPROVAL_SUBJECTS_MEDIA_TYPE },
  });
  const approval = requests[0];
  if (approval === undefined) throw new Error("Missing approval");
  expect(await answerCodeRequest(session, approval, "always")).toContain("y or n");
  expect(seen).toHaveLength(1);
  expect(await answerCodeRequest(session, approval, "y")).toBeUndefined();
  expect(seen[1]).toMatchObject({
    path: "/api/code/commands",
    body: {
      kind: "answer-provider-approval",
      approvalId: requestId,
      decision: "approved",
      threadId,
      checkoutId,
    },
  });
  const question = requests[1];
  if (question === undefined) throw new Error("Missing question");
  expect(await answerCodeRequest(session, question, "1")).toBeUndefined();
  expect(new TextDecoder().decode(seen[2]?.bytes)).toBe("Yes");
  expect(seen[3]).toMatchObject({
    body: { kind: "answer-provider-input", requestId, threadId, checkoutId },
  });
});

it("keeps unavailable Code requests distinct from an empty list", async () => {
  const empty: OpenedLocalControlSession = {
    kind: "opened",
    windowId: "test",
    close: async () => {},
    send: async () => ({ status: 200, body: { requests: [] } }),
  };
  const unavailable: OpenedLocalControlSession = {
    kind: "opened",
    windowId: "test",
    close: async () => {},
    send: async () => ({ status: 503, body: {} }),
  };
  const malformed: OpenedLocalControlSession = {
    kind: "opened",
    windowId: "test",
    close: async () => {},
    send: async () => ({ status: 200, body: null }),
  };

  expect(await readCodeRequests(empty, threadId)).toEqual({ kind: "ready", requests: [] });
  expect(await readCodeRequests(unavailable, threadId)).toMatchObject({
    kind: "refused",
    message: expect.any(String),
  });
  expect(await readCodeRequests(malformed, threadId)).toEqual({
    kind: "refused",
    message: "Provider requests are unavailable.",
  });
  const networkFailure: OpenedLocalControlSession = {
    kind: "opened",
    windowId: "test",
    close: async () => {},
    send: async () => {
      throw new Error("network unavailable");
    },
  };
  expect(await readCodeRequests(networkFailure, threadId)).toEqual({
    kind: "refused",
    message: "Provider requests are unavailable.",
  });
});

it("reports a missing Code answer response instead of treating it as success", async () => {
  const listing: OpenedLocalControlSession = {
    kind: "opened",
    windowId: "test",
    close: async () => {},
    send: async () => ({
      status: 200,
      body: {
        requests: [
          {
            ...common,
            kind: "approval",
            approves: "tool-call",
            answer: { threadId, checkoutId, approvalId: requestId },
          },
        ],
      },
    }),
  };
  const result = await readCodeRequests(listing, threadId);
  if (result.kind !== "ready") throw new Error("Code requests were unavailable");
  const approval = result.requests[0];
  if (approval?.kind !== "approval") throw new Error("Missing Code approval");
  const session: OpenedLocalControlSession = {
    kind: "opened",
    windowId: "test",
    close: async () => {},
    send: async () => ({ status: 200, body: null }),
  };

  expect(await answerCodeRequest(session, approval, "yes")).toContain("refused");
});

it("refuses to answer a move into or out of Plan with y or n, and sends the person to the thread that shows the plan", async () => {
  const seen: LocalControlRequest[] = [];
  const session: OpenedLocalControlSession = {
    kind: "opened",
    windowId: "test",
    close: async () => {},
    send: async (request) => {
      seen.push(request);
      return {
        status: 200,
        body: {
          requests: [
            {
              ...common,
              kind: "approval",
              approves: "level-change",
              answer: { threadId, checkoutId, approvalId: requestId },
            },
            // A host that names neither subject is read as one that may change
            // the level, so the terminal never allows a plan it cannot show.
            {
              ...common,
              kind: "approval",
              answer: { threadId, checkoutId, approvalId: requestId },
            },
          ],
        },
      };
    },
  };
  const result = await readCodeRequests(session, threadId);
  if (result.kind !== "ready") throw new Error("Code requests were unavailable");
  expect(result.requests).toHaveLength(2);
  seen.length = 0;
  for (const approval of result.requests) {
    const opens = codeApprovalOpensThread(approval);
    expect(opens).toContain("Open this thread in the Octant app");
    for (const text of ["y", "yes", "n"]) {
      expect(await answerCodeRequest(session, approval, text)).toBe(opens);
    }
  }
  expect(seen).toEqual([]);
  const [levelChange] = result.requests;
  expect(levelChange === undefined ? "" : codeApprovalOpensThread(levelChange)).toContain("Plan");
});
