import { describe, expect, it, vi } from "vitest";
import { createIntegrationHostPort } from "../../integration/integrationHostPort";
import {
  createLinearIntegration,
  LINEAR_OAUTH_UNCONFIGURED,
  LINEAR_RECONNECT_REASON,
  LINEAR_REVOKE_URL,
} from "./linearIntegration";

const redirectUri = "http://127.0.0.1:52693/oauth/linear/callback";
const clientId = "linear-public-client";
const accessToken = "00a21d8b0c4e2375114e49c067dfb81eb0d2076f48354714cd5df984d87b67cc";

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

describe("Linear integration plugin", () => {
  it("fails closed when the public OAuth client id is missing", async () => {
    const runtime = createLinearIntegration(createIntegrationHostPort(), { redirectUri });
    const observation = await runtime.execute({
      kind: "authenticate",
      command: { kind: "setup" },
    });
    expect(observation.kind).toBe("authentication");
    if (observation.kind !== "authentication") return;
    expect(observation.snapshot.state).toBe("unauthorized");
    expect(observation.snapshot.remediation).toBe(LINEAR_OAUTH_UNCONFIGURED);
    expect(serialized(observation)).not.toContain(accessToken);
  });

  it("starts PKCE setup through the host and returns only an authorization URL", async () => {
    const beginPkceAuthorization = vi.fn(async () => ({
      kind: "redirect" as const,
      authorizationUrl: "https://linear.app/oauth/authorize?client_id=linear-public-client",
    }));
    const runtime = createLinearIntegration(createIntegrationHostPort({ beginPkceAuthorization }), {
      clientId,
      redirectUri,
    });
    const observation = await runtime.execute({
      kind: "authenticate",
      command: { kind: "setup" },
    });
    expect(beginPkceAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId,
        redirectUri,
        extraParams: { prompt: "consent", actor: "user" },
      }),
    );
    expect(observation.kind).toBe("authentication");
    if (observation.kind !== "authentication") return;
    expect(observation.snapshot.interaction).toEqual({
      kind: "authorization-redirect",
      authorizationUri: "https://linear.app/oauth/authorize?client_id=linear-public-client",
    });
    expect(serialized(observation)).not.toContain(accessToken);
  });

  it("does not consult a personal API key after an expired OAuth grant", async () => {
    const requestCredential = vi.fn(async (scope: string) => {
      if (scope === "oauth") {
        return {
          kind: "refused" as const,
          reason: "The authorization expired. Reconnect to continue.",
        };
      }
      return { kind: "granted" as const, reference: "personal-ref" };
    });
    const fetch = vi.fn();
    const runtime = createLinearIntegration(
      createIntegrationHostPort({ requestCredential, fetch }),
      { clientId, redirectUri },
    );
    const observation = await runtime.observe({
      kind: "authenticate",
      command: { kind: "refresh" },
    });
    expect(requestCredential).toHaveBeenCalledWith("oauth");
    expect(requestCredential).not.toHaveBeenCalledWith("personal-api-key");
    expect(fetch).not.toHaveBeenCalled();
    expect(observation.kind).toBe("authentication");
    if (observation.kind !== "authentication") return;
    expect(observation.snapshot.remediation).toBe(LINEAR_RECONNECT_REASON);
    expect(serialized(observation)).not.toContain(accessToken);
  });

  it("returns opaque workspace identity from a host-authorized fetch", async () => {
    const requestCredential = vi.fn(async () => ({
      kind: "granted" as const,
      reference: "oauth-ref",
    }));
    const fetch = vi.fn(
      async (_input: Request) =>
        new Response(
          JSON.stringify({
            data: {
              viewer: {
                id: "user-1",
                name: "Ada",
                organization: { name: "Og", urlKey: "ogard-labs" },
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const runtime = createLinearIntegration(
      createIntegrationHostPort({ requestCredential, fetch }),
      { clientId, redirectUri },
    );
    const observation = await runtime.observe({
      kind: "authenticate",
      command: { kind: "refresh" },
    });
    expect(observation.kind).toBe("authentication");
    if (observation.kind !== "authentication") return;
    expect(observation.snapshot).toEqual({
      state: "ready",
      account: { login: "ogard-labs", source: "oauth", scopes: ["read"] },
      capabilities: [
        { operationId: "list-issues", available: true },
        { operationId: "get-issue", available: true },
        { operationId: "list-issue-filters", available: true },
      ],
    });
    expect(serialized(observation)).not.toContain(accessToken);
    expect(fetch).toHaveBeenCalledOnce();
    const firstCall = fetch.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (firstCall === undefined) return;
    const input = firstCall[0];
    expect(input).toBeInstanceOf(Request);
    if (!(input instanceof Request)) return;
    expect(input.headers.get("x-octant-credential-ref")).toBe("oauth-ref");
    expect(input.headers.get("authorization")).toBeNull();
  });

  it("revokes through the host on disconnect", async () => {
    const revokeCredential = vi.fn(async () => ({ kind: "cleared" as const }));
    const runtime = createLinearIntegration(createIntegrationHostPort({ revokeCredential }), {
      clientId,
      redirectUri,
    });
    const observation = await runtime.execute({
      kind: "authenticate",
      command: { kind: "logout" },
    });
    expect(revokeCredential).toHaveBeenCalledWith({
      scope: "oauth",
      revokeEndpoint: LINEAR_REVOKE_URL,
    });
    expect(observation.kind).toBe("authentication");
    if (observation.kind !== "authentication") return;
    expect(observation.snapshot.state).toBe("unauthorized");
  });

  it("lists bounded issue rows and never returns token material", async () => {
    const fetch = vi.fn(async (_input: Request) => graphqlResponse(issuesPayload()));
    const runtime = connectedRuntime(fetch);
    const observation = await runtime.execute({
      kind: "operation",
      operationId: "list-issues",
      input: { search: "browse", filter: { teamId: "22222222-2222-4222-8222-222222222222" } },
    });
    expect(observation).toMatchObject({
      kind: "operation",
      result: {
        kind: "ok",
        value: {
          rows: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              identifier: "ENG-12",
              title: "Browse issues in the workspace",
              state: { name: "In Progress", type: "started" },
              assignee: "Ada",
            },
          ],
          hasNextPage: false,
        },
      },
    });
    expect(serialized(observation)).not.toContain(accessToken);
    expect(fetch).toHaveBeenCalledOnce();
    const firstCall = fetch.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (firstCall === undefined) return;
    const input = firstCall[0];
    expect(input).toBeInstanceOf(Request);
    if (!(input instanceof Request)) return;
    expect(input.headers.get("authorization")).toBeNull();
    const body = JSON.parse(await input.text()) as { variables: { filter: unknown } };
    expect(body.variables.filter).toEqual({
      and: [
        { or: [{ title: { containsIgnoreCase: "browse" } }] },
        { team: { id: { eq: "22222222-2222-4222-8222-222222222222" } } },
      ],
    });
  });

  it("opens an issue for description and status without storing the body as source of truth", async () => {
    const fetch = vi.fn(async () =>
      graphqlResponse({
        data: {
          issue: {
            ...issueNode(),
            description: "Read-only description.",
          },
        },
      }),
    );
    const runtime = connectedRuntime(fetch);
    const observation = await runtime.execute({
      kind: "operation",
      operationId: "get-issue",
      input: { id: "11111111-1111-4111-8111-111111111111" },
    });
    expect(observation).toMatchObject({
      kind: "operation",
      result: {
        kind: "ok",
        value: {
          identifier: "ENG-12",
          description: "Read-only description.",
          descriptionTruncated: false,
          url: "https://linear.app/ogard-labs/issue/ENG-12",
        },
      },
    });
  });

  it("fails closed on stale authorization, missing capability, rate limits, and network loss", async () => {
    const unauthorized = createLinearIntegration(
      createIntegrationHostPort({
        requestCredential: async () => ({
          kind: "refused" as const,
          reason: "The authorization expired. Reconnect to continue.",
        }),
      }),
      { clientId, redirectUri },
    );
    const unauthorizedObservation = await unauthorized.execute({
      kind: "operation",
      operationId: "list-issues",
      input: {},
    });
    expect(unauthorizedObservation).toMatchObject({
      kind: "operation",
      result: { kind: "refused", reason: LINEAR_RECONNECT_REASON },
    });

    const rateLimited = connectedRuntime(async () => new Response("{}", { status: 429 }));
    const rateLimitedObservation = await rateLimited.execute({
      kind: "operation",
      operationId: "list-issues",
      input: {},
    });
    expect(rateLimitedObservation).toMatchObject({
      kind: "operation",
      result: {
        kind: "failed",
        retryable: true,
        reason: "Linear is rate limited. Try again in a moment.",
      },
    });

    const unavailable = connectedRuntime(async () => {
      throw new Error("offline");
    });
    const unavailableObservation = await unavailable.execute({
      kind: "operation",
      operationId: "get-issue",
      input: { id: "11111111-1111-4111-8111-111111111111" },
    });
    expect(unavailableObservation).toMatchObject({
      kind: "operation",
      result: { kind: "failed", retryable: true, reason: "Linear is unavailable." },
    });

    const unknown = connectedRuntime(async () =>
      graphqlResponse({ data: { issues: { nodes: [] } } }),
    );
    const unknownObservation = await unknown.execute({
      kind: "operation",
      operationId: "create-issue",
      input: {},
    });
    expect(unknownObservation).toMatchObject({
      kind: "operation",
      result: { kind: "refused" },
    });
  });

  it("returns filter options including an unassigned choice", async () => {
    const runtime = connectedRuntime(async () =>
      graphqlResponse({
        data: {
          teams: {
            nodes: [
              { id: "22222222-2222-4222-8222-222222222222", name: "Engineering", key: "ENG" },
            ],
          },
          users: { nodes: [{ id: "55555555-5555-4555-8555-555555555555", name: "Ada" }] },
          workflowStates: {
            nodes: [
              {
                id: "33333333-3333-4333-8333-333333333333",
                name: "In Progress",
                type: "started",
                team: { key: "ENG" },
              },
            ],
          },
          projects: { nodes: [{ id: "44444444-4444-4444-8444-444444444444", name: "Octant" }] },
        },
      }),
    );
    const observation = await runtime.execute({
      kind: "operation",
      operationId: "list-issue-filters",
      input: {},
    });
    expect(observation).toMatchObject({
      kind: "operation",
      result: {
        kind: "ok",
        value: {
          assignees: [
            { id: "unassigned", label: "Unassigned" },
            { id: "55555555-5555-4555-8555-555555555555", label: "Ada" },
          ],
        },
      },
    });
  });
});

function connectedRuntime(fetch: (input: Request) => Promise<Response>) {
  return createLinearIntegration(
    createIntegrationHostPort({
      requestCredential: async () => ({ kind: "granted" as const, reference: "oauth-ref" }),
      fetch,
    }),
    { clientId, redirectUri },
  );
}

function graphqlResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function issueNode() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    identifier: "ENG-12",
    title: "Browse issues in the workspace",
    url: "https://linear.app/ogard-labs/issue/ENG-12",
    state: { name: "In Progress", type: "started" },
    assignee: { name: "Ada" },
  };
}

function issuesPayload() {
  return {
    data: {
      issues: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [issueNode()],
      },
    },
  };
}
