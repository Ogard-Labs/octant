import { describe, expect, it } from "vitest";
import type { ConnectorCatalogEntry } from "../packages/domain/src/connectorCatalog";
import { probeConnector, type ProbeFetch } from "./check-connector-catalog";

type Route = {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
};

function fakeNetwork(routes: Record<string, Route>): ProbeFetch {
  return async (url) => {
    const route = routes[url] ?? { status: 404 };
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), {
      status: route.status,
      headers: route.headers ?? {},
    });
  };
}

const signIn: ConnectorCatalogEntry = {
  id: "example",
  displayName: "Example",
  description: "An example service.",
  category: "business",
  url: "https://mcp.example.com/mcp",
  docs: "https://example.com/docs/mcp",
  auth: { kind: "sign-in" },
};

const challenge: Route = {
  status: 401,
  headers: {
    "www-authenticate":
      'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"',
  },
};
const resource: Route = {
  status: 200,
  body: { authorization_servers: ["https://auth.example.com"] },
};
const mcpAnswer: Route = {
  status: 200,
  body: { jsonrpc: "2.0", id: 1, result: {} },
  headers: { "content-type": "application/json" },
};
const metadataUrl = "https://auth.example.com/.well-known/oauth-authorization-server";

describe("the connector catalog probe", () => {
  it("passes a sign-in server that challenges and publishes PKCE and registration", async () => {
    const result = await probeConnector(
      signIn,
      fakeNetwork({
        [signIn.url]: challenge,
        "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": resource,
        [metadataUrl]: {
          status: 200,
          body: {
            code_challenge_methods_supported: ["S256"],
            registration_endpoint: "https://auth.example.com/register",
          },
        },
        [signIn.docs]: { status: 200 },
      }),
    );
    expect(result).toEqual({ status: "ok", id: "example" });
  });

  it("refuses an open sign-in server without registration, but not one that needs a registered client", async () => {
    const routes = {
      [signIn.url]: challenge,
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": resource,
      [metadataUrl]: { status: 200, body: { code_challenge_methods_supported: ["S256"] } },
      [signIn.docs]: { status: 200 },
    };
    expect(await probeConnector(signIn, fakeNetwork(routes))).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("no dynamic client registration"),
    });
    const registered: ConnectorCatalogEntry = {
      ...signIn,
      auth: { kind: "sign-in", clientSetup: "registered" },
    };
    expect(await probeConnector(registered, fakeNetwork(routes))).toEqual({
      status: "ok",
      id: "example",
    });
  });

  it("refuses a key server that answers without a key and a docs page that is gone", async () => {
    const keyed: ConnectorCatalogEntry = {
      ...signIn,
      auth: { kind: "key", header: "Authorization", keyPage: "https://example.com/keys" },
    };
    expect(
      await probeConnector(
        keyed,
        fakeNetwork({ [keyed.url]: mcpAnswer, [keyed.docs]: { status: 200 } }),
      ),
    ).toMatchObject({
      status: "refused",
      reason: expect.stringContaining("expected 401 without a key"),
    });
    expect(
      await probeConnector(
        keyed,
        fakeNetwork({ [keyed.url]: { status: 401 }, [keyed.docs]: { status: 404 } }),
      ),
    ).toMatchObject({ status: "refused", reason: "docs page answered 404" });
  });

  it("refuses an open server whose address now serves a web page", async () => {
    const open: ConnectorCatalogEntry = { ...signIn, auth: { kind: "none" } };
    expect(
      await probeConnector(
        open,
        fakeNetwork({
          [open.url]: { status: 200, headers: { "content-type": "text/html" } },
          [open.docs]: { status: 200 },
        }),
      ),
    ).toMatchObject({ status: "refused", reason: expect.stringContaining("no MCP answer") });
  });

  it("notes a docs page behind a bot wall without failing the entry", async () => {
    const open: ConnectorCatalogEntry = { ...signIn, auth: { kind: "none" } };
    expect(
      await probeConnector(
        open,
        fakeNetwork({ [open.url]: mcpAnswer, [open.docs]: { status: 403 } }),
      ),
    ).toEqual({ status: "ok", id: "example", note: "docs answered 403 to the probe" });
  });
});
