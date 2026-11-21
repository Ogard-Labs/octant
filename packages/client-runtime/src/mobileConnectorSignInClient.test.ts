import { describe, expect, it, vi } from "vitest";
import {
  listMobileMcpConnections,
  mobileMcpServerSignIn,
  relayMobileMcpServerSignIn,
} from "./mobileConnectorSignInClient";

const extensionId = "44000000-0000-4000-8000-000000000002";
const attemptId = "55000000-0000-4000-8000-000000000001";

describe("mobile connector sign-in client", () => {
  it("lists hosted connections, starts device-code or relay sign-ins, and relays callback addresses over the signed transport", async () => {
    const calls: Array<{ readonly path: string; readonly body: unknown }> = [];
    const authenticatedFetch = vi.fn(
      async (input: { readonly path: string; readonly body?: string | Uint8Array }) => {
        const body = typeof input.body === "string" ? JSON.parse(input.body) : undefined;
        calls.push({ path: input.path, body });
        if (input.path === "/api/extensions/connections") {
          return new Response(
            JSON.stringify({
              servers: [
                {
                  extensionId,
                  packageId: "44000000-0000-4000-8000-000000000003",
                  componentId: "mcp-docs",
                  packageName: "Docs",
                  serverName: "Docs",
                  transport: "streamable-http",
                  state: "needs-sign-in",
                  reason: "Not signed in.",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (input.path === "/api/extensions/sign-in") {
          return new Response(
            JSON.stringify({
              kind: "awaiting-consent",
              attemptId,
              flow: "relay",
              relayable: true,
              authorizationUrl: "https://auth.example/authorize?state=abc",
              expiresAt: "2026-11-20T12:00:00.000Z",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ kind: "signed-in", issuer: "auth.example" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    const transport = { hostId: "host-1", authenticatedFetch };

    const listed = await listMobileMcpConnections({ transport });
    expect(listed.servers).toHaveLength(1);
    const begun = await mobileMcpServerSignIn({
      transport,
      request: {
        kind: "begin",
        extensionId: extensionId as never,
        componentId: "mcp-docs" as never,
      },
    });
    expect(begun).toMatchObject({ kind: "awaiting-consent", flow: "relay", relayable: true });
    const relayed = await relayMobileMcpServerSignIn({
      transport,
      request: {
        attemptId,
        callbackUrl: "http://127.0.0.1:43125/oauth/callback?code=abc&state=xyz",
      },
    });
    expect(relayed).toEqual({ kind: "signed-in", issuer: "auth.example" });
    expect(calls.map((call) => call.path)).toEqual([
      "/api/extensions/connections",
      "/api/extensions/sign-in",
      "/api/extensions/mcp-sign-in/relay",
    ]);
  });
});
