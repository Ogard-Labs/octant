import { describe, expect, it } from "vitest";
import { answerWorkRequest, readWorkRequests } from "./agentWorkRequests";
import type { LocalControlRequest, OpenedLocalControlSession } from "./localControl";

const threadId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const requestId = "00000000-0000-4000-8000-000000000003";
const pending = {
  mode: "work",
  projectId,
  threadId,
  threadTitle: "Task",
  requestedAt: "2026-11-16T12:00:00.000Z",
  answer: { requestId, expectedVersion: 4 },
};

describe("terminal Work requests", () => {
  it("lists only answerable Work approvals and questions for the current thread", async () => {
    const session: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "test",
      close: async () => undefined,
      send: async () => ({
        status: 200,
        body: {
          requests: [
            { ...pending, kind: "approval", text: "Run the command?" },
            {
              ...pending,
              kind: "question",
              text: "Which format?",
              options: [{ label: "PDF" }],
            },
            {
              mode: "work",
              projectId,
              threadId,
              threadTitle: "Task",
              requestedAt: "2026-11-16T12:00:00.000Z",
              kind: "lead-question",
              text: "What next?",
            },
            {
              ...pending,
              kind: "approval",
              threadId: "00000000-0000-4000-8000-000000000004",
              text: "Other thread",
            },
          ],
        },
      }),
    };

    const requests = await readWorkRequests(session, threadId);

    expect(requests.map((request) => request.kind)).toEqual(["approval", "question"]);
  });

  it("returns an empty list when there are no pending requests", async () => {
    const session: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "test",
      close: async () => undefined,
      send: async () => ({ status: 200, body: { requests: [] } }),
    };

    expect(await readWorkRequests(session, threadId)).toEqual([]);
  });

  it("rejects unavailable or malformed pending-request responses", async () => {
    const unavailable: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "test",
      close: async () => undefined,
      send: async () => ({ status: 403, body: {} }),
    };
    const malformed: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "test",
      close: async () => undefined,
      send: async () => ({ status: 200, body: null }),
    };

    await expect(readWorkRequests(unavailable, threadId)).rejects.toThrow(
      "Provider requests are unavailable.",
    );
    await expect(readWorkRequests(malformed, threadId)).rejects.toThrow(
      "Invalid provider request list.",
    );
  });

  it("answers approvals and selects question options through the existing Work route", async () => {
    const seen: LocalControlRequest[] = [];
    const approvalInput = {
      ...pending,
      kind: "approval" as const,
      text: "Run the command?",
    };
    const questionInput = {
      ...pending,
      kind: "question" as const,
      text: "Which format?",
      options: [{ label: "PDF" }, { label: "DOCX" }],
    };
    const session: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "test",
      close: async () => undefined,
      send: async (request) => {
        if (request.path === "/api/pending-requests")
          return { status: 200, body: { requests: [approvalInput, questionInput] } };
        seen.push(request);
        return { status: 200, body: { kind: "work-request-resolved" } };
      },
    };
    const requests = await readWorkRequests(session, threadId);
    const approval = requests[0];
    const question = requests[1];
    if (approval?.kind !== "approval" || question?.kind !== "question")
      throw new Error("Missing Work requests");

    expect(await answerWorkRequest(session, approval, "maybe")).toContain("y or n");
    expect(seen).toHaveLength(0);
    expect(await answerWorkRequest(session, approval, "y")).toBeUndefined();
    expect(await answerWorkRequest(session, question, "2")).toBeUndefined();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      path: "/api/work/requests/commands",
      body: {
        kind: "resolve-work-request",
        requestId,
        expectedVersion: 4,
        resolution: { kind: "approval", approved: true },
      },
    });
    expect(seen[1]).toMatchObject({
      body: {
        kind: "resolve-work-request",
        resolution: { kind: "user-input", answer: "DOCX" },
      },
    });
  });

  it("reports an empty or refused answer response without throwing", async () => {
    const listing: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "test",
      close: async () => undefined,
      send: async () => ({
        status: 200,
        body: {
          requests: [{ ...pending, kind: "approval", text: "Run the command?" }],
        },
      }),
    };
    const approval = (await readWorkRequests(listing, threadId))[0];
    if (approval?.kind !== "approval") throw new Error("Missing Work approval");
    const empty: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "test",
      close: async () => undefined,
      send: async () => ({ status: 200, body: null }),
    };
    const refused: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "test",
      close: async () => undefined,
      send: async () => ({
        status: 409,
        body: { kind: "refused", failure: { message: "The request was already resolved." } },
      }),
    };

    expect(await answerWorkRequest(empty, approval, "yes")).toContain("refused");
    expect(await answerWorkRequest(refused, approval, "yes")).toContain("already resolved");
  });
});
