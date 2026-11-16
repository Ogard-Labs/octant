import { describe, expect, it, vi } from "vitest";
import type { IntegrationHostPort } from "@octant/plugin-api/integration";
import { executeLinearAssignmentSource } from "./linearAssignmentSource";
import { createRemoteRoutePolicy } from "../../remoteRoutePolicy";

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
  it("fits a full assignment set with ordinary issue titles in the remote response budget", async () => {
    const nodes = Array.from({ length: 256 }, (_, index) => ({
      id: `issue-${index}`,
      identifier: `ENG-${index + 1}`,
      title:
        "Implement the requested changes and verify behavior across supported environments ".repeat(
          2,
        ),
      url: `https://linear.app/team/issue/ENG-${index + 1}`,
      updatedAt: "2026-11-06T12:00:00.000Z",
    }));
    const fixture = host([]);
    let page = 0;
    fixture.fetch.mockImplementation(async () => {
      const start = page * 100;
      page += 1;
      return Response.json({
        data: {
          viewer: {
            id: "viewer-1",
            name: "Person",
            organization: { id: "workspace-1", name: "Workspace" },
          },
          issues: {
            nodes: nodes.slice(start, start + 100),
            pageInfo: { hasNextPage: page < 3, endCursor: `cursor${page}` },
          },
        },
      });
    });
    const result = await executeLinearAssignmentSource(fixture.port, {});
    expect(result.kind).toBe("ok");
    const size = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    expect(size).toBeGreaterThan(96 * 1_024);
    const origin = "https://octant.example";
    const decision = createRemoteRoutePolicy({ origin }).inspect(
      new Request(`${origin}/api/integrations/linear/operations`, {
        method: "POST",
        headers: { host: "octant.example", origin, "content-type": "application/json" },
      }),
    );
    expect(decision.kind).toBe("allow");
    if (decision.kind === "allow") expect(size).toBeLessThanOrEqual(decision.maxResponseBytes);
  });

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
