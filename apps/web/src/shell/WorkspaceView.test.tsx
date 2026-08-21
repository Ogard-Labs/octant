import type { ProjectAvailability, ProjectSummary } from "@octant/contracts/projects";
import type { WorkspaceTab } from "@octant/contracts/shell";
import { decodeChatBootstrap, decodeChatThreadView } from "@octant/contracts/chat";
import { defaultEnvironmentPresentationState } from "@octant/domain/shell-policy";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceView, type WorkspaceViewProps } from "./WorkspaceView";
import { stubSurfaceDragHandle } from "../App.test-fixtures";
import { createChatReadCursorStore } from "../chat/useChatController";
import { createCodeThreadControllers } from "../code/codeThreadControllers";
import {
  codeClient,
  gitObservation,
  ids as codeIds,
  pullRequestReviewNone,
} from "../code/CodeDeliveryPane.test-fixtures";

const ids = {
  checkout: "10000000-0000-4000-8000-000000000001",
  pane: "10000000-0000-4000-8000-000000000002",
  node: "10000000-0000-4000-8000-000000000003",
  tab: "10000000-0000-4000-8000-000000000004",
  thread: "10000000-0000-4000-8000-000000000005",
  project: "10000000-0000-4000-8000-000000000007",
  window: "10000000-0000-4000-8000-000000000006",
} as const;

const codeTabs: ReadonlyArray<
  readonly [WorkspaceTab["kind"], string, "monaco" | "xterm" | undefined, string]
> = [
  ["code-overview", "Overview", undefined, "Composition"],
  ["code-diff", "README.md changes", "monaco", "Checkout changes"],
  ["code-terminal", "Terminal", "xterm", "No terminal attached"],
  ["code-test", "Tests", undefined, "Repository test approval unavailable"],
  ["code-git", "Git", undefined, "Git mutation approval unavailable"],
  ["code-pr", "Pull request", undefined, "Pull request approval unavailable"],
  ["code-local-review", "Review findings", undefined, "Local review unavailable"],
];

describe("WorkspaceView Code tab registration", () => {
  it.each(codeTabs)(
    "routes %s through an explicit Code pane boundary",
    async (kind, title, deferredAdapter, expectedHeading) => {
      const { container } = render(<WorkspaceView {...propsFor(codeTab(kind, title))} />);

      // The Code pane boundary is intentionally lazy (React.lazy + Suspense), so
      // the pane heading appears only after the deferred chunk resolves. Keep a
      // generous wait budget for loaded CI runners; the assertion itself is
      // unchanged — the exact heading must render and be visible.
      expect(
        await screen.findByRole("heading", { name: expectedHeading }, { timeout: 5_000 }),
      ).toBeVisible();
      expect(
        screen.queryByRole("heading", { name: "No Code Project open" }),
      ).not.toBeInTheDocument();
      const boundary = container.querySelector(`[data-code-tab-kind="${kind}"]`);
      expect(boundary).toBeVisible();
      if (deferredAdapter === undefined) {
        expect(boundary).not.toHaveAttribute("data-deferred-code-adapter");
      } else {
        expect(boundary).toHaveAttribute("data-deferred-code-adapter", deferredAdapter);
      }
    },
  );

  it("routes code-file through a Code pane boundary that loads the file", async () => {
    // Unlike the other Code surfaces, this pane resolves an authoritative file
    // projection before it can render: it starts unavailable, the host answers,
    // and the editor takes over. Asserting the transient unavailable heading
    // would race React's Suspense reveal, so assert the settled editor instead.
    const props = propsFor(codeTab("code-file", "README.md"));
    const { container } = render(<WorkspaceView {...props} />);

    expect(
      await screen.findByRole("region", { name: "Code editor for README.md" }, { timeout: 5_000 }),
    ).toBeVisible();
    expect(props.codeController.client.openFile).toHaveBeenCalledWith(
      codeIds.thread,
      codeIds.checkout,
      "README.md",
    );
    const boundary = container.querySelector('[data-code-tab-kind="code-file"]');
    expect(boundary).toBeVisible();
    expect(boundary).toHaveAttribute("data-deferred-code-adapter", "monaco");
  });

  it("routes a persistent Apple workbench tab through shared client state", async () => {
    const tab = codeTab("apple-workbench", "Apple workbench");
    const base = propsFor(tab);
    const appleToolchainClient = {
      discover: vi.fn(() => new Promise(() => undefined)),
      snapshot: vi.fn(),
      execute: vi.fn(),
      cancel: vi.fn(),
    } as never;
    const { container } = render(
      <WorkspaceView {...base} appleToolchainClient={appleToolchainClient} />,
    );
    expect(await screen.findByRole("heading", { name: "Loading Apple toolchain" })).toBeVisible();
    expect(container.querySelector('[data-code-tab-kind="apple-workbench"]')).toBeVisible();
  });

  it("opens Code tools with concise surface titles instead of duplicating the thread title", async () => {
    const base = propsFor(codeTab("code-overview", "A very long Code thread title"));
    render(
      <WorkspaceView
        {...base}
        availableSurfaces={{
          chat: [],
          work: [],
          code: [{ kind: "thread", label: "Thread", available: true }],
        }}
        onOpenSurface={vi.fn()}
      />,
    );
    await screen.findByRole("heading", { name: "Composition" });

    fireEvent.click(screen.getByRole("button", { name: "Open surface" }));
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));

    expect(base.onOpenCodeSurface).toHaveBeenCalledWith(
      "code-terminal",
      codeIds.thread,
      "Terminal",
    );
  });

  it("mounts the exact-thread Browser activity preview over an active Code conversation", async () => {
    const base = propsFor(codeTab("code-overview", "Browser owner"));
    const onOpenSurface = vi.fn();
    const browserAutomationClient = {
      inspectThread: vi.fn(async () => ({
        status: "running",
        threadId: codeIds.thread,
        context: {
          contextId: "30000000-0000-4000-8000-000000000001",
          threadId: codeIds.thread,
          state: "active",
        },
        observation: {
          title: "Preview page",
          url: "https://example.com",
          screenshotDataUrl: "data:image/jpeg;base64,AQID",
          stale: false,
        },
        evidence: [],
      })),
    } as never;

    render(
      <WorkspaceView
        {...base}
        browserAutomationClient={browserAutomationClient}
        onOpenSurface={onOpenSurface}
      />,
    );

    expect(await screen.findByRole("img", { name: "Preview page browser activity" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open Browser tab" }));
    expect(onOpenSurface).toHaveBeenCalledWith("browser", ids.pane);
  });
});

/** Closes a pane the way a person does: through its own actions disclosure. */
async function closePaneShowing(title: string): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: `Pane actions for ${title}` }));
  fireEvent.click(screen.getByRole("button", { name: "Close pane" }));
}

async function expandLocalServers(): Promise<void> {
  fireEvent.click(
    await screen.findByRole("button", { name: /^Local servers/ }, { timeout: 5_000 }),
  );
}

