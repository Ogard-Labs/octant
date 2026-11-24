import { describe, expect, it, vi } from "vitest";
import type { CodeThread, ProjectLinearTarget, WindowId } from "@octant/contracts";
import type { IntegrationAuthenticationSnapshot } from "@octant/contracts/integration";
import {
  LINEAR_ISSUE_GET_BY_IDENTIFIER_OPERATION,
  LINEAR_ISSUE_LIST_OPERATION,
} from "@octant/contracts/linear-issues";
import {
  LINEAR_READ_TOOL_NAME,
  LinearReadToolService,
  type LinearReadToolReader,
} from "./linearReadToolService";

const WINDOW_ID = "11111111-1111-4111-8111-111111111111" as WindowId;

const TARGET: ProjectLinearTarget = {
  teamId: "team-oct",
  teamKey: "OCT",
  teamName: "Octant",
  projectId: "proj-v1",
  projectName: "Preview 1",
};

const READY_SNAPSHOT: IntegrationAuthenticationSnapshot = {
  state: "ready",
  account: { login: "ogard-labs", source: "oauth", scopes: ["read"] },
  capabilities: [
    { operationId: LINEAR_ISSUE_LIST_OPERATION, available: true },
    { operationId: LINEAR_ISSUE_GET_BY_IDENTIFIER_OPERATION, available: true },
  ],
};

function makeThread(overrides: Partial<CodeThread> = {}): CodeThread {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    projectId: "33333333-3333-4333-8333-333333333333",
    bindingRevisionId: "44444444-4444-4444-8444-444444444444",
    lifecycle: "active",
    ...overrides,
  } as CodeThread;
}

function makeHarness(
  options: {
    readonly target?: ProjectLinearTarget | undefined;
    readonly thread?: CodeThread;
    readonly currentThread?: CodeThread | undefined;
    readonly snapshot?: IntegrationAuthenticationSnapshot;
    readonly executeOperation?: LinearReadToolReader["executeOperation"];
  } = {},
) {
  const thread = options.thread ?? makeThread();
  const current = "currentThread" in options ? options.currentThread : thread;
  const executeOperation =
    options.executeOperation ??
    vi.fn(async (operationId: string) => {
      if (operationId === LINEAR_ISSUE_LIST_OPERATION) {
        return {
          kind: "ok" as const,
          value: {
            rows: [
              {
                id: "issue-1",
                identifier: "OCT-42",
                title: "Rotate lin_api_SECRET12345678901234567890 and AKIAIOSFODNN7EXAMPLE",
                state: { name: "In Progress", type: "started" },
                assignee: "Henrik",
                teamId: "team-oct",
                teamKey: "OCT",
                projectId: "proj-v1",
                url: "https://linear.app/ogard-labs/issue/OCT-42",
              },
            ],
            hasNextPage: false,
          },
        };
      }
      return {
        kind: "ok" as const,
        value: {
          id: "issue-1",
          identifier: "OCT-42",
          title: "Ship mapping",
          state: { name: "In Progress", type: "started" },
          assignee: "Henrik",
          teamId: "team-oct",
          teamKey: "OCT",
          projectId: "proj-v1",
          url: "https://linear.app/ogard-labs/issue/OCT-42",
          description: "Body with lin_api_SECRET12345678901234567890 and AKIAIOSFODNN7EXAMPLE",
          descriptionTruncated: false,
          comments: [],
        },
      };
    });
  const ingestion = {
    record: vi.fn(() => ({
      kind: "recorded" as const,
      taint: { externalContentIngested: true, ingestedSources: ["linear-issue"] },
    })),
  };
  const service = new LinearReadToolService({
    reader: {
      snapshot: vi.fn(async () => options.snapshot ?? READY_SNAPSHOT),
      executeOperation,
    },
    ingestion,
    uuid: () => "55555555-5555-4555-8555-555555555555",
  });
  const toolSet = service.createToolSet({
    windowId: WINDOW_ID,
    thread,
    readThread: () => current,
    readProjectLinearTarget: () => ("target" in options ? options.target : TARGET),
  });
  return { toolSet, executeOperation, ingestion };
}

