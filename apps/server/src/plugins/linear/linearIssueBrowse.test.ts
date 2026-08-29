import type { IntegrationHostPort } from "@octant/plugin-api/integration";
import { describe, expect, it, vi } from "vitest";
import { executeLinearIssueOperation } from "./linearIssueBrowse";

const issuesPage = {
  data: {
    issues: {
      pageInfo: { hasNextPage: false },
      nodes: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          identifier: "OCT-188",
          title: "Inbox",
          url: "https://linear.app/octant/issue/OCT-188/inbox",
          state: { name: "Backlog", type: "backlog" },
          assignee: { name: "Henrik" },
        },
      ],
    },
  },
};

function hostPort() {
  const fetch = vi.fn(
    async (_input: Request) => new Response(JSON.stringify(issuesPage), { status: 200 }),
  );
  const port: IntegrationHostPort = {
    fetch,
    requestCredential: vi.fn(async () => ({ kind: "granted", reference: "ref-1" }) as never),
    beginPkceAuthorization: vi.fn(),
    refreshPkceAuthorization: vi.fn(),
    revokeCredential: vi.fn(),
  } as unknown as IntegrationHostPort;
  return { port, fetch };
}

describe("linear issue browse", () => {
  it("translates the reserved viewer assignee into an isMe filter, never an id lookup", async () => {
    const { port, fetch } = hostPort();
    const result = await executeLinearIssueOperation(port, "list-issues", {
      filter: { assigneeId: "me" },
    });
    expect(result).toMatchObject({ kind: "ok" });
    const request = fetch.mock.calls[0]?.[0];
    if (request === undefined) throw new Error("Linear GraphQL was never fetched");
    const body = JSON.parse(await request.text()) as {
      variables?: { filter?: unknown };
    };
    expect(body.variables?.filter).toEqual({ assignee: { isMe: { eq: true } } });
  });
});
