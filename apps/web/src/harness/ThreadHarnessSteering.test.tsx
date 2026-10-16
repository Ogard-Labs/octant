import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { NativeHarnessSessionView } from "@octant/contracts";
import { NativeHarnessClientFailure } from "@octant/client-runtime/native-harness-client";
import { ThreadHarnessSteering } from "./ThreadHarnessSteering";

const threadId = "00000000-0000-4000-8000-000000000020";
const queued = {
  id: "00000000-0000-4000-8000-0000000000a1",
  text: "Prefer the smaller change",
  status: "queued",
  at: "2026-10-16T12:06:00.000Z",
};

function view(
  status: "idle" | "running" | "paused-by-user" = "running",
  steering: ReadonlyArray<unknown> = [],
): NativeHarnessSessionView {
  return {
    session: {
      id: "00000000-0000-4000-8000-000000000010",
      threadId,
      mode: "chat",
      leadSlotId: "default",
      lead: {
        hostId: "00000000-0000-4000-8000-0000000000aa",
        providerInstanceId: "00000000-0000-4000-8000-000000000001",
        modelId: "frontier-large",
      },
      status,
      turnsRun: 1,
      cutovers: 0,
      startedAt: "2026-10-16T12:00:00.000Z",
      updatedAt: "2026-10-16T12:05:00.000Z",
      version: 4,
    },
    routes: [],
    turns: [],
    reductions: [],
    interventions: [],
    activatedFollowUpIds: [],
    questions: [],
    steering,
  } as never;
}

describe("ThreadHarnessSteering", () => {
  it("queues the typed note once under its own id, even when the first send fails", async () => {
    const steer = vi
      .fn()
      .mockRejectedValueOnce(new NativeHarnessClientFailure("The steering queue is full.", 409))
      .mockResolvedValue(null);
    const client = { session: vi.fn(async () => view()), steer };
    render(<ThreadHarnessSteering client={client} running threadId={threadId} />);
    const input = await screen.findByRole("textbox", { name: "Note for the lead" });
    await userEvent.type(input, "Use the smaller change");
    await userEvent.click(screen.getByRole("button", { name: "Send note" }));
    expect(await screen.findByText("The steering queue is full.")).toBeVisible();
    expect(input).toHaveValue("Use the smaller change");
    await userEvent.click(screen.getByRole("button", { name: "Send note" }));
    await waitFor(() => expect(steer).toHaveBeenCalledTimes(2));
    expect(steer.mock.calls[1]?.[1]).toEqual(steer.mock.calls[0]?.[1]);
    expect(steer.mock.calls[0]?.[1]).toMatchObject({
      kind: "queue",
      text: "Use the smaller change",
      noteId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    await waitFor(() => expect(input).toHaveValue(""));
  });

  it("keeps text typed while a note is being sent and queues it as the next note", async () => {
    let release: (value: null) => void = () => undefined;
    const steer = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          release = resolve;
        }),
    );
    const client = { session: vi.fn(async () => view()), steer };
    render(<ThreadHarnessSteering client={client} running threadId={threadId} />);
    const input = await screen.findByRole("textbox", { name: "Note for the lead" });
    await userEvent.type(input, "First note");
    await userEvent.click(screen.getByRole("button", { name: "Send note" }));
    await waitFor(() => expect(steer).toHaveBeenCalledTimes(1));
    await userEvent.type(input, "Second");
    release(null);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send note" })).toBeEnabled());
    expect(input).toHaveValue("First noteSecond");
  });

  it("gives an edited draft a new note id after a send whose answer was lost", async () => {
    const steer = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValue(null);
    const client = { session: vi.fn(async () => view()), steer };
    render(<ThreadHarnessSteering client={client} running threadId={threadId} />);
    const input = await screen.findByRole("textbox", { name: "Note for the lead" });
    await userEvent.type(input, "Use sqlite");
    await userEvent.click(screen.getByRole("button", { name: "Send note" }));
    expect(await screen.findByText("The note was not queued. Try again.")).toBeVisible();
    await userEvent.type(input, " instead");
    await userEvent.click(screen.getByRole("button", { name: "Send note" }));
    await waitFor(() => expect(steer).toHaveBeenCalledTimes(2));
    expect(steer.mock.calls[1]?.[1]).toMatchObject({ text: "Use sqlite instead" });
    expect(steer.mock.calls[1]?.[1].noteId).not.toEqual(steer.mock.calls[0]?.[1].noteId);
  });

  it("keeps reading while the session runs even when the thread list says the turn is parked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let status: "running" | "idle" = "running";
      const client = { session: vi.fn(async () => view(status)), steer: vi.fn() };
      render(
        <ThreadHarnessSteering
          client={client}
          refreshIntervalMs={50}
          running={false}
          threadId={threadId}
        />,
      );
      expect(await screen.findByRole("textbox", { name: "Note for the lead" })).toBeVisible();
      await vi.advanceTimersByTimeAsync(200);
      expect(client.session.mock.calls.length).toBeGreaterThan(1);
      status = "idle";
      await vi.advanceTimersByTimeAsync(200);
      await waitFor(() =>
        expect(screen.queryByRole("textbox", { name: "Note for the lead" })).toBeNull(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a queued note as queued and a delivered one as delivered while the turn runs", async () => {
    const delivered = {
      ...queued,
      id: "00000000-0000-4000-8000-0000000000a2",
      status: "delivered",
    };
    const client = {
      session: vi.fn(async () => view("running", [queued, delivered])),
      steer: vi.fn(),
    };
    render(<ThreadHarnessSteering client={client} running threadId={threadId} />);
    const list = await screen.findByRole("list", { name: "Notes for the running turn" });
    expect(within(list).getByText("queued")).toBeVisible();
    expect(within(list).getByText("delivered")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Discard unsent notes" })).toBeNull();
  });

  it("offers no note input between turns and lets the person drop notes the lead never reached", async () => {
    const steer = vi.fn(async () => null);
    const client = { session: vi.fn(async () => view("idle", [queued])), steer };
    render(<ThreadHarnessSteering client={client} running={false} threadId={threadId} />);
    const list = await screen.findByRole("list", { name: "Notes for the running turn" });
    expect(within(list).getByText("not reached")).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Note for the lead" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Discard unsent notes" }));
    await waitFor(() => expect(steer).toHaveBeenCalledWith(threadId, { kind: "clear" }));
  });

  it("offers nothing to an idle or paused session with no notes", async () => {
    const client = { session: vi.fn(async () => view("paused-by-user")), steer: vi.fn() };
    const { container } = render(
      <ThreadHarnessSteering client={client} running={false} threadId={threadId} />,
    );
    await waitFor(() => expect(client.session).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing, and stops polling, for a thread whose lead is not the harness", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const client = { session: vi.fn(async () => null), steer: vi.fn() };
      const { container } = render(
        <ThreadHarnessSteering
          client={client}
          refreshIntervalMs={50}
          running
          threadId={threadId}
        />,
      );
      await waitFor(() => expect(client.session).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(400);
      expect(client.session).toHaveBeenCalledTimes(1);
      expect(container).toBeEmptyDOMElement();
    } finally {
      vi.useRealTimers();
    }
  });
});
