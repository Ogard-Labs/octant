import { expect, it } from "vitest";
import { answerCodeRequest, readCodeRequests } from "./agentCodeRequests";
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
  const requests = await readCodeRequests(session, threadId);
  expect(requests.map((request) => request.kind)).toEqual(["approval", "question"]);
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

it("returns an empty Code request list and refuses unavailable or malformed responses", async () => {
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

  expect(await readCodeRequests(empty, threadId)).toEqual([]);
  await expect(readCodeRequests(unavailable, threadId)).rejects.toThrow(
    "Provider requests are unavailable.",
  );
  await expect(readCodeRequests(malformed, threadId)).rejects.toThrow(
    "Invalid provider request list.",
  );
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
            answer: { threadId, checkoutId, approvalId: requestId },
          },
        ],
      },
    }),
  };
  const approval = (await readCodeRequests(listing, threadId))[0];
  if (approval?.kind !== "approval") throw new Error("Missing Code approval");
  const session: OpenedLocalControlSession = {
    kind: "opened",
    windowId: "test",
    close: async () => {},
    send: async () => ({ status: 200, body: null }),
  };

  expect(await answerCodeRequest(session, approval, "yes")).toContain("refused");
});
