import { decodeDirectoryClientId, decodeDirectoryTenantId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { directoryOAuthHostFromBroker } from "./directoryOAuthHost";
import { makeHostOAuthBrokerClient } from "./hostOAuthBrokerClient";

const credentialRef = "5e0f6a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b";
const binding = {
  tenantId: decodeDirectoryTenantId("6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f"),
  clientId: decodeDirectoryClientId("0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d"),
  audience: "https://cognitiveservices.azure.com",
  endpointOrigin: "https://contoso.openai.azure.com",
};

function brokerAnswering(answers: Readonly<Record<string, unknown>>) {
  const requests: Array<{ readonly path: string; readonly body: unknown }> = [];
  const client = makeHostOAuthBrokerClient({
    url: "http://127.0.0.1:9",
    token: "broker-token",
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, body: JSON.parse(String(init?.body)) });
      return Response.json(answers[path] ?? { kind: "unavailable" });
    },
  });
  return { host: directoryOAuthHostFromBroker(client), requests };
}

describe("directory sign-in through the broker", () => {
  it("names the whole binding on every access and returns only the token and its expiry", async () => {
    const { host, requests } = brokerAnswering({
      "/v1/oauth/access": {
        kind: "granted",
        accessToken: "directory-token",
        tokenType: "Bearer",
        expiresAt: "2026-10-26T10:00:00.000Z",
      },
    });

    expect(await host.access(credentialRef, binding)).toEqual({
      kind: "granted",
      accessToken: "directory-token",
      expiresAt: "2026-10-26T10:00:00.000Z",
    });
    expect(requests).toEqual([
      {
        path: "/v1/oauth/access",
        body: {
          credentialRef,
          binding: {
            tenantId: String(binding.tenantId),
            clientId: String(binding.clientId),
            audience: binding.audience,
            endpointOrigin: binding.endpointOrigin,
          },
        },
      },
    ]);
  });

  it("reads the broker's binding refusal and a sign-in the organization wants repeated in person", async () => {
    const { host } = brokerAnswering({
      "/v1/oauth/access": { kind: "binding-mismatch" },
      "/v1/oauth/refresh": { kind: "sign-in-again", reason: "interaction-required" },
    });

    expect(await host.access(credentialRef, binding)).toEqual({ kind: "binding-mismatch" });
    expect(await host.refresh(credentialRef)).toEqual({
      kind: "sign-in-again",
      reason: "interaction-required",
    });
  });

  it("fails closed on a token without an expiry or a reason it does not know", async () => {
    const { host } = brokerAnswering({
      "/v1/oauth/access": { kind: "granted", accessToken: "directory-token", tokenType: "Bearer" },
      "/v1/oauth/refresh": { kind: "sign-in-again", reason: "something-new" },
    });

    expect(await host.access(credentialRef, binding)).toEqual({ kind: "unavailable" });
    expect(await host.refresh(credentialRef)).toEqual({ kind: "unavailable" });
  });
});