describe("WorkspaceView Local servers wiring", () => {
  it("opens a prepared local server as a restricted Browser tab for exactly one origin", async () => {
    const wired = localServersWiring();
    const onOpenSurface = vi.fn(async () => true);
    render(
      <WorkspaceView
        {...wired.props}
        browserAutomationClient={wired.browserAutomationClient}
        onOpenSurface={onOpenSurface}
      />,
    );
    // Collapsed by default: no listener enumeration until the user opens it.
    await screen.findByRole("button", { name: /^Local servers/ }, { timeout: 5_000 });
    expect(wired.props.localServerClient?.execute).not.toHaveBeenCalled();
    await expandLocalServers();

    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: "Open http://127.0.0.1:5173/ in a new Browser tab" },
        { timeout: 5_000 },
      ),
    );

    await waitFor(() =>
      expect(onOpenSurface).toHaveBeenCalledWith(
        "browser",
        ids.pane,
        // The tab is named by the context this Open created, not by the thread.
        "60000000-0000-4000-8000-000000000001",
      ),
    );
    expect(wired.create).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: expect.objectContaining({
          profileMode: "isolated",
          allowedOrigins: ["http://127.0.0.1:5173"],
        }),
      }),
    );
    expect(wired.act).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "navigate", target: "http://127.0.0.1:5173/" }),
    );
    // The tab adopted this context, so nothing releases it behind the user's back.
    expect(wired.stop).not.toHaveBeenCalled();
  });

  it("releases the context it just created when the Open navigation fails", async () => {
    // Without a tab named by it, a created-then-abandoned context would hold a
    // host Browser session no user control can reach until it expires.
    const wired = localServersWiring({ navigationFailure: new Error("transport closed") });
    const onOpenSurface = vi.fn();
    render(
      <WorkspaceView
        {...wired.props}
        browserAutomationClient={wired.browserAutomationClient}
        onOpenSurface={onOpenSurface}
      />,
    );
    await expandLocalServers();

    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: "Open http://127.0.0.1:5173/ in a new Browser tab" },
        { timeout: 5_000 },
      ),
    );

    await waitFor(() =>
      expect(wired.stop).toHaveBeenCalledWith({
        contextId: "60000000-0000-4000-8000-000000000001",
        threadId: codeIds.thread,
      }),
    );
    expect(onOpenSurface).not.toHaveBeenCalled();
    // Exactly one release: the tab-adoption compensation must not fire a second
    // stop for a context the navigation failure already released.
    expect(wired.stop).toHaveBeenCalledTimes(1);
    // The failure is still the user's to see, not something the cleanup ate.
    expect(
      await screen.findByText("Octant could not open a Browser tab for this server."),
    ).toBeVisible();
  });

  it("releases the context it just created when no tab adopts it", async () => {
    // The shell resolves a rejected workspace mutation instead of throwing, so
    // a settled Open proves nothing on its own. Only a committed tab bound to
    // this exact context gives the user a way to close the session; without
    // one the context would hold a host Browser session until it expires.
    const wired = localServersWiring();
    const onOpenSurface = vi.fn(async () => false);
    render(
      <WorkspaceView
        {...wired.props}
        browserAutomationClient={wired.browserAutomationClient}
        onOpenSurface={onOpenSurface}
      />,
    );
    await expandLocalServers();

    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: "Open http://127.0.0.1:5173/ in a new Browser tab" },
        { timeout: 5_000 },
      ),
    );

    await waitFor(() =>
      expect(wired.stop).toHaveBeenCalledWith({
        contextId: "60000000-0000-4000-8000-000000000001",
        threadId: codeIds.thread,
      }),
    );
    expect(wired.stop).toHaveBeenCalledTimes(1);
    // A failed Open must read as failed rather than as a silent success.
    expect(
      await screen.findByText("Octant could not open a Browser tab for this server."),
    ).toBeVisible();
  });

  it("still reports the failed Open when releasing the orphaned context also fails", async () => {
    const wired = localServersWiring({
      navigationFailure: new Error("transport closed"),
      stopFailure: new Error("host unreachable"),
    });
    const onOpenSurface = vi.fn();
    render(
      <WorkspaceView
        {...wired.props}
        browserAutomationClient={wired.browserAutomationClient}
        onOpenSurface={onOpenSurface}
      />,
    );
    await expandLocalServers();

    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: "Open http://127.0.0.1:5173/ in a new Browser tab" },
        { timeout: 5_000 },
      ),
    );

    expect(
      await screen.findByText("Octant could not open a Browser tab for this server."),
    ).toBeVisible();
    expect(wired.stop).toHaveBeenCalledTimes(1);
    expect(onOpenSurface).not.toHaveBeenCalled();
  });

  it("keeps the first server's session when a second one is opened", async () => {
    // Every Open creates a new tab and context for exactly one origin.
    const wired = localServersWiring({ second: true });
    const onOpenSurface = vi.fn(async (..._args: ReadonlyArray<unknown>) => true);
    render(
      <WorkspaceView
        {...wired.props}
        browserAutomationClient={wired.browserAutomationClient}
        onOpenSurface={onOpenSurface}
      />,
    );
    await expandLocalServers();

    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: "Open http://127.0.0.1:5173/ in a new Browser tab" },
        { timeout: 5_000 },
      ),
    );
    await waitFor(() => expect(wired.create).toHaveBeenCalledTimes(1));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open http://127.0.0.1:4321/ in a new Browser tab",
      }),
    );
    await waitFor(() => expect(wired.create).toHaveBeenCalledTimes(2));

    // The first context is never stopped to make room for the second.
    expect(wired.stop).not.toHaveBeenCalled();
    for (const call of wired.create.mock.calls) {
      expect(call[0]).toMatchObject({ dedicated: true });
    }
    expect(wired.create.mock.calls[0]?.[0].policy.allowedOrigins).toEqual([
      "http://127.0.0.1:5173",
    ]);
    expect(wired.create.mock.calls[1]?.[0].policy.allowedOrigins).toEqual([
      "http://127.0.0.1:4321",
    ]);
    // Each Open lands in its own tab, named by the context it created.
    const opened = onOpenSurface.mock.calls.map((call) => call[2]);
    expect(opened).toHaveLength(2);
    expect(new Set(opened).size).toBe(2);
  });

  it("carries the host's certificate decision into the isolated context it opens", async () => {
    const wired = localServersWiring({ https: true });
    render(
      <WorkspaceView
        {...wired.props}
        browserAutomationClient={wired.browserAutomationClient}
        onOpenSurface={vi.fn(async () => true)}
      />,
    );
    await expandLocalServers();

    fireEvent.click(
      await screen.findByRole(
        "button",
        { name: "Open https://127.0.0.1:8443/ in a new Browser tab" },
        { timeout: 5_000 },
      ),
    );

    await waitFor(() =>
      expect(wired.create).toHaveBeenCalledWith(
        expect.objectContaining({
          policy: expect.objectContaining({
            allowedOrigins: ["https://127.0.0.1:8443"],
            acceptsLocalCertificate: true,
          }),
        }),
      ),
    );
  });

  it("copies a local server URL to the clipboard and confirms it in words", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    try {
      const wired = localServersWiring();
      render(<WorkspaceView {...wired.props} />);
      await expandLocalServers();

      fireEvent.click(
        await screen.findByRole(
          "button",
          { name: "Copy http://127.0.0.1:5173/" },
          { timeout: 5_000 },
        ),
      );

      expect(await screen.findByText("Copied")).toBeVisible();
      expect(writeText).toHaveBeenCalledWith("http://127.0.0.1:5173/");
    } finally {
      Reflect.deleteProperty(globalThis.navigator, "clipboard");
    }
  });

  it("hides Open when the shell has no Browser tab path instead of rendering a dead control", async () => {
    const wired = localServersWiring();
    // No browserAutomationClient and no onOpenSurface: nowhere to put the tab.
    render(<WorkspaceView {...wired.props} />);
    await expandLocalServers();

    expect(await screen.findByText("node · vite", undefined, { timeout: 5_000 })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Open http/ })).toBeNull();
  });
});

