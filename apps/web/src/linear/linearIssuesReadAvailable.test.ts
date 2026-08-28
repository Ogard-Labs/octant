import { describe, expect, it, vi } from "vitest";
import type { IntegrationAuthenticationSnapshot } from "@octant/contracts/integration";
import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import { linearIssuesReadAvailable, withLinearIssuesReadSync } from "./linearIssuesReadAvailable";

const readySnapshot: IntegrationAuthenticationSnapshot = {
  state: "ready",
  capabilities: [{ operationId: "list-issues", available: true }],
};

const unauthorizedSnapshot: IntegrationAuthenticationSnapshot = {
  state: "unauthorized",
  capabilities: [{ operationId: "list-issues", available: false }],
};

function makeClient(snapshot: IntegrationAuthenticationSnapshot): IntegrationClient {
  return {
    authenticationSnapshot: async () => snapshot,
    executeAuthenticationCommand: async () => snapshot,
    executeOperation: async () => ({ kind: "refused", reason: "not used" }),
    listIssues: async () => ({ rows: [], hasNextPage: false }),
    getIssue: async () => {
      throw new Error("not used");
    },
    listIssueFilters: async () => ({ teams: [], states: [], assignees: [], projects: [] }),
    storePersonalCredential: async () => {},
    deletePersonalCredential: async () => {},
  };
}

describe("Linear issues-read capability sync", () => {
  it("treats a snapshot as available only when list-issues is present and true", () => {
    expect(linearIssuesReadAvailable(readySnapshot)).toBe(true);
    expect(linearIssuesReadAvailable(unauthorizedSnapshot)).toBe(false);
    expect(linearIssuesReadAvailable({ state: "ready", capabilities: [] })).toBe(false);
  });

  it("refreshes availability after a successful authentication command", async () => {
    const onAvailable = vi.fn();
    const client = withLinearIssuesReadSync(makeClient(unauthorizedSnapshot), onAvailable);
    await client.executeAuthenticationCommand({ kind: "logout" });
    expect(onAvailable).toHaveBeenCalledWith(false);
  });

  it("does not refresh availability when the authentication command fails", async () => {
    const onAvailable = vi.fn();
    const client = withLinearIssuesReadSync(
      {
        ...makeClient(readySnapshot),
        executeAuthenticationCommand: async () => {
          throw new Error("Linear is unavailable.");
        },
      },
      onAvailable,
    );
    await expect(client.executeAuthenticationCommand({ kind: "setup" })).rejects.toThrow(
      "Linear is unavailable.",
    );
    expect(onAvailable).not.toHaveBeenCalled();
  });
});
