import { describe, expect, it } from "vitest";
import { decodeMcpServerSignInRequest, decodeMcpServerSignInView } from "./extensionRpc";

const target = { extensionId: "44000000-0000-4000-8000-000000000002", componentId: "mcp-docs" };
const setup = {
  binding: {
    resource: "https://mcp.example/mcp",
    issuer: "https://auth.example",
    tokenEndpoint: "https://auth.example/token",
    callback: "http://127.0.0.1:43125/oauth/callback",
  },
  kind: "registered",
  clientId: "owned-client",
  authentication: "client_secret_post",
  secret: { store: "onepassword", reference: "op://Private/App/client secret" },
};

describe("reusable MCP client setup wire", () => {
  it("represents cancellation retry without exposing broker identity or grant material", () => {
    const view = {
      kind: "cancel-pending",
      message: "Cancellation is not confirmed. Retry on this host.",
    };
    expect(decodeMcpServerSignInView(view)).toEqual(view);
    expect(decodeMcpServerSignInView({ ...view, kind: "status-unavailable" })).toEqual({
      ...view,
      kind: "status-unavailable",
    });
    for (const extra of [
      { credentialRef: "55000000-0000-4000-8000-000000000001" },
      { actorId: "private-host-actor" },
      { accessToken: "synthetic-token" },
    ])
      expect(() => decodeMcpServerSignInView({ ...view, ...extra })).toThrow();
  });
  it("accepts a linked item pointer and an explicit prepare action without account consent", () => {
    expect(decodeMcpServerSignInRequest({ kind: "prepare-client", ...target }).kind).toBe(
      "prepare-client",
    );
    expect(decodeMcpServerSignInRequest({ kind: "save-client", ...target, setup })).toEqual({
      kind: "save-client",
      ...target,
      setup,
    });
  });
  it.each([
    { ...setup, secret: { ...setup.secret, value: "not-a-pointer" } },
    { ...setup, clientSecret: "not-a-pointer" },
    { ...setup, secretRef: "44000000-0000-4000-8000-000000000003" },
    { ...setup, secret: { store: "unknown", reference: "item" } },
    {
      ...setup,
      secret: { store: "onepassword", reference: "bad\\nreference".replace("\\n", "\n") },
    },
  ])(
    "refuses secret material, caller broker references or invalid linked store pointers",
    (invalid) => {
      expect(() =>
        decodeMcpServerSignInRequest({ kind: "save-client", ...target, setup: invalid }),
      ).toThrow();
    },
  );
  it("never admits token or secret values in the setup view", () => {
    const view = {
      kind: "client-setup",
      resource: "https://mcp.example/mcp",
      issuer: "https://auth.example",
      tokenEndpoint: "https://auth.example/token",
      callback: "http://127.0.0.1:43125/oauth/callback",
      metadataClientSupported: false,
      authenticationMethods: ["none"],
      secretStoreAvailable: false,
    };
    expect(decodeMcpServerSignInView(view)).toEqual(view);
    expect(() => decodeMcpServerSignInView({ ...view, accessToken: "not-public" })).toThrow();
  });
});
