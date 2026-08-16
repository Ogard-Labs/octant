import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeOperationResult } from "@octant/contracts/code-operations";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MonacoAdapterRuntime } from "./MonacoEditorAdapter";
import { CodeDiffPane, type CodeDiffProjection } from "./CodeDiffPane";

describe("CodeDiffPane", () => {
  it("loads exact Git evidence into a read-only opaque Monaco model", async () => {
    const code = client();
    const fixture = runtime();
    render(<CodeDiffPane client={code} diff={available()} loadRuntime={fixture.loadRuntime} />);

    expect(await screen.findByRole("heading", { name: "Checkout changes" })).toBeVisible();
    expect(code.operationContent).toHaveBeenCalledWith(ids.thread, ids.operation, ids.content);
    expect(code.content).not.toHaveBeenCalled();
    await waitFor(() => expect(fixture.options?.value).toContain("diff --git"));
    expect(fixture.options?.readOnly).toBe(true);
    expect(fixture.options?.modelUri).toBe(`octant-code://${ids.checkout}/diff/${ids.content}`);
    expect(fixture.options?.modelUri).not.toContain("/Users/");
    expect(screen.queryByText(/incomplete/i)).not.toBeInTheDocument();
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
});

const ids = {
  checkout: "20000000-0000-4000-8000-000000000001",
  content: "20000000-0000-4000-8000-000000000002",
  git: "20000000-0000-4000-8000-000000000003",
  operation: "20000000-0000-4000-8000-000000000004",
  thread: "20000000-0000-4000-8000-000000000005",
} as const;

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
      status: [],
      changedPaths: ["src/index.ts"],
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
      version: 1 as const,
      threadId,
      turns: [],
      nextCursor: 0,
      hasMore: false,
    })),
    content: vi.fn(
      async () =>
        options.bytes ??
        new TextEncoder().encode("diff --git a/src/index.ts b/src/index.ts\n+changed\n"),
    ),
    operationContent: vi.fn(
      async () =>
        options.bytes ??
        new TextEncoder().encode("diff --git a/src/index.ts b/src/index.ts\n+changed\n"),
    ),
    execute: vi.fn(),
    executeOperation: vi.fn(),
    inspectTerminal: vi.fn(),
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
  let options: Parameters<MonacoAdapterRuntime["mount"]>[1] | undefined;
  const loadRuntime = vi.fn(
    async (): Promise<MonacoAdapterRuntime> => ({
      mount: (_element, value) => {
        options = value;
        return {
          dispose: vi.fn(),
          focus: vi.fn(),
          setReadOnly: vi.fn(),
          setValue: vi.fn(),
        };
      },
    }),
  );
  return {
    loadRuntime,
    get options() {
      return options;
    },
  };
}
