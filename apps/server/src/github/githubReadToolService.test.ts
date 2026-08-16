import { describe, expect, it, vi } from "vitest";
import type { CodeThread, GithubAuthenticationSnapshot } from "@octant/contracts";
import { GITHUB_READ_TOOL_NAME, GithubReadToolService } from "./githubReadToolService";

const readySnapshot: GithubAuthenticationSnapshot = {
  state: "ready",
  account: { login: "octocat", gitProtocol: "https", scopes: ["repo"] },
  capabilities: [
    { kind: "repository-catalogue", available: true },
    { kind: "issues-read", available: true },
    { kind: "pull-requests-read", available: true },
    { kind: "projects-read", available: true },
  ],
};

const thread = {
  id: "thread-1",
  projectId: "project-1",
  bindingRevisionId: "binding-1",
  repositoryId: "repository-1",
  checkoutId: "checkout-1",
  title: "Thread",
  lifecycle: "active",
  providerInstanceId: "provider-1",
  modelId: "model-1",
  executionPolicy: "approval-gated",
  permissionPersistence: "session",
  deliveryTarget: {
    branchIntent: "feature/x",
    remoteName: "origin",
    proposedBaseRepository: "octant/octant",
    proposedBaseBranch: "development",
    outcomeKind: "local-implementation",
    confirmedAt: "2026-08-11T00:00:00Z",
  },
  version: 1,
  createdAt: "2026-08-11T00:00:00Z",
  updatedAt: "2026-08-11T00:00:00Z",
} as unknown as CodeThread;

const issuePage = {
  kind: "issues" as const,
  page: {
    rows: [
      {
        number: 7,
        title: "Issue",
        state: "open" as const,
        author: "octocat",
        updatedAt: "2026-08-11T10:00:00Z",
        url: "https://github.com/octant/octant/issues/7",
      },
    ],
    sort: "updated-desc" as const,
    hasNextPage: false,
    freshness: { status: "fresh" as const },
  },
};

