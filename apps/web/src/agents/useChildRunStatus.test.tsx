import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AgentRunClient } from "@octant/client-runtime";
import type { AgentRunParentThreadId } from "@octant/contracts";
import { useChildRunStatus } from "./useChildRunStatus";

const parentThreadId = "00000000-0000-4000-8000-000000000001" as AgentRunParentThreadId;

function summaryEntry(runId: string, lifecycleStatus: string, parentRunId?: string) {
  return {
    runId,
    requestId: `req-${runId}`,
    parentThreadId,
    ...(parentRunId === undefined ? {} : { parentRunId }),
    role: "worker",
    task: `task ${runId}`,
    lifecycleStatus,
    executionKind: "managed",
    usageQuality: "measured",
    resultAcknowledgement: { required: false, acknowledged: false },
    version: 1,
    updatedAt: "2026-08-14T10:00:00.000Z",
  };
}

function stubClient(overrides: Partial<AgentRunClient> = {}): AgentRunClient {
  return {
    parentSummary: vi.fn().mockResolvedValue({
      parentThreadId,
      entries: [summaryEntry("a", "running"), summaryEntry("b", "waiting")],
    }),
    acknowledge: vi.fn().mockResolvedValue({ kind: "run-updated" }),
    requestRun: vi.fn(),
    cancel: vi.fn().mockResolvedValue({ results: [] }),
    ...overrides,
  } as unknown as AgentRunClient;
}

function Harness(props: {
  readonly client?: AgentRunClient;
  readonly parentThreadId?: AgentRunParentThreadId;
}) {
  const status = useChildRunStatus({
    ...(props.client === undefined ? {} : { client: props.client }),
    ...(props.parentThreadId === undefined ? {} : { parentThreadId: props.parentThreadId }),
    refreshMs: 10_000,
  });
  const [stopped, setStopped] = useState<string>("idle");
  return (
    <div>
      <output aria-label="label">{status.summary.label}</output>
      <output aria-label="stoppable">{status.summary.stoppableRunIds.join(",")}</output>
      <output aria-label="entries">{status.entries.map((entry) => entry.runId).join(",")}</output>
      <output aria-label="status">{status.status}</output>
      <output aria-label="reconnecting">{status.reconnecting ? "stale" : "live"}</output>
      <output aria-label="error">{status.errorMessage ?? "none"}</output>
      <output aria-label="stopped">{stopped}</output>
      <button
        onClick={() => void status.stopAll().then((ok) => setStopped(ok ? "ok" : "failed"))}
        type="button"
      >
        stop
      </button>
    </div>
  );
}

