import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { CodeThreadWorkspace } from "./CodeThreadWorkspace";
import type { CodeController } from "./useCodeController";
import type { PickerGroup } from "@octant/domain";

const threadId = "10000000-0000-4000-8000-000000000001" as never;
const anotherThreadId = "10000000-0000-4000-8000-000000000002" as never;
const providerId = "80000000-0000-4000-8000-0000000000a1" as never;
const modelId = "model-one" as never;
const mentionedThreadId = "90000000-0000-4000-8000-000000000001" as never;
const alternateProviderId = "80000000-0000-4000-8000-0000000000a2" as never;
const alternateModelId = "model-two" as never;

describe("CodeThreadWorkspace", () => {
  it("renders the conversation center and sends follow-ups through the controller", async () => {
    const user = userEvent.setup();
    const onOpenSurface = vi.fn();
    const onOpenBrowser = vi.fn();
    const sendFollowUp = vi.fn(async () => true);
    const setPendingDraft = vi.fn();
    render(
      <CodeThreadWorkspace
        controller={controller({ sendFollowUp, setPendingDraft })}
        onOpenBrowser={onOpenBrowser}
        onOpenSurface={onOpenSurface}
        providerGroups={[providerGroup()]}
        threadId={threadId}
      />,
    );

    expect(screen.getByRole("heading", { name: "find bugs in this repo" })).toBeVisible();
    expect(screen.getByRole("log")).toHaveTextContent(
      "No messages yet. Send a prompt to start this thread.",
    );
    expect(screen.getByRole("button", { name: "Provider and model" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Changes" }));
    expect(onOpenSurface).toHaveBeenCalledWith("code-diff");
    await user.click(screen.getByRole("button", { name: "Browser" }));
    expect(onOpenBrowser).toHaveBeenCalledOnce();

    await user.type(screen.getByLabelText("Follow-up message"), "check tests too");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(sendFollowUp).toHaveBeenCalledWith("check tests too", []);
  });

  it("opens the `#` picker in the Code composer and sends the chip as an id", async () => {
    const user = userEvent.setup();
    const sendFollowUp = vi.fn(async (_prompt: string) => true);
    const search = vi.fn(async () => [
      {
        threadId: mentionedThreadId,
        mode: "chat" as const,
        title: "Release notes",
        placement: { kind: "unfiled" as const },
        updatedAt: "2026-08-15T09:00:00.000Z" as never,
      },
    ]);
    const resolve = vi.fn(async () => ({
      mentions: [
        {
          threadId: mentionedThreadId,
          mode: "chat" as const,
          title: "Release notes",
          placement: { kind: "unfiled" as const },
          transcript: [
            {
              role: "user" as const,
              text: "ship on Friday",
              occurredAt: "2026-08-15T09:00:00.000Z" as never,
            },
          ],
          truncated: false,
        },
      ],
      unavailable: [],
    }));
    render(
      <CodeThreadWorkspace
        controller={controller({ sendFollowUp })}
        threadMentionClient={{ search, resolve, openSideChat: vi.fn(), execute: vi.fn() } as never}
        threadId={threadId}
      />,
    );

    const composer = screen.getByLabelText("Follow-up message");
    await user.type(composer, "#Rel");
    const hit = await screen.findByRole("option", { name: /Release notes/ });
    await user.click(hit);
    expect(screen.getByLabelText("Mentioned threads")).toHaveTextContent("Release notes");

    await user.type(composer, "does this still hold?");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));

    expect(resolve).toHaveBeenCalledWith(expect.anything(), [mentionedThreadId]);
    // The chip travels as an id. The message the host journals — and the
    // conversation and every later turn read back — is the user's own words,
    // so nothing the mention contributed can be replayed.
    expect(sendFollowUp).toHaveBeenCalledWith("#[Release notes] does this still hold?", [
      mentionedThreadId,
    ]);
  });

  it("completes an `@` path from the checkout listing the host returned", async () => {
    const user = userEvent.setup();
    const sendFollowUp = vi.fn(async () => true);
    const list = vi.fn(async () => ({
      status: "listed" as const,
      listing: {
        kind: "code-file-listing" as const,
        threadId,
        checkoutId: "20000000-0000-4000-8000-000000000002" as never,
        entries: [
          { kind: "directory" as const, path: "src" as never },
          {
            kind: "file" as const,
            fileId: "file_" + "a".repeat(59),
            path: "src/index.ts" as never,
            byteLength: 12,
            availability: { status: "available" as const },
          },
        ],
        truncated: false,
        observedAt: "2026-08-16T09:00:00.000Z" as never,
      },
    }));
    render(
      <CodeThreadWorkspace
        controller={controller({ sendFollowUp })}
        fileListingClient={{ list } as never}
        threadId={threadId}
      />,
    );

    const composer = screen.getByLabelText("Follow-up message");
    // Nothing is listed until a mention is actually opened.
    expect(list).not.toHaveBeenCalled();
    await user.type(composer, "explain @ind");

    const hit = await screen.findByRole("option", { name: /src\/index\.ts/ });
    await user.click(hit);
    expect(composer).toHaveValue("explain @src/index.ts ");

    await user.type(composer, "please");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    // The path travels as ordinary prompt text; naming a file reaches nothing.
    expect(sendFollowUp).toHaveBeenCalledWith("explain @src/index.ts please", []);
  });

  it("leaves an `@` that matches no file in this checkout as ordinary text", async () => {
    const user = userEvent.setup();
    const list = vi.fn(async () => ({
      status: "listed" as const,
      listing: {
        kind: "code-file-listing" as const,
        threadId,
        checkoutId: "20000000-0000-4000-8000-000000000002" as never,
        entries: [],
        truncated: false,
        observedAt: "2026-08-16T09:00:00.000Z" as never,
      },
    }));
    render(
      <CodeThreadWorkspace
        controller={controller()}
        fileListingClient={{ list } as never}
        threadId={threadId}
      />,
    );

    await user.type(screen.getByLabelText("Follow-up message"), "mail henrik@ogard.no");
    expect(
      screen.queryByRole("listbox", { name: "Files you can mention" }),
    ).not.toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();
  });

  it("keeps a failed follow-up in the composer so it can be retried", async () => {
    const user = userEvent.setup();
    const sendFollowUp = vi.fn(async () => false);
    render(<CodeThreadWorkspace controller={controller({ sendFollowUp })} threadId={threadId} />);

    const composer = screen.getByLabelText("Follow-up message");
    await user.type(composer, "keep this prompt");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));

    expect(sendFollowUp).toHaveBeenCalledWith("keep this prompt", []);
    expect(composer).toHaveValue("keep this prompt");
  });

  it("keeps post-preview Canvas tools out of the live thread toolbar", () => {
    render(
      <CodeThreadWorkspace
        canvasClient={{} as never}
        controller={controller()}
        threadId={threadId}
      />,
    );

    expect(screen.queryByRole("button", { name: "Canvas" })).not.toBeInTheDocument();
  });

  it("keeps the transcript top-aligned like a conversation instead of bottom-anchoring it", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(styles).toMatch(/\.code-thread-workspace__transcript\s*\{[^}]*margin:\s*0 auto;/);
    expect(styles).not.toMatch(
      /\.code-thread-workspace__transcript\s*\{[^}]*margin:\s*auto auto 0;/,
    );
  });

  it("changes provider and model through the authoritative Code command", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => undefined) as CodeController["execute"];
    render(
      <CodeThreadWorkspace
        controller={controller({ execute })}
        providerGroups={[providerGroup(), alternateProviderGroup()]}
        threadId={threadId}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    await user.click(screen.getByRole("option", { name: "Remote Provider" }));
    await user.click(screen.getByRole("option", { name: "Model Two" }));

    expect(execute).toHaveBeenCalledWith({
      kind: "change-code-thread-provider",
      threadId,
      expectedVersion: 1,
      providerInstanceId: alternateProviderId,
      modelId: alternateModelId,
    });
  });

  it("lowers thread access from the composer through the authoritative command", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => undefined) as CodeController["execute"];
    render(<CodeThreadWorkspace controller={controller({ execute })} threadId={threadId} />);

    await user.click(screen.getByRole("combobox", { name: "Thread access" }));
    await user.click(await screen.findByRole("option", { name: "Plan · read-only" }));

    expect(execute).toHaveBeenCalledWith({
      kind: "change-code-thread-access",
      threadId,
      expectedVersion: 1,
      executionPolicy: "plan",
      permissionPersistence: "current-session",
    });
  });

  it("switches to auto-accept edits without asking for native confirmation", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => undefined) as CodeController["execute"];
    const requestFullAccessApproval = vi.fn(async () => undefined);
    render(
      <CodeThreadWorkspace
        controller={controller({ execute })}
        requestFullAccessApproval={requestFullAccessApproval}
        threadId={threadId}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Thread access" }));
    await user.click(await screen.findByRole("option", { name: "Auto-accept edits" }));

    expect(requestFullAccessApproval).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith({
      kind: "change-code-thread-access",
      threadId,
      expectedVersion: 1,
      executionPolicy: "auto-accept-edits",
      permissionPersistence: "current-session",
    });
  });

  it("raises a thread to Full access only with the host's native confirmation", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => undefined) as CodeController["execute"];
    const approvalId = "40000000-0000-4000-8000-000000000004";
    const requestFullAccessApproval = vi.fn(async () => approvalId as never);
    render(
      <CodeThreadWorkspace
        controller={controller({ execute })}
        requestFullAccessApproval={requestFullAccessApproval}
        threadId={threadId}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Thread access" }));
    await user.click(await screen.findByRole("option", { name: "Full access" }));

    expect(requestFullAccessApproval).toHaveBeenCalledWith({
      kind: "change-thread-full-access",
      threadId,
      expectedVersion: 1,
      permissionPersistence: "current-session",
    });
    expect(execute).toHaveBeenCalledWith({
      kind: "change-code-thread-access",
      threadId,
      expectedVersion: 1,
      executionPolicy: "full-access",
      permissionPersistence: "current-session",
      approvalId,
    });
  });

  it("keeps the current access when native confirmation is declined", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => undefined) as CodeController["execute"];
    render(
      <CodeThreadWorkspace
        controller={controller({ execute })}
        requestFullAccessApproval={vi.fn(async () => undefined)}
        threadId={threadId}
      />,
    );

    await user.click(screen.getByRole("combobox", { name: "Thread access" }));
    await user.click(await screen.findByRole("option", { name: "Full access" }));

    expect(execute).not.toHaveBeenCalled();
    expect(
      await screen.findByText(
        "Full access was not confirmed. This thread keeps its current access.",
      ),
    ).toBeVisible();
  });

  it("does not offer Full access on a host that cannot confirm it natively", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => undefined) as CodeController["execute"];
    render(<CodeThreadWorkspace controller={controller({ execute })} threadId={threadId} />);

    await user.click(screen.getByRole("combobox", { name: "Thread access" }));
    const option = await screen.findByRole("option", { name: "Full access" });
    expect(option).toHaveAttribute("aria-disabled", "true");
    await user.click(option);
    expect(execute).not.toHaveBeenCalled();
  });

  it("answers agent-initiated approvals and questions through the controller", async () => {
    const user = userEvent.setup();
    const answerProviderRequest = vi.fn(
      async () => true,
    ) as CodeController["answerProviderRequest"];
    render(
      <CodeThreadWorkspace
        controller={controller({
          answerProviderRequest,
          providerRequests: [
            {
              kind: "approval",
              approvalId: "30000000-0000-4000-8000-000000000003" as never,
              summary: "terminal: run bun test",
            },
            {
              kind: "input",
              requestId: "req-1",
              prompt: "Which package manager?",
              options: ["bun", "npm"],
            },
          ],
        })}
        threadId={threadId}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(answerProviderRequest).toHaveBeenCalledWith({
      kind: "approval",
      approvalId: "30000000-0000-4000-8000-000000000003",
      decision: "approved",
    });

    await user.click(screen.getByRole("button", { name: "npm" }));
    expect(answerProviderRequest).toHaveBeenCalledWith({
      kind: "input",
      requestId: "req-1",
      response: "npm",
    });

    await user.type(screen.getByRole("textbox", { name: "Answer" }), "pnpm");
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    expect(answerProviderRequest).toHaveBeenLastCalledWith({
      kind: "input",
      requestId: "req-1",
      response: "pnpm",
    });
  });

  it("marks a provider handoff between replayed assistant turns", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: "turn:assistant-one",
              role: "assistant",
              text: "The first pass is complete.",
              providerInstanceId: providerId,
              modelId,
              status: "completed",
            },
            {
              id: "turn:assistant-two",
              role: "assistant",
              text: "The second pass is complete.",
              providerInstanceId: alternateProviderId,
              modelId: alternateModelId,
              status: "completed",
            },
          ],
        })}
        providerGroups={[providerGroup(), alternateProviderGroup()]}
        threadId={threadId}
      />,
    );

    expect(screen.getByRole("separator", { name: /provider handoff/i })).toHaveTextContent(
      "Provider handoff",
    );
  });

  it("does not invent a provider handoff for an app-authored assistant message", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: "turn:assistant-provider",
              role: "assistant",
              text: "The provider pass is complete.",
              providerInstanceId: providerId,
              modelId,
              status: "completed",
            },
            {
              id: "turn:assistant-app",
              role: "assistant",
              text: "Local app status.",
              status: "completed",
            },
          ],
        })}
        providerGroups={[providerGroup()]}
        threadId={threadId}
      />,
    );

    expect(screen.queryByRole("separator", { name: /provider handoff/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });

  it("keeps a pending draft editable without auto-sending it under Strict Mode", async () => {
    const sendFollowUp = vi.fn(async () => true);

    const { rerender } = render(
      <StrictMode>
        <CodeThreadWorkspace
          controller={controller({ pendingDraft: "Reply exactly: FOLLOWUP_OK.", sendFollowUp })}
          threadId={threadId}
        />
      </StrictMode>,
    );

    expect(screen.getByLabelText("Follow-up message")).toHaveValue("Reply exactly: FOLLOWUP_OK.");
    expect(sendFollowUp).not.toHaveBeenCalled();

    rerender(
      <StrictMode>
        <CodeThreadWorkspace
          controller={controller({ pendingDraft: "Do not auto-send this edit", sendFollowUp })}
          threadId={threadId}
        />
      </StrictMode>,
    );

    expect(screen.getByLabelText("Follow-up message")).toHaveValue("Do not auto-send this edit");
    expect(sendFollowUp).not.toHaveBeenCalled();
  });

  it("does not send pending drafts while navigating between threads", async () => {
    const sendFollowUp = vi.fn(async () => true);
    const { rerender } = render(
      <CodeThreadWorkspace
        controller={controller({ pendingDraft: "Opening A", sendFollowUp })}
        threadId={threadId}
      />,
    );
    expect(screen.getByLabelText("Follow-up message")).toHaveValue("Opening A");

    rerender(
      <CodeThreadWorkspace
        controller={controller({ pendingDraft: "Opening B", sendFollowUp }, anotherThreadId)}
        threadId={anotherThreadId}
      />,
    );
    expect(screen.getByLabelText("Follow-up message")).toHaveValue("Opening B");

    rerender(
      <CodeThreadWorkspace
        controller={controller({ pendingDraft: "Opening A", sendFollowUp })}
        threadId={threadId}
      />,
    );
    expect(screen.getByLabelText("Follow-up message")).toHaveValue("Opening A");
    expect(sendFollowUp).not.toHaveBeenCalled();
  });

  it("says so when a replayed turn kept only its earliest steps", () => {
    const operationId = "70000000-0000-4000-8000-000000000052";
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: `${operationId}:assistant`,
              role: "assistant",
              text: "Done.",
              operationId: operationId as never,
              status: "completed",
            },
          ],
          turnActivity: new Map([
            [
              operationId,
              {
                reasoning: "",
                truncated: true,
                rows: [{ kind: "tool", id: "call-1", toolName: "Read", state: "completed" }],
              },
            ],
          ]),
        })}
        threadId={threadId}
      />,
    );

    // The transcript never implies it is showing the whole turn when it is not.
    expect(screen.getByText("1 step · earliest kept")).toBeVisible();
  });

  it("collapses a turn's tool steps and reasoning until the user opens them", async () => {
    const user = userEvent.setup();
    const operationId = "70000000-0000-4000-8000-000000000051";
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: `${operationId}:assistant`,
              role: "assistant",
              text: "Verified the change.",
              operationId: operationId as never,
              status: "completed",
            },
          ],
          turnActivity: new Map([
            [
              operationId,
              {
                reasoning: "Check the failing suite first.",
                rows: [
                  {
                    kind: "tool",
                    id: "call-1",
                    toolName: "Bash",
                    state: "completed",
                    summary: "bun run verify",
                  },
                  { kind: "task", id: "task-1", state: "running", summary: "Rewrite the pane" },
                ],
              },
            ],
          ]),
        })}
        threadId={threadId}
      />,
    );

    // Closed by default: the summary counts the work without printing it.
    expect(screen.getByText("2 steps")).toBeVisible();
    expect(screen.queryByText("bun run verify")).not.toBeVisible();
    expect(screen.queryByText("Check the failing suite first.")).not.toBeVisible();

    await user.click(screen.getByText("2 steps"));
    expect(screen.getByText("bun run verify")).toBeVisible();
    expect(screen.getByText("Bash")).toBeVisible();

    await user.click(screen.getByText("Thinking"));
    expect(screen.getByText("Check the failing suite first.")).toBeVisible();
  });

  it("renders no activity disclosure for a turn that reported none", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: "assistant-plain",
              role: "assistant",
              text: "Done.",
              operationId: "70000000-0000-4000-8000-000000000052" as never,
              status: "completed",
            },
          ],
        })}
        threadId={threadId}
      />,
    );

    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
    expect(screen.queryByText(/steps?$/)).not.toBeInTheDocument();
  });

  it("lets the engine skip layout for transcript rows scrolled out of view", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(styles).toMatch(/\.code-thread-workspace__row\s*\{[^}]*content-visibility:\s*auto;/);
    expect(styles).toMatch(/\.code-thread-workspace__row\s*\{[^}]*contain-intrinsic-size:/);
  });

  it("queues a follow-up written while a turn runs instead of blocking the composer", async () => {
    const user = userEvent.setup();
    const queueFollowUp = vi.fn(() => ({
      id: "queued-1",
      prompt: "and then push",
      threadMentionIds: [],
    }));
    const sendFollowUp = vi.fn(async () => true);
    render(
      <CodeThreadWorkspace
        controller={controller({ queueFollowUp, sendFollowUp, turnStatus: "running" })}
        threadId={threadId}
      />,
    );

    const composer = screen.getByLabelText("Follow-up message");
    expect(composer).toBeEnabled();
    await user.type(composer, "and then push");
    await user.click(screen.getByRole("button", { name: "Queue follow-up" }));

    expect(queueFollowUp).toHaveBeenCalledWith("and then push", []);
    expect(sendFollowUp).not.toHaveBeenCalled();
    await waitFor(() => expect(composer).toHaveValue(""));
  });

  it("lists queued follow-ups in order and cancels one through the controller", async () => {
    const user = userEvent.setup();
    const cancelQueuedFollowUp = vi.fn();
    render(
      <CodeThreadWorkspace
        controller={controller({
          cancelQueuedFollowUp,
          queuedFollowUps: [
            { id: "queued-1", prompt: "run the tests", threadMentionIds: [] },
            { id: "queued-2", prompt: "then open a PR", threadMentionIds: [] },
          ],
          turnStatus: "running",
        })}
        threadId={threadId}
      />,
    );

    const queue = screen.getByRole("list", { name: "Queued follow-ups" });
    const entries = within(queue).getAllByRole("listitem");
    expect(entries.map((entry) => entry.textContent)).toEqual([
      "1run the tests",
      "2then open a PR",
    ]);

    await user.click(screen.getByRole("button", { name: "Cancel queued follow-up 2" }));
    expect(cancelQueuedFollowUp).toHaveBeenCalledWith("queued-2");
  });

  it("keeps loading and disconnected states honest", () => {
    const { rerender } = render(
      <CodeThreadWorkspace
        controller={{
          ...controller(),
          activeView: undefined,
          status: "loading",
        }}
        threadId={threadId}
      />,
    );
    expect(screen.getByRole("heading", { name: "Loading Code thread" })).toBeVisible();

    rerender(
      <CodeThreadWorkspace
        controller={{
          ...controller(),
          activeView: undefined,
          errorMessage: "Code transport disconnected.",
          retry: vi.fn(),
          status: "disconnected",
        }}
        threadId={threadId}
      />,
    );
    expect(screen.getByRole("heading", { name: "Code is disconnected" })).toBeVisible();
  });

  it("shows the historical provider binding and terminal state for replayed turns", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: "turn:assistant",
              role: "assistant",
              text: "The checks did not pass.",
              providerInstanceId: providerId,
              modelId,
              status: "failed",
            },
          ],
        })}
        providerGroups={[providerGroup()]}
        threadId={threadId}
      />,
    );

    expect(screen.getAllByText("Local OpenCode — Model One")).toHaveLength(1);
    expect(screen.getByText("Failed")).toBeVisible();
  });

  it("marks a thread for follow-up through the controller", async () => {
    const user = userEvent.setup();
    const markFollowUp = vi.fn(async () => true);
    render(<CodeThreadWorkspace controller={controller({ markFollowUp })} threadId={threadId} />);

    await user.click(screen.getByRole("button", { name: "Mark for follow-up" }));
    expect(markFollowUp).toHaveBeenCalledWith(threadId);
  });

  it("shows an open follow-up marker with its reason and completes it explicitly", async () => {
    const user = userEvent.setup();
    const completeFollowUp = vi.fn(async () => true);
    render(
      <CodeThreadWorkspace
        controller={controller({
          completeFollowUp,
          followUps: new Map([
            [
              String(threadId),
              {
                threadId,
                followUpVersion: 3,
                followUp: {
                  threadId,
                  state: "open",
                  origin: "automatic",
                  reason: "Approval requested: run tests",
                  triggerSequence: 6,
                  acknowledgedThroughSequence: 0,
                  createdAt: "2026-07-27T09:00:00.000Z",
                },
              },
            ],
          ]) as never,
        })}
        threadId={threadId}
      />,
    );

    const marker = screen.getByRole("status", { name: "Follow-up required" });
    expect(marker).toHaveTextContent("Approval requested: run tests");
    expect(screen.queryByRole("button", { name: "Mark for follow-up" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Complete follow-up" }));
    expect(completeFollowUp).toHaveBeenCalledWith(threadId);
  });

  it("starts a subagent from the Agents surface under this thread's own identity", async () => {
    // The managed child runtime is reachable only through an explicit creation
    // request. Rendering the hierarchy read-only would leave that runtime with
    // no production surface at all, so the Code thread — which is the parent
    // authority the host already verifies — must offer creation here.
    const user = userEvent.setup();
    const requestRun = vi.fn(async (_input: unknown) => ({ kind: "run-accepted" as const }));
    const agentRunClient = {
      parentSummary: vi.fn(async () => ({ parentThreadId: threadId, entries: [] })),
      acknowledge: vi.fn(),
      cancel: vi.fn(async () => ({ results: [] })),
      requestRun,
    } as never;
    render(
      <CodeThreadWorkspace
        agentRunClient={agentRunClient}
        controller={controller()}
        threadId={threadId}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Agents" }));
    const form = await screen.findByRole("form", { name: "Create subagent" });
    expect(form).toBeVisible();

    await user.type(within(form).getByLabelText("Task"), "Summarize the failing tests.");
    await user.type(
      within(form).getByLabelText("Provider instance ID"),
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    );
    await user.type(within(form).getByLabelText("Model ID"), "model-one");
    await user.click(within(form).getByRole("button", { name: "Create subagent" }));

    await waitFor(() => expect(requestRun).toHaveBeenCalledTimes(1));
    expect(requestRun.mock.calls[0]?.[0]).toMatchObject({
      // The parent identity is the thread this workspace is bound to; the host
      // authorizes creation against exactly that thread.
      parentThreadId: threadId,
      task: "Summarize the failing tests.",
    });
  });
});

function providerGroup(): PickerGroup {
  return {
    driverLabel: "OpenCode",
    endpointHost: "local",
    executionHost: "local",
    instance: {
      id: providerId,
      displayName: "Local OpenCode",
    },
    readiness: "ready",
    sections: [
      {
        label: "Models",
        models: [
          {
            model: {
              id: modelId,
              displayName: "Model One",
            },
          },
        ],
      },
    ],
  } as never;
}

function alternateProviderGroup(): PickerGroup {
  return {
    driverLabel: "Remote",
    endpointHost: "remote.example",
    executionHost: "remote",
    instance: {
      id: alternateProviderId,
      displayName: "Remote Provider",
    },
    readiness: "ready",
    sections: [
      {
        label: "Models",
        models: [
          {
            model: {
              id: alternateModelId,
              displayName: "Model Two",
            },
          },
        ],
      },
    ],
  } as never;
}

function controller(
  overrides: Partial<CodeController> = {},
  activeThreadId = threadId,
): CodeController {
  return {
    activeView: {
      checkout: {
        id: "20000000-0000-4000-8000-000000000002",
        repositoryId: "repo_" + "a".repeat(64),
        kind: "existing-worktree",
        availability: "available",
        head: { kind: "branch", name: "main", oid: "b".repeat(40) },
        observedAt: "2026-07-27T09:00:00.000Z",
      },
      lastSequence: 1,
      thread: {
        id: activeThreadId,
        title: "find bugs in this repo",
        lifecycle: "active",
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
        checkoutId: "20000000-0000-4000-8000-000000000002",
        providerInstanceId: providerId,
        modelId,
        version: 1,
      },
    },
    conversation: [],
    followUps: new Map(),
    markFollowUp: vi.fn(async () => true),
    completeFollowUp: vi.fn(async () => true),
    refreshFollowUp: vi.fn(async () => undefined),
    pendingDraft: "",
    providerRequests: [],
    answerProviderRequest: vi.fn(async () => true),
    cancelQueuedFollowUp: vi.fn(),
    queueFollowUp: vi.fn(),
    queuedFollowUps: [],
    turnActivity: new Map(),
    sendFollowUp: vi.fn(async () => true),
    setPendingDraft: vi.fn(),
    status: "ready",
    turnStatus: "idle",
    retry: vi.fn(),
    ...overrides,
  } as never;
}
