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
      capabilities: [],
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
});
