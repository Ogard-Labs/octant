import type { PendingRequestClient } from "@octant/client-runtime/pending-request-client";
import type { PendingRequest } from "@octant/contracts/pending-requests";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { codeDecision, pendingIds } from "../palette/pendingRequests.test-fixtures";
import { ThreadConnectionLostContext } from "../transcript/ThreadConnectionNotice";
import {
  CoordinatorWorkerRequests,
  type CoordinatorWorker,
  type CoordinatorWorkerRequestSource,
} from "./CoordinatorWorkerRequests";

const requestedAt = new Date(Date.now() - 3 * 60_000).toISOString();

function approval(threadId: string, threadTitle: string, approvalId: string): PendingRequest {
  return {
    mode: "code",
    kind: "approval",
    projectId: "project-code",
    threadId,
    threadTitle,
    text: `Run: bun run test (${approvalId})`,
    requestedAt,
    answer: { threadId, checkoutId: "checkout-1", approvalId },
  } as unknown as PendingRequest;
}

const workerApproval = approval("worker-1", "Fix the parser", "approval-1");
const secondWorkerQuestion = {
  mode: "code",
  kind: "question",
  projectId: "project-code",
  threadId: "worker-2",
  threadTitle: "Write the docs",
  text: "Which page should change?",
  options: [{ label: "Guide" }, { label: "Reference" }],
  requestedAt,
  answer: { threadId: "worker-2", checkoutId: "checkout-2", requestId: "input-1" },
} as unknown as PendingRequest;
const unrelatedApproval = approval("other-thread", "Someone else's thread", "approval-9");

const workers: ReadonlyArray<CoordinatorWorker> = [
  { threadId: "worker-1", title: "Fix the parser" },
  { threadId: "worker-2", title: "Write the docs" },
];

function reader(...reads: ReadonlyArray<ReadonlyArray<PendingRequest>>): PendingRequestClient {
  let index = 0;
  return {
    list: vi.fn(async () => {
      const requests = reads[Math.min(index, reads.length - 1)] ?? [];
      index += 1;
      return { requests, truncated: false };
    }),
  };
}

function clients() {
  return {
    chatClient: { execute: vi.fn(async () => ({})) },
    codeClient: {
      executeOperation: vi.fn(async () => ({ kind: "operation-accepted" })),
      putEvidence: vi.fn(async () => ({ evidenceId: "evidence-1" })),
    },
    workRequestClient: { execute: vi.fn(async () => ({})) },
    workTurnClient: { startFirstTurn: vi.fn(async () => ({ kind: "accepted" })) },
  };
}

function source(
  pendingRequestClient: PendingRequestClient,
  answerClients: ReturnType<typeof clients>,
): CoordinatorWorkerRequestSource {
  return {
    pendingRequestClient,
    answerClients: answerClients as never,
    feedRevision: 0,
    settings: {},
    workspace: {},
    modes: ["code"],
  };
}

describe("a coordinator's composer listing its workers' requests", () => {
  it("names the worker, opens it, and answers its approval through the worker's own command", async () => {
    const user = userEvent.setup();
    const answerClients = clients();
    const onOpenWorker = vi.fn();
    render(
      <CoordinatorWorkerRequests
        source={source(reader([unrelatedApproval, workerApproval, codeDecision()]), answerClients)}
        workers={[...workers, { threadId: pendingIds.codeThread, title: "Decide the release" }]}
        onOpenWorker={onOpenWorker}
      />,
    );
    const region = await screen.findByRole("region", { name: "Worker requests" });
    expect(within(region).getByText("A worker needs your input")).toBeInTheDocument();
    expect(within(region).getByText("Fix the parser")).toBeInTheDocument();
    expect(within(region).getByText("Run: bun run test (approval-1)")).toBeInTheDocument();
    // Another thread's request and a finished turn's decision are not the worker waiting.
    expect(within(region).queryByText(/approval-9/)).toBeNull();
    expect(within(region).queryByRole("group", { name: "Pending worker requests" })).toBeNull();

    await user.click(within(region).getByRole("button", { name: "Open worker" }));
    expect(onOpenWorker).toHaveBeenCalledExactlyOnceWith({
      threadId: "worker-1",
      title: "Fix the parser",
    });

    await user.click(within(region).getByRole("button", { name: "Approve" }));
    expect(answerClients.codeClient.executeOperation).toHaveBeenCalledExactlyOnceWith({
      kind: "answer-provider-approval",
      operationId: expect.any(String),
      threadId: "worker-1",
      checkoutId: "checkout-1",
      approvalId: "approval-1",
      decision: "approved",
    });
  });

  it("keeps several workers' requests in one region, one at a time, each naming its worker", async () => {
    const user = userEvent.setup();
    const onOpenWorker = vi.fn();
    render(
      <CoordinatorWorkerRequests
        source={source(reader([workerApproval, secondWorkerQuestion]), clients())}
        workers={workers}
        onOpenWorker={onOpenWorker}
      />,
    );
    const choices = await screen.findByRole("group", { name: "Pending worker requests" });
    expect(screen.getAllByRole("region", { name: "Worker requests" })).toHaveLength(1);
    await user.click(within(choices).getByRole("button", { name: "Request 2" }));
    expect(screen.getByText("Which page should change?")).toBeInTheDocument();
    expect(screen.getByText("Write the docs")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open worker" }));
    expect(onOpenWorker).toHaveBeenCalledExactlyOnceWith({
      threadId: "worker-2",
      title: "Write the docs",
    });
  });

  it("shows the refusal when the worker's turn no longer takes the answer", async () => {
    const user = userEvent.setup();
    const answerClients = clients();
    answerClients.codeClient.executeOperation.mockResolvedValueOnce({
      kind: "provider-turn-state",
      operationId: "operation-1",
      state: "failed",
    } as never);
    const client = reader([workerApproval]);
    render(
      <CoordinatorWorkerRequests
        source={source(client, answerClients)}
        workers={workers}
        onOpenWorker={vi.fn()}
      />,
    );
    const region = await screen.findByRole("region", { name: "Worker requests" });
    await user.click(within(region).getByRole("button", { name: "Approve" }));
    expect(await within(region).findByRole("status")).toHaveTextContent(
      "The answer was not delivered. The turn changed since it asked.",
    );
    await waitFor(() => expect(client.list).toHaveBeenCalledTimes(2));
  });

  it("offers no answer while the thread's host connection is lost", async () => {
    const answerClients = clients();
    render(
      <ThreadConnectionLostContext.Provider value>
        <CoordinatorWorkerRequests
          source={source(reader([workerApproval]), answerClients)}
          workers={workers}
          onOpenWorker={vi.fn()}
        />
      </ThreadConnectionLostContext.Provider>,
    );
    const region = await screen.findByRole("region", { name: "Worker requests" });
    expect(within(region).getByText("Reconnect to answer this request.")).toBeInTheDocument();
    expect(within(region).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(region).getByRole("button", { name: "Open worker" })).toBeEnabled();
  });

  it("lists nothing when no worker is waiting", async () => {
    const client = reader([unrelatedApproval]);
    const { container } = render(
      <CoordinatorWorkerRequests
        source={source(client, clients())}
        workers={workers}
        onOpenWorker={vi.fn()}
      />,
    );
    await waitFor(() => expect(client.list).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
