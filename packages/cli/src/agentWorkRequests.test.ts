import { describe, expect, it } from "vitest";
import {
  answerWorkQuestionnaire,
  answerWorkRequest,
  readWorkRequests,
  stepWorkQuestionnaire,
  WORK_SECRET_QUESTION_REFUSAL,
  workLevelChangeText,
  workQuestionnaireText,
} from "./agentWorkRequests";
import type { LocalControlRequest, OpenedLocalControlSession } from "./localControl";

const threadId = "00000000-0000-4000-8000-000000000001";
const projectId = "00000000-0000-4000-8000-000000000002";
const requestId = "00000000-0000-4000-8000-000000000003";
const questionRequestId = "00000000-0000-4000-8000-000000000007";
const pending = {
  mode: "work",
  projectId,
  threadId,
  threadTitle: "Task",
  requestedAt: "2026-11-16T12:00:00.000Z",
  answer: { requestId, expectedVersion: 4 },
};
/** The journaled Work request the app's thread view reads, with its full detail. */
const journaled = (detail: unknown, id: string = requestId) => ({
  requestId: id,
  projectId,
  threadId,
  providerInstanceId: "00000000-0000-4000-8000-000000000005",
  providerSessionId: "00000000-0000-4000-8000-000000000006",
  providerRequestId: "provider-request",
  status: "pending",
  requestedAt: "2026-11-16T12:00:00.000Z",
  version: 4,
  detail,
});
const questionDetail = { kind: "user-input", prompt: "Which format?", options: ["PDF"] };
const approvalDetail = { kind: "approval", action: "Run", description: "Run the command?" };
/** Each pending row is derived from its own journaled request, so each has its own id. */
const details = [journaled(approvalDetail), journaled(questionDetail, questionRequestId)];
const questionAnswer = { requestId: questionRequestId, expectedVersion: 4 };

