import { describe, expect, it, vi } from "vitest";
import { createMemoryConnectionStore } from "./integrationConnectionStore";
import { createMemorySecretVault } from "./integrationCredentialVault";
import { createIntegrationOAuthHost } from "./integrationOAuth";
import { LINEAR_CREDENTIAL_IDS } from "./linearCredentialIds";

const accessToken = "00a21d8b0c4e2375114e49c067dfb81eb0d2076f48354714cd5df984d87b67cc";
const refreshToken = "sz0c8ffy95zj2ff6bh1hiausauw3dbfsu4gly1z4p49b5odqv8l7owunb654vg1f";
const nextAccess = "fxra4u0msw3bagb9rdn2i641bs52m9zo8ksoxljouygcu31nh8s2jf8fygbepy16";
const nextRefresh = "qjmj51q8f8fnwe188702jarfqxwhdy6r5ivqy4yjuhw2crubm5e7nyu84un3marx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("integration OAuth host", () => {
  it("stores tokens from a PKCE exchange and never returns them to the caller", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: 86399,
        scope: "read",
      }),
    );
    const host = createIntegrationOAuthHost({
      vault: createMemorySecretVault(),
      credentialIds: LINEAR_CREDENTIAL_IDS,
      fetch,
    });
    const began = await host.beginPkceAuthorization({
      authorizationEndpoint: "https://linear.app/oauth/authorize",
      tokenEndpoint: "https://api.linear.app/oauth/token",
      clientId: "public-client",
      redirectUri: "http://127.0.0.1:13773/oauth/integrations/linear/callback",
      scopes: ["read"],
    });
    expect(began.kind).toBe("redirect");
    if (began.kind !== "redirect") return;
    const state = new URL(began.authorizationUrl).searchParams.get("state");
    expect(state).toEqual(expect.any(String));
    const completed = await host.completePkceAuthorization({
      state: state ?? "",
      code: "authorization-code",
    });
    expect(completed).toEqual({ kind: "stored" });
    expect(JSON.stringify(completed)).not.toContain(accessToken);
    expect(JSON.stringify(completed)).not.toContain(refreshToken);
    const granted = await host.requestCredential("oauth");
    expect(granted.kind).toBe("granted");
    if (granted.kind !== "granted") return;
    expect(granted.reference).toBe(LINEAR_CREDENTIAL_IDS.oauth);
    expect(granted.reference).not.toContain(accessToken);
  });

  it("clears local OAuth secrets even when revoke fails", async () => {
    const vault = createMemorySecretVault();
    await vault.put(
      LINEAR_CREDENTIAL_IDS.oauth,
      JSON.stringify({
        accessToken,
        refreshToken,
        tokenType: "Bearer",
        expiresAt: Date.now() + 60_000,
        scope: "read",
        clientId: "public-client",
        tokenEndpoint: "https://api.linear.app/oauth/token",
      }),
    );
    const bodies: string[] = [];
    const fetch = vi.fn(async (input: Request) => {
      bodies.push(await input.text());
      return new Response(null, { status: 500 });
    });
    const host = createIntegrationOAuthHost({
      vault,
      credentialIds: LINEAR_CREDENTIAL_IDS,
      fetch,
    });
    const result = await host.revokeCredential({
      scope: "oauth",
      revokeEndpoint: "https://api.linear.app/oauth/revoke",
    });
    expect(result.kind).toBe("cleared");
    expect(await vault.has(LINEAR_CREDENTIAL_IDS.oauth)).toBe(false);
    expect(bodies[0]).toContain(`token=${accessToken}`);
    expect(bodies[0]).not.toContain("access_token=");
  });

  it("surfaces invalid_grant without looping or leaving a usable OAuth credential", async () => {
    const vault = createMemorySecretVault();
    await vault.put(
      LINEAR_CREDENTIAL_IDS.oauth,
      JSON.stringify({
        accessToken,
        refreshToken,
        tokenType: "Bearer",
        expiresAt: Date.now() - 1_000,
        scope: "read",
        clientId: "public-client",
        tokenEndpoint: "https://api.linear.app/oauth/token",
      }),
    );
    await vault.put(LINEAR_CREDENTIAL_IDS["personal-api-key"], "lin_api_abcdefghijklmnop1234");
    const fetch = vi.fn(async () =>
      jsonResponse(
        { error: "invalid_grant", error_description: "Token has been expired or revoked." },
        400,
      ),
    );
    const host = createIntegrationOAuthHost({
      vault,
      credentialIds: LINEAR_CREDENTIAL_IDS,
      fetch,
    });
    const first = await host.refreshPkceAuthorization({
      scope: "oauth",
      tokenEndpoint: "https://api.linear.app/oauth/token",
      clientId: "public-client",
    });
    const second = await host.refreshPkceAuthorization({
      scope: "oauth",
      tokenEndpoint: "https://api.linear.app/oauth/token",
      clientId: "public-client",
    });
    expect(first.kind).toBe("invalid_grant");
    expect(second.kind).toBe("invalid_grant");
    expect(fetch).toHaveBeenCalledOnce();
    expect(await vault.has(LINEAR_CREDENTIAL_IDS.oauth)).toBe(false);
    expect(await vault.has(LINEAR_CREDENTIAL_IDS["personal-api-key"])).toBe(true);
    const oauth = await host.requestCredential("oauth");
    expect(oauth).toEqual({
      kind: "refused",
      reason: "The authorization expired. Reconnect to continue.",
    });
    expect(JSON.stringify(first)).not.toContain(accessToken);
    expect(JSON.stringify(first)).not.toContain(nextAccess);
    expect(JSON.stringify(first)).not.toContain(nextRefresh);
  });

  it("does not grant a personal API key after a persisted expired OAuth grant", async () => {
    const vault = createMemorySecretVault();
    await vault.put(LINEAR_CREDENTIAL_IDS["personal-api-key"], "lin_api_abcdefghijklmnop1234");
    const host = createIntegrationOAuthHost({
      vault,
      credentialIds: LINEAR_CREDENTIAL_IDS,
      connectionStore: createMemoryConnectionStore({
        source: "oauth",
        reconnectRequired: true,
      }),
    });
    await expect(host.requestCredential("oauth")).resolves.toMatchObject({ kind: "refused" });
    await expect(host.requestCredential("personal-api-key")).resolves.toMatchObject({
      kind: "refused",
    });
  });
});
