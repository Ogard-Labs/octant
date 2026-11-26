import type { IntegrationHostPort } from "@octant/plugin-api/integration";
import {
  LINEAR_ISSUE_COMMENT_OPERATION,
  LINEAR_ISSUE_SET_STATE_OPERATION,
  LINEAR_ISSUE_WORKFLOW_OPERATION,
  LINEAR_MISSING_WRITE_SCOPE,
} from "@octant/contracts/linear-issues";
import { describe, expect, it, vi } from "vitest";
import { executeLinearIssueOperation } from "./linearIssueBrowse";

// A fake host port: no request here leaves the process.
function hostPort(scopes: ReadonlyArray<string> | undefined, body: unknown = { data: {} }) {
  const fetch = vi.fn(async (_input: Request) => Response.json(body, { status: 200 }));
  const port = {
    fetch,
    requestCredential: vi.fn(
      async (scope: string): ReturnType<IntegrationHostPort["requestCredential"]> =>
        scope === "oauth"
          ? { kind: "granted", reference: "ref-1", ...(scopes === undefined ? {} : { scopes }) }
          : { kind: "unavailable", reason: "none" },
    ),
    beginPkceAuthorization: vi.fn(),
    refreshPkceAuthorization: vi.fn(),
    revokeCredential: vi.fn(),
  } satisfies IntegrationHostPort;
  return { port, fetch };
}

async function sentQuery(fetch: ReturnType<typeof hostPort>["fetch"]) {
  const request = fetch.mock.calls[0]?.[0];
  if (request === undefined) throw new Error("Linear GraphQL was never fetched");
  return JSON.parse(await request.text()) as {
    query: string;
    variables: Record<string, unknown>;
  };
}

describe("linear issue writes", () => {
  it("a Linear token without the write scope fails closed with a reconnect message", async () => {
    const { port, fetch } = hostPort(["read"]);
    for (const [operation, input] of [
      [LINEAR_ISSUE_SET_STATE_OPERATION, { id: "issue-1", stateId: "state-1" }],
      [LINEAR_ISSUE_COMMENT_OPERATION, { id: "issue-1", body: "Merged." }],
    ] as const) {
      expect(await executeLinearIssueOperation(port, operation, input)).toEqual({
        kind: "refused",
        reason: LINEAR_MISSING_WRITE_SCOPE,
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("moves an issue to a state and comments with a write-scoped token", async () => {
    const moved = hostPort(["read", "write"], { data: { issueUpdate: { success: true } } });
    expect(
      await executeLinearIssueOperation(moved.port, LINEAR_ISSUE_SET_STATE_OPERATION, {
        id: "issue-1",
        stateId: "state-2",
      }),
    ).toEqual({ kind: "ok", value: { applied: true } });
    const update = await sentQuery(moved.fetch);
    expect(update.query).toContain("issueUpdate");
    expect(update.variables).toEqual({ id: "issue-1", stateId: "state-2" });

    const commented = hostPort(["read", "write"], { data: { commentCreate: { success: true } } });
    expect(
      await executeLinearIssueOperation(commented.port, LINEAR_ISSUE_COMMENT_OPERATION, {
        id: "issue-1",
        body: "Merged in https://github.com/acme/app/pull/9.",
      }),
    ).toEqual({ kind: "ok", value: { applied: true } });
    expect((await sentQuery(commented.fetch)).variables).toEqual({
      issueId: "issue-1",
      body: "Merged in https://github.com/acme/app/pull/9.",
    });
  });

  it("reads an issue's state and its team's states with a read-only token", async () => {
    const { port } = hostPort(["read"], {
      data: {
        issue: {
          id: "issue-1",
          identifier: "ENG-4",
          url: "https://linear.app/acme/issue/ENG-4/x",
          state: { id: "s1", name: "Todo", type: "unstarted", position: 1 },
          team: {
            states: {
              nodes: [
                { id: "s1", name: "Todo", type: "unstarted", position: 1 },
                { id: "s2", name: "In Progress", type: "started", position: 2 },
              ],
            },
          },
        },
      },
    });
    const result = await executeLinearIssueOperation(port, LINEAR_ISSUE_WORKFLOW_OPERATION, {
      id: "issue-1",
    });
    expect(result).toMatchObject({
      kind: "ok",
      value: { identifier: "ENG-4", state: { id: "s1" }, teamStates: [{}, { id: "s2" }] },
    });
  });
});
