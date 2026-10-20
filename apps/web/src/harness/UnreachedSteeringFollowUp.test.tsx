import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  decodeNativeHarnessSteeringTaken,
  decodeThreadMessageQueueScope,
  decodeAggregateVersion,
  type ThreadMessageQueueCommand,
  type ThreadMessageQueueResult,
} from "@octant/contracts";
import { UnreachedSteeringFollowUp } from "./UnreachedSteeringFollowUp";

const threadId = "00000000-0000-4000-8000-000000000020";
const notes = decodeNativeHarnessSteeringTaken({
  taken: [
    {
      id: "00000000-0000-4000-8000-000000000021",
      text: "First note",
      status: "queued",
      at: "2026-10-16T12:06:00.000Z",
    },
    {
      id: "00000000-0000-4000-8000-000000000022",
      text: "Second note",
      status: "queued",
      at: "2026-10-16T12:06:01.000Z",
    },
  ],
}).taken;

function fixture(mode: "chat" | "work" | "code" = "chat") {
  const snapshot = {
    scope: decodeThreadMessageQueueScope({ mode, threadId }),
    version: decodeAggregateVersion(1),
    paused: false,
    items: [],
  };
  const client = {
    takeSteering: vi.fn(async () => ({ taken: notes })),
    steer: vi.fn(async () => null),
  };
  const queue = {
    read: vi.fn(async () => snapshot),
    execute: vi.fn(async (command: ThreadMessageQueueCommand) => ({
      status: "applied" as const,
      requestId: command.requestId,
      snapshot,
    })),
  };
  return {
    client,
    queue,
    threadId,
    mode,
    settled: true,
    notes,
    refresh: vi.fn(async () => undefined),
  };
}

