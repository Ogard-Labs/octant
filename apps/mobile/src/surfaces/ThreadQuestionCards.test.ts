// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeChatThreadView } from "@octant/contracts";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import { ThemeProvider } from "../../design-system/theme";
import { clearAllMobileQuestionnaireDrafts } from "./questionnaireDraftStore";
import { ChatQuestionCards, CodeQuestionCards } from "./ThreadQuestionCards";

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("expo-blur", () => ({ BlurView: () => null }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
vi.mock("../../design-system", async () => ({
  ...(await import("../../design-system/theme")),
  ...(await import("../../design-system/tokens")),
  ...(await import("../../design-system/tone")),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];
const hostId = "00000000-0000-4000-8000-0000000000aa";
const now = "2026-11-20T10:00:00.000Z";

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    act(() => {
      root?.unmount();
    });
  }
  document.body.replaceChildren();
  clearAllMobileQuestionnaireDrafts();
});

function byRoleText(container: ParentNode, role: string, text: string): HTMLElement {
  const match = [...container.querySelectorAll(`[role="${role}"]`)].find(
    (node) => node.textContent?.replace(/\s+/g, " ").trim() === text,
  );
  if (!(match instanceof HTMLElement)) throw new Error(`No ${role} reads "${text}".`);
  return match;
}

describe("Chat and Code questionnaires on the phone", () => {
  it("answers a Chat multi-question form in one submit and preserves the draft across screen leave", async () => {
    const chatThreadId = "00000000-0000-4000-8000-000000000001";
    const turnId = "00000000-0000-4000-8000-000000000002";
    const attemptId = "00000000-0000-4000-8000-000000000003";
    const view = decodeChatThreadView({
      thread: {
        id: chatThreadId,
        title: "Release plan",
        lifecycle: "active",
        providerInstanceId: "10000000-0000-4000-8000-000000000001",
        modelId: "model-a",
        researchEnabled: false,
        researchRouting: "automatic",
        personalityInstructions: "Be clear.",
        version: 4,
        createdAt: now,
        updatedAt: now,
      },
      turns: [
        {
          id: turnId,
          threadId: chatThreadId,
          sequence: 1,
          userMessageRef: {
            contentId: "44444444-4444-4444-8444-444444444444",
            digest: "a".repeat(64),
            byteLength: 10,
          },
          attachmentIds: [],
          attempts: [
            {
              id: attemptId,
              turnId,
              threadId: chatThreadId,
              providerInstanceId: "10000000-0000-4000-8000-000000000001",
              providerSessionId: "55555555-5555-4555-8555-555555555555",
              modelId: "model-a",
              contextManifestId: "66666666-6666-4666-8666-666666666666",
              outcome: "waiting",
              responseRefs: [],
              citationIds: [],
              pendingQuestion: {
                requestId: "chat-q-1",
                prompt: "Two details",
                options: [],
                questionnaire: {
                  allowComment: false,
                  questions: [
                    {
                      id: "q0",
                      header: "Format",
                      prompt: "Which format?",
                      selection: "single",
                      options: [
                        { id: "o0", label: "Markdown", recommended: true },
                        { id: "o1", label: "PDF" },
                      ],
                    },
                    {
                      id: "q1",
                      header: "Scope",
                      prompt: "Which sections?",
                      selection: "multiple",
                      options: [
                        { id: "o0", label: "Summary" },
                        { id: "o1", label: "Timeline" },
                      ],
                    },
                  ],
                },
              },
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

    const commands: unknown[] = [];
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: async ({ body }) => {
        commands.push(JSON.parse(String(body)));
        return Response.json({ kind: "attempt-updated" });
      },
    };
    const settled = vi.fn();

    const mount = async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      roots.push(root);
      await act(async () => {
        root.render(
          createElement(ThemeProvider, {
            preference: "light",
            surfaceStyle: "flat",
            children: createElement(ChatQuestionCards, {
              transport,
              view,
              onSettled: settled,
            }),
          }),
        );
      });
      return { container, root };
    };

    const first = await mount();
    await act(async () => byRoleText(first.container, "radio", "Markdown Recommended").click());
    // Leave and return before answering the second question.
    roots.pop();
    act(() => first.root.unmount());
    first.container.remove();

    const second = await mount();
    expect(
      byRoleText(second.container, "radio", "Markdown Recommended").getAttribute("aria-checked"),
    ).toBe("true");
    await act(async () => byRoleText(second.container, "checkbox", "Summary").click());
    await act(async () => byRoleText(second.container, "checkbox", "Timeline").click());
    await act(async () => byRoleText(second.container, "button", "Send answers").click());

    expect(commands).toEqual([
      {
        kind: "answer-chat-turn-question",
        threadId: chatThreadId,
        expectedVersion: 4,
        turnId,
        attemptId,
        requestId: "chat-q-1",
        answer: JSON.stringify({
          version: 1,
          answers: [
            { questionId: "q0", selectedOptionIds: ["o0"] },
            { questionId: "q1", selectedOptionIds: ["o0", "o1"] },
          ],
        }),
      },
    ]);
    expect(settled).toHaveBeenCalledOnce();
  });

  it("loads a Code questionnaire with more than eight options and submits through answer-provider-input", async () => {
    const codeThreadId = "10000000-0000-4000-8000-000000000010";
    const checkoutId = "20000000-0000-4000-8000-000000000010";
    const projectId = "30000000-0000-4000-8000-000000000010";
    const tenOptions = Array.from({ length: 10 }, (_, idx) => ({
      id: `o${String(idx)}`,
      label: `Target ${String(idx + 1)}`,
    }));
    const staged: string[] = [];
    const operations: unknown[] = [];
    let pending = true;
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: async ({ method, path, body }) => {
        if (method === "GET" && path === "/api/pending-requests") {
          return Response.json({
            requests: pending
              ? [
                  {
                    mode: "code",
                    kind: "question",
                    projectId,
                    threadId: codeThreadId,
                    threadTitle: "Ship release",
                    text: "Pick a target",
                    options: [],
                    questionnaire: {
                      allowComment: false,
                      questions: [
                        {
                          id: "q0",
                          header: "Target",
                          prompt: "Which target?",
                          selection: "single",
                          options: tenOptions,
                        },
                      ],
                    },
                    requestedAt: now,
                    answer: {
                      threadId: codeThreadId,
                      checkoutId,
                      requestId: "code-q-1",
                    },
                  },
                ]
              : [],
            truncated: false,
            asks: [],
          });
        }
        if (method === "PUT" && path === "/api/code/evidence") {
          staged.push(String(body));
          return Response.json({
            contentId: "40000000-0000-4000-8000-000000000010",
            digest: "b".repeat(64),
            byteLength: String(body).length,
          });
        }
        if (method === "POST" && path === "/api/code/commands") {
          const parsed = JSON.parse(String(body)) as { operationId: string };
          operations.push(parsed);
          pending = false;
          return Response.json({
            kind: "operation-accepted",
            operationId: parsed.operationId,
            threadId: codeThreadId,
            checkoutId,
            acceptedAt: now,
          });
        }
        return new Response("missing", { status: 404 });
      },
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        createElement(ThemeProvider, {
          preference: "light",
          surfaceStyle: "flat",
          children: createElement(CodeQuestionCards, {
            transport,
            threadId: codeThreadId,
            refreshIntervalMs: 60_000,
          }),
        }),
      );
    });

    await act(async () => byRoleText(container, "radio", "Target 10").click());
    await act(async () => byRoleText(container, "button", "Send answers").click());

    expect(staged).toEqual([
      JSON.stringify({
        version: 1,
        answers: [{ questionId: "q0", selectedOptionIds: ["o9"] }],
      }),
    ]);
    expect(operations).toEqual([
      expect.objectContaining({
        kind: "answer-provider-input",
        threadId: codeThreadId,
        checkoutId,
        requestId: "code-q-1",
      }),
    ]);
  });
});
