import type { AgentRunClient } from "@octant/client-runtime/agent-run-client";
import type { CodeClient } from "@octant/client-runtime/code-client";
import { decodeAgentRunId } from "@octant/contracts/agent-run";
import { decodeCodeThreadId } from "@octant/contracts/code";
import { decodePendingRequest, type PendingRequest } from "@octant/contracts/pending-requests";
import { decodeWorkThread } from "@octant/contracts/work-threads";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import {
  client,
  codeShellBootstrap,
  codeThreadId,
  codes,
  projectId,
  projectWindowCapability,
  projects,
  windowId,
  workProjectId,
  workProjects,
  workThreadId,
} from "./App.test-fixtures";

/**
 * Choosing Review request on a waiting subagent's row, rendered through the
 * whole shell because the row is found in the palette and the parent thread
 * is opened by the shell: the list the row came from and the list the shell
 * opens threads from are read separately and can disagree for a moment.
 *
 * A suite of its own, as the thread-rest suite is: a full-shell render leaves
 * state the next one in the same file trips over.
 */
const runId = decodeAgentRunId("30000000-0000-4000-8000-000000000003");
const lateCodeThreadId = decodeCodeThreadId("00000000-0000-4000-8000-0000000008f1");
const requestedAt = "2026-10-12T09:00:00.000Z";

function childRequest(input: {
  readonly mode: "code" | "work";
  readonly threadId: string;
  readonly threadTitle: string;
  readonly projectId: string;
}): PendingRequest {
  return decodePendingRequest({
    mode: input.mode,
    kind: "child-approval",
    projectId: input.projectId,
    threadId: input.threadId,
    threadTitle: input.threadTitle,
    child: { runId, role: "review", task: "Inspect parser" },
    text: "Run the parser tests?",
    requestedAt,
  });
}

