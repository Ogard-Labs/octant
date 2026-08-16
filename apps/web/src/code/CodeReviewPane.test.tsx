import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CodeReviewFinding } from "@octant/contracts/code-operations";
import { describe, expect, it, vi } from "vitest";
import { CodeReviewPane, PullRequestConversation } from "./CodeReviewPane";
import { codeClient, ids, scope } from "./CodeDeliveryPane.test-fixtures";

describe("PullRequestConversation", () => {
  it("renders observed reviews and comments read-only with no mutation controls", () => {
    render(
      <PullRequestConversation
        comments={[{ author: "octocat", body: "Ready for review." }]}
        reviews={[
          { author: "reviewer", state: "changes-requested", body: "Tighten the guardrail." },
        ]}
      />,
    );
    expect(screen.getByText("reviewer")).toBeVisible();
    expect(screen.getByText("Changes requested")).toBeVisible();
    expect(screen.getByText("Tighten the guardrail.")).toBeVisible();
    expect(screen.getByText("Ready for review.")).toBeVisible();
    expect(
      screen.getByText(/approving, requesting changes, and commenting stay on GitHub/i),
    ).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("labels stale reviews and comments and reports empty sections", () => {
    render(<PullRequestConversation comments={[]} reviews={[]} staleComments staleReviews />);
    expect(screen.getByText("No reviews observed.")).toBeVisible();
    expect(screen.getByText("No comments observed.")).toBeVisible();
    expect(
      screen
        .getAllByRole("note")
        .filter((node) => /could not be refreshed/i.test(node.textContent ?? "")),
    ).toHaveLength(2);
  });
});

describe("CodeReviewPane", () => {
  it("creates durable local findings against exact file evidence", async () => {
    const client = codeClient();
    render(
      <CodeReviewPane
        client={client}
        createFindingId={() => ids.finding as never}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        findings={[]}
        scope={scope}
        target={{
          fileDigest: "d".repeat(64),
          fileId: ids.file as never,
          line: 14,
          path: "src/changed.ts" as never,
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Finding summary"), {
      target: { value: "Handle the failure before continuing." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add local finding" }));

    await waitFor(() =>
      expect(client.executeOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "create-review-finding",
          path: "src/changed.ts",
          location: { kind: "line", line: 14 },
        }),
      ),
    );
    expect(screen.getByText(/Local only/i)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /publish|approve|merge/i }),
    ).not.toBeInTheDocument();
  });

  it("renders findings read-only in Plan with no mutation controls", () => {
    render(
      <CodeReviewPane
        client={codeClient()}
        createFindingId={() => ids.finding as never}
        createOperationId={() => ids.operation as never}
        executionPolicy="plan"
        findings={[finding()]}
        scope={scope}
      />,
    );
    expect(screen.getByText("Handle the failure")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders an actionable local-review command failure", async () => {
    const client = codeClient();
    (client.executeOperation as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("offline"));
    render(
      <CodeReviewPane
        client={client}
        createFindingId={() => ids.finding as never}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        findings={[]}
        scope={scope}
        target={{
          fileDigest: "d".repeat(64),
          fileId: ids.file as never,
          line: 14,
          path: "src/changed.ts" as never,
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Finding summary"), {
      target: { value: "Handle the failure." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add local finding" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/review command failed/i);
  });

  it("adopts returned finding state without duplicating refreshed findings", async () => {
    const client = codeClient();
    const resolved = { ...finding(), state: "resolved", version: 2 } as never;
    (client.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "review-finding-state",
      operationId: ids.operation,
      finding: resolved,
    });
    const { rerender } = render(
      <CodeReviewPane
        client={client}
        createFindingId={() => ids.finding as never}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        findings={[finding()]}
        scope={scope}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(await screen.findByText(/resolved/)).toBeVisible();

    rerender(
      <CodeReviewPane
        client={client}
        createFindingId={() => ids.finding as never}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        findings={[resolved]}
        scope={scope}
      />,
    );
    expect(screen.getAllByText("Handle the failure")).toHaveLength(1);
  });
});

function finding(): CodeReviewFinding {
  const now = "2026-07-21T12:00:00.000Z" as never;
  return {
    id: ids.finding,
    threadId: ids.thread,
    checkoutId: ids.checkout,
    fileId: ids.file,
    path: "src/changed.ts",
    fileDigest: "d".repeat(64),
    location: { kind: "line", line: 14 },
    severity: "warning",
    author: { kind: "local-user", actorId: "local-user" },
    provenance: { kind: "manual" },
    summary: "Handle the failure",
    state: "open",
    version: 1,
    createdAt: now,
    updatedAt: now,
  } as never;
}
