import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChildRunRequests, type ChildRunInteractionsClient } from "./ChildRunRequests";
import type { AgentHierarchyInputEntry } from "./buildAgentHierarchyModel";

const threadId = "11111111-1111-4111-8111-111111111111";
const runId = "90000000-0000-4000-8000-000000000001";
const entries: ReadonlyArray<AgentHierarchyInputEntry> = [
  {
    runId,
    role: "research",
    task: "Inspect parser",
    lifecycleStatus: "running",
    executionKind: "octant-managed",
    usageQuality: "unavailable",
    resultAcknowledgement: { required: false, acknowledged: false },
    version: 1,
    updatedAt: "2026-11-06T12:00:00Z",
  },
];
const source = {
  runId,
  providerInstanceId: "worker-account",
  providerName: "Worker",
  modelId: "large",
  targetFolder: "/checkout/child",
};
const approval = {
  id: "approval-1",
  status: "pending",
  source,
  toolName: "shell",
  summary: "Run parser tests",
  approvalClass: "shell",
  singleUse: true,
};
const question = {
  id: "question-1",
  status: "pending",
  source,
  prompt: "Which parser?",
  options: ["Strict", "Loose"],
};

function client() {
  let approvals = [approval];
  let questions = [question];
  const session = vi.fn(
    async () => ({ session: { status: "running" }, approvals, questions }) as never,
  );
  const decideApproval = vi.fn(async () => {
    approvals = [];
    return { kind: "approval-decided", approval: { ...approval, status: "approved" } } as never;
  });
  const answerQuestion = vi.fn(async () => {
    questions = [];
    return { kind: "question-answered", question: { ...question, status: "answered" } } as never;
  });
  return { session, decideApproval, answerQuestion } satisfies ChildRunInteractionsClient;
}

describe("answering a child beside its parent", () => {
  it("answers only the selected authoritative child request through the existing route", async () => {
    const api = client();
    render(
      <ChildRunRequests client={api} threadId={threadId} entries={entries} disconnected={false} />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(api.decideApproval).toHaveBeenCalledExactlyOnceWith(threadId, {
      approvalId: "approval-1",
      decision: "approve",
    });
    expect(
      screen.queryByRole("button", { name: "Allow for this session" }),
    ).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("radio", { name: "Strict" }));
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(api.answerQuestion).toHaveBeenCalledExactlyOnceWith(threadId, {
      questionId: "question-1",
      answer: "Strict",
    });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Child requests" })).not.toBeInTheDocument(),
    );
  });

  it("retains a failed answer for retry only while the same request remains pending", async () => {
    const api = client();
    api.decideApproval.mockRejectedValueOnce(new Error("offline"));
    render(
      <ChildRunRequests client={api} threadId={threadId} entries={entries} disconnected={false} />,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("response could not be confirmed");
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(api.decideApproval).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument(),
    );
  });

  it("disables a retained request on disconnect and clears it immediately on thread change", async () => {
    const api = client();
    const ui = render(
      <ChildRunRequests client={api} threadId={threadId} entries={entries} disconnected={false} />,
    );
    expect(await screen.findByText("Connection: worker-account · /checkout/child")).toBeVisible();
    ui.rerender(
      <ChildRunRequests client={api} threadId={threadId} entries={entries} disconnected />,
    );
    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(api.decideApproval).not.toHaveBeenCalled();
    ui.rerender(
      <ChildRunRequests client={api} threadId="another-thread" entries={[]} disconnected={false} />,
    );
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
  });
});
