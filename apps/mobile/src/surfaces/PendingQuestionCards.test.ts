// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { ThemeProvider } from "../../design-system/theme";
import { heldQuestionnaireDraft, holdQuestionnaireDraft } from "../approvals/questionnaireDraft";
import { PendingQuestionCards } from "./PendingQuestionCards";

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("expo-blur", () => ({ BlurView: () => null }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
vi.mock("../../design-system", async () => ({
  ...(await import("../../design-system/theme")),
  ...(await import("../../design-system/tokens")),
  ...(await import("../../design-system/tone")),
}));
vi.mock("@octant/client-runtime", async () => {
  const actual =
    await vi.importActual<typeof import("@octant/client-runtime")>("@octant/client-runtime");
  return { ...actual, executeMobileCodeOperation: vi.fn() };
});

const { executeMobileCodeOperation } = await import("@octant/client-runtime");

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const chatThreadId = "30000000-0000-4000-8000-000000000001";
const codeThreadId = "30000000-0000-4000-8000-000000000002";
const checkoutId = "30000000-0000-4000-8000-000000000003";
const roots: Root[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    act(() => {
      root?.unmount();
    });
  }
  document.body.replaceChildren();
  vi.mocked(executeMobileCodeOperation).mockReset();
});

const chatQuestionnaire = {
  mode: "chat",
  kind: "question",
  threadId: chatThreadId,
  threadTitle: "Trip",
  requestedAt: "2026-11-28T10:00:00.000Z",
  text: "Dates · Budget",
  options: [],
  questionnaire: {
    allowComment: false,
    questions: [
      {
        id: "q0",
        header: "Dates",
        prompt: "Which week?",
        selection: "single",
        options: [
          { id: "o0", label: "First week" },
          { id: "o1", label: "Second week", recommended: true },
        ],
      },
      {
        id: "q1",
        header: "Budget",
        prompt: "How much?",
        selection: "single",
        options: [{ id: "o0", label: "Under 1000" }],
      },
    ],
  },
  answer: {
    threadId: chatThreadId,
    expectedVersion: 7,
    turnId: "30000000-0000-4000-8000-000000000011",
    attemptId: "30000000-0000-4000-8000-000000000012",
    requestId: "q-1",
  },
};

const codeQuestion = {
  mode: "code",
  kind: "question",
  projectId: "20000000-0000-4000-8000-000000000001",
  threadId: codeThreadId,
  threadTitle: "Fix login",
  requestedAt: "2026-11-28T10:00:00.000Z",
  text: "Which branch?",
  options: [{ label: "main" }, { label: "develop" }],
  answer: { threadId: codeThreadId, checkoutId, requestId: "provider-req-1" },
};

const evidence = {
  contentId: "40000000-0000-4000-8000-000000000001",
  digest: "a".repeat(64),
  byteLength: 7,
};

function hostListing(
  requests: ReadonlyArray<unknown>,
  options: { readonly truncated?: boolean; readonly refusesThreadReads?: boolean } = {},
) {
  const sent: Array<{ readonly method: string; readonly path: string; readonly body: unknown }> =
    [];
  const reads: string[] = [];
  const transport: MobileRemoteTransport = {
    hostId: "00000000-0000-4000-8000-0000000000aa",
    authenticatedFetch: async ({ method, path, body }) => {
      if (method === "GET") {
        reads.push(path);
        const [, query = ""] = path.split("?");
        const threadId = new URLSearchParams(query).get("threadId");
        // A host from before thread reads refuses every query.
        if (threadId !== null && options.refusesThreadReads === true)
          return Response.json({ code: "invalid" }, { status: 400 });
        return Response.json({
          requests: requests.filter(
            (request) =>
              threadId === null ||
              (request as { readonly threadId: string }).threadId === threadId,
          ),
          truncated: options.truncated ?? false,
        });
      }
      sent.push({ method, path, body });
      if (path === "/api/code/evidence") {
        return Response.json(evidence);
      }
      return Response.json({ kind: "attempt-updated" });
    },
  };
  return { transport, sent, reads };
}

async function render(transport: MobileRemoteTransport, mode: "chat" | "code", threadId: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      createElement(ThemeProvider, {
        preference: "light",
        surfaceStyle: "flat",
        children: createElement(PendingQuestionCards, {
          transport,
          mode,
          threadId,
          refreshIntervalMs: 60_000,
        }),
      }),
    );
  });
  return container;
}

async function press(container: ParentNode, role: string, label: string) {
  const match = container.querySelector(`[role="${role}"][aria-label="${label}"]`);
  if (!(match instanceof HTMLElement)) throw new Error(`No ${role} is labelled "${label}".`);
  await act(async () => {
    match.click();
  });
}

