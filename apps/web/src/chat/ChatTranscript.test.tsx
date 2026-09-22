import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decodeChatThreadView } from "@octant/contracts/chat";
import { decodeThreadCheckpoint } from "@octant/contracts/thread-checkpoints";
import { describe, expect, it, vi } from "vitest";
import { ChatTranscript } from "./ChatTranscript";

const now = "2026-07-20T08:00:00.000Z";
const ids = {
  thread: "00000000-0000-4000-8000-000000000801",
  turn: "00000000-0000-4000-8000-000000000802",
  firstAttempt: "00000000-0000-4000-8000-000000000803",
  secondAttempt: "00000000-0000-4000-8000-000000000804",
  userContent: "00000000-0000-4000-8000-000000000805",
  responseContent: "00000000-0000-4000-8000-000000000806",
  responseContent2: "00000000-0000-4000-8000-000000000809",
  attachment: "00000000-0000-4000-8000-000000000807",
  citation: "00000000-0000-4000-8000-000000000808",
} as const;

function viewFixture(
  overrides: Record<string, unknown> & {
    readonly attemptOutcome?: string;
    readonly attemptUpdatedAt?: string;
  } = {},
) {
  const { attemptOutcome, attemptUpdatedAt, ...rest } = overrides;
  const completedAttemptOutcome = attemptOutcome ?? "completed";
  const completedAttemptUpdatedAt = attemptUpdatedAt ?? now;
  return decodeChatThreadView({
    thread: {
      id: ids.thread,
      title: "Transcript",
      lifecycle: "active",
      providerInstanceId: "10000000-0000-4000-8000-000000000001",
      modelId: "model-a",
      researchEnabled: false,
      researchRouting: "automatic",
      personalityInstructions: "Be calm.",
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    lastSequence: 4,
    turns: [
      {
        id: ids.turn,
        threadId: ids.thread,
        sequence: 1,
        userMessageRef: reference(ids.userContent, "a"),
        attachmentIds: [ids.attachment],
        attempts: [
          {
            id: ids.firstAttempt,
            turnId: ids.turn,
            threadId: ids.thread,
            providerInstanceId: "10000000-0000-4000-8000-000000000001",
            providerSessionId: "20000000-0000-4000-8000-000000000001",
            modelId: "model-a",
            contextManifestId: "30000000-0000-4000-8000-000000000001",
            outcome: "interrupted",
            responseRefs: [],
            citationIds: [],
            createdAt: now,
            updatedAt: now,
          },
          {
            id: ids.secondAttempt,
            turnId: ids.turn,
            threadId: ids.thread,
            providerInstanceId: "10000000-0000-4000-8000-000000000002",
            providerSessionId: "20000000-0000-4000-8000-000000000002",
            modelId: "model-b",
            contextManifestId: "30000000-0000-4000-8000-000000000002",
            outcome: completedAttemptOutcome,
            responseRefs: [reference(ids.responseContent, "b")],
            citationIds: [ids.citation],
            createdAt: now,
            updatedAt: completedAttemptUpdatedAt,
          },
        ],
        createdAt: now,
      },
    ],
    contents: [
      body(ids.userContent, "user", "Please summarize this.", "a"),
      body(ids.responseContent, "assistant", "Here is the summary.", "b"),
    ],
    attachments: [
      {
        id: ids.attachment,
        threadId: ids.thread,
        turnId: ids.turn,
        displayName: "diagram.png",
        mediaType: "image/png",
        byteLength: 128,
        digest: "c".repeat(64),
        status: "finalized",
        createdAt: now,
      },
    ],
    citations: [
      {
        citationId: ids.citation,
        threadId: ids.thread,
        turnId: ids.turn,
        attemptId: ids.secondAttempt,
        sourceTitle: "Octant guide",
        sourceUrl: "https://example.test/guide",
        backend: "searxng",
        retrievedAt: now,
      },
    ],
    workItems: [],
    workListVersion: 0,
    followUpVersion: 0,
    ...rest,
  });
}

function reference(contentId: string, digest: string) {
  return { contentId, digest: digest.repeat(64), byteLength: 12 };
}

function body(contentId: string, role: "user" | "assistant", text: string, digest = "d") {
  return {
    contentId,
    role,
    body: text,
    digest: digest.repeat(64),
    byteLength: text.length,
  };
}

function longView(count: number) {
  const turns = Array.from({ length: count }, (_, index) => {
    const n = String(index + 1).padStart(12, "0");
    return {
      id: `00000000-0000-4000-8000-${n}`,
      threadId: ids.thread,
      sequence: index + 1,
      userMessageRef: {
        contentId: `10000000-0000-4000-8000-${n}`,
        digest: "a".repeat(64),
        byteLength: 12,
      },
      attachmentIds: [],
      attempts: [
        {
          id: `30000000-0000-4000-8000-${n}`,
          turnId: `00000000-0000-4000-8000-${n}`,
          threadId: ids.thread,
          providerInstanceId: "10000000-0000-4000-8000-000000000001",
          providerSessionId: "20000000-0000-4000-8000-000000000001",
          modelId: "model-a",
          contextManifestId: "30000000-0000-4000-8000-000000000001",
          outcome: "completed" as const,
          responseRefs: [
            { contentId: `20000000-0000-4000-8000-${n}`, digest: "b".repeat(64), byteLength: 12 },
          ],
          citationIds: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
      createdAt: now,
    };
  });
  const contents = turns.flatMap((turn, index) => [
    body(String(turn.userMessageRef.contentId), "user", `User turn ${String(index)}`, "a"),
    body(
      String(turn.attempts[0]!.responseRefs[0]!.contentId),
      "assistant",
      `Assistant turn ${String(index)}`,
      "b",
    ),
  ]);
  return decodeChatThreadView({
    ...viewFixture(),
    lastSequence: count,
    turns,
    contents,
    attachments: [],
    citations: [],
  });
}

describe("ChatTranscript", () => {
  it("renders immutable ordered content, attachment names, attempt states, citations, and handoffs", () => {
    render(<ChatTranscript view={viewFixture()} />);

    expect(screen.getByText("Please summarize this.")).toBeVisible();
    expect(screen.getByText("Here is the summary.")).toBeVisible();
    expect(screen.getByText("diagram.png")).toBeVisible();
    expect(screen.queryByText(/managed\//i)).not.toBeInTheDocument();
    expect(screen.getByText("Interrupted")).toBeVisible();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
    expect(screen.getByText("Provider handoff · model-b")).toBeVisible();
    expect(screen.getByRole("link", { name: "Octant guide · SearXNG" })).toHaveAttribute(
      "href",
      "https://example.test/guide",
    );

    const content = screen.getByRole("list", { name: "Chat transcript" });
    expect(content.textContent).toMatch(
      // Exceptional outcomes stay visible; successful replies speak for themselves.
      /Please summarize this\.\s*diagram\.png[\s\S]*Interrupted[\s\S]*Provider handoff · model-b[\s\S]*Here is the summary\./,
    );
  });

  it("closes a completed turn with how long it took", () => {
    render(<ChatTranscript view={viewFixture({ attemptUpdatedAt: "2026-07-20T08:00:37.000Z" })} />);
    expect(screen.getByText("Worked for 37s")).toBeVisible();
  });

  it("omits a duration shorter than one second", () => {
    render(<ChatTranscript view={viewFixture({ attemptUpdatedAt: "2026-07-20T08:00:00.999Z" })} />);

    expect(screen.queryByText(/Worked for/)).not.toBeInTheDocument();
  });

  it("does not claim a duration for a turn that did not complete", () => {
    render(
      <ChatTranscript
        view={viewFixture({
          attemptOutcome: "interrupted",
          attemptUpdatedAt: "2026-07-20T08:00:37.000Z",
        })}
      />,
    );
    expect(screen.queryByText(/Worked for/)).not.toBeInTheDocument();
  });

  it("renders streamed response references as one coherent assistant message", () => {
    const current = viewFixture();
    const completed = current.turns[0]!.attempts[1]!;
    render(
      <ChatTranscript
        view={viewFixture({
          turns: [
            {
              ...current.turns[0]!,
              attempts: [
                current.turns[0]!.attempts[0]!,
                {
                  ...completed,
                  responseRefs: [
                    reference(ids.responseContent, "b"),
                    reference(ids.responseContent2, "e"),
                  ],
                },
              ],
            },
          ],
          contents: [
            body(ids.userContent, "user", "Please summarize this.", "a"),
            body(ids.responseContent, "assistant", "Hello ", "b"),
            body(ids.responseContent2, "assistant", "world", "e"),
          ],
        })}
      />,
    );

    expect(screen.getByText("Hello world")).toBeVisible();
    expect(screen.queryByText("Hello")).not.toBeInTheDocument();
    expect(screen.queryByText("world")).not.toBeInTheDocument();
  });

  it("shows the provider's task list under the attempt it belongs to", () => {
    const current = viewFixture();
    const completed = current.turns[0]!.attempts[1]!;
    render(
      <ChatTranscript
        view={viewFixture({
          turns: [
            {
              ...current.turns[0]!,
              attempts: [
                current.turns[0]!.attempts[0]!,
                {
                  ...completed,
                  tasks: [
                    {
                      taskId: "task-1",
                      state: "completed",
                      summary: "Watch CI on the branch head",
                    },
                    { taskId: "task-2", state: "pending", summary: "Commit the evidence" },
                  ],
                },
              ],
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole("region", { name: "Agent tasks" })).toBeVisible();
    expect(screen.getByText("1 of 2 tasks completed")).toBeVisible();
  });

  it("shows no task list for an attempt whose provider reported none", () => {
    render(<ChatTranscript view={viewFixture()} />);
    expect(screen.queryByRole("region", { name: "Agent tasks" })).not.toBeInTheDocument();
  });

  it("renders safe structured assistant content without interpreting raw HTML", () => {
    const current = viewFixture();
    const completed = current.turns[0]!.attempts[1]!;
    const richBody = [
      "## Plan",
      "",
      "- Inspect the workspace",
      "- Run the checks",
      "",
      "```ts",
      "const ready = true;",
      "```",
      "",
      "See **verified output** and <script>alert('unsafe')</script>.",
    ].join("\n");
    render(
      <ChatTranscript
        view={viewFixture({
          turns: [
            {
              ...current.turns[0]!,
              attempts: [{ ...completed, responseRefs: [reference(ids.responseContent, "b")] }],
            },
          ],
          contents: [
            body(ids.userContent, "user", "Please summarize this.", "a"),
            body(ids.responseContent, "assistant", richBody, "b"),
          ],
        })}
      />,
    );

    expect(screen.getByRole("heading", { name: "Plan" })).toBeVisible();
    expect(screen.getByText("Inspect the workspace").closest("ul")).toHaveTextContent(
      "Run the checks",
    );
    expect(screen.getByText("const ready = true;")).toBeVisible();
    expect(screen.getByText("verified output").tagName).toBe("STRONG");
    expect(document.querySelector("script")).not.toBeInTheDocument();
    expect(screen.getByText(/<script>alert\('unsafe'\)<\/script>/)).toBeVisible();
  });

  it("renders the durable historical attachment handoff warning without a managed path", () => {
    const current = viewFixture();
    render(
      <ChatTranscript
        view={viewFixture({
          thread: {
            ...current.thread,
            handoffWarning: {
              targetProviderInstanceId: "10000000-0000-4000-8000-000000000002",
              targetModelId: "model-b",
              omittedAttachments: [
                {
                  attachmentId: ids.attachment,
                  displayName: "diagram.png",
                  mediaType: "image/png",
                  reason: "native-attachments-unsupported",
                },
              ],
              createdAt: now,
            },
          },
        })}
      />,
    );

    expect(screen.getByRole("status", { name: "Historical attachment warning" })).toHaveTextContent(
      "diagram.png remains available locally and was not sent to model-b.",
    );
    expect(screen.queryByText(/managed\//i)).not.toBeInTheDocument();
  });

  it("makes missing content and unsafe citations visible without fabricating a message or link", () => {
    const view = viewFixture({
      contents: [body(ids.userContent, "user", "Please summarize this.", "a")],
      citations: [
        {
          citationId: ids.citation,
          threadId: ids.thread,
          turnId: ids.turn,
          attemptId: ids.secondAttempt,
          sourceTitle: "Untrusted source",
          sourceUrl: "javascript:alert(1)",
          backend: "provider-native",
          retrievedAt: now,
        },
      ],
    });

    render(<ChatTranscript view={view} connectionStatus="disconnected" />);

    expect(screen.getByRole("alert")).toHaveTextContent("Response content is unavailable.");
    expect(screen.getByRole("status")).toHaveTextContent("Disconnected");
    expect(screen.getByText("Untrusted source · Provider-native source unavailable")).toBeVisible();
    expect(screen.queryByRole("link", { name: /Untrusted source/i })).not.toBeInTheDocument();
  });

  it("uses visible text for every durable attempt state", () => {
    const outcomes = [
      "queued",
      "streaming",
      "waiting",
      "interrupted",
      "failed",
      "cancelled",
      "completed",
    ] as const;
    const baseAttempt = viewFixture().turns[0]!.attempts[0]!;
    const view = viewFixture({
      turns: [
        {
          ...viewFixture().turns[0]!,
          attempts: outcomes.map((outcome, index) => ({
            ...baseAttempt,
            id: `00000000-0000-4000-8000-00000000090${index}`,
            outcome,
          })),
        },
      ],
    });

    render(<ChatTranscript view={view} />);

    for (const label of [
      "Queued",
      "Streaming",
      "Waiting for approval",
      "Interrupted",
      "Failed",
      "Cancelled",
    ]) {
      expect(screen.getByText(label)).toBeVisible();
    }
  });

  it("shows completed work duration while omitting sub-second durations", () => {
    const view = viewFixture({ attemptUpdatedAt: "2026-07-20T08:01:05.000Z" });
    const { rerender } = render(<ChatTranscript view={view} />);
    const workedFor = screen.getByText("Worked for 1m 5s");
    expect(workedFor).toBeVisible();
    expect(getComputedStyle(workedFor.closest("header")!).position).not.toBe("absolute");

    rerender(
      <ChatTranscript view={viewFixture({ attemptUpdatedAt: "2026-07-20T08:00:00.999Z" })} />,
    );
    expect(screen.queryByText(/Worked for/)).not.toBeInTheDocument();
  });

  it("surfaces the exact failed attempt correlation for Settings support", () => {
    const failed = viewFixture().turns[0]!.attempts[0]!;
    render(
      <ChatTranscript
        view={viewFixture({
          turns: [
            {
              ...viewFixture().turns[0]!,
              attempts: [{ ...failed, outcome: "failed" }],
            },
          ],
        })}
      />,
    );

    expect(screen.getByLabelText("Support correlation")).toHaveTextContent(ids.firstAttempt);
    expect(screen.getByRole("button", { name: "Copy support ID" })).toBeVisible();
  });

  it.each([
    ["timed-out", "The provider stopped responding and the turn timed out."],
    ["unavailable", "The provider is unavailable."],
    ["tool-timed-out", "An app-managed tool call did not return before the turn deadline."],
  ] as const)("states why a %s turn failed in Octant's own words", (code, sentence) => {
    const failed = viewFixture().turns[0]!.attempts[0]!;
    render(
      <ChatTranscript
        view={viewFixture({
          turns: [
            {
              ...viewFixture().turns[0]!,
              attempts: [{ ...failed, outcome: "failed", failure: { code } }],
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(sentence);
    expect(screen.getByLabelText("Support correlation")).toHaveTextContent(ids.firstAttempt);
  });

  it("states the timeout cause on an interrupted attempt too", () => {
    const interrupted = viewFixture().turns[0]!.attempts[0]!;
    render(
      <ChatTranscript
        view={viewFixture({
          turns: [
            {
              ...viewFixture().turns[0]!,
              attempts: [
                { ...interrupted, outcome: "interrupted", failure: { code: "timed-out" } },
              ],
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The provider stopped responding and the turn timed out.",
    );
  });

  it.each(["failed", "interrupted"] as const)("retries only %s attempts", async (outcome) => {
    const onRetryAttempt = vi.fn();
    const view = viewFixture({
      turns: [
        {
          ...viewFixture().turns[0]!,
          attempts: [
            {
              ...viewFixture().turns[0]!.attempts[0]!,
              outcome,
            },
            {
              ...viewFixture().turns[0]!.attempts[1]!,
              outcome: "cancelled",
            },
          ],
        },
      ],
    });
    const user = userEvent.setup();
    render(<ChatTranscript onRetryAttempt={onRetryAttempt} view={view} />);

    const retry = screen.getByRole("button", { name: `Retry ${outcome} response` });
    await user.click(retry);

    expect(onRetryAttempt).toHaveBeenCalledWith(ids.turn, ids.firstAttempt);
    expect(screen.queryByRole("button", { name: /Retry cancelled/i })).not.toBeInTheDocument();
  });

  it("offers regenerate on a completed attempt and routes it through the server", async () => {
    const onRetryAttempt = vi.fn();
    const user = userEvent.setup();
    render(<ChatTranscript onRetryAttempt={onRetryAttempt} view={viewFixture()} />);

    await user.click(screen.getByRole("button", { name: "Regenerate response" }));

    expect(onRetryAttempt).toHaveBeenCalledWith(ids.turn, ids.secondAttempt);
  });

  it("shows no regenerate affordance for attempts that did not complete", () => {
    const view = viewFixture({
      turns: [
        {
          ...viewFixture().turns[0]!,
          attempts: [
            { ...viewFixture().turns[0]!.attempts[0]!, outcome: "cancelled" },
            { ...viewFixture().turns[0]!.attempts[1]!, outcome: "cancelled" },
          ],
        },
      ],
    });
    render(<ChatTranscript view={view} />);

    expect(screen.queryByRole("button", { name: "Regenerate response" })).not.toBeInTheDocument();
  });

  it("says when a reply was regenerated, and only then", () => {
    const first = viewFixture().turns[0]!.attempts[1]!;
    const second = {
      ...first,
      id: ids.firstAttempt,
      outcome: "completed",
      responseRefs: [reference(ids.responseContent2, "e")],
    };
    const view = viewFixture({
      turns: [{ ...viewFixture().turns[0]!, attempts: [first, second] }],
      contents: [
        body(ids.userContent, "user", "Please summarize this.", "a"),
        body(ids.responseContent, "assistant", "First answer.", "b"),
        body(ids.responseContent2, "assistant", "Second answer.", "e"),
      ],
    });
    render(<ChatTranscript view={view} />);

    expect(screen.getByText("Regenerated")).toBeVisible();
  });

  it("folds a reply's inline thinking into a collapsed disclosure and keeps the reply readable", async () => {
    const user = userEvent.setup();
    const view = viewFixture({
      turns: [
        {
          ...viewFixture().turns[0]!,
          attempts: [
            {
              ...viewFixture().turns[0]!.attempts[1]!,
              responseRefs: [reference(ids.responseContent, "b")],
            },
          ],
        },
      ],
      contents: [
        body(ids.userContent, "user", "Please summarize this.", "a"),
        body(
          ids.responseContent,
          "assistant",
          "```reasoning\nWeigh the two sources.\n```\nHere is the summary.",
          "b",
        ),
      ],
    });
    render(<ChatTranscript view={view} />);

    const thinking = screen.getByText("Thinking").closest("details");
    if (!(thinking instanceof HTMLDetailsElement)) {
      throw new Error("Thinking disclosure is missing.");
    }
    expect(thinking.open).toBe(false);
    // The reasoning stays in the document while closed, so in-page find and
    // Chromium's find-in-page can reach it.
    expect(screen.getByText("Weigh the two sources.")).not.toBeVisible();
    expect(screen.getByText("Here is the summary.")).toBeVisible();

    await user.click(screen.getByText("Thinking"));
    expect(thinking.open).toBe(true);
  });

  it("lets the reader expand streaming reasoning and keeps their choice after completion", () => {
    const attempt = viewFixture().turns[0]!.attempts[1]!;
    const streamingBody = " <think>Weighing the two options.";
    const settledBody = " <think>Weighing the two options.</think>Here is the summary.";
    const streaming = viewFixture({
      turns: [
        {
          ...viewFixture().turns[0]!,
          attempts: [
            {
              ...attempt,
              outcome: "streaming",
              responseRefs: [reference(ids.responseContent, "b")],
            },
          ],
        },
      ],
      contents: [
        body(ids.userContent, "user", "Please summarize this.", "a"),
        body(ids.responseContent, "assistant", streamingBody, "b"),
      ],
    });
    const onQuoteSelection = vi.fn();
    const { rerender } = render(
      <ChatTranscript onQuoteSelection={onQuoteSelection} view={streaming} />,
    );

    const live = screen.getByText("Thinking").closest("details");
    if (!(live instanceof HTMLDetailsElement)) throw new Error("Thinking disclosure missing.");
    expect(live.open).toBe(false);
    fireEvent.click(screen.getByText("Thinking"));
    expect(live.open).toBe(true);
    expect(screen.getByText("Weighing the two options.")).toBeVisible();

    rerender(
      <ChatTranscript
        onQuoteSelection={onQuoteSelection}
        view={viewFixture({
          turns: [
            {
              ...viewFixture().turns[0]!,
              attempts: [{ ...attempt, responseRefs: [reference(ids.responseContent, "b")] }],
            },
          ],
          contents: [
            body(ids.userContent, "user", "Please summarize this.", "a"),
            body(ids.responseContent, "assistant", settledBody, "b"),
          ],
        })}
      />,
    );
    const settled = screen.getByText("Thinking").closest("details");
    if (!(settled instanceof HTMLDetailsElement)) throw new Error("Thinking disclosure missing.");
    expect(settled.open).toBe(true);
  });

  it("folds a reply's inline tool call into its own collapsed disclosure", () => {
    const view = viewFixture({
      turns: [
        {
          ...viewFixture().turns[0]!,
          attempts: [
            {
              ...viewFixture().turns[0]!.attempts[1]!,
              responseRefs: [reference(ids.responseContent, "b")],
            },
          ],
        },
      ],
      contents: [
        body(ids.userContent, "user", "Please summarize this.", "a"),
        body(
          ids.responseContent,
          "assistant",
          "```tool name=octant_web_research status=done\nquery: octant\n```\nHere is the summary.",
          "b",
        ),
      ],
    });
    render(<ChatTranscript view={view} />);

    const tool = screen.getByText("Tool · octant_web_research").closest("details");
    if (!(tool instanceof HTMLDetailsElement)) {
      throw new Error("Tool disclosure is missing.");
    }
    expect(tool.open).toBe(false);
    expect(tool).toHaveTextContent("done");
    expect(tool).toHaveTextContent("query: octant");
  });

  it("shows an open provider question inline and answers it with the chosen option", async () => {
    const onAnswerQuestion = vi.fn();
    const user = userEvent.setup();
    const view = viewFixture({
      turns: [
        {
          ...viewFixture().turns[0]!,
          attempts: [
            {
              ...viewFixture().turns[0]!.attempts[1]!,
              outcome: "waiting",
              pendingQuestion: {
                requestId: "q1",
                prompt: "Proceed?",
                options: [
                  { label: "Yes", description: "Go ahead now" },
                  { label: "No", description: "Stop here" },
                ],
                questionIndex: 1,
                questionCount: 2,
              },
            },
          ],
        },
      ],
    });
    render(<ChatTranscript onAnswerQuestion={onAnswerQuestion} view={view} />);

    expect(screen.getByText("Waiting for your answer")).toBeVisible();
    expect(screen.getByText("Question 1 of 2")).toBeVisible();
    const card = screen.getByLabelText("Provider question");
    expect(card).toHaveTextContent("Proceed?");
    expect(card).toHaveTextContent("Go ahead");
    await user.click(within(card).getByRole("radio", { name: /Yes/ }));
    await user.click(within(card).getByRole("button", { name: "Next" }));

    expect(onAnswerQuestion).toHaveBeenCalledWith({
      turnId: ids.turn,
      attemptId: ids.secondAttempt,
      requestId: "q1",
      answer: "Yes",
    });
  });

  it("submits the final question of a set and offers typed text when no option fits", async () => {
    const onAnswerQuestion = vi.fn();
    const user = userEvent.setup();
    const view = viewFixture({
      turns: [
        {
          ...viewFixture().turns[0]!,
          attempts: [
            {
              ...viewFixture().turns[0]!.attempts[1]!,
              outcome: "waiting",
              pendingQuestion: {
                requestId: "q1",
                prompt: "Proceed?",
                options: [{ label: "Yes" }],
                questionIndex: 2,
                questionCount: 2,
              },
            },
          ],
        },
      ],
    });
    render(<ChatTranscript onAnswerQuestion={onAnswerQuestion} view={view} />);

    const card = screen.getByLabelText("Provider question");
    await user.click(within(card).getByRole("radio", { name: "Type your own answer" }));
    await user.type(within(card).getByLabelText("Your answer"), "Go ahead");
    await user.click(within(card).getByRole("button", { name: "Submit" }));

    expect(onAnswerQuestion).toHaveBeenCalledWith({
      turnId: ids.turn,
      attemptId: ids.secondAttempt,
      requestId: "q1",
      answer: "Go ahead",
    });
  });

  it("dismisses a question by cancelling the turn that asked it", async () => {
    const onAnswerQuestion = vi.fn();
    const onDismissQuestion = vi.fn();
    const user = userEvent.setup();
    const view = viewFixture({
      turns: [
        {
          ...viewFixture().turns[0]!,
          attempts: [
            {
              ...viewFixture().turns[0]!.attempts[1]!,
              outcome: "waiting",
              pendingQuestion: {
                requestId: "q1",
                prompt: "Proceed?",
                options: [{ label: "Yes" }],
              },
            },
          ],
        },
      ],
    });
    render(
      <ChatTranscript
        onAnswerQuestion={onAnswerQuestion}
        onDismissQuestion={onDismissQuestion}
        view={view}
      />,
    );

    const card = screen.getByLabelText("Provider question");
    await user.click(within(card).getByRole("button", { name: "Dismiss" }));

    expect(onDismissQuestion).toHaveBeenCalledWith(ids.turn, ids.secondAttempt);
    expect(onAnswerQuestion).not.toHaveBeenCalled();
  });

  it("keeps an unanswered question read-only when the host serves no answer route", () => {
    const view = viewFixture({
      turns: [
        {
          ...viewFixture().turns[0]!,
          attempts: [
            {
              ...viewFixture().turns[0]!.attempts[1]!,
              outcome: "waiting",
              pendingQuestion: { requestId: "q1", prompt: "Proceed?", options: [{ label: "Yes" }] },
            },
          ],
        },
      ],
    });
    render(<ChatTranscript view={view} />);

    expect(screen.getByText("Waiting for your answer")).toBeVisible();
    expect(screen.queryByLabelText("Provider question")).not.toBeInTheDocument();
  });

  it("keeps an answered question readable beside the reply", () => {
    const view = viewFixture({
      turns: [
        {
          ...viewFixture().turns[0]!,
          attempts: [
            {
              ...viewFixture().turns[0]!.attempts[1]!,
              answeredQuestions: [
                {
                  requestId: "q1",
                  prompt: "Proceed?",
                  options: [{ label: "Yes" }, { label: "No" }],
                  answer: "Yes",
                  answeredAt: now,
                },
              ],
            },
          ],
        },
      ],
    });
    render(<ChatTranscript view={view} />);

    const row = screen.getByLabelText("Answered question");
    expect(row).toHaveTextContent("Proceed?");
    expect(row).toHaveTextContent("Answered: Yes");
    expect(screen.queryByRole("radio", { name: /Yes/ })).not.toBeInTheDocument();
  });

  it("shows the durable pool route receipt for a fallback-selected turn", () => {
    render(
      <ChatTranscript
        view={viewFixture({
          routeDecisions: [
            {
              threadId: ids.thread,
              turnId: ids.turn,
              decision: selectedFallbackReceipt(),
              decidedAt: now,
            },
          ],
        })}
      />,
    );

    const receipt = screen.getByLabelText("Turn route receipt");
    expect(receipt).toHaveTextContent("Route: model-a → model-b · pool fallback");
    expect(receipt).toHaveTextContent(
      "The requested model is unavailable; an explicitly permitted pool fallback was selected.",
    );
  });

  it("shows a durable waiting route receipt even when the turn never started", () => {
    render(
      <ChatTranscript
        view={viewFixture({
          turns: [],
          attachments: [],
          citations: [],
          routeDecisions: [
            {
              threadId: ids.thread,
              turnId: ids.turn,
              decision: waitingReceipt(),
              decidedAt: now,
            },
          ],
        })}
      />,
    );

    const receipt = screen.getByLabelText("Turn route receipt");
    expect(receipt).toHaveTextContent("Route: model-a · pool waiting");
    expect(receipt).toHaveTextContent(
      "No selected model is currently eligible. Check provider readiness and pool policy.",
    );
  });

  it("renders no route receipt for single-model turns", () => {
    render(<ChatTranscript view={viewFixture()} />);
    expect(screen.queryByLabelText("Turn route receipt")).not.toBeInTheDocument();
  });

  it("revises a message in place and asks the server to re-run from there", async () => {
    const onEditTurn = vi.fn();
    render(<ChatTranscript onEditTurn={onEditTurn} view={viewFixture()} />);

    await chooseTurnAction("Edit");
    const editor = screen.getByRole("textbox", { name: "Edit your message" });
    expect(editor).toHaveValue("Please summarize this.");
    // An unchanged message is not a revision.
    expect(screen.getByRole("button", { name: "Save and run" })).toBeDisabled();

    await userEvent.clear(editor);
    await userEvent.type(editor, "Summarize it in one line.");
    await userEvent.click(screen.getByRole("button", { name: "Save and run" }));

    expect(onEditTurn).toHaveBeenCalledWith(ids.turn, "Summarize it in one line.");
    // The renderer never edits the transcript itself; it waits for the server.
    expect(screen.getByText("Please summarize this.")).toBeVisible();
  });

  it("shows the conversation as it now stands and says how much history is behind it", () => {
    const revisedTurnId = "00000000-0000-4000-8000-00000000080a";
    const revisedContentId = "00000000-0000-4000-8000-00000000080b";
    const base = viewFixture();
    const view = viewFixture({
      turns: [
        ...base.turns,
        {
          id: revisedTurnId,
          threadId: ids.thread,
          sequence: 2,
          userMessageRef: reference(revisedContentId, "e"),
          attachmentIds: [],
          attempts: [],
          supersedes: ids.turn,
          createdAt: now,
        },
      ],
      contents: [
        ...base.contents,
        body(revisedContentId, "user", "Summarize it in one line.", "e"),
      ],
    });

    render(<ChatTranscript view={view} />);

    expect(screen.getByText("Summarize it in one line.")).toBeVisible();
    expect(screen.queryByText("Please summarize this.")).not.toBeInTheDocument();
    expect(screen.queryByText("Here is the summary.")).not.toBeInTheDocument();
    expect(
      screen.getByText(/1 earlier message was revised.*stays in this thread's history/),
    ).toBeVisible();
  });

  it("offers a branch from a turn and states a branch's own provenance", async () => {
    const onBranchTurn = vi.fn();
    render(<ChatTranscript onBranchTurn={onBranchTurn} view={viewFixture()} />);
    await chooseTurnAction("Branch from here");
    expect(onBranchTurn).toHaveBeenCalledWith(ids.turn);

    const base = viewFixture();
    render(
      <ChatTranscript
        view={viewFixture({
          thread: {
            ...base.thread,
            branchedFrom: {
              threadId: "00000000-0000-4000-8000-0000000008f1",
              turnId: ids.turn,
              sourceVersion: 6,
              carriedTurnCount: 2,
              omittedAttachmentCount: 1,
              branchedAt: now,
            },
          },
        })}
      />,
    );
    expect(
      screen.getByText(
        /carrying 2 messages of it\. 1 attachment stayed with the original thread\./,
      ),
    ).toBeVisible();
  });

  it("keeps revising and branching unavailable while a response is running", async () => {
    render(
      <ChatTranscript busy onBranchTurn={vi.fn()} onEditTurn={vi.fn()} view={viewFixture()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("menuitemradio", { name: "Edit" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: "Branch from here" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("offers a checkpoint on each message and marks the turn the user chose", async () => {
    const user = userEvent.setup();
    const onMark = vi.fn();
    render(
      <ChatTranscript
        checkpoints={{
          byTurnId: new Map(),
          busy: false,
          onForget: vi.fn(),
          onMark,
          onRestore: vi.fn(),
        }}
        view={viewFixture()}
      />,
    );

    await chooseTurnAction("Checkpoint");
    await user.click(screen.getByRole("button", { name: "Mark" }));

    expect(onMark).toHaveBeenCalledWith(ids.turn, "Message 1");
  });

  it("keeps the checkpoint marker visible only when a checkpoint exists", async () => {
    render(
      <ChatTranscript
        checkpoints={{
          byTurnId: new Map([[ids.turn, markedCheckpoint()]]),
          busy: false,
          onForget: vi.fn(),
          onMark: vi.fn(),
          onRestore: vi.fn(),
        }}
        onRetryAttempt={vi.fn()}
        view={viewFixture()}
      />,
    );

    expect(screen.getByText("Before the rewrite")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Checkpoint" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Forget" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry interrupted response" })).toBeVisible();
    expect(screen.getByText("Interrupted")).toBeVisible();
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("menuitemradio", { name: "Restore from here" })).toBeVisible();
    expect(screen.getByRole("menuitemradio", { name: "Forget" })).toBeVisible();
    expect(screen.queryByRole("menuitemradio", { name: "Checkpoint" })).not.toBeInTheDocument();
  });

  it("forgets a marked checkpoint from the turn's action menu", async () => {
    const onForget = vi.fn();
    const checkpoint = markedCheckpoint();
    render(
      <ChatTranscript
        checkpoints={{
          byTurnId: new Map([[ids.turn, checkpoint]]),
          busy: false,
          onForget,
          onMark: vi.fn(),
          onRestore: vi.fn(),
        }}
        view={viewFixture()}
      />,
    );

    await chooseTurnAction("Forget");
    expect(onForget).toHaveBeenCalledWith(checkpoint);
  });

  it("restores a checkpoint by starting a second thread rather than rewinding this one", async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn();
    const checkpoint = markedCheckpoint();
    render(
      <ChatTranscript
        checkpoints={{
          byTurnId: new Map([[ids.turn, checkpoint]]),
          busy: false,
          onForget: vi.fn(),
          onMark: vi.fn(),
          onRestore,
        }}
        view={viewFixture()}
      />,
    );

    await chooseTurnAction("Restore from here");
    expect(screen.getByRole("button", { name: "Start the new thread" })).toBeVisible();
    expect(screen.getByText("Please summarize this.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Start the new thread" }));
    expect(onRestore).toHaveBeenCalledWith(checkpoint, "Before the rewrite");
  });

  it("keeps the checkpoint affordance off a transcript the host serves none for", async () => {
    render(<ChatTranscript view={viewFixture()} />);

    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.queryByRole("menuitemradio", { name: "Checkpoint" })).not.toBeInTheDocument();
  });

  it("copies the turn's references from the action menu", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...globalThis.navigator, clipboard: { writeText } });
    render(<ChatTranscript view={viewFixture()} />);

    await chooseTurnAction("Copy turn with sources");
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Please summarize this.")),
    );
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("diagram.png"));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("Here is the summary."));
    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining("Octant guide · https://example.test/guide"),
    );
    vi.unstubAllGlobals();
  });

  it("copies finished assistant prose as Markdown from the action menu", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...globalThis.navigator, clipboard: { writeText } });
    render(<ChatTranscript view={viewFixture()} />);

    await chooseTurnAction("Copy as Markdown");
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Here is the summary."));
    vi.unstubAllGlobals();
  });

  it("quotes a finished selection into the composer via Add to chat", async () => {
    const user = userEvent.setup();
    const onQuoteSelection = vi.fn();
    render(<ChatTranscript onQuoteSelection={onQuoteSelection} view={viewFixture()} />);

    const prose = screen.getByText("Here is the summary.");
    const range = document.createRange();
    range.selectNodeContents(prose);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent(document, new Event("selectionchange"));

    await user.click(await screen.findByRole("button", { name: "Add to chat" }));
    expect(onQuoteSelection).toHaveBeenCalledWith({
      turnId: ids.turn,
      text: "Here is the summary.",
    });
  });

  it("mirrors fork, checkpoint, and copy on the turn's context menu", async () => {
    const onBranchTurn = vi.fn();
    render(
      <ChatTranscript
        checkpoints={{
          byTurnId: new Map(),
          busy: false,
          onForget: vi.fn(),
          onMark: vi.fn(),
          onRestore: vi.fn(),
        }}
        onBranchTurn={onBranchTurn}
        view={viewFixture()}
      />,
    );

    fireEvent.contextMenu(screen.getByText("Please summarize this."));
    expect(await screen.findByRole("menuitem", { name: "Branch from here" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Checkpoint" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Copy as Markdown" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Copy turn with sources" })).toBeVisible();
  });

  it("windows a 1000-turn conversation so only a bounded number of rows mount", () => {
    render(<ChatTranscript view={longView(1000)} />);

    expect(document.querySelectorAll("[data-transcript-row]").length).toBeLessThan(80);
    expect(screen.getByText("User turn 0")).toBeVisible();
    expect(screen.queryByText("User turn 999")).not.toBeInTheDocument();
  });

  it("jumps to a turn that was outside the window", async () => {
    const view = longView(1000);
    const turnId = view.turns[500]!.id;
    render(<ChatTranscript revealTurnId={turnId} view={view} />);

    expect(await screen.findByText("User turn 500")).toBeVisible();
  });
});

async function chooseTurnAction(name: string) {
  await userEvent.click(screen.getByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name }));
}

function markedCheckpoint() {
  return decodeThreadCheckpoint({
    id: "11111111-1111-4111-8111-111111111111",
    anchor: { mode: "chat", threadId: ids.thread, turnId: ids.turn },
    label: "Before the rewrite",
    lifecycle: "marked",
    restoreCount: 0,
    markedAt: now,
    version: 1,
    updatedAt: now,
  });
}

const poolCandidates = [
  {
    hostId: "local",
    providerInstanceId: "10000000-0000-4000-8000-000000000001",
    modelId: "model-a",
  },
  {
    hostId: "local",
    providerInstanceId: "10000000-0000-4000-8000-000000000002",
    modelId: "model-b",
  },
] as const;

function receiptRequest() {
  return {
    pool: {
      candidates: poolCandidates,
      mixedVendorEnabled: true,
      fallbackAllowed: true,
      higherCostFallbackAllowed: true,
    },
    requestedCandidate: poolCandidates[0],
    requiredCapabilities: [],
  };
}

function selectedFallbackReceipt() {
  return {
    kind: "selected",
    request: receiptRequest(),
    mode: "chat",
    activeHostId: "local",
    parentCandidate: poolCandidates[0],
    eligibility: [
      { candidate: poolCandidates[0], eligible: false, reasons: ["provider-not-ready"] },
      { candidate: poolCandidates[1], eligible: true, reasons: [] },
    ],
    selectedCandidate: poolCandidates[1],
    selectionKind: "fallback",
    reason:
      "The requested model is unavailable; an explicitly permitted pool fallback was selected.",
  };
}

function waitingReceipt() {
  return {
    kind: "waiting",
    request: receiptRequest(),
    mode: "chat",
    activeHostId: "local",
    parentCandidate: poolCandidates[0],
    eligibility: [
      { candidate: poolCandidates[0], eligible: false, reasons: ["provider-not-ready"] },
      { candidate: poolCandidates[1], eligible: false, reasons: ["model-unavailable"] },
    ],
    reason: "no-eligible-candidate",
    message: "No selected model is currently eligible. Check provider readiness and pool policy.",
  };
}