function localServersWiring(
  options: {
    readonly second?: boolean;
    readonly https?: boolean;
    readonly navigationFailure?: Error;
    readonly stopFailure?: Error;
  } = {},
) {
  const base = propsFor(codeTab("code-overview", "Local servers owner"));
  const now = "2026-08-14T08:00:00.000Z";
  const observation = {
    status: "ready",
    projectId: ids.project,
    projectName: "Octant",
    repositoryRoot: "/Users/example/code/octant",
    worktreeRoot: "/Users/example/code/octant",
    branch: { kind: "named", name: "feature/local-servers" },
    changes: "clean",
    observedAt: now,
  };
  const projectClient = {
    bootstrap: vi.fn(),
    search: vi.fn(),
    executeProject: vi.fn(),
    memory: vi.fn(),
    environment: vi.fn(async () => observation),
    environmentForThread: vi.fn(async () => observation),
    executeMemory: vi.fn(),
  } as never;
  const project = {
    id: ids.project,
    type: "code",
    name: "Octant",
    lifecycle: "active",
    pinned: false,
    rank: "0/1",
    version: 1,
    createdAt: now,
    updatedAt: now,
    binding: { canonicalRoot: "/Users/example/code/octant" },
    codeAccessPersistence: "current-session",
  } as never;
  const listener = {
    listenerId: "lsn_0123456789abcdef0123456789abcdef",
    port: options.https === true ? 8443 : 5173,
    url: options.https === true ? "https://127.0.0.1:8443/" : "http://127.0.0.1:5173/",
    processName: "node",
    framework: "vite",
    attribution: "current-checkout",
    startSource: "octant",
    bindScope: "loopback",
    health: "listening",
    openAvailable: true,
    stop: { status: "available", confirmationRequired: false },
  };
  // A second classified leftover on its own port, so opening one after the
  // other exercises two Opens rather than a repeat of the same one.
  const otherListener = {
    ...listener,
    listenerId: "lsn_0123456789abcdef0123456789abcde0",
    port: 4321,
    url: "http://127.0.0.1:4321/",
  };
  const listeners = options.second === true ? [listener, otherListener] : [listener];
  const localServerClient = {
    execute: vi.fn(async (command: { kind: string; listenerId?: string }) => {
      if (command.kind !== "open-local-server") {
        return {
          kind: "local-servers-listed",
          requestId: "90000000-0000-4000-8000-000000000002",
          snapshot: {
            threadId: codeIds.thread,
            projectId: ids.project,
            currentCheckout: listeners,
            other: [],
            observedAt: now,
          },
        };
      }
      const target = listeners.find((entry) => entry.listenerId === command.listenerId) ?? listener;
      const url = new URL(target.url);
      return {
        kind: "local-server-open-prepared",
        requestId: "90000000-0000-4000-8000-000000000001",
        listenerId: target.listenerId,
        target: {
          url: target.url,
          allowedOrigin: url.origin,
          acceptsLocalCertificate: url.protocol === "https:",
        },
      };
    }),
  } as never;
  const authority = {
    rootId: "40000000-0000-4000-8000-000000000001",
    providerInstanceId: "50000000-0000-4000-8000-000000000001",
    extension: { kind: "core" },
  };
  const resolve = vi.fn(async () => ({ threadId: codeIds.thread, authority }));
  let mintedContexts = 0;
  const create = vi.fn(async (input: { policy: { allowedOrigins: ReadonlyArray<string> } }) => ({
    status: "ready",
    threadId: codeIds.thread,
    context: {
      contextId: `60000000-0000-4000-8000-00000000000${++mintedContexts}`,
      threadId: codeIds.thread,
      actionId: "70000000-0000-4000-8000-000000000001",
      correlationId: "70000000-0000-4000-8000-000000000002",
      authority,
      policy: {
        profileMode: "isolated",
        allowedOrigins: input.policy.allowedOrigins,
        credentialFieldProtection: true,
        maxConcurrentTabs: 1,
        sessionTimeoutMs: 300_000,
      },
      state: "active",
      createdAt: "2026-08-14T08:00:00.000Z",
    },
    evidence: [],
  }));
  const act = vi.fn(async () => {
    if (options.navigationFailure !== undefined) throw options.navigationFailure;
    return { status: "ready", threadId: codeIds.thread, evidence: [] };
  });
  const stop = vi.fn(async () => {
    if (options.stopFailure !== undefined) throw options.stopFailure;
    return { status: "ready", threadId: codeIds.thread, evidence: [] };
  });
  const browserAutomationClient = {
    resolve,
    create,
    act,
    stop,
    inspectThread: vi.fn(async () => ({
      status: "ready",
      threadId: codeIds.thread,
      evidence: [],
    })),
    releaseThread: vi.fn(),
  } as never;
  const props: WorkspaceViewProps = {
    ...base,
    codeController: {
      ...(base.codeController as object),
      navigation: [{ threadId: codeIds.thread, projectId: ids.project }],
    } as never,
    projects: [project],
    projectClient,
    localServerClient,
  };
  return { props, browserAutomationClient, create, act, stop };
}

describe("WorkspaceView split Code file explorer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists files with each pane's own thread checkout, not the focused view's", async () => {
    const threadBId = "b0000000-0000-4000-8000-000000000002";
    const checkoutBId = "20000000-0000-4000-8000-000000000002";
    const tabA = codeTab("code-overview", "Thread A");
    const tabBId = "10000000-0000-4000-8000-000000000014" as WorkspaceTab["id"];
    const tabB = {
      id: tabBId,
      kind: "code-overview",
      mode: "code",
      threadId: threadBId,
      title: "Thread B",
    } as WorkspaceTab;
    const base = propsFor(tabA);
    const paneB = {
      kind: "pane",
      nodeId: "10000000-0000-4000-8000-000000000012",
      paneId: "10000000-0000-4000-8000-000000000013",
      surface: tabB,
    } as const;
    const split = {
      kind: "split",
      nodeId: "10000000-0000-4000-8000-000000000011",
      orientation: "horizontal",
      ratio: 0.5,
      first: base.layout,
      second: paneB,
    } as never as WorkspaceViewProps["layout"];
    // The focused controller view is thread A. Thread B's checkout is known
    // only through the bootstrap thread record, exactly as at runtime.
    const codeController = {
      ...(base.codeController as object),
      bootstrap: {
        checkouts: [],
        activity: [],
        threads: [
          { id: codeIds.thread, checkoutId: codeIds.checkout, title: "Thread A" },
          { id: threadBId, checkoutId: checkoutBId, title: "Thread B" },
        ],
      },
    } as never as WorkspaceViewProps["codeController"];
    // Both panes are open, so both threads have a controller. Neither reads a
    // checkout from the other's view: thread B's is known only through the
    // bootstrap thread record, exactly as at runtime.
    const codeControllers = createCodeThreadControllers();
    codeControllers.publish(codeIds.thread as never, codeController);
    codeControllers.publish(threadBId as never, codeController);
    const listingRequests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/code/files/listing")) listingRequests.push(url);
        return new Response(JSON.stringify({ message: "unavailable" }), {
          headers: { "content-type": "application/json" },
          status: 503,
        });
      }),
    );

    render(
      <WorkspaceView
        {...base}
        codeController={codeController}
        codeControllers={codeControllers}
        layout={split}
        workspace={
          {
            ...base.workspace,
            layouts: { ...base.workspace.layouts, code: split },
          } as never
        }
      />,
    );

    // Files is collapsed until asked for; expand it in both panes.
    const filesButtons = await screen.findAllByRole(
      "button",
      { name: "Files" },
      { timeout: 5_000 },
    );
    expect(filesButtons).toHaveLength(2);
    for (const button of filesButtons) fireEvent.click(button);

    await waitFor(() => expect(listingRequests).toHaveLength(2), { timeout: 5_000 });
    const byThread = new Map(
      listingRequests
        .map((request) => new URL(request))
        .map((url) => [url.searchParams.get("threadId"), url.searchParams.get("checkoutId")]),
    );
    expect(byThread.get(String(codeIds.thread))).toBe(String(codeIds.checkout));
    expect(byThread.get(threadBId)).toBe(checkoutBId);
  });
});

