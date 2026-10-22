import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostOAuthDescriptor, HostOAuthSignInState } from "@octant/contracts/host-oauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostOAuthService } from "../providers/oauth/hostOAuthService";
import { McpServerSignIn } from "./mcpServerSignIn";

const SERVER = "https://mcp.example/mcp";
const ISSUER = "https://auth.example";
const EXTENSION = "44000000-0000-4000-8000-000000000002";
const COMPONENT = "mcp-docs";
const ATTEMPT = "55000000-0000-4000-8000-000000000001";
const CREDENTIAL = "55000000-0000-4000-8000-000000000002";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A hosted server with its own authorization server, both answering as the MCP flow lays out. */
function issuerFetch(
  options: {
    readonly registration?: boolean;
    readonly scopes?: string[];
    /** What the protected-resource metadata claims to be; the server itself by default. */
    readonly resource?: string;
    /** What the authorization-server metadata calls its issuer; the real one by default. */
    readonly issuerClaim?: string;
  } = {},
) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    if (url === SERVER) {
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${SERVER.replace("/mcp", "")}/.well-known/oauth-protected-resource/mcp"`,
        },
      });
    }
    if (url === "https://mcp.example/.well-known/oauth-protected-resource/mcp") {
      return json({
        resource: options.resource ?? SERVER,
        authorization_servers: [ISSUER],
        ...(options.scopes === undefined ? {} : { scopes_supported: options.scopes }),
      });
    }
    if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
      return json({
        issuer: options.issuerClaim ?? ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        code_challenge_methods_supported: ["S256"],
        ...(options.registration === false ? {} : { registration_endpoint: `${ISSUER}/register` }),
      });
    }
    if (url === `${ISSUER}/register`) {
      return json({ client_id: "octant-issued-client", client_secret_expires_at: 0 }, 201);
    }
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function fakeOauth(states: { readonly afterPoll?: HostOAuthSignInState } = {}) {
  const begun: HostOAuthDescriptor[] = [];
  const signedOut: string[] = [];
  const oauth = {
    acknowledgeTerms: vi.fn(() => ({ kind: "recorded" }) as never),
    begin: vi.fn(async (input: { descriptor: HostOAuthDescriptor }) => {
      begun.push(input.descriptor);
      return {
        kind: "awaiting-consent",
        attemptId: ATTEMPT,
        descriptorId: input.descriptor.descriptorId,
        flow: "authorization-code-pkce",
        authorizationUrl: `${ISSUER}/authorize?client_id=octant-issued-client`,
        expiresAt: "2026-10-20T12:10:00.000Z",
      } as never;
    }),
    status: vi.fn(
      async () =>
        states.afterPoll ??
        ({
          kind: "signed-in",
          attemptId: ATTEMPT,
          descriptorId: "x",
          credentialRef: CREDENTIAL,
        } as never),
    ),
    signOut: vi.fn(async (input: { credentialRef: string }) => {
      signedOut.push(input.credentialRef);
      return { kind: "signed-out" } as never;
    }),
  } as unknown as HostOAuthService;
  return { oauth, begun, signedOut };
}

async function signIn(options: {
  readonly fetchImpl: typeof fetch;
  readonly oauth: HostOAuthService;
  readonly access?: (credentialRef: string) => Promise<unknown>;
  readonly serverUrl?: string | undefined;
}) {
  const directory = await mkdtemp(join(tmpdir(), "octant-mcp-sign-in-"));
  directories.push(directory);
  const statePath = join(directory, "sign-ins.json");
  return {
    statePath,
    service: new McpServerSignIn({
      statePath,
      oauth: options.oauth,
      access: options.access ?? (async () => ({ kind: "unavailable" })),
      serverUrl: async () => ("serverUrl" in options ? options.serverUrl : SERVER),
      fetch: options.fetchImpl,
      actorId: "66000000-0000-4000-8000-000000000001",
      pickPort: async () => 43125,
    }),
  };
}

