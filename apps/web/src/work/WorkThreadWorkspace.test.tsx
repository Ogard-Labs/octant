import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import type { FileMentionClient, ThreadMentionClient } from "@octant/client-runtime";
import {
  decodeFileMentionPath,
  decodeUtcTimestamp,
  decodeWorkThread,
  decodeWorkThreadId,
} from "@octant/contracts";
import type { MentionableThreadId, ThreadMentionCandidate } from "@octant/contracts";
import type { PickerGroup } from "@octant/domain";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Profiler } from "react";
import { describe, expect, it, vi } from "vitest";
import { WorkThreadWorkspace } from "./WorkThreadWorkspace";
import { createComposerThreadDraftStore } from "../composer/composerThreadDraftStore";

const threadId = decodeWorkThreadId("10000000-0000-4000-8000-000000000101");
const providerId = "80000000-0000-4000-8000-0000000000b1" as never;
const modelId = "model-one" as never;
const alternateProviderId = "80000000-0000-4000-8000-0000000000b2" as never;
const alternateModelId = "model-two" as never;

describe("WorkThreadWorkspace", () => {
  it("changes provider and model through the authoritative Work command", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => ({
      kind: "thread-updated" as const,
      thread: workThread({
        providerInstanceId: alternateProviderId,
        modelId: alternateModelId,
      }),
    }));
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute,
    } as unknown as WorkThreadClient;

    render(
      <WorkThreadWorkspace
        providerGroups={[providerGroup(), alternateProviderGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );

    await screen.findByLabelText("Bound provider and model");
    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    await user.click(screen.getByRole("option", { name: "Remote Provider" }));
    await user.click(screen.getByRole("option", { name: "Model Two" }));

    expect(execute).toHaveBeenCalledWith({
      kind: "change-work-thread-provider",
      threadId,
      expectedVersion: 1,
      providerInstanceId: alternateProviderId,
      modelId: alternateModelId,
    });
  });

  it("notifies the sidebar after an authoritative Work thread update", async () => {
    const user = userEvent.setup();
    const updated = workThread({
      providerInstanceId: alternateProviderId,
      modelId: alternateModelId,
      updatedAt: "2026-08-01T20:01:00.000Z",
      version: 2,
    });
    const onThreadUpdated = vi.fn();
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(async () => ({
        kind: "thread-updated" as const,
        thread: updated,
      })),
    } as unknown as WorkThreadClient;

    render(
      <WorkThreadWorkspace
        onThreadUpdated={onThreadUpdated}
        providerGroups={[providerGroup(), alternateProviderGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );

    await screen.findByLabelText("Bound provider and model");
    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    await user.click(screen.getByRole("option", { name: "Remote Provider" }));
    await user.click(screen.getByRole("option", { name: "Model Two" }));
    expect(onThreadUpdated).toHaveBeenCalledWith(updated);
  });

  it("opens Browser from the exact Work thread toolbar", async () => {
    const user = userEvent.setup();
    const onOpenBrowser = vi.fn();
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;

    render(
      <WorkThreadWorkspace
        onOpenBrowser={onOpenBrowser}
        providerGroups={[providerGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );

    await screen.findByLabelText("Bound provider and model");
    await user.click(screen.getByRole("button", { name: "Browser" }));
    expect(onOpenBrowser).toHaveBeenCalledOnce();
  });

  it("confirms completion through the user-facing Work action", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => ({
      kind: "thread-completion-confirmed" as const,
      thread: workThread({ version: 2, completionConfirmed: true }),
    }));
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute,
    } as unknown as WorkThreadClient;

    render(
      <WorkThreadWorkspace
        providerGroups={[providerGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );

    await screen.findByLabelText("Bound provider and model");
    await user.click(screen.getByRole("button", { name: "Mark delivery target complete" }));
    await user.type(
      screen.getByRole("textbox", { name: "Delivery satisfaction evidence" }),
      "The reviewed draft is saved in the bound folder.",
    );
    await user.click(
      screen.getByRole("button", {
        name: "Confirm delivery target completion",
      }),
    );

    expect(execute).toHaveBeenCalledWith({
      kind: "confirm-work-thread-completion",
      threadId,
      expectedVersion: 1,
      deliveryTarget: "Draft brief",
      satisfactionEvidence: "The reviewed draft is saved in the bound folder.",
    });
    expect(await screen.findByText("Delivery target marked complete.")).toBeInTheDocument();
  });

  it("blocks artifact and provider mutations after completion until reactivation", async () => {
    const threadClient = {
      bootstrap: vi.fn(async () => ({
        threads: [workThread({ completionConfirmed: true })],
      })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;

    render(
      <WorkThreadWorkspace
        mutationClient={{ mutate: vi.fn() } as never}
        providerGroups={[providerGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );

    expect(await screen.findByLabelText("Bound provider and model")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Work prompt" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Provider and model" })).toBeDisabled();
    expect(screen.getByText(/Reactivate this Work thread/)).toBeInTheDocument();
  });

  it("keeps post-preview Canvas tools out of the live thread toolbar", async () => {
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;

    render(
      <WorkThreadWorkspace
        canvasClient={{} as never}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );

    await screen.findByLabelText("Bound provider and model");
    expect(screen.queryByRole("button", { name: "Canvas" })).not.toBeInTheDocument();
  });

  it("renders the durable transcript and pending request projection", async () => {
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const turnClient = {
      transcript: vi.fn(async () => ({
        threadId,
        turns: [
          {
            requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            threadId,
            turnId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            projectId: "20000000-0000-4000-8000-000000000101",
            authority: {
              hostId: "local",
              projectId: "20000000-0000-4000-8000-000000000101",
              bindingRevisionId: "30000000-0000-4000-8000-000000000101",
              workingDirectory: "research/brief",
              confinementPosture: "project-root-confined",
              providerInstanceId: providerId,
              modelId,
            },
            status: "completed",
            prompt: "Summarize the brief",
            transcript: [
              { role: "user", text: "Summarize the brief" },
              { role: "assistant", text: "Here is the confined summary." },
            ],
            capabilities: {
              workspace: "project-backed",
              confinement: "project-root-confined",
              shell: "denied",
              git: "denied",
              worktree: "denied",
              pullRequest: "denied",
              code: "denied",
            },
            version: 2,
            acceptedAt: "2026-08-01T20:00:00.000Z",
            updatedAt: "2026-08-01T20:01:00.000Z",
          },
        ],
      })),
    };
    const requestClient = {
      list: vi.fn(async () => ({
        requests: [
          {
            requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            projectId: "20000000-0000-4000-8000-000000000101",
            threadId,
            status: "pending",
            detail: {
              kind: "approval",
              action: "write-file",
              description: "Save notes.md in the Project root.",
            },
            createdAt: "2026-08-01T20:01:30.000Z",
            updatedAt: "2026-08-01T20:01:30.000Z",
          },
        ],
      })),
    };

    render(
      <WorkThreadWorkspace
        requestClient={requestClient as never}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    expect(await screen.findByText("Summarize the brief")).toBeInTheDocument();
    expect(screen.getByText("Here is the confined summary.")).toBeInTheDocument();
    expect(screen.getByText("Approval required")).toBeInTheDocument();
    expect(screen.getByText("write-file: Save notes.md in the Project root.")).toBeInTheDocument();
    expect(turnClient.transcript).toHaveBeenCalledWith(threadId);
    expect(requestClient.list).toHaveBeenCalledWith(
      "20000000-0000-4000-8000-000000000101",
      threadId,
    );
  });

  it("keeps a slow initial transcript read from overwriting a newer polled result", async () => {
    // The initial bootstrap read and the interval poll are separate effects
    // that share one generation counter. A read the initial effect started
    // before the interval ever ticked must still lose to a poll that
    // completed after it, even though it settles later.
    const older = deferred<ReadonlyArray<ReturnType<typeof workTurn>>>();
    let reads = 0;
    const turnClient = {
      transcript: vi.fn(async () => {
        reads += 1;
        if (reads === 1) return { threadId, turns: await older.promise };
        return {
          threadId,
          turns: [
            workTurn({
              prompt: "Newest transcript",
              transcript: [{ role: "user", text: "Newest transcript" }],
            }),
          ],
        };
      }),
    };
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;

    render(
      <WorkThreadWorkspace
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    await waitFor(() => expect(turnClient.transcript).toHaveBeenCalledOnce());
    await waitFor(() => expect(turnClient.transcript).toHaveBeenCalledTimes(2), {
      timeout: 2_500,
    });
    expect(await screen.findByText("Newest transcript")).toBeInTheDocument();

    older.resolve([
      workTurn({
        prompt: "Stale transcript",
        transcript: [{ role: "user", text: "Stale transcript" }],
      }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByText("Stale transcript")).not.toBeInTheDocument();
  });

  it("waits for a slow polling cycle to settle before starting the next one", async () => {
    // Promise.allSettled from a polling tick used to run unawaited, so the
    // very next tick would bump the generation before a slow response came
    // back - discarding it. A host that consistently answers a little slower
    // than the 1s interval would then never see its transcript update again.
    const slow = deferred<ReadonlyArray<ReturnType<typeof workTurn>>>();
    let reads = 0;
    const transcript = vi.fn(async () => {
      reads += 1;
      if (reads === 1) return { threadId, turns: [] };
      return { threadId, turns: await slow.promise };
    });
    const turnClient = { transcript };
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;

    render(
      <WorkThreadWorkspace
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    await waitFor(() => expect(transcript).toHaveBeenCalledOnce());
    await waitFor(() => expect(transcript).toHaveBeenCalledTimes(2), { timeout: 2_500 });

    // The second read is still pending. Two more interval ticks pass without
    // a third call, proving the next cycle waited instead of piling on.
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    expect(transcript).toHaveBeenCalledTimes(2);

    slow.resolve([
      workTurn({
        prompt: "Recovered after a slow poll",
        transcript: [{ role: "user", text: "Recovered after a slow poll" }],
      }),
    ]);

    expect(await screen.findByText("Recovered after a slow poll")).toBeInTheDocument();
    await waitFor(() => expect(transcript).toHaveBeenCalledTimes(3), { timeout: 2_500 });
  });

  it("keeps polling pending requests on a schedule without a turn client", async () => {
    // requestClient and turnClient are supplied independently by the host, so
    // request polling must not be gated on turnClient being present.
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    let pending: ReadonlyArray<Record<string, unknown>> = [];
    const list = vi.fn(async () => ({ requests: pending }));
    const requestClient = { list };

    render(
      <WorkThreadWorkspace
        requestClient={requestClient as never}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );

    await waitFor(() => expect(list).toHaveBeenCalledOnce());

    pending = [
      {
        requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        projectId: "20000000-0000-4000-8000-000000000101",
        threadId,
        status: "pending",
        detail: {
          kind: "approval",
          action: "write-file",
          description: "Save notes.md in the Project root.",
        },
        createdAt: "2026-08-01T20:01:30.000Z",
        updatedAt: "2026-08-01T20:01:30.000Z",
      },
    ];

    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(1), { timeout: 2_500 });
    expect(await screen.findByText("Approval required")).toBeInTheDocument();
  });

  it("does not commit again when transcript polling returns the same data", async () => {
    const turns = [workTurn()];
    const transcript = vi.fn(async () => ({ threadId, turns }));
    const turnClient = {
      transcript,
    };
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const commits: Array<string> = [];

    render(
      <Profiler id="work-thread-workspace" onRender={(_, phase) => commits.push(phase)}>
        <WorkThreadWorkspace
          threadClient={threadClient}
          threadId={threadId}
          title="Draft brief"
          turnClient={turnClient as never}
        />
      </Profiler>,
    );

    await waitFor(() => expect(transcript.mock.calls.length).toBeGreaterThan(2), {
      timeout: 2_500,
    });
    const commitsAfterPolling = commits.length;
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    expect(commits.length).toBe(commitsAfterPolling);
  });

  it("sends a follow-up written while a turn is running once that turn completes", async () => {
    const user = userEvent.setup();
    const startFirstTurn = vi.fn(async () => ({
      kind: "accepted" as const,
      turn: workTurn({
        requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        turnId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        status: "accepted",
        prompt: "Next instruction",
        transcript: [{ role: "user", text: "Next instruction" }],
      }),
    }));
    let turns = [workTurn({ status: "running" })];
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const turnClient = {
      transcript: vi.fn(async () => ({ threadId, turns })),
      startFirstTurn,
    };

    render(
      <WorkThreadWorkspace
        hostId={"local" as never}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    const composer = await screen.findByLabelText("Work prompt");
    expect(composer).toBeEnabled();
    await user.type(composer, "Next instruction");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(startFirstTurn).not.toHaveBeenCalled();
    // The message left the composer and joined the transcript: it was sent,
    // not parked somewhere the user has to go back and release.
    expect(composer).toHaveValue("");
    expect(await screen.findByText("Next instruction")).toBeVisible();

    turns = [workTurn({ status: "completed" })];
    await waitFor(() => expect(startFirstTurn).toHaveBeenCalledOnce(), { timeout: 2500 });
    expect(startFirstTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "start-work-thread-turn",
        threadId,
        prompt: "Next instruction",
      }),
    );
  });

  it("sends a follow-up written mid-turn even after that turn is cancelled", async () => {
    const user = userEvent.setup();
    const startFirstTurn = vi.fn(async () => ({
      kind: "accepted" as const,
      turn: workTurn({
        requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        turnId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        status: "accepted",
        prompt: "Hold this",
        transcript: [{ role: "user", text: "Hold this" }],
      }),
    }));
    let turns = [workTurn({ status: "running" })];
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const turnClient = {
      transcript: vi.fn(async () => ({ threadId, turns })),
      startFirstTurn,
    };

    render(
      <WorkThreadWorkspace
        hostId={"local" as never}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    await user.type(await screen.findByLabelText("Work prompt"), "Hold this");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    turns = [workTurn({ status: "cancelled" })];
    await waitFor(() => expect(startFirstTurn).toHaveBeenCalledOnce(), { timeout: 2500 });
  });

  it("sends the captured Work context and keeps context added to a later draft", async () => {
    const user = userEvent.setup();
    const firstThreadId = "90000000-0000-4000-8000-000000000001" as MentionableThreadId;
    const secondThreadId = "90000000-0000-4000-8000-000000000002" as MentionableThreadId;
    let turns = [workTurn({ status: "running" })];
    const startFirstTurn = vi.fn(async () => ({
      kind: "accepted" as const,
      turn: workTurn({
        status: "accepted",
        prompt: "first draft",
        transcript: [{ role: "user", text: "first draft" }],
      }),
    }));
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const turnClient = {
      transcript: vi.fn(async () => ({ threadId, turns })),
      startFirstTurn,
      putAttachment: vi.fn(async (input) => ({
        attachmentId: input.attachmentId,
        displayName: input.displayName,
        mediaType: input.mediaType,
        byteLength: input.bytes.byteLength,
        digest: "d".repeat(64),
      })),
    };
    const threadMentionClient: ThreadMentionClient = {
      search: vi.fn(async (_requestId, query) => [
        mentionCandidate(query.includes("second") ? secondThreadId : firstThreadId),
      ]),
      resolve: vi.fn(async (_requestId, ids: ReadonlyArray<MentionableThreadId>) => ({
        mentions: [],
        unavailable: ids.map((id) => ({ threadId: id, reason: "unauthorized" as const })),
      })),
      openSideChat: vi.fn(),
      execute: vi.fn(),
    };
    const fileMentionClient: FileMentionClient = {
      complete: vi.fn(async (_requestId, _scope, query) => [
        {
          kind: "file" as const,
          path: decodeFileMentionPath(query.includes("second") ? "second.md" : "first.md"),
        },
      ]),
      resolve: vi.fn(async () => ({ mentions: [], unavailable: [] })),
      execute: vi.fn(),
    };

    render(
      <WorkThreadWorkspace
        fileMentionClient={fileMentionClient}
        hostId={"local" as never}
        threadClient={threadClient}
        threadId={threadId}
        threadMentionClient={threadMentionClient}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    const composer = await screen.findByLabelText("Work prompt");
    await user.type(composer, "first draft #first");
    await user.click(await screen.findByRole("option", { name: /Release notes/ }));
    await user.type(composer, " @first");
    await user.click(await screen.findByRole("option", { name: /first.md/ }));
    fireEvent.paste(composer, {
      clipboardData: {
        files: [new File([new Uint8Array([137, 80, 78])], "first.png", { type: "image/png" })],
        items: [],
      },
    });
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));

    await user.type(composer, "second draft #second");
    await user.click(await screen.findByRole("option", { name: /Roadmap/ }));
    await user.type(composer, " @second");
    await user.click(await screen.findByRole("option", { name: /second.md/ }));
    fireEvent.paste(composer, {
      clipboardData: {
        files: [new File([new Uint8Array([137, 80, 78])], "second.png", { type: "image/png" })],
        items: [],
      },
    });

    turns = [workTurn({ status: "completed" })];
    await waitFor(() => expect(startFirstTurn).toHaveBeenCalledOnce(), { timeout: 2500 });
    expect(startFirstTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "first draft #[Release notes]  @first.md",
        threadMentionIds: [firstThreadId],
        fileMentionPaths: ["first.md"],
        attachmentIds: [expect.anything()],
      }),
    );
    expect(composer).toHaveValue("second draft #[Roadmap]  @second.md ");
    expect(screen.getByLabelText("Mentioned threads")).toHaveTextContent("Roadmap");
    expect(await screen.findByAltText("second.png")).toBeInTheDocument();
  });

  it("restores the captured Work context when the deferred send is refused", async () => {
    const user = userEvent.setup();
    const mentionedThreadId = "90000000-0000-4000-8000-000000000001" as MentionableThreadId;
    let turns = [workTurn({ status: "running" })];
    const startFirstTurn = vi.fn(async () => ({
      kind: "not-created" as const,
      requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      message: "Work turn refused",
    }));
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const turnClient = {
      transcript: vi.fn(async () => ({ threadId, turns })),
      startFirstTurn,
      putAttachment: vi.fn(async (input) => ({
        attachmentId: input.attachmentId,
        displayName: input.displayName,
        mediaType: input.mediaType,
        byteLength: input.bytes.byteLength,
        digest: "e".repeat(64),
      })),
    };
    const threadMentionClient: ThreadMentionClient = {
      search: vi.fn(async () => [mentionCandidate(mentionedThreadId)]),
      resolve: vi.fn(async () => ({ mentions: [], unavailable: [] })),
      openSideChat: vi.fn(),
      execute: vi.fn(),
    };
    const fileMentionClient: FileMentionClient = {
      complete: vi.fn(async () => [
        { kind: "file" as const, path: decodeFileMentionPath("first.md") },
      ]),
      resolve: vi.fn(async () => ({ mentions: [], unavailable: [] })),
      execute: vi.fn(),
    };

    render(
      <WorkThreadWorkspace
        fileMentionClient={fileMentionClient}
        hostId={"local" as never}
        threadClient={threadClient}
        threadId={threadId}
        threadMentionClient={threadMentionClient}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    const composer = await screen.findByLabelText("Work prompt");
    await user.type(composer, "retry this #first");
    await user.click(await screen.findByRole("option", { name: /Release notes/ }));
    await user.type(composer, " @first");
    await user.click(await screen.findByRole("option", { name: /first.md/ }));
    fireEvent.paste(composer, {
      clipboardData: {
        files: [new File([new Uint8Array([137, 80, 78])], "first.png", { type: "image/png" })],
        items: [],
      },
    });
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(composer).toHaveValue("");

    turns = [workTurn({ status: "completed" })];
    await waitFor(() => expect(startFirstTurn).toHaveBeenCalledOnce(), { timeout: 2500 });
    await waitFor(() => expect(composer).toHaveValue("retry this #[Release notes]  @first.md"));
    expect(await screen.findByAltText("first.png")).toBeInTheDocument();
    expect(screen.getByLabelText("Mentioned threads")).toHaveTextContent("Release notes");
  });

  it("does not let Enter submit a second Work draft while one message waits", async () => {
    const user = userEvent.setup();
    const startFirstTurn = vi.fn();
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const turnClient = {
      transcript: vi.fn(async () => ({ threadId, turns: [workTurn({ status: "running" })] })),
      startFirstTurn,
    };

    render(
      <WorkThreadWorkspace
        hostId={"local" as never}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    const composer = await screen.findByLabelText("Work prompt");
    await user.type(composer, "first draft");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    await user.type(composer, "second draft");
    expect(screen.getByRole("button", { name: "Send follow-up" })).toBeDisabled();

    fireEvent.keyDown(composer, { key: "Enter" });
    expect(composer).toHaveValue("second draft");
    expect(startFirstTurn).not.toHaveBeenCalled();
  });

  it("keeps a newer draft when an accepted send has identical text", async () => {
    const user = userEvent.setup();
    const store = createComposerThreadDraftStore(memoryDraftStorage());
    let finish: ((value: ReturnType<typeof workTurn>) => void) | undefined;
    const startFirstTurn = vi.fn(
      () =>
        new Promise<{ kind: "accepted"; turn: ReturnType<typeof workTurn> }>((resolve) => {
          finish = (turn) => resolve({ kind: "accepted", turn });
        }),
    );
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const turnClient = {
      transcript: vi.fn(async () => ({ threadId, turns: [workTurn({ status: "completed" })] })),
      startFirstTurn,
    };

    render(
      <WorkThreadWorkspace
        draftStore={store}
        hostId={"local" as never}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    const composer = await screen.findByLabelText("Work prompt");
    await user.type(composer, "same draft");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    store.clear("work", String(threadId));
    store.write("work", String(threadId), {
      text: "same draft",
      caretIndex: 10,
      stagedDropped: false,
    });
    finish?.(workTurn({ status: "accepted", prompt: "same draft" }));

    await waitFor(() => expect(startFirstTurn).toHaveBeenCalledOnce());
    expect(composer).toHaveValue("same draft");
  });

  it("hands a Work follow-up back to the composer when the thread is confirmed Done", async () => {
    const user = userEvent.setup();
    const startFirstTurn = vi.fn();
    let turns = [workTurn({ status: "running" })];
    const execute = vi.fn(async () => ({
      kind: "thread-completion-confirmed" as const,
      thread: workThread({ version: 2, completionConfirmed: true }),
    }));
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute,
    } as unknown as WorkThreadClient;
    const turnClient = {
      transcript: vi.fn(async () => ({ threadId, turns })),
      startFirstTurn,
    };

    render(
      <WorkThreadWorkspace
        hostId={"local" as never}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    await user.type(await screen.findByLabelText("Work prompt"), "After done");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    await user.click(screen.getByRole("button", { name: "Mark delivery target complete" }));
    await user.type(
      screen.getByRole("textbox", { name: "Delivery satisfaction evidence" }),
      "The reviewed draft is saved in the bound folder.",
    );
    await user.click(screen.getByRole("button", { name: "Confirm delivery target completion" }));
    expect(await screen.findByText("Delivery target marked complete.")).toBeInTheDocument();
    turns = [workTurn({ status: "completed" })];
    await waitFor(
      () =>
        expect(
          (turnClient.transcript as { mock: { calls: unknown[] } }).mock.calls.length,
        ).toBeGreaterThan(1),
      { timeout: 2500 },
    );
    expect(startFirstTurn).not.toHaveBeenCalled();
    // The thread will never run it, so the words go back where the user can
    // still use them rather than disappearing with the message.
    expect(screen.getByLabelText("Work prompt")).toHaveValue("After done");
  });

  it("refuses a follow-up when the thread has no binding authority instead of writing an artifact", async () => {
    const user = userEvent.setup();
    const { bindingRevisionId: _omitted, ...unbound } = workThread();
    const threadClient = {
      bootstrap: vi.fn(async () => ({
        threads: [unbound],
      })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const mutate = vi.fn();
    const startFirstTurn = vi.fn();
    render(
      <WorkThreadWorkspace
        mutationClient={{ mutate } as never}
        providerGroups={[providerGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={
          { startFirstTurn, transcript: vi.fn(async () => ({ threadId, turns: [] })) } as never
        }
      />,
    );

    await screen.findByLabelText("Bound provider and model");
    await user.type(screen.getByRole("textbox", { name: "Work prompt" }), "Revise that");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));

    expect(mutate).not.toHaveBeenCalled();
    expect(startFirstTurn).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/must be rebound before sending a follow-up/),
    ).toBeInTheDocument();
  });

  it("offers a file picker on an existing Work thread that can send images", async () => {
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    render(
      <WorkThreadWorkspace
        providerGroups={[
          {
            ...providerGroup(),
            sections: [
              {
                label: "Models",
                models: [
                  {
                    model: {
                      id: modelId,
                      displayName: "Model One",
                      inputModalities: ["text", "image"],
                    },
                  },
                ],
              },
            ],
          } as never,
        ]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={{ transcript: vi.fn(async () => ({ threadId, turns: [] })) } as never}
      />,
    );

    await screen.findByLabelText("Bound provider and model");
    expect(screen.getByRole("button", { name: "Add attachment" })).toBeEnabled();
  });

  it("says a text-only model cannot take a pasted image instead of attaching it", async () => {
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    render(
      <WorkThreadWorkspace
        providerGroups={[
          {
            ...providerGroup(),
            sections: [
              {
                label: "Models",
                models: [
                  {
                    model: {
                      id: modelId,
                      displayName: "Model One",
                      inputModalities: ["text"],
                    },
                  },
                ],
              },
            ],
          } as never,
        ]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );

    await screen.findByLabelText("Bound provider and model");
    const file = new File([new Uint8Array([137, 80, 78])], "pasted.png", { type: "image/png" });
    fireEvent.paste(screen.getByLabelText("Work prompt"), {
      clipboardData: { files: [file], items: [] },
    });
    const attached = await screen.findByLabelText("Attached images");
    expect(attached).toHaveTextContent(
      "The selected model does not accept images. Choose an image-capable model.",
    );
    expect(screen.queryByAltText("pasted.png")).not.toBeInTheDocument();
  });

  it("does not offer @file completion until the host can list the bound root", async () => {
    const user = userEvent.setup();
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    render(
      <WorkThreadWorkspace
        providerGroups={[providerGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );
    await screen.findByLabelText("Bound provider and model");
    await user.type(screen.getByLabelText("Work prompt"), "look at @notes");
    expect(
      screen.queryByRole("listbox", { name: "Files you can mention" }),
    ).not.toBeInTheDocument();
  });

  it("restores a Work draft after leaving the thread and remounting", async () => {
    const store = createComposerThreadDraftStore(memoryDraftStorage());
    store.write("work", String(threadId), {
      text: "quarterly notes",
      caretIndex: 9,
      stagedDropped: false,
    });
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;

    const first = render(
      <WorkThreadWorkspace
        draftStore={store}
        providerGroups={[providerGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );
    expect(await screen.findByRole("textbox", { name: "Work prompt" })).toHaveValue(
      "quarterly notes",
    );
    first.unmount();

    render(
      <WorkThreadWorkspace
        draftStore={store}
        providerGroups={[providerGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );
    const prompt = await screen.findByRole("textbox", { name: "Work prompt" });
    expect(prompt).toHaveValue("quarterly notes");
    expect((prompt as HTMLTextAreaElement).selectionStart).toBe(9);
  });

  it("clears a Work draft so it does not reappear", async () => {
    const store = createComposerThreadDraftStore(memoryDraftStorage());
    store.write("work", String(threadId), {
      text: "artifact body",
      caretIndex: 0,
      stagedDropped: false,
    });
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const { unmount } = render(
      <WorkThreadWorkspace
        draftStore={store}
        providerGroups={[providerGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );
    expect(await screen.findByRole("textbox", { name: "Work prompt" })).toHaveValue(
      "artifact body",
    );
    store.clear("work", String(threadId));
    unmount();

    render(
      <WorkThreadWorkspace
        draftStore={store}
        providerGroups={[providerGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );
    expect(await screen.findByRole("textbox", { name: "Work prompt" })).toHaveValue("");
  });

  it("purges a Work draft when the thread is no longer available", async () => {
    const store = createComposerThreadDraftStore(memoryDraftStorage());
    store.write("work", String(threadId), {
      text: "gone with thread",
      caretIndex: 0,
      stagedDropped: false,
    });
    const missing = {
      bootstrap: vi.fn(async () => ({ threads: [] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    render(
      <WorkThreadWorkspace
        draftStore={store}
        providerGroups={[providerGroup()]}
        threadClient={missing}
        threadId={threadId}
        title="Draft brief"
      />,
    );
    expect(await screen.findByText("This Work thread is no longer available.")).toBeInTheDocument();
    expect(store.read("work", String(threadId))).toBeUndefined();
  });

  it("shows why Save to Project failed instead of leaving an unhandled rejection", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => {
      throw new Error("disk full");
    });
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    render(
      <WorkThreadWorkspace
        imageGenerationClient={
          {
            list: async () => ({ jobs: [completedGeneratedJob()] }),
            artifact: async () => new Blob([Uint8Array.from([1])], { type: "image/png" }),
            save,
          } as never
        }
        imageGenerationProfiles={[imageProfile()]}
        providerGroups={[providerGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Save to Project" }));
    expect(await screen.findByText("The image could not be saved.")).toBeVisible();
  });
});

function workTurn(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    threadId,
    turnId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    projectId: "20000000-0000-4000-8000-000000000101",
    authority: {
      hostId: "local",
      projectId: "20000000-0000-4000-8000-000000000101",
      bindingRevisionId: "30000000-0000-4000-8000-000000000101",
      workingDirectory: "research/brief",
      confinementPosture: "project-root-confined",
      providerInstanceId: providerId,
      modelId,
    },
    status: "completed",
    prompt: "Summarize the brief",
    transcript: [
      { role: "user", text: "Summarize the brief" },
      { role: "assistant", text: "Here is the confined summary." },
    ],
    capabilities: {
      workspace: "project-backed",
      confinement: "project-root-confined",
      shell: "denied",
      git: "denied",
      worktree: "denied",
      pullRequest: "denied",
      code: "denied",
    },
    version: 2,
    acceptedAt: "2026-08-01T20:00:00.000Z",
    updatedAt: "2026-08-01T20:01:00.000Z",
    ...overrides,
  };
}

function workThread(overrides: Record<string, unknown> = {}) {
  return decodeWorkThread({
    id: threadId,
    projectId: "20000000-0000-4000-8000-000000000101",
    title: "Draft brief",
    lifecycle: "active",
    providerInstanceId: providerId,
    modelId,
    bindingRevisionId: "30000000-0000-4000-8000-000000000101",
    workingDirectory: "research/brief",
    version: 1,
    createdAt: "2026-08-01T20:00:00.000Z",
    updatedAt: "2026-08-01T20:00:00.000Z",
    ...overrides,
  });
}

function providerGroup(): PickerGroup {
  return {
    driverLabel: "OpenCode",
    endpointHost: "local",
    executionHost: "local",
    instance: { id: providerId, displayName: "Local OpenCode" },
    readiness: "ready",
    sections: [
      {
        label: "Models",
        models: [{ model: { id: modelId, displayName: "Model One" } }],
      },
    ],
  } as never;
}

function mentionCandidate(threadId: MentionableThreadId): ThreadMentionCandidate {
  return {
    threadId,
    mode: "chat",
    title: threadId.endsWith("002") ? "Roadmap" : "Release notes",
    placement: { kind: "project", label: "Launch" },
    updatedAt: decodeUtcTimestamp("2026-08-14T10:00:00.000Z"),
  };
}

function memoryDraftStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function alternateProviderGroup(): PickerGroup {
  return {
    driverLabel: "Remote",
    endpointHost: "remote.example",
    executionHost: "remote",
    instance: { id: alternateProviderId, displayName: "Remote Provider" },
    readiness: "ready",
    sections: [
      {
        label: "Models",
        models: [{ model: { id: alternateModelId, displayName: "Model Two" } }],
      },
    ],
  } as never;
}

function imageProfile() {
  return {
    instanceId: providerId,
    displayName: "OpenAI Image",
    driverKind: "openai-image" as const,
    modelAllowlist: ["gpt-image-2" as never],
    defaultModel: "gpt-image-2" as never,
  };
}

function completedGeneratedJob() {
  const jobId = "a3000000-0000-4000-8000-000000000003";
  return {
    id: jobId,
    status: "completed",
    threadKind: "work-thread",
    scopeId: String(threadId),
    profileInstanceId: providerId,
    modelId: "gpt-image-2",
    promptHash: "a".repeat(64),
    artifacts: [
      {
        attachmentId: "a3000000-0000-4000-8000-000000000010",
        hash: "b".repeat(64),
        size: 1,
        mime: "image/png",
        evidence: {
          profileInstanceId: providerId,
          modelId: "gpt-image-2",
          promptHash: "a".repeat(64),
          jobId,
        },
      },
    ],
    version: 3,
    createdAt: "2026-08-01T20:00:00.000Z",
    updatedAt: "2026-08-01T20:00:00.000Z",
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
