import { describe, expect, it, vi } from "vitest";
import { linkedIssueUpdatePort } from "../../trackerIssues/agentIssueUpdates";
import type { CodeThread, LinkedIssueRef, ProjectLinearTarget, WindowId } from "@octant/contracts";
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
    const refusedByKey = await foreign.toolSet.execute({
      name: LINEAR_READ_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "get", identifier: "OTHER-9" }),
    });
    expect(refusedByKey).toMatchObject({
      isError: true,
      result: { error: "issue-not-found" },
    });

    const renamedTeam = makeHarness({
      executeOperation: vi.fn(async () => ({
        kind: "ok" as const,
        value: {
          id: "issue-3",
          identifier: "DEV-42",
          title: "Renamed team key issue",
          state: { name: "In Progress", type: "started" },
          teamId: "team-oct",
          teamKey: "DEV",
          projectId: "proj-v1",
          url: "https://linear.app/ogard-labs/issue/DEV-42",
          description: "Matches by stable teamId",
          descriptionTruncated: false,
          comments: [],
        },
      })),
    });
    const renamedOk = await renamedTeam.toolSet.execute({
      name: LINEAR_READ_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "get", identifier: "DEV-42" }),
    });
    expect(renamedOk.isError).toBe(false);

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

  it("pins reads to the Project's bound account, refuses model-supplied accountRef, and includes the account in outside-content references", async () => {
    const accountATarget: ProjectLinearTarget = {
      accountRef: "acct-a",
      teamId: "team-a-eng",
      teamKey: "ENG",
      teamName: "Engineering",
    };
    const snapshot = vi.fn(async (_signal: AbortSignal, accountRef?: string) =>
      accountRef === "acct-a"
        ? READY_SNAPSHOT
        : { state: "unauthorized" as const, capabilities: [], remediation: "Not connected" },
    );
    const executeOperation = vi.fn(
      async (operationId: string, input: unknown, _signal: AbortSignal, accountRef?: string) => {
        if (accountRef !== "acct-a") {
          return { kind: "refused" as const, reason: "Wrong account" };
        }
        if (operationId === LINEAR_ISSUE_LIST_OPERATION) {
          return {
            kind: "ok" as const,
            value: {
              rows: [
                {
                  id: "issue-a-1",
                  identifier: "ENG-1",
                  title: "Account A task",
                  state: { name: "Todo", type: "unstarted" },
                  teamId: "team-a-eng",
                  teamKey: "ENG",
                  url: "https://linear.app/personal/issue/ENG-1",
                },
              ],
              hasNextPage: false,
            },
          };
        }
        const id = (input as { readonly id?: string; readonly identifier?: string }).id;
        if (id === "issue-b-1") {
          return { kind: "refused" as const, reason: "That Linear issue is not available." };
        }
        return {
          kind: "ok" as const,
          value: {
            id: "issue-a-1",
            identifier: "ENG-1",
            title: "Account A task",
            state: { name: "Todo", type: "unstarted" },
            teamId: "team-a-eng",
            teamKey: "ENG",
            url: "https://linear.app/personal/issue/ENG-1",
            description: "Personal detail",
            descriptionTruncated: false,
            comments: [],
          },
        };
      },
    );
    const ingestion = {
      record: vi.fn(() => ({
        kind: "recorded" as const,
        taint: { externalContentIngested: true, ingestedSources: ["linear-issues"] },
      })),
    };
    const thread = makeThread();
    const service = new LinearReadToolService({
      reader: { snapshot, executeOperation },
      ingestion,
      uuid: () => "55555555-5555-4555-8555-555555555555",
    });
    const toolSet = service.createToolSet({
      windowId: WINDOW_ID,
      thread,
      readThread: () => thread,
      readProjectLinearTarget: () => accountATarget,
    });

    // Model cannot choose or pass an accountRef.
    const modelAccountAttempt = await toolSet.execute({
      name: LINEAR_READ_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "list", accountRef: "acct-b" }),
    });
    expect(modelAccountAttempt).toEqual({
      result: { error: "invalid-linear-input" },
      isError: true,
    });

    const listed = await toolSet.execute({
      name: LINEAR_READ_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "list" }),
    });
    expect(listed.isError).toBe(false);
    expect(snapshot).toHaveBeenCalledWith(expect.any(AbortSignal), "acct-a");
    expect(executeOperation).toHaveBeenCalledWith(
      LINEAR_ISSUE_LIST_OPERATION,
      expect.objectContaining({ filter: expect.objectContaining({ teamId: "team-a-eng" }) }),
      expect.any(AbortSignal),
      "acct-a",
    );
    expect(ingestion.record).toHaveBeenCalledWith(
      expect.objectContaining({ contentReference: "linear-issues-acct-a-ENG" }),
    );

    const searched = await toolSet.execute({
      name: LINEAR_READ_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "search", query: "task" }),
    });
    expect(searched.isError).toBe(false);
    expect(ingestion.record).toHaveBeenCalledWith(
      expect.objectContaining({ contentReference: "linear-search-acct-a-ENG" }),
    );

    const gotOwn = await toolSet.execute({
      name: LINEAR_READ_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "get", identifier: "ENG-1" }),
    });
    expect(gotOwn.isError).toBe(false);
    expect(ingestion.record).toHaveBeenCalledWith(
      expect.objectContaining({ contentReference: "linear-issue-acct-a-ENG-1" }),
    );

    // An issue from account B is withheld identically to a missing issue.
    const gotForeign = await toolSet.execute({
      name: LINEAR_READ_TOOL_NAME,
      inputJson: JSON.stringify({ operation: "get", identifier: "issue-b-1" }),
    });
    expect(gotForeign).toMatchObject({
      isError: true,
      result: { error: "issue-not-found" },
    });
  });
});

