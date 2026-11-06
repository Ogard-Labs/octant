import { describe, expect, it, vi } from "vitest";
import type { IntegrationHostPort } from "@octant/plugin-api/integration";
import { executeLinearAssignmentSource } from "./linearAssignmentSource";

function host(nodes: ReadonlyArray<unknown>, hasNextPage = false) {
  const fetch = vi.fn(async (_request: Request) =>
    Response.json({
      data: {
        viewer: {
          id: "viewer-1",
          name: "Person",
          organization: { id: "workspace-1", name: "Workspace" },
        },
        issues: { nodes, pageInfo: { hasNextPage, endCursor: "cursor" } },
      },
    }),
  );
  const port: IntegrationHostPort = {
    fetch,
    requestCredential: async () => ({ kind: "granted", reference: "opaque-reference" }),
    beginPkceAuthorization: async () => ({ kind: "refused", reason: "Not used" }),
    refreshPkceAuthorization: async () => ({ kind: "ready" }),
    revokeCredential: async () => ({ kind: "cleared" }),
  };
  return { fetch, port };
}
describe("assignment observation through the Linear plugin", () => {
  it("returns a complete current assignment set and immutable account/workspace identity", async () => {
    const f = host([
      {
        id: "issue-1",
        identifier: "ENG-1",
        title: "External title",
        url: "https://linear.app/team/issue/ENG-1",
        updatedAt: "2026-11-06T12:00:00.000Z",
      },
    ]);
    const result = await executeLinearAssignmentSource(f.port, { team: "ENG" });
    expect(result).toMatchObject({
      kind: "ok",
      value: {
        identity: JSON.stringify(["viewer-1", "workspace-1"]),
        events: [{ id: "issue-1", label: "ENG-1: External title" }],
      },
    });
    const request = f.fetch.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    if (request instanceof Request)
      expect(await request.json()).toMatchObject({
        variables: {
          filter: { assignee: { isMe: { eq: true } }, team: { key: { eqIgnoreCase: "ENG" } } },
        },
      });
  });
  it("never substitutes an incomplete or malformed page for a complete assignment set", async () => {
    const malformed = host([{ id: "incomplete" }]);
    expect(await executeLinearAssignmentSource(malformed.port, {})).toMatchObject({
      kind: "failed",
    });
    const pages = host([], true);
    expect(await executeLinearAssignmentSource(pages.port, {})).toMatchObject({ kind: "failed" });
    expect(pages.fetch).toHaveBeenCalledTimes(2);
  });
});
