import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CodePullRequestReview } from "@octant/contracts/code-operations";
import { BrowserAutomationClientFailure } from "@octant/client-runtime/browser-automation-client";
import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { BrowserThreadId } from "@octant/contracts";
import type { OctantHostBridge } from "../shell/hostBridge";
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

  it("explains when the checkout has no GitHub remote", async () => {
    const client = codeClient();
    client.executeOperation = vi.fn(
      async () =>
        ({
          kind: "pull-request-state",
          operationId: ids.operation,
          state: "unavailable",
          failureCode: "no-remote",
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

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This checkout has no GitHub remote, so there is nowhere to open a pull request. Add a GitHub remote to the repository, then retry.",
    );
  });

  it("explains a missing GitHub remote instead of blaming GitHub authentication", () => {
    render(
      <CodePullRequestPane
        client={codeClient()}
        createOperationId={() => ids.operation as never}
        executionPolicy="full-access"
        idempotencyKey="thread-delivery-v1"
        review={{
          kind: "pull-request-review",
          operationId: ids.operation as never,
          state: "unavailable",
          freshness: "stale",
          failureCode: "no-remote",
        }}
        scope={scope}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "This checkout has no GitHub remote, so there is no pull request to observe or open. Add a GitHub remote to the repository, then retry.",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(/GitHub authentication/i);
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

  describe("Browser proof choice", () => {
    const browserThread = "c1000000-0000-4000-8000-000000000001" as BrowserThreadId;
    const step = (number: number, overrides: Record<string, unknown> = {}) => ({
      stepId: `c3000000-0000-4000-8000-00000000000${number}`,
      threadId: browserThread,
      operation: "click",
      element: { role: "button", name: "Save" },
      origin: "https://example.com",
      path: "/settings",
      changed: "The page's text changed.",
      recordedAt: `2026-10-12T09:00:0${number}.000Z`,
      ...overrides,
    });
    const shot = {
      captureId: "c2000000-0000-4000-8000-000000000001",
      threadId: browserThread,
      origin: "https://example.com",
      url: "https://example.com/settings",
      hash: "a".repeat(64),
      size: 8,
      mime: "image/png",
      capturedAt: "2026-10-12T09:00:01.500Z",
    };

    function proofClient(
      steps: unknown[] = [step(1), step(2, { operation: "screenshot", captureId: shot.captureId })],
    ) {
      return {
        listSteps: vi.fn(async () => ({ steps })),
        listCaptures: vi.fn(async () => ({ captures: [shot] })),
        readCapture: vi.fn(async () => ({
          captureId: shot.captureId,
          dataUrl: "data:image/png;base64,AAAA",
        })),
      } as unknown as BrowserAutomationClient;
    }

    function renderPane(
      browser: BrowserAutomationClient,
      hostBridge?: OctantHostBridge,
      client = codeClient(),
    ) {
      client.executeOperation = vi.fn(async () => ({
        kind: "pull-request-state",
        operationId: ids.operation,
        state: "created",
        number: 7,
        url: "https://github.com/octant/octant/pull/7",
        headRepository: "octant/octant",
        headBranch: "feature/x",
        baseRepository: "octant/octant",
        baseBranch: "development",
      })) as never;
      render(
        <CodePullRequestPane
          browserProof={{ client: browser, threadId: browserThread, hostBridge }}
          client={client}
          createOperationId={() => ids.operation as never}
          executionPolicy="full-access"
          idempotencyKey="thread-delivery-v1"
          scope={scope}
        />,
      );
      fireEvent.change(screen.getByLabelText("Pull request title"), { target: { value: "T" } });
      fireEvent.change(screen.getByLabelText("Pull request body"), {
        target: { value: "What changed." },
      });
      return client;
    }

    it("is off by default and creates the pull request with the body as written", async () => {
      const browser = proofClient();
      const client = renderPane(browser);
      expect(screen.getByRole("checkbox", { name: "Include Browser proof" })).not.toBeChecked();
      fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));
      await waitFor(() => expect(client.executeOperation).toHaveBeenCalled());
      expect(client.executeOperation).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "create-pull-request", body: "What changed." }),
      );
      // Nothing was read from the Browser without the choice.
      expect(browser.listSteps).not.toHaveBeenCalled();
    });

    it("adds a Browser check section with the numbered steps only when chosen", async () => {
      const client = renderPane(proofClient());
      fireEvent.click(screen.getByRole("checkbox", { name: "Include Browser proof" }));
      expect(await screen.findByText(/Adds a “Browser check” section with 2 steps/)).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));
      await waitFor(() => expect(client.executeOperation).toHaveBeenCalled());
      const sent = vi.mocked(client.executeOperation).mock.calls.at(-1)?.[0] as { body: string };
      expect(sent.body).toContain("What changed.\n\n## Browser check\n");
      expect(sent.body).toContain('1. click button "Save" on https://example.com/settings');
      expect(sent.body).toContain("   - Screenshot: browser-check-01.png");
      // The section names files; no picture or data URL goes into the body.
      expect(sent.body).not.toContain("data:image");
    });

    it("offers Save screenshots only in the desktop app, and writes through its folder picker", async () => {
      const browser = proofClient();
      const saveBrowserProofScreenshots = vi.fn(async () => ({
        kind: "saved" as const,
        count: 1,
        folderName: "pr-7",
      }));
      renderPane(browser, { saveBrowserProofScreenshots } as unknown as OctantHostBridge);
      fireEvent.click(screen.getByRole("checkbox", { name: "Include Browser proof" }));
      fireEvent.click(await screen.findByRole("button", { name: "Save screenshots…" }));
      expect(await screen.findByText("Saved 1 screenshot to “pr-7”.")).toBeVisible();
      expect(saveBrowserProofScreenshots).toHaveBeenCalledWith([
        { fileNumber: 1, dataUrl: "data:image/png;base64,AAAA" },
      ]);
    });

    it("asks for another save when the captures changed after the files were saved", async () => {
      const browser = proofClient();
      const saveBrowserProofScreenshots = vi.fn(async () => ({
        kind: "saved" as const,
        count: 1,
        folderName: "pr-7",
      }));
      const client = renderPane(browser, {
        saveBrowserProofScreenshots,
      } as unknown as OctantHostBridge);
      fireEvent.click(screen.getByRole("checkbox", { name: "Include Browser proof" }));
      fireEvent.click(await screen.findByRole("button", { name: "Save screenshots…" }));
      await screen.findByText("Saved 1 screenshot to “pr-7”.");

      // A newer capture arrives before Create.
      const newer = {
        ...shot,
        captureId: "c2000000-0000-4000-8000-000000000002",
        capturedAt: "2026-10-12T09:00:09.000Z",
      };
      (browser.listCaptures as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
        captures: [shot, newer],
      });
      fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));
      expect(await screen.findByText(/changed since you saved them/)).toBeVisible();
      expect(client.executeOperation).not.toHaveBeenCalled();
    });

    it("offers no save without the desktop app's folder picker", async () => {
      renderPane(proofClient());
      fireEvent.click(screen.getByRole("checkbox", { name: "Include Browser proof" }));
      await screen.findByText(/Adds a “Browser check” section/);
      expect(screen.queryByRole("button", { name: "Save screenshots…" })).not.toBeInTheDocument();
    });

    it("says so, and creates nothing, when a window cannot read the proof", async () => {
      const browser = {
        listSteps: vi
          .fn()
          .mockRejectedValue(new BrowserAutomationClientFailure("unauthorized", "No.")),
        listCaptures: vi
          .fn()
          .mockRejectedValue(new BrowserAutomationClientFailure("unauthorized", "No.")),
      } as unknown as BrowserAutomationClient;
      const client = renderPane(browser);
      fireEvent.click(screen.getByRole("checkbox", { name: "Include Browser proof" }));
      expect(
        await screen.findByText(
          "Browser proof can be attached only from a window on this computer.",
        ),
      ).toBeVisible();
      fireEvent.click(screen.getByRole("button", { name: "Create pull request" }));
      await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
      expect(client.executeOperation).not.toHaveBeenCalled();
    });

    it("offers no choice on a host that keeps no Browser proof", () => {
      render(
        <CodePullRequestPane
          client={codeClient()}
          createOperationId={() => ids.operation as never}
          executionPolicy="full-access"
          idempotencyKey="thread-delivery-v1"
          scope={scope}
        />,
      );
      expect(
        screen.queryByRole("checkbox", { name: "Include Browser proof" }),
      ).not.toBeInTheDocument();
    });
  });
});
