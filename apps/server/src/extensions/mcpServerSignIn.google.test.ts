import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostOAuthDescriptor } from "@octant/contracts/host-oauth";
import { GOOGLE_WORKSPACE_SERVICES } from "@octant/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServerSignIn } from "./mcpServerSignIn";

const EXTENSION = "44000000-0000-4000-8000-000000000002";
const ATTEMPT = "55000000-0000-4000-8000-000000000001";
const CREDENTIAL = "55000000-0000-4000-8000-000000000002";
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function googleConnection(
  resource: string,
  options: {
    readonly issuer?: string;
    readonly tokenEndpoint?: string;
    readonly resourceClaim?: string;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "octant-google-mcp-"));
  directories.push(directory);
  const statePath = join(directory, "sign-ins.json");
  const begun: HostOAuthDescriptor[] = [];
  const oauth = {
    acknowledgeTerms: vi.fn(() => ({ kind: "recorded" })),
    begin: vi.fn(async (input: { readonly descriptor: HostOAuthDescriptor }) => {
      begun.push(input.descriptor);
      return {
        kind: "awaiting-consent",
        attemptId: ATTEMPT,
        flow: "authorization-code-pkce",
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        expiresAt: "2026-11-03T13:30:00.000Z",
      };
    }),
    status: vi.fn(async () => ({
      kind: "signed-in",
      attemptId: ATTEMPT,
      credentialRef: CREDENTIAL,
    })),
    signOut: vi.fn(async () => ({ kind: "signed-out" })),
  };
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === resource) return new Response(null, { status: 401 });
    if (url.startsWith(`${new URL(resource).origin}/.well-known/oauth-protected-resource`))
      return Response.json({
        resource: options.resourceClaim ?? resource,
        authorization_servers: [options.issuer ?? "https://accounts.google.com/"],
        scopes_supported: GOOGLE_WORKSPACE_SERVICES.flatMap((service) => service.scopes).concat([
          "https://mail.google.com/",
          "https://www.googleapis.com/auth/drive",
          "https://www.googleapis.com/auth/calendar",
        ]),
      });
    if (url === "https://accounts.google.com/.well-known/openid-configuration")
      return Response.json({
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: options.tokenEndpoint ?? "https://oauth2.googleapis.com/token",
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      });
    return new Response(null, { status: 404 });
  });
  const access = vi.fn(async () => ({
    kind: "granted",
    accessToken: "fixture-token-never-persist",
    tokenType: "Bearer",
  }));
  const make = () =>
    new McpServerSignIn({
      statePath,
      oauth: oauth as never,
      access,
      serverUrl: async () => resource,
      fetch: fetchImpl as never,
      actorId: "66000000-0000-4000-8000-000000000001",
      pickPort: async () => 43125,
    });
  const service = make();
  return { service, make, oauth, begun, statePath };
}

describe("Google Workspace read-only connections", () => {
  it.each(GOOGLE_WORKSPACE_SERVICES)(
    "authorizes only the selected $displayName workflow through a Desktop public client",
    async (profile) => {
      const { service, begun } = await googleConnection(profile.resource);
      const prepared = await service.prepareClient(EXTENSION, "google", "local-window");
      expect(prepared).toMatchObject({
        kind: "client-setup",
        issuer: "https://accounts.google.com",
        authenticationMethods: ["none"],
        metadataClientSupported: false,
      });
      if (prepared.kind !== "client-setup") throw new Error("Google setup unavailable");
      const saved = await service.saveClient(
        EXTENSION,
        "google",
        {
          kind: "registered",
          clientId: "123-test.apps.googleusercontent.com",
          authentication: "none",
          binding: {
            resource: prepared.resource,
            issuer: prepared.issuer,
            tokenEndpoint: prepared.tokenEndpoint,
            callback: prepared.callback,
          },
        },
        "local-window",
      );
      expect(saved.kind).toBe("client-configured");
      expect(await service.begin(EXTENSION, "google", "local-window")).toMatchObject({
        kind: "awaiting-consent",
      });
      expect(begun[0]).toMatchObject({
        resource: profile.resource,
        scopes: profile.scopes,
        clientId: "123-test.apps.googleusercontent.com",
      });
      expect(begun[0]?.clientAuthentication).toBeUndefined();
    },
  );

  it("keeps application setup and an account grant after restart without persisting the bearer", async () => {
    const { service, make, statePath, oauth } = await googleConnection(
      "https://gmailmcp.googleapis.com/mcp/v1",
    );
    await service.configureClient(
      {
        kind: "registered",
        resource: "https://gmailmcp.googleapis.com/mcp/v1",
        issuer: "https://accounts.google.com",
        clientId: "123-test.apps.googleusercontent.com",
        redirectPort: 43125,
      },
      "local-window",
    );
    expect(await service.begin(EXTENSION, "google", "local-window")).toMatchObject({
      kind: "awaiting-consent",
    });
    expect(await service.poll(EXTENSION, "google", ATTEMPT, "local-window")).toMatchObject({
      kind: "signed-in",
    });
    expect(await make().status(EXTENSION, "google", "local-window")).toMatchObject({
      kind: "signed-in",
    });
    expect(await service.begin(EXTENSION, "google", "local-window")).toMatchObject({
      kind: "signed-in",
    });
    expect(oauth.begin).toHaveBeenCalledTimes(1);
    expect(
      await make().attachBearer(EXTENSION, "google", {
        transport: "streamable-http",
        name: "gmail",
        url: "https://gmailmcp.googleapis.com/mcp/v1",
        headers: {},
      }),
    ).toMatchObject({ headers: { Authorization: "Bearer fixture-token-never-persist" } });
    const persisted = await readFile(statePath, "utf8");
    expect(persisted).toContain(CREDENTIAL);
    expect(persisted).not.toContain("fixture-token-never-persist");
    expect(persisted).not.toContain("refresh_token");
  });

  it("refuses Google's discovery when the token endpoint or resource changes", async () => {
    for (const options of [
      { tokenEndpoint: "https://attacker.example/token" },
      { resourceClaim: "https://drivemcp.googleapis.com/mcp/v1" },
    ]) {
      const { service, begun } = await googleConnection(
        "https://gmailmcp.googleapis.com/mcp/v1",
        options,
      );
      expect(await service.prepareClient(EXTENSION, "google", "local-window")).toMatchObject({
        kind: "refused",
        reason: "issuer-unsupported",
      });
      expect(begun).toEqual([]);
    }
  });

  it("does not allow a paired device to set up or begin Google consent", async () => {
    const { service, begun } = await googleConnection("https://gmailmcp.googleapis.com/mcp/v1");
    expect(await service.prepareClient(EXTENSION, "google", "remote-device")).toMatchObject({
      kind: "refused",
      reason: "local-host-required",
    });
    expect(await service.begin(EXTENSION, "google", "remote-device")).toMatchObject({
      kind: "refused",
      reason: "local-host-required",
    });
    expect(begun).toEqual([]);
  });
});