describe("WorkspaceView concurrent Code threads", () => {
  it("shows each open Code thread its own composition rather than the focused one's", async () => {
    const threadBId = "b0000000-0000-4000-8000-000000000002";
    const checkoutBId = "20000000-0000-4000-8000-000000000002";
    const tabA = codeTab("code-overview", "Thread A");
    const tabBId = "10000000-0000-4000-8000-000000000024" as WorkspaceTab["id"];
    const tabB = {
      id: tabBId,
      kind: "code-overview",
      mode: "code",
      threadId: threadBId,
      title: "Thread B",
    } as WorkspaceTab;
    const base = propsFor(tabA);
    const split = {
      kind: "split",
      nodeId: "10000000-0000-4000-8000-000000000021",
      orientation: "horizontal",
      ratio: 0.5,
      first: base.layout,
      second: {
        kind: "pane",
        nodeId: "10000000-0000-4000-8000-000000000022",
        paneId: "10000000-0000-4000-8000-000000000023",
        surface: tabB,
      },
    } as never as WorkspaceViewProps["layout"];
    const controllers = createCodeThreadControllers();
    controllers.publish(codeIds.thread as never, base.codeController);
    controllers.publish(
      threadBId as never,
      {
        ...(base.codeController as object),
        activeView: {
          ...((base.codeController.activeView ?? {}) as object),
          checkout: {
            ...((base.codeController.activeView?.checkout ?? {}) as object),
            id: checkoutBId,
          },
          thread: {
            ...((base.codeController.activeView?.thread ?? {}) as object),
            id: threadBId,
            checkoutId: checkoutBId,
            title: "Second composition",
          },
        },
      } as never,
    );

    render(
      <WorkspaceView
        {...base}
        codeControllers={controllers}
        layout={split}
        workspace={
          { ...base.workspace, layouts: { ...base.workspace.layouts, code: split } } as never
        }
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Composition" }, { timeout: 5_000 }),
    ).toBeVisible();
    expect(
      await screen.findByRole("heading", { name: "Second composition" }, { timeout: 5_000 }),
    ).toBeVisible();
  });

  it("waits for a Code thread's own controller instead of borrowing another thread's", async () => {
    const base = propsFor(codeTab("code-overview", "Thread A"));

    render(<WorkspaceView {...base} codeControllers={createCodeThreadControllers()} />);

    expect(
      await screen.findByRole(
        "heading",
        { name: "Preparing this Code thread" },
        { timeout: 5_000 },
      ),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Composition" })).not.toBeInTheDocument();
  });
});

describe("WorkspaceView child-run status chrome", () => {
  function agentRunClient() {
    return {
      parentSummary: vi.fn(async (parentThreadId: string) => ({
        parentThreadId,
        entries: [
          {
            runId: "90000000-0000-4000-8000-000000000001",
            requestId: "90000000-0000-4000-8000-000000000002",
            parentThreadId,
            role: "worker",
            task: "collect evidence",
            lifecycleStatus: "running",
            executionKind: "managed",
            usageQuality: "measured",
            resultAcknowledgement: { required: false, acknowledged: false },
            version: 1,
            updatedAt: "2026-08-14T10:00:00.000Z",
          },
        ],
      })),
      acknowledge: vi.fn(),
      cancel: vi.fn(async () => ({ results: [] })),
      requestRun: vi.fn(),
    } as never;
  }

  it("mounts the chrome on a Chat thread", async () => {
    const tab = {
      id: ids.tab,
      kind: "chat-thread",
      mode: "chat",
      threadId: ids.thread,
      title: "Release plan",
    } as WorkspaceTab;
    const chatClient = {
      bootstrap: vi.fn(() => new Promise(() => undefined)),
      execute: vi.fn(),
      search: vi.fn(async () => []),
      subscribe: vi.fn(async function* () {}),
      thread: vi.fn(() => new Promise(() => undefined)),
      upload: vi.fn(),
      discard: vi.fn(),
    } as never;
    render(
      <WorkspaceView
        {...propsFor(tab)}
        agentRunClient={agentRunClient()}
        chatClient={chatClient}
        chatReadCursorStore={createChatReadCursorStore()}
        mode="chat"
      />,
    );
    const chrome = await screen.findByRole("region", { name: "Child run status" });
    expect(chrome).toBeVisible();
    expect(chrome.closest("header")).not.toBeNull();
    // Chat keeps observability only. Whether Chat should be able to start a
    // subagent is a product decision, so this surface must not acquire one by
    // accident alongside the Code thread's creation affordance.
    expect(screen.queryByRole("form", { name: "Create subagent" })).not.toBeInTheDocument();
  });

  it("mounts the chrome on a Work thread", async () => {
    const tab = {
      id: ids.tab,
      kind: "work-thread",
      mode: "work",
      threadId: ids.thread,
      title: "Draft brief",
    } as WorkspaceTab;
    render(
      <WorkspaceView
        {...propsFor(tab)}
        agentRunClient={agentRunClient()}
        workThreadClient={
          { bootstrap: vi.fn(async () => ({ threads: [] })), execute: vi.fn() } as never
        }
        mode="work"
      />,
    );
    const chrome = await screen.findByRole("region", { name: "Child run status" });
    expect(chrome).toBeVisible();
    expect(chrome.closest("header")).not.toBeNull();
  });

  it("mounts the chrome on a Code thread overview", async () => {
    render(
      <WorkspaceView
        {...propsFor(codeTab("code-overview", "Overview"))}
        agentRunClient={agentRunClient()}
      />,
    );
    const chrome = await screen.findByRole(
      "region",
      { name: "Child run status" },
      { timeout: 5_000 },
    );
    expect(chrome).toBeVisible();
    expect(chrome.closest("header")).not.toBeNull();
  });
});

describe("WorkspaceView cross-context banner", () => {
  it("renders the cross-context banner with a dismiss control", () => {
    const base = propsFor(codeTab("code-overview", "Overview"));
    const onDismiss = vi.fn();
    render(
      <WorkspaceView
        {...base}
        crossContextOffer={{
          message: "That Project belongs to a different window.",
          canOpenInNewWindow: false,
        }}
        onDismissCrossContextOffer={onDismiss}
      />,
    );
    expect(
      screen.getByText("That Project belongs to a different window.").closest('[role="alert"]'),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe("WorkspaceView execution profiles", () => {
  it("mounts the isolated execution-profile control on a new-thread surface", () => {
    const tab = {
      id: ids.tab,
      kind: "draft-thread",
      mode: "code",
      title: "New Code thread",
    } as WorkspaceTab;
    render(
      <WorkspaceView
        {...propsFor(tab)}
        draftExecutionProfile={<div data-testid="execution-profile-mount">Profile control</div>}
      />,
    );
    expect(screen.getByTestId("execution-profile-mount")).toBeVisible();
    expect(screen.getByRole("region", { name: "New Code thread" })).toBeVisible();
  });

  it("leaves the execution-profile control off a draft whose mode it cannot bind", () => {
    const tab = {
      id: ids.tab,
      kind: "draft-thread",
      mode: "chat",
      title: "New Chat thread",
    } as WorkspaceTab;
    render(
      <WorkspaceView
        {...propsFor(tab)}
        draftExecutionProfile={<div data-testid="execution-profile-mount">Profile control</div>}
      />,
    );
    expect(screen.queryByTestId("execution-profile-mount")).toBeNull();
  });

  it("threads the GitHub onboarding clients into the Code draft composer", () => {
    const tab = {
      id: ids.tab,
      kind: "draft-thread",
      mode: "code",
      title: "New Code thread",
    } as WorkspaceTab;
    const githubClient = {
      authenticationSnapshot: vi.fn(),
      executeAuthenticationCommand: vi.fn(),
      readCatalogue: vi.fn(),
      recordRecentRepository: vi.fn(),
    } as never;
    const githubCloneClient = {
      execute: vi.fn(),
      listOperations: vi.fn(),
    } as never;
    render(
      <WorkspaceView
        {...propsFor(tab)}
        githubClient={githubClient}
        githubCloneClient={githubCloneClient}
        onCreateProject={vi.fn(async () => undefined)}
      />,
    );
    expect(screen.getByRole("button", { name: "GitHub repository" })).toBeVisible();
  });
});

describe("WorkspaceView preview tab", () => {
  it("renders a persistent preview tab through the existing preview shell", async () => {
    const previewTab: WorkspaceTab = {
      id: ids.tab,
      kind: "preview",
      mode: "work",
      title: "report.pdf",
      targetId: "11111111-2222-4333-8444-555555555555",
      projectId: "00000000-0000-4000-8000-000000000899",
      hostId: "22222222-3333-4444-8555-666666666666",
      targetKind: "file",
      opaqueRef: "opaque-token",
      displayName: "report.pdf",
    } as WorkspaceTab;
    const base = propsFor(previewTab);
    const previewClient = {
      open: vi.fn(async () => ({ kind: "unauthorized" })),
      readChunks: vi.fn(async () => ({ kind: "chunks", chunks: [] })),
      cancel: vi.fn(async () => undefined),
    } as never;
    render(<WorkspaceView {...base} previewClient={previewClient} />);
    // The preview shell renders the display name as the section heading.
    expect(await screen.findByRole("heading", { name: "report.pdf" })).toBeVisible();
    // An unauthorized outcome surfaces an honest access message, never a
    // guessed file body.
    expect(screen.getByRole("alert")).toHaveTextContent("You do not have access to this preview.");
  });
});

describe("WorkspaceView tab isolation", () => {
  it("does not retain an active Browser context when another Browser tab becomes active", async () => {
    const secondTabId = "10000000-0000-4000-8000-000000000008" as WorkspaceTab["id"];
    const firstThreadId = ids.thread;
    const secondThreadId = "10000000-0000-4000-8000-000000000009";
    const firstTab = {
      kind: "browser",
      id: ids.tab,
      mode: "code",
      title: "Browser A",
      threadId: firstThreadId,
    } as WorkspaceTab;
    const secondTab = {
      kind: "browser",
      id: secondTabId,
      mode: "code",
      title: "Browser B",
      threadId: secondThreadId,
    } as WorkspaceTab;
    const contextId = "60000000-0000-4000-8000-000000000001";
    const browserAutomationClient = {
      inspectThread: vi.fn(async ({ threadId }) =>
        threadId === firstThreadId
          ? {
              status: "running",
              threadId: firstThreadId,
              context: {
                contextId,
                threadId: firstThreadId,
                actionId: "70000000-0000-4000-8000-000000000001",
                correlationId: "80000000-0000-4000-8000-000000000001",
                authority: {
                  hostId: "local",
                  mode: "code",
                  projectId: ids.project,
                  rootId: "40000000-0000-4000-8000-000000000001",
                  providerInstanceId: "50000000-0000-4000-8000-000000000001",
                  extension: { kind: "core" },
                },
                policy: {
                  profileMode: "isolated",
                  allowedOrigins: ["https://example.com"],
                  credentialFieldProtection: true,
                  maxConcurrentTabs: 1,
                  sessionTimeoutMs: 300_000,
                },
                state: "active",
                createdAt: "2026-08-05T18:00:00.000Z",
              },
              evidence: [],
            }
          : { status: "ready", threadId, evidence: [] },
      ),
      releaseThread: vi.fn(async ({ threadId }) => ({ status: "ready", threadId, evidence: [] })),
      inspect: vi.fn(async () => ({
        status: "running",
        threadId: firstThreadId,
        context: {
          contextId,
          threadId: firstThreadId,
          actionId: "70000000-0000-4000-8000-000000000001",
          correlationId: "80000000-0000-4000-8000-000000000001",
          authority: {
            hostId: "local",
            mode: "code",
            projectId: ids.project,
            rootId: "40000000-0000-4000-8000-000000000001",
            providerInstanceId: "50000000-0000-4000-8000-000000000001",
            extension: { kind: "core" },
          },
          policy: {
            profileMode: "isolated",
            allowedOrigins: ["https://example.com"],
            credentialFieldProtection: true,
            maxConcurrentTabs: 1,
            sessionTimeoutMs: 300_000,
          },
          state: "active",
          createdAt: "2026-08-05T18:00:00.000Z",
        },
        evidence: [],
      })),
    } as never;
    const firstProps = propsFor(firstTab);
    const { rerender } = render(
      <WorkspaceView {...firstProps} browserAutomationClient={browserAutomationClient} />,
    );
    expect(await screen.findByRole("button", { name: "Stop" })).toBeVisible();

    const secondProps = propsFor(secondTab);
    const secondLayout = {
      ...(secondProps.layout as Extract<WorkspaceViewProps["layout"], { kind: "pane" }>),
      surface: secondTab,
    };
    rerender(
      <WorkspaceView
        {...secondProps}
        browserAutomationClient={browserAutomationClient}
        layout={secondLayout}
        workspace={{
          ...secondProps.workspace,
          layouts: {
            ...secondProps.workspace.layouts,
            code: secondLayout,
          },
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Start browser" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
  });

  it("closes a Browser tab locally without waiting for authoritative cleanup", async () => {
    const browserTab = {
      kind: "browser",
      id: ids.tab,
      mode: "code",
      title: "Browser A",
      threadId: ids.thread,
    } as WorkspaceTab;
    const base = propsFor(browserTab);
    const inspectThread = vi.fn(async () => ({
      status: "ready",
      threadId: ids.thread,
      evidence: [],
    }));
    const releaseThread = vi.fn(() => new Promise(() => undefined));
    const browserAutomationClient = { inspectThread, releaseThread } as never;
    render(<WorkspaceView {...base} browserAutomationClient={browserAutomationClient} />);

    await closePaneShowing("Browser A");

    await waitFor(() => expect(releaseThread).toHaveBeenCalledOnce());
    expect(releaseThread).toHaveBeenCalledWith({ threadId: ids.thread });
    expect(base.onClosePane).toHaveBeenCalledWith(ids.pane);
    expect(vi.mocked(base.onClosePane).mock.invocationCallOrder[0]).toBeLessThan(
      releaseThread.mock.invocationCallOrder[0]!,
    );
  });

  it("stops the shell a closing terminal tab owns, and leaves the thread's own terminal running", async () => {
    const terminalId = "b0000000-0000-4000-8000-000000000001";
    const secondary = { ...codeTab("code-terminal", "Terminal 2"), terminalId } as WorkspaceTab;
    const secondaryProps = propsFor(secondary);
    const executeOperation = secondaryProps.codeController.client!.executeOperation as ReturnType<
      typeof vi.fn
    >;
    render(<WorkspaceView {...secondaryProps} />);

    await closePaneShowing("Terminal 2");

    // This tab minted the identity and is the only thing that carries it, so
    // closing it without stopping the shell would strand a running process.
    await waitFor(() =>
      expect(executeOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "stop-terminal",
          terminalId,
          threadId: codeIds.thread,
          checkoutId: codeIds.checkout,
        }),
      ),
    );

    const sharedProps = propsFor(codeTab("code-terminal", "Terminal"));
    const shared = sharedProps.codeController.client!.executeOperation as ReturnType<typeof vi.fn>;
    render(<WorkspaceView {...sharedProps} />);
    await closePaneShowing("Terminal");

    // A tab with no identity of its own only views the thread's original
    // terminal, which stays reachable from the thread's Terminal surface.
    await waitFor(() => expect(sharedProps.onClosePane).toHaveBeenCalled());
    expect(shared).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "stop-terminal" as const }),
    );
  });

  // The tab is the only thing carrying the identity, so if it goes while the
  // shell is still running there is nothing left to retry or stop it with.
  it("keeps a terminal tab when its shell will not stop", async () => {
    const terminalId = "b0000000-0000-4000-8000-000000000002";
    const secondary = { ...codeTab("code-terminal", "Terminal 3"), terminalId } as WorkspaceTab;
    const secondaryProps = propsFor(secondary);
    const executeOperation = secondaryProps.codeController.client!.executeOperation as ReturnType<
      typeof vi.fn
    >;
    executeOperation.mockImplementation(async (command) =>
      command.kind === "stop-terminal"
        ? {
            kind: "operation-failed",
            operationId: command.operationId,
            failure: { category: "failed", message: "The terminal could not be stopped." },
          }
        : gitObservation,
    );
    render(<WorkspaceView {...secondaryProps} />);

    await closePaneShowing("Terminal 3");

    await waitFor(() =>
      expect(executeOperation).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "stop-terminal" as const }),
      ),
    );
    expect(secondaryProps.onClosePane).not.toHaveBeenCalled();
  });

  // A terminal the host no longer owns has already stopped, so there is nothing
  // left to strand. Keeping the tab open would leave the user unable to close a
  // shell they already ended from inside it.
  it("closes a terminal tab whose shell has already stopped", async () => {
    const terminalId = "b0000000-0000-4000-8000-000000000003";
    const secondary = { ...codeTab("code-terminal", "Terminal 4"), terminalId } as WorkspaceTab;
    const secondaryProps = propsFor(secondary);
    const executeOperation = secondaryProps.codeController.client!.executeOperation as ReturnType<
      typeof vi.fn
    >;
    executeOperation.mockImplementation(async (command) =>
      command.kind === "stop-terminal"
        ? {
            kind: "operation-failed",
            operationId: command.operationId,
            failure: { category: "unavailable", message: "Terminal is unavailable." },
          }
        : gitObservation,
    );
    render(<WorkspaceView {...secondaryProps} />);

    await closePaneShowing("Terminal 4");

    await waitFor(() => expect(secondaryProps.onClosePane).toHaveBeenCalledWith(ids.pane));
  });

  it("closes one local server's tab without releasing the thread's other contexts", async () => {
    // Releasing the thread would stop every context it owns, taking the other
    // local servers' sessions down with this one.
    const contextId = "60000000-0000-4000-8000-000000000002";
    const browserTab = {
      kind: "browser",
      id: ids.tab,
      mode: "code",
      title: "Browser A",
      threadId: ids.thread,
      contextId,
    } as WorkspaceTab;
    const base = propsFor(browserTab);
    const releaseThread = vi.fn(async () => ({ status: "ready", evidence: [] }));
    const stop = vi.fn(async () => ({ status: "ready", evidence: [] }));
    render(
      <WorkspaceView
        {...base}
        browserAutomationClient={
          {
            inspect: vi.fn(async () => ({ status: "ready", threadId: ids.thread, evidence: [] })),
            inspectThread: vi.fn(),
            releaseThread,
            stop,
          } as never
        }
      />,
    );

    await closePaneShowing("Browser A");

    await waitFor(() => expect(stop).toHaveBeenCalledWith({ contextId, threadId: ids.thread }));
    expect(releaseThread).not.toHaveBeenCalled();
  });

  it("still closes a Browser tab locally when best-effort server cleanup is unavailable", async () => {
    const browserTab = {
      kind: "browser",
      id: ids.tab,
      mode: "code",
      title: "Browser A",
      threadId: ids.thread,
    } as WorkspaceTab;
    const base = propsFor(browserTab);
    const releaseThread = vi.fn(async () => {
      throw new Error("offline");
    });
    render(
      <WorkspaceView
        {...base}
        browserAutomationClient={{ inspectThread: vi.fn(), releaseThread } as never}
      />,
    );

    await closePaneShowing("Browser A");

    await waitFor(() => expect(releaseThread).toHaveBeenCalledOnce());
    expect(base.onClosePane).toHaveBeenCalledWith(ids.pane);
  });
});

describe("WorkspaceView Work overview", () => {
  it("keeps quick-start disabled until the exact Project is explicitly available", () => {
    const projectId = "00000000-0000-4000-8000-000000000901" as never;
    render(
      <WorkspaceView
        {...workProjectPropsFor({
          availability: {
            projectId,
            status: "unavailable",
            reason: "missing",
            observedAt: "2026-07-26T21:00:00.000Z" as ProjectAvailability["observedAt"],
          },
          workMutationClient: undefined,
          workOverviewClient: undefined,
          project: {
            id: projectId,
            type: "work",
            name: "Workspace",
            lifecycle: "active",
            pinned: true,
            rank: "0/1" as ProjectSummary["rank"],
            version: 1 as ProjectSummary["version"],
            createdAt: "2026-07-26T21:00:00.000Z" as ProjectSummary["createdAt"],
            updatedAt: "2026-07-26T21:00:00.000Z" as ProjectSummary["updatedAt"],
            binding: { canonicalRoot: "/Users/example/Workspace" },
            bindingRevisionId: "30000000-0000-4000-8000-000000000901" as never,
          },
          promotionReload: async () => undefined,
        })}
        availabilityByProject={new Map()}
        workCreateThreadAvailable
        onCreateWorkThread={vi.fn(async () => true)}
      />,
    );

    const composer = screen.getByRole("region", { name: "Work quick start" });
    expect(
      within(composer).getByRole("textbox", { name: "Start a new Work thread" }),
    ).toBeDisabled();
  });

  it("creates from the exact Project tab instead of ambient active Project state", async () => {
    const user = userEvent.setup();
    const projectId = "00000000-0000-4000-8000-000000000901" as never;
    const onCreateWorkThread = vi.fn(async () => true);
    render(
      <WorkspaceView
        {...workProjectPropsFor({
          availability: {
            projectId,
            status: "available",
            observedAt: "2026-07-26T21:00:00.000Z" as ProjectAvailability["observedAt"],
          },
          workMutationClient: undefined,
          workOverviewClient: undefined,
          project: {
            id: projectId,
            type: "work",
            name: "Workspace",
            lifecycle: "active",
            pinned: true,
            rank: "0/1" as ProjectSummary["rank"],
            version: 1 as ProjectSummary["version"],
            createdAt: "2026-07-26T21:00:00.000Z" as ProjectSummary["createdAt"],
            updatedAt: "2026-07-26T21:00:00.000Z" as ProjectSummary["updatedAt"],
            binding: { canonicalRoot: "/Users/example/Workspace" },
            bindingRevisionId: "30000000-0000-4000-8000-000000000901" as never,
          },
          promotionReload: async () => undefined,
        })}
        workCreateThreadAvailable
        onCreateWorkThread={onCreateWorkThread}
      />,
    );

    const composer = screen.getByRole("region", { name: "Work quick start" });
    await user.type(
      within(composer).getByRole("textbox", { name: "Start a new Work thread" }),
      "Prepare the brief",
    );
    await user.click(within(composer).getByRole("button", { name: "Start thread" }));

    await waitFor(() => {
      expect(onCreateWorkThread).toHaveBeenCalledWith(projectId, "Prepare the brief");
    });
  });

  it("reloads overview and promotion after creating a starter artifact", async () => {
    const user = userEvent.setup();
    const projectId = "00000000-0000-4000-8000-000000000901" as never;
    const load = vi
      .fn()
      .mockResolvedValueOnce({
        projectId,
        filesAndArtifacts: [],
        workflowsAndThreads: [],
        approvals: [],
        versions: [],
        validation: [],
        exports: [],
      })
      .mockResolvedValueOnce({
        projectId,
        filesAndArtifacts: [{ id: "artifact-1", label: "notes.md", detail: "markdown" }],
        workflowsAndThreads: [],
        approvals: [],
        versions: [],
        validation: [],
        exports: [],
      });
    const mutate = vi.fn(async () => ({
      requestId: "33333333-3333-4333-8333-333333333333",
      outcome: {
        kind: "created" as const,
        artifact: {
          artifactId: "11111111-1111-4111-8111-111111111111",
          projectId,
          format: "markdown" as const,
          artifactRef: "opaque-artifact-token-1",
          displayName: "notes.md",
          createdAt: "2026-07-26T21:00:00.000Z",
        },
        version: {
          versionId: "22222222-2222-4222-8222-222222222222",
          artifactId: "11111111-1111-4111-8111-111111111111",
          projectId,
          format: "markdown" as const,
          sourceVersion: {
            contentSha256: "0".repeat(64),
            byteSize: 12,
            observedAt: "2026-07-26T21:00:00.000Z",
          },
          createdBy: {
            kind: "local-user" as const,
            actorId: "44444444-4444-4444-8444-444444444444",
          },
          createdAt: "2026-07-26T21:00:00.000Z",
          sequence: 1,
        },
        previewTarget: {
          targetId: "55555555-5555-4555-8555-555555555555",
          projectId,
          hostId: "66666666-6666-4666-8666-666666666666",
          kind: "artifact-version" as const,
          opaqueRef: "opaque-artifact-token-1",
          displayName: "notes.md",
        },
      },
    }));
    const promotionReload = vi.fn(async () => undefined);

    render(
      <WorkspaceView
        {...workProjectPropsFor({
          availability: {
            projectId,
            status: "available",
            observedAt: "2026-07-26T21:00:00.000Z" as ProjectAvailability["observedAt"],
          },
          workMutationClient: { mutate } as never,
          workOverviewClient: { load } as never,
          project: {
            id: projectId,
            type: "work",
            name: "Workspace",
            lifecycle: "active",
            pinned: true,
            rank: "0/1" as ProjectSummary["rank"],
            version: 1 as ProjectSummary["version"],
            createdAt: "2026-07-26T21:00:00.000Z" as ProjectSummary["createdAt"],
            updatedAt: "2026-07-26T21:00:00.000Z" as ProjectSummary["updatedAt"],
            binding: { canonicalRoot: "/Users/example/Workspace" },
            bindingRevisionId: "30000000-0000-4000-8000-000000000901" as never,
          },
          promotionReload,
        })}
      />,
    );

    const composer = await screen.findByRole("region", { name: "Create starter artifact" });
    await user.type(
      within(composer).getByRole("textbox", { name: "Starter artifact content" }),
      "# Notes",
    );
    await user.click(within(composer).getByRole("button", { name: "Create starter artifact" }));

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        kind: "create-artifact",
        requestId: expect.any(String),
        projectId,
        format: "markdown",
        displayName: "notes.md",
        content: "# Notes",
      });
      expect(load).toHaveBeenCalledTimes(2);
      expect(promotionReload).toHaveBeenCalledTimes(1);
    });
  });
});