describe("useChildRunStatus", () => {
  it("reads the host's parent summary and reports it in words", async () => {
    const client = stubClient();
    render(<Harness client={client} parentThreadId={parentThreadId} />);

    await waitFor(() =>
      expect(screen.getByLabelText("label")).toHaveTextContent("2 child runs · Waiting"),
    );
    expect(client.parentSummary).toHaveBeenCalledWith(parentThreadId);
  });

  it("stays empty when no parent thread is bound", async () => {
    const client = stubClient();
    render(<Harness client={client} />);

    await waitFor(() =>
      expect(screen.getByLabelText("label")).toHaveTextContent("No child runs · Idle"),
    );
    expect(client.parentSummary).not.toHaveBeenCalled();
  });

  it("cancels only this parent thread's live children", async () => {
    const user = userEvent.setup();
    const client = stubClient();
    render(<Harness client={client} parentThreadId={parentThreadId} />);
    await waitFor(() => expect(screen.getByLabelText("stoppable")).toHaveTextContent("a,b"));

    await user.click(screen.getByRole("button", { name: "stop" }));

    await waitFor(() => expect(client.cancel).toHaveBeenCalledTimes(2));
    expect(client.cancel).toHaveBeenNthCalledWith(1, { runId: "a", scope: "subtree" });
    expect(client.cancel).toHaveBeenNthCalledWith(2, { runId: "b", scope: "subtree" });
  });

  it("submits one subtree cancel for a live parent instead of re-cancelling its descendant", async () => {
    const user = userEvent.setup();
    const client = stubClient({
      parentSummary: vi.fn().mockResolvedValue({
        parentThreadId,
        // Parent before nested descendant: the order the host reports when the
        // parent was created first.
        entries: [summaryEntry("a", "running"), summaryEntry("b", "running", "a")],
      }),
    });
    render(<Harness client={client} parentThreadId={parentThreadId} />);
    await waitFor(() => expect(screen.getByLabelText("stoppable")).toHaveTextContent("a,b"));

    await user.click(screen.getByRole("button", { name: "stop" }));

    // `subtree` on the parent already cancels `b`; submitting `b` again asks the
    // host to cancel a run with no live target, which it answers 403.
    await waitFor(() => expect(client.cancel).toHaveBeenCalledTimes(1));
    expect(client.cancel).toHaveBeenCalledWith({ runId: "a", scope: "subtree" });
    expect(screen.getByLabelText("error")).toHaveTextContent("none");
    expect(screen.getByLabelText("stopped")).toHaveTextContent("ok");
  });

  it("still submits a live descendant whose parent already finished", async () => {
    const user = userEvent.setup();
    const client = stubClient({
      parentSummary: vi.fn().mockResolvedValue({
        parentThreadId,
        entries: [summaryEntry("a", "completed"), summaryEntry("b", "running", "a")],
      }),
    });
    render(<Harness client={client} parentThreadId={parentThreadId} />);
    await waitFor(() => expect(screen.getByLabelText("stoppable")).toHaveTextContent("b"));

    await user.click(screen.getByRole("button", { name: "stop" }));

    await waitFor(() => expect(client.cancel).toHaveBeenCalledTimes(1));
    expect(client.cancel).toHaveBeenCalledWith({ runId: "b", scope: "subtree" });
  });

  it("reports a genuine authorization denial as a failure", async () => {
    const user = userEvent.setup();
    const client = stubClient({
      parentSummary: vi.fn().mockResolvedValue({
        parentThreadId,
        entries: [summaryEntry("a", "running"), summaryEntry("b", "running", "a")],
      }),
      cancel: vi.fn().mockRejectedValue(new Error("AgentRun cancellation is unauthorized.")),
    });
    render(<Harness client={client} parentThreadId={parentThreadId} />);
    await waitFor(() => expect(screen.getByLabelText("stoppable")).toHaveTextContent("a,b"));

    await user.click(screen.getByRole("button", { name: "stop" }));

    await waitFor(() =>
      expect(screen.getByLabelText("error")).toHaveTextContent(
        "Child runs could not be stopped. They are still running.",
      ),
    );
    expect(screen.getByLabelText("stopped")).toHaveTextContent("failed");
  });

  it("says the runs are still running when the cancel fails", async () => {
    const user = userEvent.setup();
    const client = stubClient({ cancel: vi.fn().mockRejectedValue(new Error("denied")) });
    render(<Harness client={client} parentThreadId={parentThreadId} />);
    await waitFor(() => expect(screen.getByLabelText("stoppable")).toHaveTextContent("a,b"));

    await user.click(screen.getByRole("button", { name: "stop" }));

    await waitFor(() =>
      expect(screen.getByLabelText("error")).toHaveTextContent(
        "Child runs could not be stopped. They are still running.",
      ),
    );
  });

  it("keeps the last server-authored status and says it is stale on a failed read", async () => {
    const client = stubClient({ parentSummary: vi.fn().mockRejectedValue(new Error("offline")) });
    render(<Harness client={client} parentThreadId={parentThreadId} />);

    await waitFor(() => expect(screen.getByLabelText("reconnecting")).toHaveTextContent("stale"));
    expect(screen.getByLabelText("label")).toHaveTextContent("No child runs · Idle");
  });

  it("drops the previous thread's children the moment the parent thread changes", async () => {
    const user = userEvent.setup();
    const otherThreadId = "00000000-0000-4000-8000-000000000002" as AgentRunParentThreadId;
    // The second thread's read never settles, which is exactly the window in
    // which the chrome used to keep showing — and stopping — the first
    // thread's runs.
    const client = stubClient({
      parentSummary: vi.fn().mockImplementation((thread: AgentRunParentThreadId) =>
        thread === parentThreadId
          ? Promise.resolve({
              parentThreadId,
              entries: [summaryEntry("a", "running"), summaryEntry("b", "running")],
            })
          : new Promise(() => {}),
      ),
    });
    const view = render(<Harness client={client} parentThreadId={parentThreadId} />);
    await waitFor(() => expect(screen.getByLabelText("stoppable")).toHaveTextContent("a,b"));

    view.rerender(<Harness client={client} parentThreadId={otherThreadId} />);

    // Immediately: no await, because a user can act on the very first frame
    // the new thread is shown.
    expect(screen.getByLabelText("entries")).toBeEmptyDOMElement();
    expect(screen.getByLabelText("stoppable")).toBeEmptyDOMElement();
    // Still resolving is not the same claim as "this thread has no children".
    expect(screen.getByLabelText("status")).toHaveTextContent("loading");

    await user.click(screen.getByRole("button", { name: "stop" }));

    expect(client.cancel).not.toHaveBeenCalled();
  });

  it("shows nothing from the previous thread when the new parent's read fails", async () => {
    const otherThreadId = "00000000-0000-4000-8000-000000000002" as AgentRunParentThreadId;
    const client = stubClient({
      parentSummary: vi
        .fn()
        .mockImplementation((thread: AgentRunParentThreadId) =>
          thread === parentThreadId
            ? Promise.resolve({ parentThreadId, entries: [summaryEntry("a", "running")] })
            : Promise.reject(new Error("offline")),
        ),
    });
    const view = render(<Harness client={client} parentThreadId={parentThreadId} />);
    await waitFor(() => expect(screen.getByLabelText("stoppable")).toHaveTextContent("a"));

    view.rerender(<Harness client={client} parentThreadId={otherThreadId} />);

    await waitFor(() => expect(screen.getByLabelText("reconnecting")).toHaveTextContent("stale"));
    expect(screen.getByLabelText("entries")).toBeEmptyDOMElement();
    expect(screen.getByLabelText("stoppable")).toBeEmptyDOMElement();
  });

  it("does not carry a failed stop's message onto the next thread", async () => {
    const user = userEvent.setup();
    const otherThreadId = "00000000-0000-4000-8000-000000000002" as AgentRunParentThreadId;
    const client = stubClient({ cancel: vi.fn().mockRejectedValue(new Error("denied")) });
    const view = render(<Harness client={client} parentThreadId={parentThreadId} />);
    await waitFor(() => expect(screen.getByLabelText("stoppable")).toHaveTextContent("a,b"));
    await user.click(screen.getByRole("button", { name: "stop" }));
    await waitFor(() =>
      expect(screen.getByLabelText("error")).toHaveTextContent(
        "Child runs could not be stopped. They are still running.",
      ),
    );

    view.rerender(<Harness client={client} parentThreadId={otherThreadId} />);

    // "They are still running" is a claim about the thread the user left.
    expect(screen.getByLabelText("error")).toHaveTextContent("none");
  });

  it("offers nothing to stop when no client is reachable", async () => {
    function NoClient() {
      const status = useChildRunStatus({ parentThreadId });
      return <output aria-label="stoppable">{status.summary.stoppableRunIds.length}</output>;
    }
    render(<NoClient />);

    await waitFor(() => expect(screen.getByLabelText("stoppable")).toHaveTextContent("0"));
  });
});
