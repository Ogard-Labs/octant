import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeOperationResult } from "@octant/contracts/code-operations";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MonacoDiffRuntime } from "./MonacoEditorAdapter";
import { CodeDiffPane, type CodeDiffProjection } from "./CodeDiffPane";

const DIFF = [
  "diff --git a/src/index.ts b/src/index.ts",
  "--- a/src/index.ts",
  "+++ b/src/index.ts",
  "@@ -12,2 +12,2 @@",
  "-const answer = 41;",
  "+const answer = 42;",
  " export { answer };",
  "diff --git a/README.md b/README.md",
  "--- /dev/null",
  "+++ b/README.md",
  "@@ -0,0 +1 @@",
  "+Octant",
  "",
].join("\n");

describe("CodeDiffPane", () => {
  it("loads exact Git evidence and compares one changed file at a time", async () => {
    const code = client();
    const fixture = runtime();
    render(<CodeDiffPane client={code} diff={available()} loadRuntime={fixture.loadRuntime} />);

    expect(await screen.findByRole("heading", { name: "Local changes" })).toBeVisible();
    expect(code.operationContent).toHaveBeenCalledWith(ids.thread, ids.operation, ids.content);
    expect(code.content).not.toHaveBeenCalled();

    // Both sides come from the host's own diff evidence; nothing is refetched.
    await waitFor(() =>
      expect(fixture.options?.original).toBe("const answer = 41;\nexport { answer };"),
    );
    expect(fixture.options?.modified).toBe("const answer = 42;\nexport { answer };");
    expect(fixture.options?.modelUriBase).toContain(
      `octant-code://${ids.checkout}/diff/${ids.content}`,
    );
    expect(fixture.options?.modelUriBase).not.toContain("/Users/");
    expect(screen.queryByText(/incomplete/i)).not.toBeInTheDocument();
  });

  it("lists every changed file with its change kind and line counts", async () => {
    render(
      <CodeDiffPane client={client()} diff={available()} loadRuntime={runtime().loadRuntime} />,
    );

    const files = await screen.findByRole("navigation", { name: "Changed files" });
    const entries = within(files).getAllByRole("button");
    expect(entries.map((entry) => entry.textContent)).toEqual([
      "src/index.tsmodified+1−1",
      "README.mdadded+1−0",
    ]);
    expect(entries[0]).toHaveAttribute("aria-current", "true");
  });

  it("switches the comparison to the file the user selects", async () => {
    const user = userEvent.setup();
    const fixture = runtime();
    render(<CodeDiffPane client={client()} diff={available()} loadRuntime={fixture.loadRuntime} />);

    await user.click(await screen.findByRole("button", { name: /README\.md/ }));
    await waitFor(() => expect(fixture.options?.modified).toBe("Octant"));
    expect(fixture.options?.original).toBe("");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("README.md");
  });

  it("toggles between side-by-side and inline layout", async () => {
    const user = userEvent.setup();
    const fixture = runtime();
    render(<CodeDiffPane client={client()} diff={available()} loadRuntime={fixture.loadRuntime} />);

    await waitFor(() => expect(fixture.options?.renderSideBySide).toBe(true));
    await user.click(screen.getByRole("button", { name: "Inline" }));
    expect(fixture.session?.setRenderSideBySide).toHaveBeenCalledWith(false);
    expect(screen.getByRole("button", { name: "Inline" })).toHaveAttribute("aria-pressed", "true");
  });

  it("hands the selected file to the editor", async () => {
    const user = userEvent.setup();
    const onOpenFile = vi.fn();
    render(
      <CodeDiffPane
        client={client()}
        diff={available()}
        loadRuntime={runtime().loadRuntime}
        onOpenFile={onOpenFile}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Open in editor" }));
    expect(onOpenFile).toHaveBeenCalledWith("src/index.ts");
  });

  it("offers no editor handoff when no editor is bound", async () => {
    render(
      <CodeDiffPane client={client()} diff={available()} loadRuntime={runtime().loadRuntime} />,
    );
    expect(await screen.findByRole("heading", { name: "Local changes" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Open in editor" })).not.toBeInTheDocument();
  });

  it("marks truncated diff evidence as visibly incomplete", async () => {
    render(<CodeDiffPane client={client()} diff={available(true)} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This diff is truncated and is not complete",
    );
    expect(screen.getByText("2,048 bytes retained")).toBeVisible();
  });

  it.each([
    [{ state: "loading" }, "Loading Git diff…"],
    [{ state: "stale", message: "Git state changed; refresh the diff." }, "Git state changed"],
    [{ state: "unavailable", message: "Git observation is unavailable." }, "unavailable"],
  ] as const)("renders purposeful $state state", (diff, message) => {
    const code = client();
    render(<CodeDiffPane client={code} diff={diff as CodeDiffProjection} />);
    expect(screen.getByText(new RegExp(message, "i"))).toBeVisible();
    expect(code.content).not.toHaveBeenCalled();
  });

  it("rejects non-text diff evidence without mounting Monaco", async () => {
    const fixture = runtime();
    render(
      <CodeDiffPane
        client={client({ bytes: new Uint8Array([0xff]) })}
        diff={available()}
        loadRuntime={fixture.loadRuntime}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("valid UTF-8");
    expect(fixture.loadRuntime).not.toHaveBeenCalled();
  });

  it("discards a tracked file only after confirmation and an approval receipt", async () => {
    const user = userEvent.setup();
    const code = client();
    const executeOperation = vi.fn(async () => ({
      kind: "git-mutation-state" as const,
      state: "completed" as const,
    }));
    const requestApproval = vi.fn(async () => "40000000-0000-4000-8000-000000000009" as never);
    render(
      <CodeDiffPane
        client={{ ...code, executeOperation } as never}
        createGitOperationId={() => ids.git as never}
        createOperationId={() => ids.operation as never}
        diff={available()}
        executionPolicy="approval-gated"
        loadRuntime={runtime().loadRuntime}
        requestApproval={requestApproval}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Discard changes" }));
    // Nothing happens on the first click: the change is gone for good, so the
    // pane asks before it asks the host.
    expect(executeOperation).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Discard permanently" }));

    const command = {
      kind: "discard-git-changes",
      operationId: ids.operation,
      gitOperationId: ids.git,
      paths: ["src/index.ts"],
      expectedStateToken: "b".repeat(64),
      threadId: ids.thread,
      checkoutId: ids.checkout,
    };
    expect(requestApproval).toHaveBeenCalledWith(command);
    expect(executeOperation).toHaveBeenCalledWith(command);
    expect(await screen.findByText("Discarded uncommitted changes to src/index.ts.")).toBeVisible();
  });

  it("keeps the file when the approval is refused", async () => {
    const user = userEvent.setup();
    const executeOperation = vi.fn();
    render(
      <CodeDiffPane
        client={{ ...client(), executeOperation } as never}
        createGitOperationId={() => ids.git as never}
        createOperationId={() => ids.operation as never}
        diff={available()}
        executionPolicy="approval-gated"
        loadRuntime={runtime().loadRuntime}
        requestApproval={vi.fn(async () => undefined)}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Discard changes" }));
    await user.click(screen.getByRole("button", { name: "Discard permanently" }));

    expect(executeOperation).not.toHaveBeenCalled();
    expect(
      await screen.findByText("src/index.ts was not discarded. The change is untouched."),
    ).toBeVisible();
  });

  it("shows a compact clean state rather than an empty comparison", () => {
    const code = client();
    render(<CodeDiffPane client={code} diff={clean()} />);
    expect(screen.getByRole("heading", { name: "Checkout is clean" })).toBeVisible();
    expect(screen.getByText("This checkout has no local changes to review.")).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Changed files" })).not.toBeInTheDocument();
    expect(code.operationContent).not.toHaveBeenCalled();
  });

  it("compares a run against its base without offering checkout discard", async () => {
    render(
      <CodeDiffPane
        client={client()}
        createGitOperationId={() => ids.git as never}
        createOperationId={() => ids.operation as never}
        diff={runReviewed()}
        executionPolicy="full-access"
        loadRuntime={runtime().loadRuntime}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Changes vs origin/development" }),
    ).toBeVisible();
    expect(await screen.findByRole("navigation", { name: "Changed files" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Discard changes" })).not.toBeInTheDocument();
  });

  it("keeps the current comparison when Git state has moved and offers a refresh", async () => {
    const onRefresh = vi.fn();
    render(
      <CodeDiffPane
        client={client()}
        diff={available()}
        loadRuntime={runtime().loadRuntime}
        staleNotice={{ message: "Git state changed; refresh the diff.", onRefresh }}
      />,
    );

    expect(await screen.findByRole("navigation", { name: "Changed files" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Git state changed; refresh the diff.");
    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("offers no discard for Plan mode, for an untracked file, or without a way to approve", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <CodeDiffPane
        client={client()}
        createGitOperationId={() => ids.git as never}
        createOperationId={() => ids.operation as never}
        diff={available()}
        executionPolicy="plan"
        loadRuntime={runtime().loadRuntime}
      />,
    );
    expect(await screen.findByRole("heading", { name: "src/index.ts" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Discard changes" })).not.toBeInTheDocument();

    // Approval-gated with no approval path: the control would only fail later.
    rerender(
      <CodeDiffPane
        client={client()}
        createGitOperationId={() => ids.git as never}
        createOperationId={() => ids.operation as never}
        diff={available()}
        executionPolicy="approval-gated"
        loadRuntime={runtime().loadRuntime}
      />,
    );
    expect(await screen.findByRole("heading", { name: "src/index.ts" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Discard changes" })).not.toBeInTheDocument();

    // Full access can discard, but an untracked file has nothing to restore.
    rerender(
      <CodeDiffPane
        client={client()}
        createGitOperationId={() => ids.git as never}
        createOperationId={() => ids.operation as never}
        diff={available()}
        executionPolicy="full-access"
        loadRuntime={runtime().loadRuntime}
      />,
    );
    expect(await screen.findByRole("button", { name: "Discard changes" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "README.mdadded+1−0" }));
    expect(screen.queryByRole("button", { name: "Discard changes" })).not.toBeInTheDocument();
  });
});

const ids = {
  checkout: "20000000-0000-4000-8000-000000000001",
  content: "20000000-0000-4000-8000-000000000002",
  git: "20000000-0000-4000-8000-000000000003",
  operation: "20000000-0000-4000-8000-000000000004",
  thread: "20000000-0000-4000-8000-000000000005",
} as const;

function clean(): Extract<CodeDiffProjection, { readonly state: "available" }> {
  const dirty = available();
  return {
    ...dirty,
    observation: {
      ...dirty.observation,
      status: [],
      changedPaths: [],
    },
  };
}

function runReviewed(): Extract<CodeDiffProjection, { readonly state: "run" }> {
  return {
    state: "run",
    checkoutId: ids.checkout as never,
    threadId: ids.thread as never,
    run: {
      kind: "run-reviewed",
      operationId: ids.operation,
      gitOperationId: ids.git,
      outcome: {
        branch: "feature/editor",
        baseRef: "origin/development",
        head: "a".repeat(40),
        ahead: 2,
        behind: 0,
        changedPaths: ["src/index.ts", "README.md"],
        diff: {
          contentId: ids.content,
          digest: "c".repeat(64),
          byteLength: 2_048,
        },
        uncommittedPaths: [],
        mergeability: "clean",
      },
    } as never,
  };
}

function available(
  truncated = false,
): Extract<CodeDiffProjection, { readonly state: "available" }> {
  return {
    state: "available",
    checkoutId: ids.checkout as never,
    threadId: ids.thread as never,
    observation: {
      kind: "git-observed",
      operationId: ids.operation,
      gitOperationId: ids.git,
      head: { kind: "branch", name: "feature/editor", oid: "a".repeat(40) },
      stateToken: "b".repeat(64),
      status: [
        { path: "src/index.ts", index: " ", worktree: "M" },
        { path: "README.md", index: "?", worktree: "?" },
      ],
      changedPaths: ["src/index.ts", "README.md"],
      diff: {
        contentId: ids.content,
        digest: "c".repeat(64),
        byteLength: 2_048,
        ...(truncated ? { truncated: true } : {}),
      },
      remotes: [],
      upstream: null,
      worktrees: [],
    } as unknown as CodeOperationResult & { readonly kind: "git-observed" },
  };
}

function client(options: { readonly bytes?: Uint8Array } = {}): CodeClient {
  return {
    bootstrap: vi.fn(),
    queryBoard: vi.fn(),
    conversation: vi.fn(async (threadId) => ({
      version: 3 as const,
      threadId,
      turns: [],
      nextCursor: 0,
      hasMore: false,
    })),
    content: vi.fn(async () => options.bytes ?? new TextEncoder().encode(DIFF)),
    operationContent: vi.fn(async () => options.bytes ?? new TextEncoder().encode(DIFF)),
    execute: vi.fn(),
    executeOperation: vi.fn(),
    inspectTerminal: vi.fn(),
    putAttachment: vi.fn(),
    discardAttachment: vi.fn(),
    attachment: vi.fn(),
    putEvidence: vi.fn(),
    save: vi.fn(),
    subscribe: vi.fn(),
    subscribeOperation: vi.fn(),
    thread: vi.fn(),
    readFollowUp: vi.fn(async (threadId) => ({ threadId, followUpVersion: 0 }) as never),
    executeFollowUp: vi.fn(),
    openFile: vi.fn(),
  };
}

function runtime() {
  let options: Parameters<MonacoDiffRuntime["mountDiff"]>[1] | undefined;
  let session: ReturnType<MonacoDiffRuntime["mountDiff"]> | undefined;
  const loadRuntime = vi.fn(
    async (): Promise<MonacoDiffRuntime> => ({
      mountDiff: (_element, value) => {
        options = value;
        session = {
          dispose: vi.fn(),
          setRenderSideBySide: vi.fn(),
          setTypography: vi.fn(),
          setValues: vi.fn(),
        };
        return session;
      },
    }),
  );
  return {
    loadRuntime,
    get options() {
      return options;
    },
    get session() {
      return session;
    },
  };
}