describe("WorkspaceView Work thread tab", () => {
  it("renders a functional Work thread workspace composer", async () => {
    const mutate = vi.fn().mockResolvedValue({
      outcome: {
        kind: "created",
        artifact: {
          displayName: "ship-the-preview.md",
        },
      },
    });
    const threadClient = {
      bootstrap: vi.fn().mockResolvedValue({
        threads: [
          {
            id: ids.thread,
            projectId: ids.project,
            title: "Draft brief",
            lifecycle: "active",
            providerInstanceId: "00000000-0000-4000-8000-000000000901",
            modelId: "gpt-4",
            version: 1,
            createdAt: "2026-07-26T20:00:00.000Z",
            updatedAt: "2026-07-26T20:00:00.000Z",
          },
        ],
      }),
      execute: vi.fn(),
    };

    const project = {
      id: ids.project,
      type: "work",
      name: "Knowledge Base",
      lifecycle: "active",
      pinned: true,
      rank: "0/1",
      version: 1,
      createdAt: "2026-07-26T20:00:00.000Z",
      updatedAt: "2026-07-26T20:00:00.000Z",
      binding: { canonicalRoot: "/Users/example/Documents/work-root" },
      bindingHistory: [],
    } as unknown as ProjectSummary;

    render(
      <WorkspaceView
        {...propsFor({
          id: ids.tab as never,
          kind: "work-thread",
          mode: "work",
          threadId: ids.thread as never,
          title: "Draft brief",
        })}
        workMutationClient={{ mutate } as never}
        workThreadClient={threadClient as never}
        projects={[project]}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Draft brief" })).toBeVisible();
    expect(
      await screen.findByRole("dialog", { name: "Environment for Knowledge Base" }),
    ).toBeVisible();
    expect(screen.getByText("work-root")).toBeVisible();
    const composer = screen.getByRole("textbox", { name: "Work prompt" });
    await userEvent.type(composer, "Ship the preview");
    await userEvent.click(screen.getByRole("button", { name: "Create artifact" }));
    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "create-artifact",
          projectId: ids.project,
          format: "markdown",
          displayName: "ship-the-preview.md",
          content: "Ship the preview",
        }),
      );
    });
  });
});

