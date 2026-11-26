import { describe, expect, it } from "vitest";
import type { MobileRemoteTransport } from "./mobileInboxClient";
import { readMobileSubagents, stopMobileSubagent } from "./mobileSubagentsClient";

const threadId = "70000000-0000-4000-8000-000000000001";
const runId = "70000000-0000-4000-8000-000000000002";
const provider = "70000000-0000-4000-8000-000000000004";
const at = "2026-11-26T08:00:00.000Z";
const later = "2026-11-26T08:05:21.000Z";

type Sent = {
  readonly path: string;
  readonly query?: string | undefined;
  readonly body: Record<string, unknown>;
};
function host(answer: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const transport: MobileRemoteTransport = {
    hostId: "host",
    authenticatedFetch: async ({ path, query, body }) => {
      const entry: Sent = {
        path,
        query,
        body: body === undefined ? {} : JSON.parse(String(body)),
      };
      sent.push(entry);
      return answer(entry);
    },
  };
  return { sent, transport };
}

const observed = {
  kind: "observed",
  observationId: "obs-1",
  parentThreadId: threadId,
  mode: "code",
  control: "stop",
  providerInstanceId: provider,
  sessionId: "70000000-0000-4000-8000-000000000003",
  childAgentId: "child-1",
  modelId: "claude-sonnet",
  task: "Search the codebase for callers",
  lifecycleStatus: "running",
  latestSummary: "Reading apps/server/src/codeRoutes.ts",
  firstObservedAt: at,
  updatedAt: later,
  historyStatus: "partial",
  history: [],
};

describe("a thread's subagents on the phone", () => {
  it("lists the subagents Octant started and the ones the provider started in one list", async () => {
    const { sent, transport } = host(() =>
      Response.json({
        parentThreadId: threadId,
        entries: [
          {
            runId,
            task: "Condense group A areas",
            lifecycleStatus: "completed",
            route: { executionProviderInstanceId: provider, executionModelId: "opus" },
            normalizedReasoning: "medium",
            result: { reference: "r", text: "\nGroup A is done.\nMore detail", truncated: false },
            createdAt: at,
            updatedAt: later,
          },
        ],
        observations: [observed],
      }),
    );
    const read = await readMobileSubagents({ transport, threadId });
    expect(sent[0]).toMatchObject({
      path: "/api/agent-runs/parent-summary",
      query: `parentThreadId=${threadId}`,
    });
    expect(read).toEqual({
      status: "listed",
      truncated: false,
      subagents: [
        {
          id: runId,
          origin: "octant-started",
          task: "Condense group A areas",
          status: "completed",
          providerInstanceId: provider,
          modelId: "opus",
          effort: "medium",
          latest: "Group A is done.",
          result: "\nGroup A is done.\nMore detail",
          startedAt: at,
          updatedAt: later,
          stoppable: false,
        },
        {
          id: "obs-1",
          origin: "provider-started",
          task: "Search the codebase for callers",
          status: "running",
          providerInstanceId: provider,
          modelId: "claude-sonnet",
          latest: "Reading apps/server/src/codeRoutes.ts",
          startedAt: at,
          updatedAt: later,
          stoppable: true,
        },
      ],
    });
  });

  it("says the computer refused rather than showing an empty list to a device it does not admit", async () => {
    const { transport } = host(() => Response.json({ error: "no" }, { status: 403 }));
    expect(await readMobileSubagents({ transport, threadId })).toEqual({ status: "refused" });
  });

  it("drops a provider subagent that names another thread", async () => {
    const { transport } = host(() =>
      Response.json({
        parentThreadId: threadId,
        entries: [],
        observations: [{ ...observed, parentThreadId: "70000000-0000-4000-8000-000000000009" }],
      }),
    );
    expect(await readMobileSubagents({ transport, threadId })).toEqual({
      status: "listed",
      subagents: [],
      truncated: false,
    });
  });

  it("cancels an Octant-started run alone and asks the turn to stop a provider-started one", async () => {
    const { sent, transport } = host((request) =>
      request.path === "/api/agent-runs/cancel"
        ? Response.json({ results: [{ kind: "run-updated" }] })
        : Response.json({ status: "refused", reason: "not-live" }),
    );
    expect(
      await stopMobileSubagent({
        transport,
        threadId,
        subagent: { id: runId, origin: "octant-started" },
      }),
    ).toEqual({ status: "stop-requested" });
    expect(
      await stopMobileSubagent({
        transport,
        threadId,
        subagent: { id: "obs-1", origin: "provider-started" },
      }),
    ).toEqual({ status: "refused", message: "This subagent already finished." });
    expect(sent.map(({ path, body }) => ({ path, body }))).toEqual([
      { path: "/api/agent-runs/cancel", body: { runId, scope: "self" } },
      {
        path: "/api/agent-runs/observed/stop",
        body: { parentThreadId: threadId, observationId: "obs-1" },
      },
    ]);
  });
});
