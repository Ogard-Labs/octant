import { describe, expect, it, vi } from "vitest";
import type { AutomationIntegrationEventTrigger } from "@octant/contracts";
import type { GithubActionsSource } from "./mcpServerSignIn";
import { githubRoutineEventSources } from "./githubRoutineEventSources";

const selection: AutomationIntegrationEventTrigger = {
  kind: "integration-event",
  integrationId: "repo-connector",
  sourceId: "repository",
  filters: { owner: "example", repository: "project", branch: "main", conclusions: "failure" },
  pollMinutes: 1,
  automaticStartLimit: 8,
};
describe("completed CI event contribution", () => {
  it("binds one selected repository and distinguishes attempts without reading logs or changing CI", async () => {
    let current = true;
    const repository = { id: 123, nodeId: "R_123", owner: "example", name: "project" };
    const runs: GithubActionsSource["runs"] = vi.fn<GithubActionsSource["runs"]>(async () => ({
      kind: "page",
      accountId: "42",
      repository,
      totalCount: 1000,
      nextPage: 2,
      runs: [1, 2].map((attempt) => ({
        id: 456,
        attempt,
        workflowId: 9,
        headSha: "a".repeat(40),
        branch: "main",
        conclusion: "failure",
        createdAt: "2026-11-06T12:00:00.000Z",
        updatedAt: "2026-11-06T12:01:00.000Z",
        url: "https://github.com/example/project/actions/runs/456",
      })),
    }));
    const bind = vi.fn(async () => ({ current: () => current, accountId: "42", repository, runs }));
    const provider = githubRoutineEventSources(() => ({
      bindGithubActionsSource: bind,
      githubActionsConnections: async () => [
        { extensionId: "repo-connector", componentId: "repository", label: "CI connection" },
      ],
    }));
    expect(await provider.choices()).toHaveLength(1);
    const source = await provider.bind(selection, new AbortController().signal);
    expect(bind).toHaveBeenCalledWith("repo-connector", "repository", {
      owner: "example",
      name: "project",
    });
    const observed = await source?.read(new AbortController().signal);
    expect(observed).toMatchObject({
      kind: "complete",
      events: [{ id: "123:456:1" }, { id: "123:456:2" }],
    });
    expect(runs).toHaveBeenCalledWith({ page: 1, branch: "main" });
    current = false;
    expect(source?.current()).toBe(false);
  });
  it("refuses invalid source filters before a credential-owned reader is selected", async () => {
    const bind = vi.fn();
    const provider = githubRoutineEventSources(() => ({
      bindGithubActionsSource: bind,
      githubActionsConnections: async () => [],
    }));
    expect(
      await provider.bind(
        { ...selection, filters: { ...selection.filters, token: "forbidden" } },
        new AbortController().signal,
      ),
    ).toBeUndefined();
    expect(
      await provider.bind(
        { ...selection, filters: { ...selection.filters, workflow: "1; execute" } },
        new AbortController().signal,
      ),
    ).toBeUndefined();
    expect(bind).not.toHaveBeenCalled();
  });
});