describe("terminal Work requests", () => {
  it("lists only answerable Work approvals and questions for the current thread", async () => {
    const session: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "test",
      close: async () => undefined,
      send: async (request) => ({
        status: 200,
        body: {
          requests: request.path.startsWith("/api/work/requests")
            ? details
            : [
                { ...pending, kind: "approval", text: "Run the command?" },
                {
                  ...pending,
                  answer: questionAnswer,
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

    const result = await readWorkRequests(session, threadId);
    if (result.kind !== "ready") throw new Error("Work requests were unavailable");
    const requests = result.requests;

    expect(requests.map((request) => request.kind)).toEqual(["approval", "question"]);
  });

  it("returns an empty list when there are no pending requests", async () => {
    const session: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "test",
      close: async () => undefined,
      send: async () => ({ status: 200, body: { requests: [] } }),
    };

    expect(await readWorkRequests(session, threadId)).toEqual({ kind: "ready", requests: [] });
  });

  it("keeps unavailable or malformed pending-request responses distinct from empty", async () => {
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

    expect(await readWorkRequests(unavailable, threadId)).toMatchObject({
      kind: "refused",
      message: expect.any(String),
    });
    expect(await readWorkRequests(malformed, threadId)).toEqual({
      kind: "refused",
      message: "Provider requests are unavailable.",
    });
    const networkFailure: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "test",
      close: async () => undefined,
      send: async () => {
        throw new Error("network unavailable");
      },
    };
    expect(await readWorkRequests(networkFailure, threadId)).toEqual({
      kind: "refused",
      message: "Provider requests are unavailable.",
    });
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
      answer: questionAnswer,
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
        if (request.method === "GET") return { status: 200, body: { requests: details } };
        seen.push(request);
        return { status: 200, body: { kind: "work-request-resolved" } };
      },
    };
    const result = await readWorkRequests(session, threadId);
    if (result.kind !== "ready") throw new Error("Work requests were unavailable");
    const requests = result.requests;
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
        requestId: questionRequestId,
        resolution: { kind: "user-input", answer: "DOCX" },
      },
    });
  });

  it("sends nothing for a question that asks for a secret and points to the app", async () => {
    const answers: LocalControlRequest[] = [];
    const session: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "test",
      close: async () => undefined,
      send: async (request) => {
        if (request.path === "/api/pending-requests")
          return {
            status: 200,
            body: {
              requests: [
                {
                  ...pending,
                  answer: questionAnswer,
                  kind: "question",
                  text: "Paste the API token",
                  options: [],
                  secret: true,
                },
              ],
            },
          };
        if (request.method === "GET")
          return {
            status: 200,
            body: {
              requests: [
                journaled(
                  { kind: "user-input", prompt: "Paste the API token", options: [], secret: true },
                  questionRequestId,
                ),
              ],
            },
          };
        answers.push(request);
        return { status: 200, body: { kind: "work-request-resolved" } };
      },
    };
    const read = await readWorkRequests(session, threadId);
    const secret = read.kind === "ready" ? read.requests[0] : undefined;
    if (secret?.kind !== "question") throw new Error("Missing secret question");

    expect(await answerWorkRequest(session, secret, "sk-test-123")).toBe(
      WORK_SECRET_QUESTION_REFUSAL,
    );
    expect(answers).toEqual([]);
  });

  it("reports an empty or refused answer response without throwing", async () => {
    const listing: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "test",
      close: async () => undefined,
      send: async (request) => ({
        status: 200,
        body: {
          requests: request.path.startsWith("/api/work/requests")
            ? [journaled(approvalDetail)]
            : [{ ...pending, kind: "approval", text: "Run the command?" }],
        },
      }),
    };
    const result = await readWorkRequests(listing, threadId);
    if (result.kind !== "ready") throw new Error("Work requests were unavailable");
    const approval = result.requests[0];
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

  it("shows the level and plan an approval to leave Plan would authorize", async () => {
    const plan = [
      "Edit the report",
      ...Array.from({ length: 24 }, (_, i) => `Step ${String(i + 1)}`),
    ];
    const session: OpenedLocalControlSession = {
      kind: "opened",
      windowId: "test",
      close: async () => undefined,
      send: async (request) => ({
        status: 200,
        body: {
          requests: request.path.startsWith("/api/work/requests")
            ? [
                journaled({
                  kind: "approval",
                  action: "Leave Plan",
                  description: "Start implementing",
                  levelChange: { to: "auto-accept-edits", plan: plan.join("\n") },
                }),
              ]
            : [{ ...pending, kind: "approval", text: "Start implementing" }],
        },
      }),
    };

    const result = await readWorkRequests(session, threadId);
    const approval = result.kind === "ready" ? result.requests[0] : undefined;
    if (approval?.kind !== "approval") throw new Error("Missing Work approval");
    const text = workLevelChangeText(approval.levelChange);

    expect(text).toContain("Allowing moves this thread to Accept edits.");
    expect(text).toContain("Plan:\nEdit the report\nStep 1");
    expect(text).toContain("Step 24");
    expect(text.split("\n").at(-1)).toBe("Allowing moves this thread to Accept edits.");
    expect(workLevelChangeText({ to: "plan" })).toBe("Allowing moves this thread to Plan.");
    expect(workLevelChangeText(undefined)).toBe("");
  });

  describe("questionnaires", () => {
    const questionnaire = {
      questions: [
        {
          id: "format",
          prompt: "Which format?",
          selection: "single" as const,
          options: [
            { id: "pdf", label: "PDF", recommended: true },
            { id: "md", label: "Markdown", description: "Plain text" },
          ],
          allowCustom: false,
        },
        {
          id: "extras",
          prompt: "Which extras?",
          selection: "multiple" as const,
          options: [
            { id: "toc", label: "Contents" },
            { id: "index", label: "Index" },
            { id: "notes", label: "Notes" },
          ],
          minSelections: 0,
          maxSelections: 2,
        },
      ],
    };
    const workRequest = {
      requestId,
      projectId,
      threadId,
      providerInstanceId: "00000000-0000-4000-8000-000000000005",
      providerSessionId: "00000000-0000-4000-8000-000000000006",
      providerRequestId: "provider-request",
      status: "pending",
      requestedAt: "2026-11-16T12:00:00.000Z",
      version: 4,
      detail: {
        kind: "user-input",
        prompt: "Choose the export",
        options: [],
        questionnaire,
      },
    };
    const questionRow = { ...pending, kind: "question", text: "Choose the export", options: [] };

    it("reads the journaled questionnaire from the Work request route the app uses", async () => {
      const seen: string[] = [];
      const session: OpenedLocalControlSession = {
        kind: "opened",
        windowId: "test",
        close: async () => undefined,
        send: async (request) => {
          seen.push(request.path);
          return request.path === "/api/pending-requests"
            ? { status: 200, body: { requests: [questionRow] } }
            : { status: 200, body: { requests: [workRequest] } };
        },
      };

      const result = await readWorkRequests(session, threadId);

      expect(seen[1]).toBe(`/api/work/requests?projectId=${projectId}&threadId=${threadId}`);
      expect(result).toMatchObject({ kind: "ready", requests: [{ questionnaire }] });
    });

    it("refuses to offer a question whose questionnaire cannot be read", async () => {
      const session: OpenedLocalControlSession = {
        kind: "opened",
        windowId: "test",
        close: async () => undefined,
        send: async (request) =>
          request.path === "/api/pending-requests"
            ? { status: 200, body: { requests: [questionRow] } }
            : { status: 401, body: { failure: { message: "Work request is unauthorized." } } },
      };

      expect(await readWorkRequests(session, threadId)).toMatchObject({ kind: "refused" });
    });

    it("asks each question in turn and submits the whole response once", async () => {
      expect(workQuestionnaireText(questionnaire, [])).toBe(
        [
          "Question 1 of 2: Which format?",
          "1. PDF (recommended)",
          "2. Markdown — Plain text",
          "Type a number, then Enter.",
        ].join("\n"),
      );
      const written = stepWorkQuestionnaire(questionnaire, [], "Word please");
      expect(written).toMatchObject({ kind: "asking", answers: [], note: expect.any(String) });
      expect(stepWorkQuestionnaire(questionnaire, [], "3")).toMatchObject({ answers: [] });
      const first = stepWorkQuestionnaire(questionnaire, [], "2");
      if (first.kind !== "asking") throw new Error("The questionnaire ended early");
      expect(first.note).toBeUndefined();
      /** Answers the last question, then the optional comment. */
      const finish = (text: string, comment = "") => {
        const answered = stepWorkQuestionnaire(questionnaire, first.answers, text);
        return answered.kind === "asking" && answered.answers.length === 2
          ? stepWorkQuestionnaire(questionnaire, answered.answers, comment)
          : answered;
      };
      expect(workQuestionnaireText(questionnaire, first.answers)).toContain(
        "Question 2 of 2: Which extras?",
      );
      expect(workQuestionnaireText(questionnaire, first.answers)).toContain(
        "Type numbers separated by commas, 0 for none, or your own answer (start it with = if it is a number; == keeps a leading =)",
      );
      expect(stepWorkQuestionnaire(questionnaire, first.answers, "1, 2, 3")).toMatchObject({
        kind: "asking",
        answers: first.answers,
      });
      expect(
        stepWorkQuestionnaire(questionnaire, first.answers, "see https://example.com"),
      ).toMatchObject({ kind: "asking", note: expect.stringContaining("links") });
      expect(finish("=2")).toMatchObject({
        kind: "complete",
        response: {
          answers: [{}, { questionId: "extras", selectedOptionIds: [], customAnswer: "2" }],
        },
      });
      expect(finish("= 12")).toMatchObject({
        kind: "complete",
        response: { answers: [{}, { customAnswer: "12" }] },
      });
      expect(finish("==12")).toMatchObject({
        kind: "complete",
        response: { answers: [{}, { customAnswer: "=12" }] },
      });
      expect(finish("= =12")).toMatchObject({
        kind: "complete",
        response: { answers: [{}, { customAnswer: "= =12" }] },
      });
      expect(finish("=SUM(B2:B5)")).toMatchObject({
        kind: "complete",
        response: { answers: [{}, { customAnswer: "=SUM(B2:B5)" }] },
      });
      expect(stepWorkQuestionnaire(questionnaire, [], "=2")).toMatchObject({
        kind: "asking",
        answers: [],
      });
      expect(finish("0")).toEqual({
        kind: "complete",
        response: {
          version: 1,
          answers: [
            { questionId: "format", selectedOptionIds: ["md"] },
            { questionId: "extras", selectedOptionIds: [] },
          ],
        },
      });
      const commenting = stepWorkQuestionnaire(questionnaire, first.answers, "3 1");
      if (commenting.kind !== "asking") throw new Error("The comment was not asked for");
      expect(workQuestionnaireText(questionnaire, commenting.answers)).toBe(
        "Add a comment for the agent, or press Enter to send your answers.",
      );
      expect(
        stepWorkQuestionnaire(questionnaire, commenting.answers, "see https://example.com"),
      ).toMatchObject({ kind: "asking", answers: commenting.answers, note: expect.any(String) });
      expect(
        stepWorkQuestionnaire({ ...questionnaire, allowComment: false }, first.answers, "3 1"),
      ).toMatchObject({ kind: "complete" });
      const done = stepWorkQuestionnaire(questionnaire, commenting.answers, "Ship it on Friday");
      if (done.kind !== "complete") throw new Error("The questionnaire did not complete");

      const seen: LocalControlRequest[] = [];
      const session: OpenedLocalControlSession = {
        kind: "opened",
        windowId: "test",
        close: async () => undefined,
        send: async (request) => {
          if (request.path === "/api/pending-requests")
            return { status: 200, body: { requests: [questionRow] } };
          if (request.method === "GET") return { status: 200, body: { requests: [workRequest] } };
          seen.push(request);
          return { status: 200, body: { kind: "work-request-resolved" } };
        },
      };
      const read = await readWorkRequests(session, threadId);
      const question = read.kind === "ready" ? read.requests[0] : undefined;
      if (question === undefined) throw new Error("Missing Work question");

      expect(await answerWorkQuestionnaire(session, question, done.response)).toBeUndefined();
      expect(seen).toEqual([
        {
          path: "/api/work/requests/commands",
          method: "POST",
          body: {
            kind: "resolve-work-request",
            requestId,
            expectedVersion: 4,
            resolution: {
              kind: "user-input",
              answer: {
                version: 1,
                answers: [
                  { questionId: "format", selectedOptionIds: ["md"] },
                  { questionId: "extras", selectedOptionIds: ["notes", "toc"] },
                ],
                comment: "Ship it on Friday",
              },
            },
          },
        },
      ]);
    });
  });
});
