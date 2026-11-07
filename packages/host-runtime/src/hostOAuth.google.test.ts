import { CredentialStoreFailure, type CredentialStore } from "./credentialStore";
import { createHostOAuthRuntime, type HostOAuthDescriptor } from "./hostOAuth";
import { describe, expect, it, vi } from "vitest";

const RESOURCE = "https://gmailmcp.googleapis.com/mcp/v1";
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const descriptor: HostOAuthDescriptor = {
  descriptorId: "google-mail-test",
  clientId: "123-test.apps.googleusercontent.com",
  dialect: "mcp-authorization",
  flow: "authorization-code-pkce",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  resource: RESOURCE,
  scopes: [SCOPE],
  termsId: "mcp-sign-in-terms-1",
};

function fixture(options: { readonly scope?: string; readonly refreshToken?: boolean } = {}) {
  const values = new Map<string, string>();
  const store: CredentialStore = {
    set: async (id, value) => {
      values.set(id, value);
    },
    has: async (id) => values.has(id),
    resolve: async (id) => {
      const value = values.get(id);
      if (value === undefined) throw new CredentialStoreFailure("missing");
      return value;
    },
    delete: async (id) => {
      values.delete(id);
    },
  };
  let now = Date.parse("2026-11-03T13:00:00.000Z");
  const tokenFetch = vi.fn(async () =>
    Response.json({
      access_token: "fixture-google-access",
      ...(options.refreshToken === false ? {} : { refresh_token: "fixture-google-refresh" }),
      token_type: "Bearer",
      expires_in: 30,
      scope: options.scope ?? SCOPE,
    }),
  );
  const runtime = createHostOAuthRuntime({ store, fetch: tokenFetch as never, now: () => now });
  return {
    values,
    store,
    runtime,
    tokenFetch,
    advance: () => {
      now += 60_000;
    },
  };
}

async function begin(runtime: ReturnType<typeof createHostOAuthRuntime>) {
  const result = await runtime.begin({
    descriptor,
    actorId: "66000000-0000-4000-8000-000000000001",
    termsAcknowledgedAt: "2026-11-03T13:00:00.000Z",
  });
  if (result.kind !== "awaiting-consent" || result.flow !== "authorization-code-pkce")
    throw new Error("Google flow unavailable");
  return result;
}

async function finish(
  runtime: ReturnType<typeof createHostOAuthRuntime>,
  pending: Awaited<ReturnType<typeof begin>>,
  issuer = "https://accounts.google.com",
) {
  const authorization = new URL(pending.authorizationUrl);
  const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "");
  callback.searchParams.set("state", authorization.searchParams.get("state") ?? "");
  callback.searchParams.set("code", "fixture-auth-code");
  callback.searchParams.set("iss", issuer);
  await fetch(callback);
  return runtime.status(pending.attemptId);
}