describe("LinearReadToolService", () => {
  it("omits octant_linear when the Project has no Linear binding", () => {
    const { toolSet } = makeHarness({ target: undefined });
    expect(toolSet.definitions).toEqual([]);
  });

  it("pins list and search queries to the Project's Linear team and project, redacts secrets, and journals outside content", async () => {
    const { toolSet, executeOperation, ingestion } = makeHarness();
    expect(toolSet.definitions.map((definition) => definition.name)).toEqual([
      LINEAR_READ_TOOL_NAME,
    ]);

    const outcome = await toolSet.execute({
      name: LINEAR_READ_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "list", assignee: "me", pageSize: 10 }),
    });
    expect(outcome.isError).toBe(false);
    expect(executeOperation).toHaveBeenCalledWith(
      LINEAR_ISSUE_LIST_OPERATION,
      {
        filter: {
          teamId: "team-oct",
          projectId: "proj-v1",
          stateCategory: "open",
          assigneeId: "me",
        },
        pageSize: 10,
      },
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(outcome.result)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(JSON.stringify(outcome.result)).not.toContain("lin_api_");
    expect(JSON.stringify(outcome.result)).toContain("[redacted]");
    expect(ingestion.record).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: { origin: "tool-result", sourceLabel: "linear-issues" },
      }),
    );

    const allStates = await toolSet.execute({
      name: LINEAR_READ_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "list", state: "all" }),
    });
    expect(allStates.isError).toBe(false);
    expect(executeOperation).toHaveBeenLastCalledWith(
      LINEAR_ISSUE_LIST_OPERATION,
      {
        filter: {
          teamId: "team-oct",
          projectId: "proj-v1",
        },
        pageSize: 20,
      },
      expect.any(AbortSignal),
    );

    const rejectedExtra = await toolSet.execute({
      name: LINEAR_READ_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "list", teamId: "other-team" }),
    });
    expect(rejectedExtra).toEqual({ result: { error: "invalid-linear-input" }, isError: true });
  });

  it("reads an issue by identifier inside the bound scope and withholds out-of-scope issues identically to missing ones", async () => {
    const { toolSet, executeOperation, ingestion } = makeHarness();
    const ok = await toolSet.execute({
      name: LINEAR_READ_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "get", identifier: "oct-42" }),
    });
    expect(ok.isError).toBe(false);
    expect(executeOperation).toHaveBeenCalledWith(
      LINEAR_ISSUE_GET_BY_IDENTIFIER_OPERATION,
      { identifier: "OCT-42" },
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(ok.result)).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(JSON.stringify(ok.result)).not.toContain("lin_api_");
    expect(ingestion.record).toHaveBeenCalledWith(
      expect.objectContaining({
        provenance: { origin: "tool-result", sourceLabel: "linear-issue" },
      }),
    );

    const foreignExecute = vi.fn(async () => ({
      kind: "ok" as const,
      value: {
        id: "issue-2",
        identifier: "OTHER-9",
        title: "Other team issue",
        state: { name: "Todo", type: "unstarted" },
        teamId: "team-other",
        teamKey: "OTHER",
        url: "https://linear.app/ogard-labs/issue/OTHER-9",
        description: "Private",
        descriptionTruncated: false,
        comments: [],
      },
    }));
    const foreign = makeHarness({ executeOperation: foreignExecute });
    const refusedByPrefix = await foreign.toolSet.execute({
      name: LINEAR_READ_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "get", identifier: "OTHER-9" }),
    });
    expect(refusedByPrefix).toMatchObject({
      isError: true,
      result: { error: "issue-not-found" },
    });
    expect(foreignExecute).not.toHaveBeenCalled();

    const refusedById = await foreign.toolSet.execute({
      name: LINEAR_READ_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "get", identifier: "issue-2" }),
    });
    expect(refusedById).toMatchObject({
      isError: true,
      result: { error: "issue-not-found" },
    });
    expect(foreign.ingestion.record).not.toHaveBeenCalled();
  });

  it("enforces profile tool constraints and stale thread authority", async () => {
    const constrained = makeHarness({
      thread: makeThread({ toolConstraints: ["octant_github"], profileDisplayName: "Reviewer" }),
    });
    expect(constrained.toolSet.definitions).toEqual([]);
    expect(
      await constrained.toolSet.execute({
        name: LINEAR_READ_TOOL_NAME,
        inputJson: JSON.stringify({ operation: "list" }),
      }),
    ).toMatchObject({
      isError: true,
      result: {
        error: "profile-tool-refused",
        message: 'Profile "Reviewer" does not permit "octant_linear".',
      },
    });

    const stale = makeHarness({ currentThread: undefined });
    expect(
      await stale.toolSet.execute({
        name: LINEAR_READ_TOOL_NAME,
        inputJson: JSON.stringify({ operation: "list" }),
      }),
    ).toEqual({ result: { error: "thread-stale" }, isError: true });
  });
});