function setup(
  options: {
    snapshot?: GithubAuthenticationSnapshot;
    currentThread?: CodeThread | undefined;
    read?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const read = options.read ?? vi.fn(async () => issuePage);
  const service = new GithubReadToolService({
    catalogue: { read } as never,
    snapshot: async () => options.snapshot ?? readySnapshot,
  });
  const toolSet = service.createToolSet({
    windowId: "window-1" as never,
    thread,
    readThread: () => ("currentThread" in options ? options.currentThread : thread),
  });
  return { toolSet, read };
}

function execute(toolSet: ReturnType<GithubReadToolService["createToolSet"]>, input: unknown) {
  return toolSet.execute({ name: GITHUB_READ_TOOL_NAME, inputJson: JSON.stringify(input) });
}

describe("GithubReadToolService", () => {
  it("serves a bounded issues read fixed to the current Code Project repository", async () => {
    const { toolSet, read } = setup();
    const outcome = await execute(toolSet, { operation: "issues" });
    expect(outcome.isError).toBeFalsy();
    expect(outcome.result).toMatchObject({
      repository: "octant/octant",
      page: { rows: [{ number: 7 }] },
    });
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "issues",
        owner: "octant",
        name: "octant",
        pageSize: 20,
      }),
      expect.anything(),
    );
  });

  it("rejects any input that tries to choose a repository, host, endpoint, or flags", async () => {
    const { toolSet, read } = setup();
    for (const input of [
      { operation: "issues", owner: "attacker" },
      { operation: "issues", repository: "attacker/repo" },
      { operation: "issues", hostname: "ghe.example" },
      { operation: "issues", endpoint: "/user/repos" },
      { operation: "issues", flags: ["--jq", "."] },
      { operation: "enumerate-repositories" },
      { operation: "repositories" },
      "not-an-object",
    ]) {
      const outcome = await execute(toolSet, input);
      expect(outcome.isError).toBe(true);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("clamps the agent page size to the bounded window", async () => {
    const { toolSet, read } = setup();
    await execute(toolSet, { operation: "pull-requests", pageSize: 100 });
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "pull-requests", pageSize: 30 }),
      expect.anything(),
    );
  });

  it("fails closed when the thread disappeared or its binding changed", async () => {
    const missing = setup({ currentThread: undefined });
    expect((await execute(missing.toolSet, { operation: "issues" })).isError).toBe(true);
    expect(missing.read).not.toHaveBeenCalled();

    const rebound = setup({
      currentThread: { ...thread, projectId: "project-2" } as CodeThread,
    });
    const outcome = await execute(rebound.toolSet, { operation: "issues" });
    expect(outcome.isError).toBe(true);
    expect(outcome.result).toMatchObject({ error: "thread-stale" });
    expect(rebound.read).not.toHaveBeenCalled();
  });

  it("fails closed for an inactive thread", async () => {
    const archived = setup({
      currentThread: { ...thread, lifecycle: "archived" } as CodeThread,
    });
    const outcome = await execute(archived.toolSet, { operation: "issues" });
    expect(outcome.isError).toBe(true);
    expect(outcome.result).toMatchObject({ error: "thread-inactive" });
    expect(archived.read).not.toHaveBeenCalled();
  });

  it("fails closed when the delivery target repository is not a strict GitHub identity", async () => {
    const service = new GithubReadToolService({
      catalogue: { read: vi.fn() } as never,
      snapshot: async () => readySnapshot,
    });
    const malformed = {
      ...thread,
      deliveryTarget: { ...thread.deliveryTarget, proposedBaseRepository: "../escape" },
    } as CodeThread;
    const toolSet = service.createToolSet({
      windowId: "window-1" as never,
      thread: malformed,
      readThread: () => malformed,
    });
    const outcome = await execute(toolSet, { operation: "issues" });
    expect(outcome.isError).toBe(true);
    expect(outcome.result).toMatchObject({ error: "repository-unbound" });
  });

  it("denies per operation on capability while other reads stay available", async () => {
    const scopeLimited: GithubAuthenticationSnapshot = {
      state: "scope-limited",
      account: { login: "octocat", gitProtocol: "https", scopes: ["repo"] },
      capabilities: [
        { kind: "repository-catalogue", available: true },
        { kind: "issues-read", available: true },
        { kind: "pull-requests-read", available: true },
        { kind: "projects-read", available: false, remediation: "read:project scope required" },
      ],
    };
    const { toolSet, read } = setup({ snapshot: scopeLimited });
    const denied = await execute(toolSet, { operation: "projects" });
    expect(denied.isError).toBe(true);
    expect(denied.result).toMatchObject({
      error: "capability-unavailable",
      message: "read:project scope required",
    });
    expect(read).not.toHaveBeenCalled();
    expect((await execute(toolSet, { operation: "issues" })).isError).toBeFalsy();
  });

  it("denies every read when authentication is not usable", async () => {
    const { toolSet, read } = setup({
      snapshot: { state: "unauthorized", capabilities: [] },
    });
    const outcome = await execute(toolSet, { operation: "issues" });
    expect(outcome.isError).toBe(true);
    expect(outcome.result).toMatchObject({ error: "capability-unavailable" });
    expect(read).not.toHaveBeenCalled();
  });

  it("returns the catalogue's actionable unavailable state without credential material", async () => {
    const read = vi.fn(async () => ({
      kind: "unavailable" as const,
      capability: "issues-read" as const,
      reason: "rate-limited" as const,
      retryAfterSeconds: 30,
    }));
    const { toolSet } = setup({ read });
    const outcome = await execute(toolSet, { operation: "issues" });
    expect(outcome.isError).toBe(true);
    expect(outcome.result).toMatchObject({ error: "rate-limited", retryAfterSeconds: 30 });
    expect(JSON.stringify(outcome.result)).not.toMatch(/ghp_|bearer |authorization/i);
  });

  it("ignores unknown tool names", async () => {
    const { toolSet, read } = setup();
    const outcome = await toolSet.execute({ name: "octant_terminal", inputJson: "{}" });
    expect(outcome.isError).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
});