describe("a Chat question on the phone", () => {
  it("draws the whole questionnaire as one card and answers it with one command", async () => {
    const { transport, sent } = hostListing([chatQuestionnaire]);
    const container = await render(transport, "chat", chatThreadId);
    expect(container.querySelectorAll('[data-testid="mobile-chat-question"]')).toHaveLength(1);
    expect(container.textContent).toContain("Dates · Budget");
    await press(container, "radio", "Second week, recommended");
    await press(container, "radio", "Under 1000");
    await press(container, "button", "Send answers");
    expect(sent).toHaveLength(1);
    const [command] = sent;
    expect(command?.path).toBe("/api/chat/commands");
    const body = JSON.parse(String(command?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      kind: "answer-chat-turn-question",
      threadId: chatThreadId,
      expectedVersion: 7,
      requestId: "q-1",
    });
    expect(JSON.parse(String(body["answer"]))).toEqual({
      version: 1,
      answers: [
        { questionId: "q0", selectedOptionIds: ["o1"] },
        { questionId: "q1", selectedOptionIds: ["o0"] },
      ],
    });
  });

  it("reads its own thread's requests, so a host with many waiting elsewhere still shows it", async () => {
    const { transport, reads } = hostListing([chatQuestionnaire, codeQuestion]);
    const container = await render(transport, "chat", chatThreadId);
    expect(reads).toEqual([`/api/pending-requests?threadId=${chatThreadId}`]);
    expect(container.querySelectorAll('[data-testid="mobile-chat-question"]')).toHaveLength(1);
  });

  it("falls back to the whole list on a host that takes no thread read", async () => {
    const { transport, reads } = hostListing([chatQuestionnaire], { refusesThreadReads: true });
    const container = await render(transport, "chat", chatThreadId);
    expect(reads).toEqual([
      `/api/pending-requests?threadId=${chatThreadId}`,
      "/api/pending-requests",
    ]);
    expect(container.querySelectorAll('[data-testid="mobile-chat-question"]')).toHaveLength(1);
  });

  it("keeps an unsent answer when the host's list is cut short", async () => {
    const { transport } = hostListing([], { truncated: true, refusesThreadReads: true });
    const scope = `${transport.hostId}|chat|${chatThreadId}`;
    const key = `${scope}|turn|attempt|request`;
    const draft = { answers: [] };
    holdQuestionnaireDraft(key, chatQuestionnaire.questionnaire as never, draft as never);
    await render(transport, "chat", chatThreadId);
    expect(heldQuestionnaireDraft(key, chatQuestionnaire.questionnaire as never)).toBe(draft);
  });

  it("shows only its own thread's questions", async () => {
    const { transport } = hostListing([chatQuestionnaire, codeQuestion]);
    const container = await render(transport, "chat", "30000000-0000-4000-8000-0000000000ff");
    expect(container.querySelector('[data-testid="mobile-chat-question"]')).toBeNull();
  });
});

describe("a Code question on the phone", () => {
  it("stages the chosen words as evidence and answers the provider's input request", async () => {
    vi.mocked(executeMobileCodeOperation).mockImplementation(
      async (_transport, command) =>
        ({
          kind: "provider-turn-state",
          operationId: command.operationId,
          state: "running",
        }) as never,
    );
    const { transport, sent } = hostListing([codeQuestion]);
    const container = await render(transport, "code", codeThreadId);
    expect(container.querySelectorAll('[data-testid="mobile-code-question"]')).toHaveLength(1);
    await press(container, "radio", "develop");
    await press(container, "button", "Send answer");
    expect(sent).toEqual([{ method: "PUT", path: "/api/code/evidence", body: "develop" }]);
    expect(vi.mocked(executeMobileCodeOperation).mock.calls[0]?.[1]).toMatchObject({
      kind: "answer-provider-input",
      threadId: codeThreadId,
      checkoutId,
      requestId: "provider-req-1",
      response: evidence,
    });
  });

  it("shows a refusal the running turn gives and keeps the answer to send again", async () => {
    vi.mocked(executeMobileCodeOperation).mockImplementation(
      async (_transport, command) =>
        ({
          kind: "provider-turn-state",
          operationId: command.operationId,
          state: "running",
          failure: { category: "stale", message: "That question is no longer pending." },
        }) as never,
    );
    const { transport } = hostListing([codeQuestion]);
    const container = await render(transport, "code", codeThreadId);
    await press(container, "radio", "develop");
    await press(container, "button", "Send answer");
    expect(container.textContent).toContain("That question is no longer pending.");
    expect(
      container.querySelector('[role="radio"][aria-label="develop"]')?.getAttribute("aria-checked"),
    ).toBe("true");
  });
});