describe("Google native MCP authorization", () => {
  it("reports administrator denial without exchanging a code or storing a grant", async () => {
    const { runtime, tokenFetch, values } = fixture();
    try {
      const pending = await begin(runtime);
      const authorization = new URL(pending.authorizationUrl);
      const callback = new URL(authorization.searchParams.get("redirect_uri") ?? "");
      callback.searchParams.set("state", authorization.searchParams.get("state") ?? "");
      callback.searchParams.set("error", "admin_policy_enforced");
      await fetch(callback);
      expect(runtime.status(pending.attemptId)).toMatchObject({
        kind: "refused",
        reason: "denied",
      });
      expect(tokenFetch).not.toHaveBeenCalled();
      expect(values.size).toBe(0);
    } finally {
      await runtime.close();
    }
  });
  it("keeps ordinary Google-backed MCP authorization unchanged for an unrelated resource", async () => {
    const { runtime, tokenFetch } = fixture();
    try {
      const pending = await runtime.begin({
        descriptor: {
          ...descriptor,
          descriptorId: "other-google-mcp",
          resource: "https://mcp.example/resource",
          clientId: "existing-registered-client",
          scopes: ["openid"],
        },
        actorId: "66000000-0000-4000-8000-000000000001",
        termsAcknowledgedAt: "2026-11-03T13:00:00.000Z",
      });
      expect(pending.kind).toBe("awaiting-consent");
      if (pending.kind !== "awaiting-consent" || pending.flow !== "authorization-code-pkce")
        throw new Error("Generic Google-backed connection unavailable");
      const url = new URL(pending.authorizationUrl);
      expect(url.searchParams.get("scope")).toBe("openid");
      expect(url.searchParams.has("prompt")).toBe(false);
      expect(url.searchParams.has("access_type")).toBe(false);
      tokenFetch.mockResolvedValueOnce(
        Response.json({
          access_token: "ordinary-google-backed-access",
          refresh_token: "ordinary-google-backed-refresh",
          token_type: "Bearer",
          expires_in: 30,
          scope: "openid",
        }),
      );
      const signedIn = await finish(runtime, pending);
      expect(signedIn.kind).toBe("signed-in");
      if (signedIn.kind !== "signed-in") throw new Error("Generic consent did not finish");
      expect(await runtime.access(signedIn.credentialRef)).toMatchObject({ kind: "granted" });
    } finally {
      await runtime.close();
    }
  });
  it("refuses broad request scopes and endpoint substitution before contacting an issuer", async () => {
    const { runtime, tokenFetch } = fixture();
    try {
      for (const change of [
        { scopes: [SCOPE, "https://www.googleapis.com/auth/gmail.send"] },
        { tokenEndpoint: "https://attacker.example/token" },
      ]) {
        expect(
          await runtime.begin({
            descriptor: { ...descriptor, ...change },
            actorId: "66000000-0000-4000-8000-000000000001",
            termsAcknowledgedAt: "2026-11-03T13:00:00.000Z",
          }),
        ).toEqual({ kind: "refused", reason: "invalid" });
      }
      expect(tokenFetch).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("refuses a callback naming another issuer before exchanging its code", async () => {
    const { runtime, tokenFetch } = fixture();
    try {
      expect(await finish(runtime, await begin(runtime), "https://attacker.example")).toMatchObject(
        { kind: "refused" },
      );
      expect(tokenFetch).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });
  it("requests a persistent selected-account grant with only the chosen service and preserves PKCE and state", async () => {
    const { runtime } = fixture();
    try {
      const pending = await begin(runtime);
      const url = new URL(pending.authorizationUrl);
      expect(url.searchParams.get("access_type")).toBe("offline");
      expect(url.searchParams.get("prompt")).toBe("select_account consent");
      expect(url.searchParams.get("include_granted_scopes")).toBe("false");
      expect(url.searchParams.get("scope")).toBe(SCOPE);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("state")?.length).toBeGreaterThan(20);
    } finally {
      await runtime.close();
    }
  });

  it("refuses a successful token response that widens permission or omits the selected permission", async () => {
    for (const scope of [
      "",
      `${SCOPE} https://www.googleapis.com/auth/gmail.send`,
      "https://www.googleapis.com/auth/drive.readonly",
    ]) {
      const { runtime, values } = fixture({ scope });
      try {
        expect(await finish(runtime, await begin(runtime))).toMatchObject({ kind: "refused" });
        expect(values.size).toBe(0);
      } finally {
        await runtime.close();
      }
    }
  });

  it("coalesces concurrent refresh after restart and retains the selected service permission", async () => {
    const { runtime, store, tokenFetch, advance } = fixture();
    let restarted: ReturnType<typeof createHostOAuthRuntime> | undefined;
    try {
      const signedIn = await finish(runtime, await begin(runtime));
      if (signedIn.kind !== "signed-in") throw new Error("Google consent did not finish");
      await runtime.close();
      advance();
      restarted = createHostOAuthRuntime({
        store,
        fetch: tokenFetch as never,
        now: () => Date.parse("2026-11-03T13:01:00.000Z"),
      });
      expect(
        await Promise.all([
          restarted.refresh(signedIn.credentialRef),
          restarted.refresh(signedIn.credentialRef),
        ]),
      ).toEqual([{ kind: "refreshed" }, { kind: "refreshed" }]);
      expect(tokenFetch).toHaveBeenCalledTimes(2);
      expect(await restarted.access(signedIn.credentialRef)).toMatchObject({ kind: "granted" });
    } finally {
      await runtime.close();
      await restarted?.close();
    }
  });

  it("reports missing refresh tokens honestly after access expiry instead of claiming persistence", async () => {
    const { runtime, advance } = fixture({ refreshToken: false });
    try {
      const signedIn = await finish(runtime, await begin(runtime));
      if (signedIn.kind !== "signed-in") throw new Error("Google consent did not finish");
      advance();
      expect(await runtime.refresh(signedIn.credentialRef)).toMatchObject({
        kind: "sign-in-again",
        reason: "expired",
      });
    } finally {
      await runtime.close();
    }
  });
  it("retains unchanged permissions when refresh omits scope, and refuses an explicit wider refreshed scope", async () => {
    const { runtime, tokenFetch } = fixture();
    try {
      const signedIn = await finish(runtime, await begin(runtime));
      if (signedIn.kind !== "signed-in") throw new Error("Google consent did not finish");
      tokenFetch.mockResolvedValueOnce(
        Response.json({
          access_token: "renewed-google-access",
          token_type: "Bearer",
          expires_in: 30,
        }),
      );
      expect(await runtime.refresh(signedIn.credentialRef)).toEqual({ kind: "refreshed" });
      tokenFetch.mockResolvedValueOnce(
        Response.json({
          access_token: "wider-google-access",
          token_type: "Bearer",
          expires_in: 30,
          scope: `${SCOPE} https://www.googleapis.com/auth/gmail.send`,
        }),
      );
      expect(await runtime.refresh(signedIn.credentialRef)).toMatchObject({
        kind: "sign-in-again",
      });
      expect(await runtime.access(signedIn.credentialRef)).toMatchObject({ kind: "sign-in-again" });
    } finally {
      await runtime.close();
    }
  });
});