describe("WorkspaceView Chat overview", () => {
  it("mounts Chat quick start in the existing Project workspace tab", async () => {
    const project = {
      id: "00000000-0000-4000-8000-000000000912",
      type: "chat",
      name: "Launch planning",
      lifecycle: "active",
      pinned: true,
      rank: "0/1",
      version: 1,
      createdAt: now,
      updatedAt: now,
    } as never as ProjectSummary;
    const tab = {
      id: ids.tab,
      kind: "project",
      mode: "chat",
      title: project.name,
      projectId: project.id,
    } as WorkspaceTab;
    const onCreateChatProjectThread = vi.fn(async () => false);
    const base = propsFor(tab);
    render(
      <WorkspaceView
        {...base}
        chatController={
          { ...base.chatController, bootstrap: { threads: [] }, status: "ready" } as never
        }
        mode="chat"
        onCreateChatProjectThread={onCreateChatProjectThread}
        projects={[project]}
        workspace={{
          ...base.workspace,
          activeMode: "chat",
          contextByMode: {
            ...base.workspace.contextByMode,
            chat: { host: "local" as never, mode: "chat", projectId: project.id, boundRoot: null },
          },
        }}
      />,
    );

    const quickStart = await screen.findByRole("region", { name: "Chat quick start" });
    fireEvent.change(within(quickStart).getByRole("textbox", { name: "Start a new Chat thread" }), {
      target: { value: "Prepare launch brief" },
    });
    fireEvent.click(within(quickStart).getByRole("button", { name: "Start thread" }));

    await waitFor(() =>
      expect(onCreateChatProjectThread).toHaveBeenCalledWith(project.id, "Prepare launch brief"),
    );
  });

  it("disables Chat Project quick start for an archived Project", async () => {
    const project = {
      id: "00000000-0000-4000-8000-000000000913",
      type: "chat",
      name: "Archived planning",
      lifecycle: "archived",
      pinned: false,
      rank: "0/1",
      version: 1,
      createdAt: now,
      updatedAt: now,
    } as never as ProjectSummary;
    const tab = {
      id: ids.tab,
      kind: "project",
      mode: "chat",
      title: project.name,
      projectId: project.id,
    } as WorkspaceTab;
    const base = propsFor(tab);
    render(
      <WorkspaceView
        {...base}
        chatController={
          { ...base.chatController, bootstrap: { threads: [] }, status: "ready" } as never
        }
        mode="chat"
        onCreateChatProjectThread={vi.fn(async () => true)}
        projects={[project]}
      />,
    );

    const quickStart = await screen.findByRole("region", { name: "Chat quick start" });
    expect(
      within(quickStart).getByRole("textbox", { name: "Start a new Chat thread" }),
    ).toBeDisabled();
    expect(within(quickStart).getByRole("button", { name: "Start thread" })).toBeDisabled();
  });

  it("opens a recent Chat Project thread from its Overview", async () => {
    const project = {
      id: "00000000-0000-4000-8000-000000000914",
      type: "chat",
      name: "Launch planning",
      lifecycle: "active",
      pinned: true,
      rank: "0/1",
      version: 1,
      createdAt: now,
      updatedAt: now,
    } as never as ProjectSummary;
    const thread = {
      id: "00000000-0000-4000-8000-000000000915",
      projectId: project.id,
      title: "Resume planning",
    };
    const tab = {
      id: ids.tab,
      kind: "project",
      mode: "chat",
      title: project.name,
      projectId: project.id,
    } as WorkspaceTab;
    const base = propsFor(tab);
    const onOpenChatThread = vi.fn();
    render(
      <WorkspaceView
        {...base}
        chatClient={
          { thread: vi.fn(async () => ({ thread, attachments: [], workItems: [] })) } as never
        }
        chatController={
          { ...base.chatController, bootstrap: { threads: [thread] }, status: "ready" } as never
        }
        mode="chat"
        onOpenChatThread={onOpenChatThread}
        projects={[project]}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Resume planning/i }));
    expect(onOpenChatThread).toHaveBeenCalledWith(thread.id, thread.title, project.id);
  });

  it("routes bounded Chat Overview sections to the Project thread hierarchy", async () => {
    const project = {
      id: "00000000-0000-4000-8000-000000000916",
      type: "chat",
      name: "Long-running planning",
      lifecycle: "active",
      pinned: true,
      rank: "0/1",
      version: 1,
      createdAt: now,
      updatedAt: now,
    } as never as ProjectSummary;
    const threads = Array.from({ length: 10 }, (_, index) => ({
      id: `00000000-0000-4000-8000-0000000009${index + 20}`,
      projectId: project.id,
      title: `Planning ${index + 1}`,
    }));
    const tab = {
      id: ids.tab,
      kind: "project",
      mode: "chat",
      title: project.name,
      projectId: project.id,
    } as WorkspaceTab;
    const base = propsFor(tab);
    const onViewAllChatProjectThreads = vi.fn();
    render(
      <WorkspaceView
        {...base}
        chatClient={
          {
            thread: vi.fn(async (threadId: string) => ({
              thread: threads.find((candidate) => candidate.id === threadId),
              attachments: [],
              workItems: [],
            })),
          } as never
        }
        chatController={
          { ...base.chatController, bootstrap: { threads }, status: "ready" } as never
        }
        mode="chat"
        onViewAllChatProjectThreads={onViewAllChatProjectThreads}
        projects={[project]}
      />,
    );

    fireEvent.click(
      (await screen.findAllByRole("button", { name: "View all Project threads" }))[0]!,
    );
    expect(onViewAllChatProjectThreads).toHaveBeenCalledWith(project.id);
  });

  it("does not expose a Project-thread route for an archived Chat Project", async () => {
    const project = {
      id: "00000000-0000-4000-8000-000000000917",
      type: "chat",
      name: "Archived planning",
      lifecycle: "archived",
      pinned: true,
      rank: "0/1",
      version: 1,
      createdAt: now,
      updatedAt: now,
    } as never as ProjectSummary;
    const threads = Array.from({ length: 10 }, (_, index) => ({
      id: `00000000-0000-4000-8000-0000000009${index + 40}`,
      projectId: project.id,
      title: `Archived planning ${index + 1}`,
    }));
    const tab = {
      id: ids.tab,
      kind: "project",
      mode: "chat",
      title: project.name,
      projectId: project.id,
    } as WorkspaceTab;
    const base = propsFor(tab);
    render(
      <WorkspaceView
        {...base}
        chatClient={{ thread: vi.fn(async () => ({ attachments: [], workItems: [] })) } as never}
        chatController={
          { ...base.chatController, bootstrap: { threads }, status: "ready" } as never
        }
        mode="chat"
        onViewAllChatProjectThreads={vi.fn()}
        projects={[project]}
      />,
    );

    await screen.findByText("Showing 8 of 10 Project threads.");
    expect(
      screen.queryByRole("button", { name: "View all Project threads" }),
    ).not.toBeInTheDocument();
  });
});

