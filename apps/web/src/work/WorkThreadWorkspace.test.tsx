import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import { decodeWorkThread, decodeWorkThreadId } from "@octant/contracts";
import type { PickerGroup } from "@octant/domain";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkThreadWorkspace } from "./WorkThreadWorkspace";

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

  it("queues a follow-up while a turn is running and sends it once the turn completes", async () => {
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
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    expect(startFirstTurn).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "This message is queued and will send when the response finishes.",
    );
    expect(composer).toHaveValue("Next instruction");

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

  it("leaves a queued follow-up unsent when the turn is cancelled, and lets the user discard it", async () => {
    const user = userEvent.setup();
    const startFirstTurn = vi.fn();
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
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    turns = [workTurn({ status: "cancelled" })];
    await waitFor(
      () =>
        expect(screen.getByRole("status")).toHaveTextContent(
          "The response was cancelled. The queued message was not sent.",
        ),
      { timeout: 2500 },
    );
    expect(startFirstTurn).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Discard queued message" }));
    expect(screen.getByLabelText("Work prompt")).toHaveValue("");
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
