import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeOperationResult } from "@octant/contracts/code-operations";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MonacoDiffRuntime } from "../code/MonacoEditorAdapter";
import type { CodeController } from "../code/useCodeController";
import { DockReviewTool } from "./DockReviewTool";

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

const RUN_DIFF = [
  "diff --git a/src/run.ts b/src/run.ts",
  "--- a/src/run.ts",
  "+++ b/src/run.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

describe("Review beside the active thread", () => {
  it("shows changed files, line counts, and the selected-file comparison", async () => {
    const fixture = runtime();
    render(<DockReviewTool {...bound()} loadRuntime={fixture.loadRuntime} />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading Git diff");
    const files = await screen.findByRole("navigation", { name: "Changed files" });
    expect(
      within(files)
        .getAllByRole("button")
        .map((entry) => entry.textContent),
    ).toEqual(["src/index.tsmodified+1−1", "README.mdadded+1−0"]);
    expect(screen.getByRole("heading", { name: "Local changes" })).toBeVisible();
    await waitFor(() =>
      expect(fixture.options?.original).toBe("const answer = 41;\nexport { answer };"),
    );
    expect(
      screen.queryByRole("heading", { name: "Review is unavailable" }),
    ).not.toBeInTheDocument();
  });

  it("toggles inline and side-by-side layouts", async () => {
    const user = userEvent.setup();
    const fixture = runtime();
    render(<DockReviewTool {...bound()} loadRuntime={fixture.loadRuntime} />);
    await screen.findByRole("navigation", { name: "Changed files" });
    await waitFor(() => expect(fixture.options?.renderSideBySide).toBe(true));
    await user.click(screen.getByRole("button", { name: "Inline" }));
    expect(fixture.session?.setRenderSideBySide).toHaveBeenCalledWith(false);
  });

  it("shows a compact clean state when the checkout and run have nothing to compare", async () => {
    render(
      <DockReviewTool
        {...bound({
          executeOperation: vi.fn(async (command) =>
            command.kind === "observe-git"
              ? cleanObservation(command.operationId)
              : failed(command),
          ),
        })}
      />,
    );
    expect(await screen.findByRole("heading", { name: "Checkout is clean" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Changed files" })).not.toBeInTheDocument();
  });

  it("reviews a finished run against its base when the worktree checkout is clean", async () => {
    render(
      <DockReviewTool
        {...bound({
          executeOperation: vi.fn(async (command) => {
            if (command.kind === "observe-git") return cleanObservation(command.operationId);
            if (command.kind === "review-run") return runReviewed(command.operationId);
            return failed(command);
          }),
          operationContent: vi.fn(async () => new TextEncoder().encode(RUN_DIFF)),
        })}
        loadRuntime={runtime().loadRuntime}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Changes vs origin/development" }),
    ).toBeVisible();
    expect(await screen.findByRole("button", { name: /src\/run\.ts/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Discard changes" })).not.toBeInTheDocument();
  });

  it("marks truncated checkout evidence as incomplete", async () => {
    render(
      <DockReviewTool
        {...bound({
          executeOperation: vi.fn(async (command) =>
            command.kind === "observe-git"
              ? dirtyObservation(command.operationId, true)
              : failed(command),
          ),
        })}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This diff is truncated and is not complete",
    );
  });

  it("states when Git observation is unavailable", async () => {
    render(
      <DockReviewTool
        {...bound({
          executeOperation: vi.fn(async () => {
            throw new Error("offline");
          }),
        })}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Git observation is unavailable");
  });

  it("clears the previous thread's files before the next checkout loads", async () => {
    const first = bound();
    const { rerender } = render(<DockReviewTool {...first} loadRuntime={runtime().loadRuntime} />);
    expect(await screen.findByRole("button", { name: /src\/index\.ts/ })).toBeVisible();

    let resolveNext: (value: CodeOperationResult) => void = () => undefined;
    const secondClient = {
      ...first.controller.client,
      executeOperation: vi.fn(
        async () =>
          new Promise<CodeOperationResult>((resolve) => {
            resolveNext = resolve;
          }),
      ),
    };
    rerender(
      <DockReviewTool
        {...first}
        checkoutId={ids.otherCheckout as never}
        controller={controller(ids.otherThread, secondClient as never)}
        loadRuntime={runtime().loadRuntime}
        threadId={ids.otherThread as never}
      />,
    );
    expect(screen.queryByRole("button", { name: /src\/index\.ts/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Loading Git diff");
    resolveNext(dirtyObservation(ids.operation));
    expect(await screen.findByRole("navigation", { name: "Changed files" })).toBeVisible();
  });

  it("keeps discard behind the same approval a destructive Git effect needs", async () => {
    const user = userEvent.setup();
    const executeOperation = vi.fn(async (command) => {
      if (command.kind === "observe-git") return dirtyObservation(command.operationId);
      if (command.kind === "discard-git-changes") {
        return {
          kind: "git-mutation-state",
          operationId: command.operationId,
          gitOperationId: command.gitOperationId,
          mutation: "discard",
          state: "completed",
        } as never;
      }
      return failed(command);
    });
    const requestApproval = vi.fn(async () => "40000000-0000-4000-8000-000000000009");
    render(
      <DockReviewTool
        {...bound({ executeOperation: executeOperation as never }, "approval-gated")}
        hostBridge={{ requestCodeOperationApproval: requestApproval } as never}
        loadRuntime={runtime().loadRuntime}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Discard changes" }));
    expect(executeOperation).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "discard-git-changes" }),
    );
    await user.click(screen.getByRole("button", { name: "Discard permanently" }));
    expect(requestApproval).toHaveBeenCalled();
    expect(executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "discard-git-changes", paths: ["src/index.ts"] }),
    );
  });

  it("offers no discard in Plan mode", async () => {
    render(<DockReviewTool {...bound({}, "plan")} loadRuntime={runtime().loadRuntime} />);
    expect(await screen.findByRole("navigation", { name: "Changed files" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Discard changes" })).not.toBeInTheDocument();
  });

  it("marks the open comparison stale when the checkout moves and refreshes on request", async () => {
    const user = userEvent.setup();
    const watch = vi.fn(async function* () {
      yield { paths: ["src/index.ts"], truncated: false };
    });
    const executeOperation = vi.fn(async (command) =>
      command.kind === "observe-git" ? dirtyObservation(command.operationId) : failed(command),
    );
    render(
      <DockReviewTool
        {...bound({ executeOperation })}
        loadRuntime={runtime().loadRuntime}
        watchClient={{ watch: watch as never }}
      />,
    );
    expect(await screen.findByRole("navigation", { name: "Changed files" })).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Git state changed; refresh the diff.",
    );
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(
      executeOperation.mock.calls.filter((call) => call[0].kind === "observe-git").length,
    ).toBe(2);
  });

  it("does not keep a previous thread's Review when this thread is still loading", () => {
    render(
      <DockReviewTool controller={controller(ids.otherThread)} threadId={ids.thread as never} />,
    );
    expect(screen.getByRole("heading", { name: "Review is unavailable" })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Changed files" })).not.toBeInTheDocument();
  });
});

const ids = {
  checkout: "20000000-0000-4000-8000-000000000001",
  content: "20000000-0000-4000-8000-000000000002",
  git: "20000000-0000-4000-8000-000000000003",
  operation: "20000000-0000-4000-8000-000000000004",
  otherCheckout: "20000000-0000-4000-8000-000000000006",
  otherThread: "20000000-0000-4000-8000-000000000007",
  thread: "20000000-0000-4000-8000-000000000005",
} as const;

function bound(
  client: Partial<CodeClient> = {},
  executionPolicy: "plan" | "approval-gated" | "full-access" = "full-access",
): {
  readonly controller: CodeController;
  readonly threadId: never;
  readonly checkoutId: never;
} {
  return {
    controller: controller(ids.thread, client, executionPolicy),
    threadId: ids.thread as never,
    checkoutId: ids.checkout as never,
  };
}

function controller(
  threadId: string,
  client: Partial<CodeClient> = {},
  executionPolicy: "plan" | "approval-gated" | "full-access" = "full-access",
): CodeController {
  const executeOperation =
    client.executeOperation ??
    vi.fn(async (command) =>
      command.kind === "observe-git" ? dirtyObservation(command.operationId) : failed(command),
    );
  return {
    activeView: {
      checkout: { id: threadId === ids.thread ? ids.checkout : ids.otherCheckout },
      thread: { id: threadId, executionPolicy },
    },
    client: {
      operationContent: vi.fn(async () => new TextEncoder().encode(DIFF)),
      executeOperation,
      ...client,
    },
  } as never;
}

function dirtyObservation(operationId: string, truncated = false): GitObservation {
  return {
    kind: "git-observed",
    operationId,
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
  } as unknown as GitObservation;
}

function cleanObservation(operationId: string): GitObservation {
  return {
    ...dirtyObservation(operationId),
    status: [],
    changedPaths: [],
  };
}

function runReviewed(operationId: string): RunReviewed {
  return {
    kind: "run-reviewed",
    operationId,
    gitOperationId: ids.git,
    outcome: {
      branch: "feature/editor",
      baseRef: "origin/development",
      head: "a".repeat(40),
      ahead: 2,
      behind: 0,
      changedPaths: ["src/run.ts"],
      diff: {
        contentId: ids.content,
        digest: "c".repeat(64),
        byteLength: 64,
      },
      uncommittedPaths: [],
      mergeability: "clean",
    },
  } as unknown as RunReviewed;
}

function failed(command: { readonly operationId: string }): CodeOperationResult {
  return {
    kind: "operation-failed",
    operationId: command.operationId,
    failure: { category: "unavailable", message: "unavailable" },
  } as CodeOperationResult;
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

type GitObservation = Extract<CodeOperationResult, { readonly kind: "git-observed" }>;
type RunReviewed = Extract<CodeOperationResult, { readonly kind: "run-reviewed" }>;