describe("signing in to a hosted MCP server", () => {
  it("discovers the issuer, registers Octant with the chosen callback, and begins the host's own flow", async () => {
    const { fetchImpl, calls } = issuerFetch({ scopes: ["mcp:tools"] });
    const { oauth, begun } = fakeOauth();
    const { service } = await signIn({ fetchImpl, oauth });

    const view = await service.begin(EXTENSION, COMPONENT, "local-window");
    expect(view).toEqual({
      kind: "awaiting-consent",
      attemptId: ATTEMPT,
      authorizationUrl: `${ISSUER}/authorize?client_id=octant-issued-client`,
      expiresAt: "2026-10-20T12:10:00.000Z",
    });
    const registration = calls.find((call) => call.url === `${ISSUER}/register`);
    expect(registration?.body).toEqual({
      client_name: "Octant",
      redirect_uris: ["http://127.0.0.1:43125/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "mcp:tools",
    });
    expect(begun[0]).toMatchObject({
      dialect: "mcp-authorization",
      flow: "authorization-code-pkce",
      clientId: "octant-issued-client",
      authorizationEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: `${ISSUER}/token`,
      scopes: ["mcp:tools"],
      resource: SERVER,
      redirectPort: 43125,
    });
    expect(oauth.acknowledgeTerms).toHaveBeenCalledOnce();
  });

  it("remembers a finished sign-in, attaches its bearer to the launch, and never writes the token down", async () => {
    const { fetchImpl } = issuerFetch();
    const { oauth, signedOut } = fakeOauth();
    const access = vi.fn(async () => ({
      kind: "granted",
      accessToken: "access-token-must-not-leak",
      tokenType: "Bearer",
    }));
    const { service, statePath } = await signIn({ fetchImpl, oauth, access });
    await service.begin(EXTENSION, COMPONENT, "local-window");

    expect(await service.poll(EXTENSION, COMPONENT, ATTEMPT, "local-window")).toEqual({
      kind: "signed-in",
      issuer: "auth.example",
    });
    expect(await service.status(EXTENSION, COMPONENT, "local-window")).toEqual({
      kind: "signed-in",
      issuer: "auth.example",
    });
    const persisted = await readFile(statePath, "utf8");
    expect(persisted).toContain(CREDENTIAL);
    expect(persisted).not.toContain("access-token");

    const launch = await service.attachBearer(EXTENSION, COMPONENT, {
      transport: "streamable-http",
      name: "docs",
      url: SERVER,
      headers: { "X-Team": "ada" },
    });
    expect(launch.transport === "streamable-http" ? launch.headers : {}).toEqual({
      "X-Team": "ada",
      Authorization: "Bearer access-token-must-not-leak",
    });
    expect(access).toHaveBeenCalledWith(CREDENTIAL);

    expect(await service.signOut(EXTENSION, COMPONENT, "local-window")).toEqual({
      kind: "signed-out",
    });
    expect(signedOut).toEqual([CREDENTIAL]);
    expect(await service.status(EXTENSION, COMPONENT, "local-window")).toEqual({
      kind: "signed-out",
    });
  });

  it("says plainly when the issuer offers no client registration, and when the server asks for no sign-in", async () => {
    const { fetchImpl } = issuerFetch({ registration: false });
    const { oauth } = fakeOauth();
    const { service } = await signIn({ fetchImpl, oauth });
    expect(await service.begin(EXTENSION, COMPONENT, "local-window")).toMatchObject({
      kind: "refused",
      reason: "client-registration-unavailable",
    });

    const open = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const { service: openService } = await signIn({ fetchImpl: open, oauth });
    expect(await openService.begin(EXTENSION, COMPONENT, "local-window")).toMatchObject({
      kind: "refused",
      reason: "no-sign-in-offered",
    });
  });

  it("refuses a paired device and reports a command server as not applicable", async () => {
    const { fetchImpl } = issuerFetch();
    const { oauth } = fakeOauth();
    const { service } = await signIn({ fetchImpl, oauth });
    expect(await service.begin(EXTENSION, COMPONENT, "remote-device")).toMatchObject({
      kind: "refused",
      reason: "local-host-required",
    });
    expect(oauth.begin).not.toHaveBeenCalled();

    const { service: command } = await signIn({ fetchImpl, oauth, serverUrl: undefined });
    expect(await command.status(EXTENSION, COMPONENT, "local-window")).toEqual({
      kind: "not-applicable",
    });
  });

  it("sends the launch out bare and says Sign in again once the broker reports the grant gone", async () => {
    const { fetchImpl } = issuerFetch();
    const { oauth } = fakeOauth();
    const { service, statePath } = await signIn({
      fetchImpl,
      oauth,
      access: async () => ({ kind: "sign-in-again", reason: "revoked" }),
    });
    await service.begin(EXTENSION, COMPONENT, "local-window");
    await service.poll(EXTENSION, COMPONENT, ATTEMPT, "local-window");
    const launch = {
      transport: "streamable-http" as const,
      name: "docs",
      url: SERVER,
      headers: {},
    };
    expect(await service.attachBearer(EXTENSION, COMPONENT, launch)).toEqual(launch);
    expect(await service.status(EXTENSION, COMPONENT, "local-window")).toEqual({
      kind: "sign-in-again",
      reason: "revoked",
    });
    expect(
      JSON.parse(await readFile(statePath, "utf8")).signIns[`${EXTENSION}:${COMPONENT}`],
    ).toMatchObject({ signInAgain: "revoked" });

    const { service: flaky } = await signIn({
      fetchImpl,
      oauth,
      access: async () => ({ kind: "unavailable" }),
    });
    await flaky.begin(EXTENSION, COMPONENT, "local-window");
    await flaky.poll(EXTENSION, COMPONENT, ATTEMPT, "local-window");
    expect(await flaky.attachBearer(EXTENSION, COMPONENT, launch)).toEqual(launch);
    expect(await flaky.status(EXTENSION, COMPONENT, "local-window")).toEqual({
      kind: "signed-in",
      issuer: "auth.example",
    });
  });

  it("refuses a server whose metadata names another resource, and an issuer document that names another issuer", async () => {
    const { oauth } = fakeOauth();
    const { service: impostor } = await signIn({
      fetchImpl: issuerFetch({ resource: "https://api.example/v1" }).fetchImpl,
      oauth,
    });
    expect(await impostor.begin(EXTENSION, COMPONENT, "local-window")).toMatchObject({
      kind: "refused",
      reason: "issuer-unsupported",
      message: "The server's metadata names a different resource than its own address.",
    });

    const { service: mixedUp } = await signIn({
      fetchImpl: issuerFetch({ issuerClaim: "https://other.example" }).fetchImpl,
      oauth,
    });
    expect(await mixedUp.begin(EXTENSION, COMPONENT, "local-window")).toMatchObject({
      kind: "refused",
      reason: "issuer-unsupported",
    });
    expect(oauth.begin).not.toHaveBeenCalled();
  });

  it("lets a paired device read a pending sign-in without finishing it", async () => {
    const { fetchImpl } = issuerFetch();
    const { oauth } = fakeOauth();
    const { service } = await signIn({ fetchImpl, oauth });
    const begun = await service.begin(EXTENSION, COMPONENT, "local-window");

    expect(await service.status(EXTENSION, COMPONENT, "remote-device")).toEqual(begun);
    expect(await service.poll(EXTENSION, COMPONENT, ATTEMPT, "remote-device")).toMatchObject({
      kind: "refused",
      reason: "local-host-required",
    });
    expect(oauth.status).not.toHaveBeenCalled();

    expect(await service.poll(EXTENSION, COMPONENT, ATTEMPT, "local-window")).toEqual({
      kind: "signed-in",
      issuer: "auth.example",
    });
  });

  it("keeps a URL-shaped scope the resource advertises", async () => {
    const scope = "https://www.googleapis.com/auth/drive.readonly";
    const { fetchImpl, calls } = issuerFetch({ scopes: [scope, "bad scope", "mcp:tools"] });
    const { oauth, begun } = fakeOauth();
    const { service } = await signIn({ fetchImpl, oauth });
    await service.begin(EXTENSION, COMPONENT, "local-window");
    expect(begun[0]?.scopes).toEqual([scope, "mcp:tools"]);
    const registration = calls.find((call) => call.url === `${ISSUER}/register`);
    expect(registration?.body).toMatchObject({ scope: `${scope} mcp:tools` });
  });
});
