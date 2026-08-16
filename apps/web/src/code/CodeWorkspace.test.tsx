import type { WorkspaceTab } from "@octant/contracts/shell";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeWorkspace } from "./CodeWorkspace";
import { codeClient, gitObservation, ids, terminalResult } from "./CodeDeliveryPane.test-fixtures";

describe("CodeWorkspace", () => {
  it("uses a structured loading surface while Git observation is pending", () => {
    const client = codeClient();
    (client.executeOperation as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));

    render(
      <CodeWorkspace
        client={client}
        controller={controller("full-access")}
        createUuid={uuidFactory()}
        tab={tab("code-git", "Git")}
      />,
    );

    expect(screen.getByRole("status")).toHaveClass("code-git-loading");
    expect(screen.getByRole("heading", { name: "Loading Git state" })).toBeVisible();
    expect(screen.getByText("Loading exact checkout status and diff evidence.")).toBeVisible();
  });

  it("loads an exact authoritative Git observation for Git tabs", async () => {
    const client = codeClient();
    (client.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(gitObservation);

    render(
      <CodeWorkspace
        client={client}
        controller={controller("full-access")}
        createUuid={uuidFactory()}
        tab={tab("code-git", "Git")}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Checkout changes" })).toBeVisible();
    expect(screen.getByText("src/changed.ts")).toBeVisible();
    expect(client.executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "observe-git",
        checkoutId: ids.checkout,
        threadId: ids.thread,
      }),
    );
  });

  it("opens a terminal the first time the tab is viewed, without an approval prompt", async () => {
    const client = codeClient();
    (client.inspectTerminal as ReturnType<typeof vi.fn>).mockRejectedValue(terminalUnavailable());
    (client.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValueOnce(terminalResult);

    // Approval-gated and no approval bridge: the person opening the tab is the
    // approval, and the host authorizes their own terminal without a prompt.
    render(
      <CodeWorkspace
        client={client}
        controller={controller("approval-gated")}
        createUuid={uuidFactory()}
        tab={tab("code-terminal", "Terminal")}
      />,
    );

    await waitFor(() =>
      expect(client.executeOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "start-terminal",
          terminalId: ids.thread,
          credentialRefs: [],
        }),
      ),
    );
    expect(await screen.findByRole("heading", { name: "Repository terminal" })).toBeVisible();
  });

  it("starts only one terminal while the first request is in flight", async () => {
    const client = codeClient();
    (client.inspectTerminal as ReturnType<typeof vi.fn>).mockRejectedValue(terminalUnavailable());
    (client.executeOperation as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise(() => {}),
    );

    render(
      <CodeWorkspace
        client={client}
        controller={controller("full-access")}
        createUuid={uuidFactory()}
        tab={tab("code-terminal", "Terminal")}
      />,
    );

    await waitFor(() => expect(client.executeOperation).toHaveBeenCalledOnce());
    // The reattach poll keeps running underneath; it must not start a second one.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(client.executeOperation).toHaveBeenCalledOnce();
    expect(
      (client.executeOperation as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([command]) => command.kind === "start-terminal",
      ),
    ).toHaveLength(1);
  });

  it("restores supplied terminal evidence without silently restarting", async () => {
    const client = codeClient();
    render(
      <CodeWorkspace
        client={client}
        controller={controller("full-access")}
        createUuid={uuidFactory()}
        projections={{ terminal: terminalResult }}
        tab={tab("code-terminal", "Terminal")}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Repository terminal" })).toBeVisible();
    expect(client.executeOperation).not.toHaveBeenCalled();
  });

  it("reattaches an existing terminal after the workspace remounts", async () => {
    const client = codeClient();
    (client.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValue(terminalResult);

    const first = render(
      <CodeWorkspace
        client={client}
        controller={controller("full-access")}
        createUuid={uuidFactory()}
        tab={tab("code-terminal", "Terminal")}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Repository terminal" })).toBeVisible();
    expect(client.executeOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "attach-terminal",
        terminalId: ids.thread,
      }),
    );
    expect(screen.queryByRole("button", { name: "Start terminal" })).toBeNull();

    first.unmount();
    render(
      <CodeWorkspace
        client={client}
        controller={controller("full-access")}
        createUuid={uuidFactory()}
        tab={tab("code-terminal", "Terminal")}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Repository terminal" })).toBeVisible();
    expect(client.executeOperation).toHaveBeenCalledTimes(2);
    expect(
      (client.executeOperation as ReturnType<typeof vi.fn>).mock.calls.every(
        ([command]) => command.kind === "attach-terminal",
      ),
    ).toBe(true);
  });

  it("discovers a terminal started by an agent while the Terminal tab is already open", async () => {
    const client = codeClient();
    (client.inspectTerminal as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(terminalUnavailable())
      .mockResolvedValueOnce({ terminalId: ids.thread, state: "running" });
    (client.executeOperation as ReturnType<typeof vi.fn>)
      // The tab's own automatic open cannot start one right now...
      .mockResolvedValueOnce({
        kind: "operation-failed",
        operationId: "30000000-0000-4000-8000-000000000001",
        failure: { category: "unavailable", message: "Terminal runtime is unavailable." },
      })
      // ...but the poll underneath finds and attaches the one the agent started.
      .mockResolvedValueOnce(terminalResult);

    render(
      <CodeWorkspace
        client={client}
        controller={controller("full-access")}
        createUuid={uuidFactory()}
        tab={tab("code-terminal", "Terminal")}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Repository terminal" }, { timeout: 2_000 }),
    ).toBeVisible();
    expect(client.inspectTerminal).toHaveBeenCalledTimes(2);
    expect(
      (client.executeOperation as ReturnType<typeof vi.fn>).mock.calls.map(
        ([command]) => command.kind,
      ),
    ).toEqual(["start-terminal", "attach-terminal"]);
  });

  it("offers an explicit Start when the automatic open fails, and never auto-starts in Plan", async () => {
    const client = codeClient();
    (client.inspectTerminal as ReturnType<typeof vi.fn>).mockRejectedValue(terminalUnavailable());
    (client.executeOperation as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      kind: "operation-failed",
      operationId: "30000000-0000-4000-8000-000000000001",
      failure: { category: "unavailable", message: "Terminal runtime is unavailable." },
    });
    const { unmount } = render(
      <CodeWorkspace
        client={client}
        controller={controller("approval-gated")}
        createUuid={uuidFactory()}
        tab={tab("code-terminal", "Terminal")}
      />,
    );

    expect(await screen.findByRole("button", { name: "Start terminal" })).toBeVisible();
    expect(await screen.findByText("Terminal runtime is unavailable.")).toBeVisible();
    unmount();

    const planClient = codeClient();
    (planClient.inspectTerminal as ReturnType<typeof vi.fn>).mockRejectedValue(
      terminalUnavailable(),
    );
    render(
      <CodeWorkspace
        client={planClient}
        controller={controller("plan")}
        createUuid={uuidFactory()}
        tab={tab("code-terminal", "Terminal")}
      />,
    );
    expect(await screen.findByRole("heading", { name: "No terminal attached" })).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(planClient.executeOperation).not.toHaveBeenCalled();
  });

  it("explains stale checkout recovery instead of offering a dead terminal action", () => {
    render(
      <CodeWorkspace
        client={codeClient()}
        controller={controller("full-access", "unavailable")}
        createUuid={uuidFactory()}
        tab={tab("code-terminal", "Terminal")}
      />,
    );

    expect(screen.getByRole("heading", { name: "Repository checkout changed" })).toBeVisible();
    expect(screen.getByText(/create a fresh Code thread/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Start terminal" })).not.toBeInTheDocument();
  });

  it("keeps a reconnecting checkout in a loading state instead of calling it stale", () => {
    render(
      <CodeWorkspace
        client={codeClient()}
        controller={controller("full-access", "waiting")}
        createUuid={uuidFactory()}
        tab={tab("code-terminal", "Terminal")}
      />,
    );

    expect(screen.getByRole("heading", { name: "Connecting repository checkout" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Repository checkout changed" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start terminal" })).not.toBeInTheDocument();
  });

  it("renders a path-specific recovery state instead of inventing a file projection", () => {
    render(
      <CodeWorkspace
        client={codeClient()}
        controller={controller("plan")}
        createUuid={uuidFactory()}
        tab={{ ...tab("code-file", "README.md"), relativePath: "README.md" } as never}
      />,
    );

    expect(screen.getByRole("heading", { name: "README.md is unavailable" })).toBeVisible();
    expect(screen.getByText(/authoritative file projection/i)).toBeVisible();
  });

  it("opens the conversation workspace for code-overview tabs instead of the summary card", () => {
    render(
      <CodeWorkspace
        client={codeClient()}
        controller={controller("approval-gated")}
        createUuid={uuidFactory()}
        tab={tab("code-overview", "Composition")}
      />,
    );

    expect(screen.getByRole("region", { name: "Code thread" })).toBeVisible();
    expect(screen.getByRole("log")).toBeVisible();
    expect(screen.getByLabelText("Follow-up message")).toBeVisible();
    expect(screen.queryByRole("region", { name: "Code overview" })).not.toBeInTheDocument();
  });
});

function controller(
  executionPolicy: "plan" | "approval-gated" | "full-access",
  availability: "available" | "unavailable" | "waiting" = "available",
) {
  return {
    activeView: {
      checkout: {
        id: ids.checkout,
        repositoryId: "c0000000-0000-4000-8000-000000000001",
        kind: "existing-worktree",
        availability,
        head: { kind: "branch", name: "feature/composition", oid: "a".repeat(40) },
        observedAt: "2026-07-21T12:00:00.000Z",
      },
      thread: {
        id: ids.thread,
        checkoutId: ids.checkout,
        executionPolicy,
        lifecycle: "active",
        title: "Composition",
      },
      lastSequence: 1,
    },
    pendingDraft: "",
    setPendingDraft: vi.fn(),
    conversation: [],
    providerRequests: [],
    answerProviderRequest: vi.fn(async () => true),
    cancelQueuedFollowUp: vi.fn(),
    queueFollowUp: vi.fn(),
    queuedFollowUps: [],
    turnActivity: new Map(),
    followUps: new Map(),
    markFollowUp: vi.fn(async () => true),
    completeFollowUp: vi.fn(async () => true),
    refreshFollowUp: vi.fn(async () => undefined),
    sendFollowUp: vi.fn(async () => true),
    turnStatus: "idle",
    status: "ready",
  } as never;
}

function tab(kind: WorkspaceTab["kind"], title: string) {
  return {
    id: "d0000000-0000-4000-8000-000000000001",
    kind,
    mode: "code",
    threadId: ids.thread,
    title,
  } as Extract<WorkspaceTab, { readonly mode: "code" }>;
}

function uuidFactory() {
  let value = 1;
  return () => `e0000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}

function terminalUnavailable() {
  return Object.assign(new Error("Terminal is unavailable."), { category: "unavailable" });
}