const now = "2026-07-29T12:00:00.000Z";

describe("WorkspaceView Chat thread Environment", () => {
  it("mounts authoritative Chat context inside the tab without filesystem or approval sections", async () => {
    const user = userEvent.setup();
    const now = "2026-07-28T16:00:00.000Z";
    const providerId = "20000000-0000-4000-8000-000000000001";
    const project = {
      id: ids.project,
      type: "chat",
      name: "Planning",
      lifecycle: "active",
      pinned: true,
      rank: "0/1",
      version: 1,
      createdAt: now,
      updatedAt: now,
    } as unknown as ProjectSummary;
    const thread = {
      id: ids.thread,
      projectId: ids.project,
      title: "Release plan",
      lifecycle: "active" as const,
      providerInstanceId: providerId,
      modelId: "model-a",
      researchEnabled: false,
      researchRouting: "automatic" as const,
      personalityInstructions: "Be concise.",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    const view = decodeChatThreadView({
      thread,
      turns: [],
      lastSequence: 0,
      contents: [],
      attachments: [],
      citations: [],
      workItems: [],
      workListVersion: 0,
      followUpVersion: 0,
    });
    const chatClient = {
      bootstrap: vi.fn(async () =>
        decodeChatBootstrap({
          settings: {
            defaultProviderInstanceId: providerId,
            defaultModelId: "model-a",
            defaultResearchEnabled: false,
            defaultResearchRouting: "automatic",
            defaultPersonalityInstructions: "Be concise.",
            version: 1,
            updatedAt: now,
          },
          threads: [thread],
        }),
      ),
      execute: vi.fn(),
      search: vi.fn(async () => []),
      subscribe: vi.fn(async function* () {}),
      thread: vi.fn(async () => view),
      upload: vi.fn(),
      discard: vi.fn(),
    };
    const canvasClient = {
      create: vi.fn(),
      threadReferenceCards: vi.fn(async () => ({
        mode: "chat" as const,
        threadId: ids.thread,
        projectId: ids.project,
        cards: [],
      })),
    } as never;
    const tab = {
      id: ids.tab,
      kind: "chat-thread",
      mode: "chat",
      threadId: ids.thread,
      title: "Release plan",
    } as WorkspaceTab;
    const base = propsFor(tab);
    const pinnedChat = {
      ...defaultEnvironmentPresentationState(),
      byMode: { ...defaultEnvironmentPresentationState().byMode, chat: "pinned" as const },
    };

    render(
      <WorkspaceView
        {...base}
        chatClient={chatClient as never}
        chatReadCursorStore={createChatReadCursorStore()}
        canvasClient={canvasClient}
        environmentPresentation={pinnedChat}
        mode="chat"
        projects={[project]}
      />,
    );

    expect(await screen.findByRole("region", { name: "Environment for Planning" })).toBeVisible();
    expect(screen.getByText("Virtual Project")).toBeVisible();
    expect(screen.getAllByText("Attachments").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Sources").length).toBeGreaterThan(0);
    expect(screen.queryByText("Git")).not.toBeInTheDocument();
    expect(screen.queryByText("Approvals")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Show canvas" }));
    expect(await screen.findByRole("region", { name: "Create Canvas" })).toBeVisible();
  });
});

function codeTab(kind: WorkspaceTab["kind"], title: string): WorkspaceTab {
  const base = {
    id: ids.tab,
    kind,
    mode: "code",
    threadId: codeIds.thread,
    title,
  };
  if (kind === "code-file") return { ...base, kind, relativePath: "README.md" } as WorkspaceTab;
  if (kind === "code-diff") return { ...base, kind, relativePath: "README.md" } as WorkspaceTab;
  if (kind === "apple-workbench") {
    return { ...base, kind, projectPath: "Fixture.xcodeproj" } as WorkspaceTab;
  }
  return base as WorkspaceTab;
}

function propsFor(tab: WorkspaceTab): WorkspaceViewProps {
  const client = codeClient();
  (client.executeOperation as ReturnType<typeof vi.fn>).mockImplementation(async (command) => {
    if (command.kind === "observe-pull-request") return pullRequestReviewNone;
    if (command.kind === "stop-terminal") {
      return {
        kind: "terminal-state",
        operationId: command.operationId,
        terminalId: command.terminalId,
        state: "exited",
        exitCode: 0,
      };
    }
    return gitObservation;
  });
  const layout = {
    kind: "pane",
    nodeId: ids.node,
    paneId: ids.pane,
    surface: tab,
  } as const;
  const codeControllers = createCodeThreadControllers();
  const props = {
    availabilityByProject: new Map(),
    chatClient: {} as never,
    chatController: {} as never,
    chatReadCursorStore: {} as never,
    codeControllers,
    codeController: {
      activeView: {
        checkout: {
          id: codeIds.checkout,
          repositoryId: "c0000000-0000-4000-8000-000000000001",
          kind: "existing-worktree",
          availability: "available",
          head: { kind: "branch", name: "feature/composition", oid: "a".repeat(40) },
          observedAt: "2026-07-21T12:00:00.000Z",
        },
        thread: {
          id: codeIds.thread,
          checkoutId: codeIds.checkout,
          executionPolicy: "approval-gated",
          title: "Composition",
          lifecycle: "active",
          deliveryTarget: {
            branchIntent: "feature/composition",
            proposedBaseBranch: "development",
            proposedBaseRepository: "octant",
            remoteName: "origin",
            outcomeKind: "opened-pr",
          },
        },
        lastSequence: 1,
      },
      client,
      conversation: [],
      providerRequests: [],
      answerProviderRequest: vi.fn(async () => true),

      turnActivity: new Map(),
      followUps: new Map(),
      pendingDraft: "",
      completeFollowUp: vi.fn(async () => true),
      markFollowUp: vi.fn(async () => true),
      refreshFollowUp: vi.fn(async () => undefined),
      sendFollowUp: vi.fn(async () => true),
      setPendingDraft: vi.fn(),
      status: "ready",
      threadUsage: { inputTokens: 0, outputTokens: 0, limits: [] },
      turnStatus: "idle",
    } as never,
    workPromotionController: {
      pendingProposals: [],
      availableArtifactRefs: [],
      deliveryTargetsByProject: new Map(),
      proposing: false,
      reload: vi.fn(async () => undefined),
      propose: vi.fn(async () => undefined),
      approve: vi.fn(async () => undefined),
      dismiss: vi.fn(async () => false),
    },
    codeProviderChoices: [],
    drag: stubSurfaceDragHandle(),
    layout: layout as never,
    mode: "code",
    onActivatePane: vi.fn(),
    onArchiveProject: vi.fn(),
    onCreateChat: vi.fn(),
    onClearFocus: vi.fn(),
    onClosePane: vi.fn(),
    onCommitResize: vi.fn(),
    onFocus: vi.fn(),
    onOpenCodeThread: vi.fn(),
    onOpenCodeSurface: vi.fn(),
    onPreviewResize: vi.fn(),
    onRelinkProject: vi.fn(),
    onRenameProject: vi.fn(),
    onSplitPane: vi.fn(),
    projects: [],
    providerController: {} as never,
    workspace: {
      windowId: ids.window,
      activeMode: "code",
      layouts: { chat: layout, work: layout, code: layout },
      activePaneIds: { chat: ids.pane, work: ids.pane, code: ids.pane },
      contextByMode: {
        chat: { host: "local", mode: "chat", projectId: null, boundRoot: null },
        work: { host: "local", mode: "work", projectId: null, boundRoot: null },
        code: { host: "local", mode: "code", projectId: null, boundRoot: null },
      },
      version: 1,
    } as never,
    environmentPresentation: defaultEnvironmentPresentationState(),
    onSetEnvironmentPresentation: vi.fn(),
    projectServerUrl: "http://localhost:0",
    projectWindowCapability: "test-capability",
  } as WorkspaceViewProps;
  // At runtime the shell holds one controller per open Code thread; these tests
  // stand in one for the thread the fixture tab is bound to.
  codeControllers.publish(codeIds.thread as never, props.codeController);
  if ("threadId" in tab) codeControllers.publish(tab.threadId as never, props.codeController);
  return props;
}

function workProjectPropsFor(input: {
  readonly availability: ProjectAvailability;
  readonly workMutationClient: WorkspaceViewProps["workMutationClient"];
  readonly workOverviewClient: WorkspaceViewProps["workOverviewClient"];
  readonly project: ProjectSummary;
  readonly promotionReload: () => Promise<void>;
}): WorkspaceViewProps {
  const tab: WorkspaceTab = {
    id: ids.tab,
    kind: "project",
    mode: "work",
    title: input.project.name,
    projectId: input.project.id,
  } as WorkspaceTab;
  const layout = {
    kind: "pane",
    nodeId: ids.node,
    paneId: ids.pane,
    surface: tab,
  } as const;
  return {
    ...propsFor(tab),
    availabilityByProject: new Map([[input.project.id, input.availability]]),
    ...(input.workMutationClient === undefined
      ? {}
      : { workMutationClient: input.workMutationClient }),
    ...(input.workOverviewClient === undefined
      ? {}
      : { workOverviewClient: input.workOverviewClient }),
    workPromotionController: {
      pendingProposals: [],
      availableArtifactRefs: [],
      deliveryTargetsByProject: new Map(),
      proposing: false,
      reload: input.promotionReload,
      propose: vi.fn(async () => undefined),
      approve: vi.fn(async () => undefined),
      dismiss: vi.fn(async () => false),
    },
    layout: layout as never,
    mode: "work",
    projects: [input.project],
    workspace: {
      windowId: ids.window,
      activeMode: "work",
      layouts: { chat: layout, work: layout, code: layout },
      activePaneIds: { chat: ids.pane, work: ids.pane, code: ids.pane },
      contextByMode: {
        chat: { host: "local", mode: "chat", projectId: null, boundRoot: null },
        work: { host: "local", mode: "work", projectId: input.project.id, boundRoot: null },
        code: { host: "local", mode: "code", projectId: null, boundRoot: null },
      },
      version: 1,
    } as never,
  };
}