/** The host's pending-requests route, which the shell reads through its own client. */
function hostListsPendingRequests(...requests: ReadonlyArray<PendingRequest>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!url.endsWith("/api/pending-requests")) throw new Error(`unexpected fetch ${url}`);
      return new Response(JSON.stringify({ requests, truncated: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function agentRuns(): AgentRunClient {
  return {
    parentSummary: vi.fn(async (parentThreadId) => ({
      parentThreadId,
      entries: [
        {
          runId,
          task: "Inspect parser",
          lifecycleStatus: "running",
          parentThreadId,
          requestId: String(runId),
          role: "review",
          executionKind: "octant-managed",
          usageQuality: "unavailable",
          resultAcknowledgement: { required: false, acknowledged: false },
          version: 1,
          updatedAt: "2026-10-12T09:00:00.000Z",
        },
      ],
    })),
    conversation: vi.fn(async () => {
      throw new Error("No live transcript in this fixture");
    }),
    center: vi.fn(),
    snapshotCanvas: vi.fn(),
    acknowledge: vi.fn(),
    cancel: vi.fn(),
    steer: vi.fn(),
    retry: vi.fn(),
    resume: vi.fn(),
    usageResume: vi.fn(),
  } as never;
}

/** The fixture Code client, plus a second thread the list shows only once `lateListed()` says so. */
function codesWithLateThread(lateListed: () => boolean): CodeClient {
  const base = codes();
  const late = async () => {
    const first = (await base.bootstrap()).threads[0];
    if (first === undefined) throw new Error("The Code fixture listed no thread.");
    return { ...first, id: lateCodeThreadId, title: "Late parent" };
  };
  return {
    ...base,
    navigation: vi.fn(async () => {
      const navigation = await base.navigation();
      return lateListed()
        ? ({ ...navigation, threads: [...navigation.threads, await late()] } as never)
        : navigation;
    }),
  };
}

async function reviewRequestFromPalette(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("region", { name: "Workspace pane: Controller foundation" });
  await user.keyboard("{Control>}k{/Control}");
  const search = await screen.findByRole("combobox", { name: "Search commands" });
  await waitFor(() => expect(search).toHaveFocus());
  await user.keyboard("review request");
  const row = await screen.findByRole("option", { name: /Review request/ });
  await user.click(row);
}

function shell(input: {
  readonly codeClient: CodeClient;
  readonly agentRunClient: AgentRunClient;
  readonly shellClient?: ReturnType<typeof client>;
  readonly workThreadClient?: unknown;
}) {
  return (
    <App
      agentRunClient={input.agentRunClient}
      codeClient={input.codeClient}
      isNarrow={false}
      launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
      projectClient={input.workThreadClient === undefined ? projects() : workProjects()}
      projectWindowCapability={projectWindowCapability}
      shellClient={input.shellClient ?? client(codeShellBootstrap())}
      {...(input.workThreadClient === undefined
        ? {}
        : { workThreadClient: input.workThreadClient as never })}
    />
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Review request on a waiting subagent", () => {
  it("opens the listed parent thread on its Agents tab with that subagent", async () => {
    const user = userEvent.setup();
    const agentRunClient = agentRuns();
    hostListsPendingRequests(
      childRequest({
        mode: "code",
        threadId: String(codeThreadId),
        threadTitle: "Controller foundation",
        projectId: String(projectId),
      }),
    );
    render(
      shell({
        agentRunClient,
        codeClient: codes(),
      }),
    );

    await reviewRequestFromPalette(user);

    const dock = await screen.findByRole("complementary", { name: "Right Utility Dock" });
    expect(await within(dock).findByRole("region", { name: "Subagent" })).toBeVisible();
    expect(agentRunClient.conversation).toHaveBeenCalledWith(runId);
  });

  it("reads the thread list once more and opens a parent that was not listed yet", async () => {
    const user = userEvent.setup();
    const agentRunClient = agentRuns();
    let listed = false;
    const codeClient = codesWithLateThread(() => listed);
    const shellClient = client(codeShellBootstrap());
    hostListsPendingRequests(
      childRequest({
        mode: "code",
        threadId: String(lateCodeThreadId),
        threadTitle: "Late parent",
        projectId: String(projectId),
      }),
    );
    render(
      shell({
        agentRunClient,
        codeClient,
        shellClient,
      }),
    );
    await screen.findByRole("region", { name: "Workspace pane: Controller foundation" });
    const readsBefore = vi.mocked(codeClient.navigation).mock.calls.length;
    // The host lists the thread after the window's list was read and before Review request.
    listed = true;

    await reviewRequestFromPalette(user);

    await waitFor(() =>
      expect(shellClient.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: expect.objectContaining({
            kind: "open-surface",
            surface: expect.objectContaining({ kind: "code-overview", threadId: lateCodeThreadId }),
          }),
        }),
      ),
    );
    expect(vi.mocked(codeClient.navigation).mock.calls.length).toBeGreaterThan(readsBefore);
    expect(screen.queryByText(/could not open Late parent/)).not.toBeInTheDocument();
  });

  it("says so when the thread list still does not hold the parent after a re-read", async () => {
    const user = userEvent.setup();
    const shellClient = client(codeShellBootstrap());
    hostListsPendingRequests(
      childRequest({
        mode: "code",
        threadId: String(lateCodeThreadId),
        threadTitle: "Late parent",
        projectId: String(projectId),
      }),
    );
    render(
      shell({
        agentRunClient: agentRuns(),
        codeClient: codesWithLateThread(() => false),
        shellClient,
      }),
    );

    await reviewRequestFromPalette(user);

    expect(
      await screen.findByText(/Octant could not open Late parent: this window no longer lists/),
    ).toBeVisible();
    expect(shellClient.execute).not.toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: "open-surface" }),
      }),
    );
  });

  it("switches a Code window to Work when the waiting subagent's parent is a Work thread", async () => {
    const user = userEvent.setup();
    const shellClient = client(codeShellBootstrap());
    const thread = decodeWorkThread({
      id: workThreadId,
      projectId: workProjectId,
      title: "Quarterly brief",
      lifecycle: "active",
      providerInstanceId: "90000000-0000-4000-8000-000000000001",
      modelId: "gpt-5",
      bindingRevisionId: "30000000-0000-4000-8000-000000000001",
      workingDirectory: ".",
      version: 1,
      createdAt: "2026-07-26T09:30:00.000Z",
      updatedAt: "2026-07-26T09:30:00.000Z",
    });
    const workNavigation = async () => ({ threads: [thread], runtime: [] });
    hostListsPendingRequests(
      childRequest({
        mode: "work",
        threadId: String(workThreadId),
        threadTitle: "Quarterly brief",
        projectId: String(workProjectId),
      }),
    );
    render(
      shell({
        agentRunClient: agentRuns(),
        codeClient: codes(),
        shellClient,
        workThreadClient: { bootstrap: vi.fn(workNavigation), navigation: vi.fn(workNavigation) },
      }),
    );

    await reviewRequestFromPalette(user);

    await waitFor(() =>
      expect(shellClient.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: expect.objectContaining({ kind: "set-active-mode", mode: "work" }),
        }),
      ),
    );
    await waitFor(() =>
      expect(shellClient.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: expect.objectContaining({
            kind: "open-surface",
            surface: expect.objectContaining({ kind: "work-thread", threadId: workThreadId }),
          }),
        }),
      ),
    );
  });
});
