import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeGitPane } from "./CodeGitPane";
import { codeClient, gitObservation, ids, scope } from "./CodeDeliveryPane.test-fixtures";

describe("CodeGitPane", () => {
  it("shows exact status and sends only explicitly selected stage paths", async () => {
    const client = codeClient();
    render(
      <CodeGitPane
        client={client}
        createGitOperationId={() => ids.git as never}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        observation={gitObservation}
        scope={scope}
      />,
    );

    expect(screen.getByText("feature/delivery")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select src/changed.ts" }));
    fireEvent.click(screen.getByRole("button", { name: "Stage 1 path" }));
    await waitFor(() =>
      expect(client.executeOperation).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "stage-git", paths: ["src/changed.ts"] }),
      ),
    );
  });

  it("has no active mutation controls in Plan and prompts before approval-gated staging", async () => {
    const client = codeClient();
    const requestApproval = vi.fn(async () => ids.approval as never);
    const { rerender } = render(
      <CodeGitPane
        client={client}
        createGitOperationId={() => ids.git as never}
        createOperationId={() => ids.operation as never}
        executionPolicy="plan"
        observation={gitObservation}
        scope={scope}
      />,
    );
    expect(screen.queryByRole("button", { name: /stage|commit|push/i })).not.toBeInTheDocument();

    rerender(
      <CodeGitPane
        client={client}
        createGitOperationId={() => ids.git as never}
        createOperationId={() => ids.operation as never}
        executionPolicy="approval-gated"
        observation={gitObservation}
        requestApproval={requestApproval}
        scope={scope}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select src/changed.ts" }));
    fireEvent.click(screen.getByRole("button", { name: "Stage 1 path" }));
    await waitFor(() =>
      expect(requestApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "stage-git",
          operationId: ids.operation,
          paths: ["src/changed.ts"],
        }),
      ),
    );
    expect(requestApproval.mock.invocationCallOrder[0]).toBeLessThan(
      (client.executeOperation as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
    );
  });

  it("uses the exact approval identity for approval-gated push", async () => {
    const client = codeClient();
    render(
      <CodeGitPane
        client={client}
        createGitOperationId={() => ids.git as never}
        createOperationId={() => ids.operation as never}
        executionPolicy="approval-gated"
        observation={gitObservation}
        requestApproval={vi.fn(async () => ids.approval as never)}
        scope={scope}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Push exact branch" }));
    await waitFor(() =>
      expect(client.executeOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "push-git",
          authorization: { kind: "approved", approvalId: ids.approval },
        }),
      ),
    );
  });

  it("commits only the exact observed staged summary", async () => {
    const client = codeClient();
    render(
      <CodeGitPane
        client={client}
        createGitOperationId={() => ids.git as never}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        observation={gitObservation}
        scope={scope}
      />,
    );
    fireEvent.change(screen.getByLabelText("Commit message"), {
      target: { value: "feat: deliver panes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit 1 staged path" }));
    await waitFor(() =>
      expect(client.executeOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "commit-git",
          message: "feat: deliver panes",
          stagedSummary: [{ path: "src/staged.ts", index: "M", worktree: " " }],
        }),
      ),
    );
  });

  it("renders an actionable Git command failure", async () => {
    const client = codeClient();
    (client.executeOperation as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("offline"));
    render(
      <CodeGitPane
        client={client}
        createGitOperationId={() => ids.git as never}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        observation={gitObservation}
        scope={scope}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select src/changed.ts" }));
    fireEvent.click(screen.getByRole("button", { name: "Stage 1 path" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Git command failed/i);
  });

  it("exposes a pull-request review entry point when navigation is available", () => {
    const onReviewPullRequest = vi.fn();
    const { rerender } = render(
      <CodeGitPane
        client={codeClient()}
        createGitOperationId={() => ids.git as never}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        observation={gitObservation}
        scope={scope}
      />,
    );
    expect(screen.queryByRole("button", { name: "Review pull request" })).not.toBeInTheDocument();

    rerender(
      <CodeGitPane
        client={codeClient()}
        createGitOperationId={() => ids.git as never}
        createOperationId={() => ids.operation as never}
        executionPolicy="plan"
        observation={gitObservation}
        onReviewPullRequest={onReviewPullRequest}
        scope={scope}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review pull request" }));
    expect(onReviewPullRequest).toHaveBeenCalledOnce();
  });

  it("distinguishes accepted Git work from authoritative completion", async () => {
    const client = codeClient();
    render(
      <CodeGitPane
        client={client}
        createGitOperationId={() => ids.git as never}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        observation={gitObservation}
        scope={scope}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select src/changed.ts" }));
    fireEvent.click(screen.getByRole("button", { name: "Stage 1 path" }));

    expect(await screen.findByRole("status")).toHaveTextContent(/stage requested.*refresh/i);
    expect(screen.queryByText(/stage completed/i)).not.toBeInTheDocument();
  });
});
