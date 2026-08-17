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

  it("unstages only the selected paths the checkout reports as staged", async () => {
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

    // Selecting a change that is not in the index leaves nothing to unstage.
    fireEvent.click(screen.getByRole("checkbox", { name: "Select src/changed.ts" }));
    expect(screen.getByRole("button", { name: "Unstage 0 paths" })).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: "Select src/staged.ts" }));
    fireEvent.click(screen.getByRole("button", { name: "Unstage 1 path" }));
    await waitFor(() =>
      expect(client.executeOperation).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "unstage-git", paths: ["src/staged.ts"] }),
      ),
    );
  });

  it("sends both halves of a staged rename so the rename cannot half-apply", async () => {
    const client = codeClient();
    const renamed: typeof gitObservation = {
      ...gitObservation,
      status: [
        { path: "src/new.ts", originalPath: "src/old.ts", index: "R", worktree: " " },
      ] as unknown as typeof gitObservation.status,
    };
    render(
      <CodeGitPane
        client={client}
        createGitOperationId={() => ids.git as never}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        observation={renamed}
        scope={scope}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Select src/new.ts" }));
    fireEvent.click(screen.getByRole("button", { name: "Unstage 2 paths" }));
    await waitFor(() =>
      expect(client.executeOperation).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "unstage-git", paths: ["src/new.ts", "src/old.ts"] }),
      ),
    );
  });

  it("asks before discarding and sends nothing if the answer is to keep the changes", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Discard 1 path" }));
    expect(client.executeOperation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Keep changes" }));
    expect(client.executeOperation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Discard 1 path" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() =>
      expect(client.executeOperation).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "discard-git-changes", paths: ["src/changed.ts"] }),
      ),
    );
  });

  it("fills the commit message from a provider draft the user can still edit", async () => {
    const client = codeClient();
    (client.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "git-draft-state",
      operationId: ids.operation,
      purpose: "commit-message",
      state: "completed",
      title: "Add the unstage button",
      body: "The index was the only way back.",
    });
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

    fireEvent.click(screen.getByRole("button", { name: "Suggest commit message" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Commit message")).toHaveValue(
        "Add the unstage button\n\nThe index was the only way back.",
      ),
    );
    expect(client.executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "draft-git-text", purpose: "commit-message" }),
    );
  });

  it("says so rather than inventing a message when the provider drafts nothing", async () => {
    const client = codeClient();
    (client.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "git-draft-state",
      operationId: ids.operation,
      purpose: "commit-message",
      state: "unavailable",
    });
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

    fireEvent.click(screen.getByRole("button", { name: "Suggest commit message" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Write one yourself/i);
    expect(screen.getByLabelText("Commit message")).toHaveValue("");
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