describe("unreached steering follow-up", () => {
  it("takes a newly arrived note after the previous handoff finishes", async () => {
    const props = fixture();
    const later = decodeNativeHarnessSteeringTaken({
      taken: [{ ...notes[0], id: "00000000-0000-4000-8000-000000000023", text: "One more note" }],
    }).taken;
    props.client.takeSteering
      .mockResolvedValueOnce({ taken: notes })
      .mockResolvedValue({ taken: later });
    let finish: () => void = () => undefined;
    const snapshot = await props.queue.read();
    props.queue.execute.mockImplementationOnce(
      (command) =>
        new Promise((resolve) => {
          finish = () => resolve({ status: "applied", requestId: command.requestId, snapshot });
        }),
    );
    const { rerender } = render(<UnreachedSteeringFollowUp {...props} />);
    await waitFor(() => expect(props.queue.execute).toHaveBeenCalledTimes(1));
    rerender(<UnreachedSteeringFollowUp {...props} notes={later} />);
    expect(props.client.takeSteering).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(props.queue.execute).toHaveBeenCalledTimes(2));
    expect(props.queue.execute.mock.calls[1]?.[0]).toMatchObject({
      payload: { mode: "chat", prompt: "One more note" },
    });
  });
  it.each(["chat", "work", "code"] as const)(
    "queues ordered notes in the original %s thread without extra authority",
    async (mode) => {
      const props = fixture(mode);
      const { rerender } = render(<UnreachedSteeringFollowUp {...props} />);
      await waitFor(() => expect(props.queue.execute).toHaveBeenCalledTimes(1));
      expect(props.queue.execute.mock.calls[0]?.[0]).toMatchObject({
        kind: "enqueue",
        scope: { mode, threadId },
        messageId: notes[0]?.id,
        payload: { mode, prompt: "First note\n\nSecond note" },
      });
      const command = props.queue.execute.mock.calls[0]?.[0];
      expect(Object.keys(command?.kind === "enqueue" ? command.payload : {})).toEqual([
        "mode",
        "prompt",
      ]);
      rerender(<UnreachedSteeringFollowUp {...props} notes={[...notes]} />);
      expect(props.client.takeSteering).toHaveBeenCalledTimes(1);
    },
  );

  it("leaves notes alone until the turn settles and while the queue is paused", async () => {
    const props = fixture();
    props.queue.read.mockResolvedValue({ ...(await props.queue.read()), paused: true });
    const { rerender } = render(<UnreachedSteeringFollowUp {...props} settled={false} />);
    expect(props.client.takeSteering).not.toHaveBeenCalled();
    rerender(<UnreachedSteeringFollowUp {...props} />);
    await screen.findByText(/message queue is on hold/);
    expect(props.client.takeSteering).not.toHaveBeenCalled();
  });

  it("sends only the winner of the host's single-consumer take", async () => {
    const props = fixture();
    props.client.takeSteering
      .mockResolvedValueOnce({ taken: notes })
      .mockResolvedValue({ taken: [] });
    render(
      <>
        <UnreachedSteeringFollowUp {...props} />
        <UnreachedSteeringFollowUp {...props} />
      </>,
    );
    await waitFor(() => expect(props.client.takeSteering).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(props.queue.execute).toHaveBeenCalledTimes(1));
  });

  it("keeps an unconfirmed take visible without requeueing another client's notes", async () => {
    const props = fixture();
    props.client.takeSteering.mockRejectedValue(new Error("lost answer"));
    render(<UnreachedSteeringFollowUp {...props} />);
    await screen.findByText(/Another client may have them/);
    expect(screen.getByText("First note")).toBeVisible();
    expect(props.client.steer).not.toHaveBeenCalled();
    expect(props.queue.execute).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Check submission" })).toBeNull();
  });

  it("checks an unknown enqueue with the same message and request ids", async () => {
    const props = fixture();
    props.queue.execute.mockRejectedValueOnce(new Error("lost answer"));
    render(<UnreachedSteeringFollowUp {...props} />);
    await userEvent.click(await screen.findByRole("button", { name: "Check submission" }));
    await waitFor(() => expect(props.queue.execute).toHaveBeenCalledTimes(2));
    expect(props.queue.execute.mock.calls[1]?.[0]).toEqual(props.queue.execute.mock.calls[0]?.[0]);
    expect(props.client.steer).not.toHaveBeenCalled();
  });

  it("retains a refused follow-up and retries admission with a fresh version and request but the same message", async () => {
    const props = fixture();
    const snapshot = await props.queue.read();
    const execute = vi.fn(async (command: ThreadMessageQueueCommand) => ({
      status: "refused" as const,
      reason: "queue-full" as const,
      requestId: command.requestId,
    }));
    render(<UnreachedSteeringFollowUp {...props} queue={{ ...props.queue, execute }} />);
    await screen.findByText(/follow-up was not queued/);
    expect(screen.getByText("First note")).toBeVisible();
    expect(props.client.steer).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    props.queue.read.mockResolvedValue({ ...snapshot, version: decodeAggregateVersion(5) });
    await userEvent.click(screen.getByRole("button", { name: "Retry next message" }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    const first = execute.mock.calls[0]?.[0];
    const second = execute.mock.calls[1]?.[0];
    expect(second).toMatchObject({ ...first, expectedVersion: 5, requestId: expect.any(String) });
    expect(second?.requestId).not.toEqual(first?.requestId);
    expect(props.client.takeSteering).toHaveBeenCalledTimes(1);
  });
  it("keeps a refused admission on hold and checks an uncertain retry before creating another admission", async () => {
    const props = fixture();
    const snapshot = await props.queue.read();
    const execute = vi.fn(
      async (command: ThreadMessageQueueCommand): Promise<ThreadMessageQueueResult> => ({
        status: "refused",
        reason: "queue-full",
        requestId: command.requestId,
      }),
    );
    render(<UnreachedSteeringFollowUp {...props} queue={{ ...props.queue, execute }} />);
    const retry = await screen.findByRole("button", { name: "Retry next message" });
    props.queue.read.mockResolvedValue({ ...snapshot, paused: true });
    await userEvent.click(retry);
    await screen.findByText(/queue is on hold/);
    expect(execute).toHaveBeenCalledTimes(1);
    props.queue.read.mockResolvedValue({ ...snapshot, version: decodeAggregateVersion(4) });
    execute.mockRejectedValueOnce(new Error("lost admission response"));
    await userEvent.click(retry);
    await screen.findByRole("button", { name: "Check submission" });
    const admission = execute.mock.calls[1]?.[0];
    execute.mockImplementationOnce(async (command) => ({
      status: "duplicate",
      requestId: command.requestId,
      snapshot,
    }));
    await userEvent.click(screen.getByRole("button", { name: "Check submission" }));
    await waitFor(() => expect(execute).toHaveBeenCalledTimes(3));
    expect(execute.mock.calls[2]?.[0]).toEqual(admission);
    expect(props.client.takeSteering).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("First note")).toBeNull());
  });
});