describe("LinearReadToolService issue updates", () => {
  const linked = { forge: "linear" as const, identifier: "OCT-42", issueId: "issue-1" };

  function updateHarness(input: {
    readonly executionPolicy: CodeThread["executionPolicy"];
    readonly projectAllowsUpdates?: boolean;
    readonly lifecycle?: CodeThread["lifecycle"];
  }) {
    const thread = makeThread({ executionPolicy: input.executionPolicy });
    const current =
      input.lifecycle === undefined ? thread : { ...thread, lifecycle: input.lifecycle };
    let links: ReadonlyArray<LinkedIssueRef> = [linked];
    const ask = vi.fn(async (_summary: string, _signal?: AbortSignal) => "approved" as const);
    const writes = {
      agentSetState: vi.fn(async () => ({ status: "applied" as const })),
      agentComment: vi.fn(async () => ({ status: "applied" as const })),
    };
    const toolSet = new LinearReadToolService({
      reader: { snapshot: vi.fn(async () => READY_SNAPSHOT), executeOperation: vi.fn() },
      ingestion: { record: vi.fn() },
    }).createToolSet({
      windowId: WINDOW_ID,
      thread,
      readThread: () => current,
      readProjectLinearTarget: () => TARGET,
      issueUpdates: linkedIssueUpdatePort({
        linked: () => links,
        projectAllowsUpdates: () => input.projectAllowsUpdates === true,
        readOutsideContent: () => false,
        ask,
        writes,
      }),
    });
    const run = (value: unknown) =>
      toolSet.execute({ name: LINEAR_READ_TOOL_NAME, inputJson: JSON.stringify(value) });
    return {
      run,
      ask,
      writes,
      unlink: () => {
        links = [];
      },
    };
  }

  it("refuses an approved update when the person unlinked the issue while the card waited", async () => {
    const gated = updateHarness({ executionPolicy: "approval-gated" });
    gated.ask.mockImplementation(async () => {
      gated.unlink();
      return "approved" as const;
    });
    expect(
      await gated.run({ operation: "comment", identifier: "OCT-42", body: "Started." }),
    ).toMatchObject({ result: { error: "issue-not-linked" }, isError: true });
    expect(gated.writes.agentComment).not.toHaveBeenCalled();
  });

  it("the agent cannot set the state of an issue that is not linked to its thread", async () => {
    const { run, writes, ask } = updateHarness({ executionPolicy: "full-access" });
    expect(await run({ operation: "set-state", identifier: "OCT-7", state: "Done" })).toMatchObject(
      {
        result: { error: "issue-not-linked" },
        isError: true,
      },
    );
    expect(ask).not.toHaveBeenCalled();
    expect(writes.agentSetState).not.toHaveBeenCalled();
  });

  it("refuses in Plan, writes at Full access without asking, and asks below it", async () => {
    const plan = updateHarness({ executionPolicy: "plan" });
    expect(
      await plan.run({ operation: "comment", identifier: "OCT-42", body: "Started." }),
    ).toMatchObject({ result: { error: "plan-mode-read-only" }, isError: true });
    expect(plan.writes.agentComment).not.toHaveBeenCalled();

    const full = updateHarness({ executionPolicy: "full-access" });
    expect(
      await full.run({ operation: "set-state", identifier: "oct-42", state: "In Review" }),
    ).toMatchObject({ isError: false });
    expect(full.ask).not.toHaveBeenCalled();
    expect(full.writes.agentSetState).toHaveBeenCalledWith(
      String(makeThread().id),
      linked,
      "In Review",
      undefined,
    );

    const gated = updateHarness({ executionPolicy: "approval-gated" });
    await gated.run({ operation: "comment", identifier: "OCT-42", body: "Rotate token=abc123" });
    expect(gated.ask).toHaveBeenCalledWith(
      "Comment on OCT-42 under your name?\n\nRotate [redacted]",
      undefined,
    );
    expect(gated.writes.agentComment).toHaveBeenCalledWith(
      String(makeThread().id),
      linked,
      "Rotate [redacted]",
      undefined,
    );

    const allowed = updateHarness({
      executionPolicy: "approval-gated",
      projectAllowsUpdates: true,
    });
    await allowed.run({ operation: "comment", identifier: "OCT-42", body: "Started." });
    expect(allowed.ask).not.toHaveBeenCalled();
    expect(allowed.writes.agentComment).toHaveBeenCalledOnce();
  });

  it("refuses a comment too long to show whole in the approval before asking", async () => {
    const gated = updateHarness({ executionPolicy: "approval-gated" });
    expect(
      await gated.run({ operation: "comment", identifier: "OCT-42", body: "x".repeat(3_000) }),
    ).toMatchObject({ result: { error: "comment-too-long-to-approve" }, isError: true });
    expect(gated.ask).not.toHaveBeenCalled();
    expect(gated.writes.agentComment).not.toHaveBeenCalled();

    // Without an ask, the full 4 KB is allowed.
    const full = updateHarness({ executionPolicy: "full-access" });
    await full.run({ operation: "comment", identifier: "OCT-42", body: "x".repeat(3_000) });
    expect(full.writes.agentComment).toHaveBeenCalledOnce();
  });

  it("an archived thread's agent cannot update its linked issue", async () => {
    const archived = updateHarness({ executionPolicy: "full-access", lifecycle: "archived" });
    expect(
      await archived.run({ operation: "set-state", identifier: "OCT-42", state: "Done" }),
    ).toMatchObject({ isError: true });
    expect(archived.writes.agentSetState).not.toHaveBeenCalled();
  });
});
