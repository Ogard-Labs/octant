import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CodePullRequestReview } from "@octant/contracts/code-operations";
import { describe, expect, it, vi } from "vitest";
import { CodePullRequestPane } from "./CodePullRequestPane";
import { codeClient, ids, scope } from "./CodeDeliveryPane.test-fixtures";

function observedReview(
  overrides: Partial<Extract<CodePullRequestReview, { state: "observed" }>> = {},
): CodePullRequestReview {
  return {
    kind: "pull-request-review",
    operationId: ids.operation,
    state: "observed",
    freshness: "fresh",
    ambiguous: false,
    staleSections: [],
    number: 182,
    url: "https://github.com/octant/octant/pull/182",
    title: "Deliver Code panes",
    pullRequestState: "open",
    baseRepository: "octant/octant",
    baseBranch: "development",
    headRepository: "octocat",
    headBranch: "feature/delivery",
    author: "octocat",
    matchesDeliveryBranch: true,
    description: { contentId: ids.content, digest: "c".repeat(64), byteLength: 128 },
    diff: { contentId: ids.content, digest: "c".repeat(64), byteLength: 128 },
    commits: [{ oid: "a".repeat(40), messageHeadline: "feat: deliver panes", author: "octocat" }],
    files: [{ path: "apps/web/src/code/CodePullRequestPane.tsx", additions: 12, deletions: 3 }],
    checks: [{ name: "web tests", state: "failure" }],
    reviews: [{ author: "reviewer", state: "changes-requested", body: "Tighten the guardrail." }],
    comments: [{ author: "octocat", body: "Ready for review." }],
    ...overrides,
  } as CodePullRequestReview;
}

describe("CodePullRequestPane", () => {
  it("creates with a stable idempotency key and renders retry-safe existing metadata", async () => {
    const client = codeClient();
    client.executeOperation = vi.fn(
      async () =>
        ({
          kind: "pull-request-state",
          operationId: ids.operation,
          state: "existing",
          number: 182,
          url: "https://github.com/octant/octant/pull/182",
          headRepository: "octant/octant",
          headBranch: "feature/delivery",
          baseRepository: "octant/octant",
          baseBranch: "development",
        }) as never,
    );
    render(
      <CodePullRequestPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        idempotencyKey="thread-delivery-v1"
        scope={scope}
      />,
    );
    fireEvent.change(screen.getByLabelText("Pull request title"), {
      target: { value: "Deliver Code panes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));

    expect(await screen.findByRole("link", { name: "Open pull request #182" })).toHaveAttribute(
      "href",
      "https://github.com/octant/octant/pull/182",
    );
    expect(screen.getByText(/feature\/delivery → development/)).toBeVisible();
    expect(client.executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "create-pull-request",
        idempotencyKey: "thread-delivery-v1",
      }),
    );
  });

  it("keeps Plan metadata read-only", () => {
    render(
      <CodePullRequestPane
        client={codeClient()}
        createOperationId={() => ids.operation as never}
        executionPolicy="plan"
        idempotencyKey="thread-delivery-v1"
        scope={scope}
      />,
    );
    expect(screen.getByText(/Plan mode is read-only/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /create pull request/i })).not.toBeInTheDocument();
  });

  it("renders an actionable pull-request command failure", async () => {
    const client = codeClient();
    (client.executeOperation as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("offline"));
    render(
      <CodePullRequestPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        idempotencyKey="thread-delivery-v1"
        scope={scope}
      />,
    );
    fireEvent.change(screen.getByLabelText("Pull request title"), {
      target: { value: "Deliver Code panes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/pull request command failed/i);
  });

  it("renders the linked PR review window read-only with every observed section", async () => {
    const client = codeClient({ evidence: "Delivers the review window." });
    const onNavigateWorktree = vi.fn();
    const onNavigateThread = vi.fn();
    render(
      <CodePullRequestPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        idempotencyKey="thread-delivery-v1"
        onNavigateThread={onNavigateThread}
        onNavigateWorktree={onNavigateWorktree}
        review={observedReview()}
        scope={scope}
      />,
    );

    expect(screen.getByRole("heading", { name: "Deliver Code panes" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Open on GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/octant/octant/pull/182",
    );
    expect(screen.getByText("feat: deliver panes")).toBeVisible();
    expect(screen.getByText("apps/web/src/code/CodePullRequestPane.tsx")).toBeVisible();
    expect(screen.getByText("Failing")).toBeVisible();
    expect(screen.getByText("Tighten the guardrail.")).toBeVisible();
    expect(screen.getByText("Ready for review.")).toBeVisible();
    expect(await screen.findAllByText("Delivers the review window.")).not.toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Go to worktree" }));
    fireEvent.click(screen.getByRole("button", { name: "Go to thread" }));
    expect(onNavigateWorktree).toHaveBeenCalledOnce();
    expect(onNavigateThread).toHaveBeenCalledOnce();

    expect(
      screen.queryByRole("button", { name: /merge|approve|request changes|comment|close/i }),
    ).not.toBeInTheDocument();
    expect(client.executeOperation).not.toHaveBeenCalled();
  });

  it("labels stale GitHub metadata and shows Waiting, never Done", () => {
    render(
      <CodePullRequestPane
        client={codeClient()}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        idempotencyKey="thread-delivery-v1"
        review={observedReview({
          freshness: "stale",
          ambiguous: true,
          staleSections: ["checks", "reviews"],
        })}
        scope={scope}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/Waiting on a fresh GitHub observation/i);
    expect(screen.getByText(/never marks delivery Done/i)).toBeVisible();
    expect(
      screen
        .getAllByRole("note")
        .some((node) => /checks could not be refreshed/i.test(node.textContent ?? "")),
    ).toBe(true);
  });

  it("offers creation when no pull request is linked", () => {
    render(
      <CodePullRequestPane
        client={codeClient()}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        idempotencyKey="thread-delivery-v1"
        review={{
          kind: "pull-request-review",
          operationId: ids.operation as never,
          state: "none",
          freshness: "fresh",
        }}
        scope={scope}
      />,
    );
    expect(screen.getByText(/No linked pull request yet/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Create pull request" })).toBeVisible();
  });

  it("fills the title and description from a provider draft without creating anything", async () => {
    const client = codeClient();
    (client.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "git-draft-state",
      operationId: ids.operation,
      purpose: "pull-request",
      state: "completed",
      title: "Deliver the Git pane controls",
      body: "Adds unstage, discard, and drafted delivery text.",
    });
    render(
      <CodePullRequestPane
        client={client}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        idempotencyKey="thread-delivery-v1"
        scope={scope}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Suggest title and description" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Pull request title")).toHaveValue(
        "Deliver the Git pane controls",
      ),
    );
    expect(screen.getByLabelText("Pull request body")).toHaveValue(
      "Adds unstage, discard, and drafted delivery text.",
    );
    expect(client.executeOperation).toHaveBeenCalledTimes(1);
    expect(client.executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "draft-git-text", purpose: "pull-request" }),
    );
  });
});
