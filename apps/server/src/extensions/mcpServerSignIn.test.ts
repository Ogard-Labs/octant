import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HostOAuthDescriptor, HostOAuthSignInState } from "@octant/contracts/host-oauth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostOAuthService, type HostOAuthService } from "../providers/oauth/hostOAuthService";
import { makeHostOAuthBrokerClient } from "../providers/oauth/hostOAuthBrokerClient";
import { makeConnectorLinkedSecrets } from "../secretStores/connectorLinkedSecrets";
import type { SecretStoreBrokerClient } from "../secretStores/secretStoreBrokerClient";
import type { LinkedSecretPointers } from "./userAddedMcpServers";
import { McpServerSignIn } from "./mcpServerSignIn";

const SERVER = "https://mcp.example/mcp";
const ISSUER = "https://auth.example";
const EXTENSION = "44000000-0000-4000-8000-000000000002";
const COMPONENT = "mcp-docs";
const ATTEMPT = "55000000-0000-4000-8000-000000000001";
const CREDENTIAL = "55000000-0000-4000-8000-000000000002";

const publicSetup = {
  binding: {
    resource: SERVER,
    issuer: ISSUER,
    tokenEndpoint: `${ISSUER}/token`,
    callback: "http://127.0.0.1:43125/oauth/callback",
  },
  kind: "registered",
  clientId: "owned-public-client",
  authentication: "none",
} as const;

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
    readonly server?: string;
    readonly registration?: boolean;
    readonly metadataClient?: boolean;
    readonly scopes?: string[];
    /** What the protected-resource metadata claims to be; the server itself by default. */
    readonly resource?: string;
    /** What the authorization-server metadata calls its issuer; the real one by default. */
    readonly issuerClaim?: string;
  } = {},
) {
  const server = options.server ?? SERVER;
  const calls: Array<{ url: string; body?: unknown }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    if (url === server) {
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${server.replace("/mcp", "")}/.well-known/oauth-protected-resource/mcp"`,
        },
      });
    }
    if (url === `${new URL(server).origin}/.well-known/oauth-protected-resource/mcp`) {
      return json({
        resource: options.resource ?? server,
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
        client_id_metadata_document_supported: options.metadataClient === true,
        token_endpoint_auth_methods_supported: [
          "none",
          "client_secret_post",
          "client_secret_basic",
        ],
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
    cancel: vi.fn(async () => ({ kind: "cancelled" }) as const),
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
  readonly linkedSecrets?: LinkedSecretPointers;
  readonly pickPort?: () => Promise<number>;
  readonly pointTimeoutMs?: number;
  readonly retirementTimeoutMs?: number;
  readonly beginTimeoutMs?: number;
  readonly replaceState?: (path: string, contents: string) => Promise<void>;
  readonly onAuthenticationChanged?: (extensionId: string, componentId: string) => Promise<void>;
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
      ...(options.linkedSecrets === undefined ? {} : { linkedSecrets: options.linkedSecrets }),
      actorId: "66000000-0000-4000-8000-000000000001",
      ...(options.pointTimeoutMs === undefined ? {} : { pointTimeoutMs: options.pointTimeoutMs }),
      ...(options.retirementTimeoutMs === undefined
        ? {}
        : { retirementTimeoutMs: options.retirementTimeoutMs }),
      ...(options.beginTimeoutMs === undefined ? {} : { beginTimeoutMs: options.beginTimeoutMs }),
      ...(options.replaceState === undefined ? {} : { replaceState: options.replaceState }),
      ...(options.onAuthenticationChanged === undefined
        ? {}
        : { onAuthenticationChanged: options.onAuthenticationChanged }),
      pickPort: options.pickPort ?? (async () => 43125),
    }),
  };
}

describe("signing in to a hosted MCP server", () => {
  it("does not create a hidden completed-cleanup owner during prepared package removal", async () => {
    const { oauth } = fakeOauth();
    const { service } = await signIn({ fetchImpl: issuerFetch().fetchImpl, oauth });
    await service.begin(EXTENSION, COMPONENT, "local-window");
    await service.poll(EXTENSION, COMPONENT, ATTEMPT, "local-window");
    const release = await service.preparePackageRemoval(EXTENSION);
    try {
      expect(await service.signOut(EXTENSION, COMPONENT, "local-window")).toMatchObject({
        kind: "refused",
        reason: "unavailable",
      });
      expect(oauth.signOut).not.toHaveBeenCalled();
      expect(await service.signOut(EXTENSION, COMPONENT, "remote-device")).toMatchObject({
        kind: "refused",
        reason: "local-host-required",
      });
      expect(await service.status(EXTENSION, COMPONENT, "local-window")).toMatchObject({
        kind: "signed-in",
      });
    } finally {
      release();
    }
    expect(await service.signOut(EXTENSION, COMPONENT, "local-window")).toEqual({
      kind: "signed-out",
    });
  });

  it("retains an unusable completed grant across restart until explicit sign-out cleanup succeeds", async () => {
    const { oauth } = fakeOauth();
    const access = vi.fn(async () => ({
      kind: "granted",
      tokenType: "Bearer",
      accessToken: "synthetic-old-bearer",
    }));
    const invalidate = vi.fn(async () => undefined);
    const fetchImpl = issuerFetch().fetchImpl;
    const { service, statePath } = await signIn({
      fetchImpl,
      oauth,
      access,
      onAuthenticationChanged: invalidate,
    });
    await service.saveClient(EXTENSION, COMPONENT, publicSetup, "local-window");
    await service.begin(EXTENSION, COMPONENT, "local-window");
    await service.poll(EXTENSION, COMPONENT, ATTEMPT, "local-window");
    vi.mocked(oauth.signOut).mockResolvedValue({ kind: "unavailable" });
    expect(await service.signOut(EXTENSION, COMPONENT, "local-window")).toMatchObject({
      kind: "sign-out-pending",
    });
    expect(invalidate).toHaveBeenLastCalledWith(EXTENSION, COMPONENT);
    expect(
      JSON.parse(await readFile(statePath, "utf8")).signIns[`${EXTENSION}:${COMPONENT}`],
    ).toMatchObject({ credentialRef: CREDENTIAL, signOutPending: true });
    const restarted = new McpServerSignIn({
      statePath,
      oauth,
      access,
      fetch: fetchImpl,
      serverUrl: async () => SERVER,
      actorId: "66000000-0000-4000-8000-000000000001",
      onAuthenticationChanged: invalidate,
    });
    const launch = {
      transport: "streamable-http",
      name: "remote",
      headers: {},
      url: SERVER,
    } as const;
    expect(await restarted.attachBearer(EXTENSION, COMPONENT, launch)).toEqual(launch);
    expect(access).not.toHaveBeenCalled();
    expect(await restarted.begin(EXTENSION, COMPONENT, "local-window")).toMatchObject({
      kind: "sign-out-pending",
    });
    expect(oauth.begin).toHaveBeenCalledTimes(1);
    vi.mocked(oauth.signOut).mockResolvedValue({ kind: "signed-out" });
    expect(await restarted.signOut(EXTENSION, COMPONENT, "local-window")).toEqual({
      kind: "signed-out",
    });
    expect((await restarted.prepareClient(EXTENSION, COMPONENT, "local-window")).kind).toBe(
      "client-setup",
    );
    expect(JSON.parse(await readFile(statePath, "utf8")).signIns).toEqual({});
    expect(JSON.parse(await readFile(statePath, "utf8")).registrations[SERVER].clientId).toBe(
      publicSetup.clientId,
    );
  });

  it("invalidates cached authentication on a proven revoked grant and refuses remote sign-out", async () => {
    const { oauth } = fakeOauth();
    const invalidate = vi.fn(async () => undefined);
    const access = vi.fn(async () => ({ kind: "sign-in-again", reason: "revoked" }));
    const { service } = await signIn({
      fetchImpl: issuerFetch().fetchImpl,
      oauth,
      access,
      onAuthenticationChanged: invalidate,
    });
    await service.begin(EXTENSION, COMPONENT, "local-window");
    await service.poll(EXTENSION, COMPONENT, ATTEMPT, "local-window");
    invalidate.mockClear();
    expect(await service.signOut(EXTENSION, COMPONENT, "remote-device")).toMatchObject({
      kind: "refused",
      reason: "local-host-required",
    });
    expect(invalidate).not.toHaveBeenCalled();
    expect(oauth.signOut).not.toHaveBeenCalled();
    const launch = {
      transport: "streamable-http",
      name: "remote",
      headers: {},
      url: SERVER,
    } as const;
    expect(await service.attachBearer(EXTENSION, COMPONENT, launch)).toEqual(launch);
    expect(invalidate).toHaveBeenCalledExactlyOnceWith(EXTENSION, COMPONENT);
    expect(await service.attachBearer(EXTENSION, COMPONENT, launch)).toEqual(launch);
    expect(access).toHaveBeenCalledOnce();
    expect(await service.status(EXTENSION, COMPONENT, "local-window")).toEqual({
      kind: "sign-in-again",
      reason: "revoked",
    });
  });

  it("bounds unknown completed sign-out cleanup and suppresses its late result", async () => {
    const { oauth } = fakeOauth();
    const { service } = await signIn({ fetchImpl: issuerFetch().fetchImpl, oauth });
    await service.begin(EXTENSION, COMPONENT, "local-window");
    await service.poll(EXTENSION, COMPONENT, ATTEMPT, "local-window");
    const held = Promise.withResolvers<Awaited<ReturnType<HostOAuthService["signOut"]>>>();
    const entered = Promise.withResolvers<void>();
    vi.mocked(oauth.signOut).mockImplementation(async () => {
      entered.resolve();
      return held.promise;
    });
    vi.useFakeTimers();
    try {
      const signingOut = service.signOut(EXTENSION, COMPONENT, "local-window");
      await entered.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await signingOut).toMatchObject({ kind: "sign-out-pending" });
      held.resolve({ kind: "signed-out" });
      await Promise.resolve();
      expect(await service.status(EXTENSION, COMPONENT, "local-window")).toMatchObject({
        kind: "sign-out-pending",
      });
      expect(await service.begin(EXTENSION, COMPONENT, "local-window")).toMatchObject({
        kind: "sign-out-pending",
      });
      vi.mocked(oauth.signOut).mockResolvedValue({ kind: "signed-out" });
      expect(await service.signOut(EXTENSION, COMPONENT, "local-window")).toEqual({
        kind: "signed-out",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains sign-out ownership if final persistence fails after broker deletion", async () => {
    const { oauth } = fakeOauth();
    let fail = false;
    const { service, statePath } = await signIn({
      fetchImpl: issuerFetch().fetchImpl,
      oauth,
      replaceState: async (path, contents) => {
        if (fail && Object.keys(JSON.parse(contents).signIns).length === 0)
          throw new Error("synthetic disk failure");
        await writeFile(path, contents, "utf8");
      },
    });
    await service.begin(EXTENSION, COMPONENT, "local-window");
    await service.poll(EXTENSION, COMPONENT, ATTEMPT, "local-window");
    fail = true;
    expect(await service.signOut(EXTENSION, COMPONENT, "local-window")).toMatchObject({
      kind: "sign-out-pending",
    });
    expect(await service.status(EXTENSION, COMPONENT, "local-window")).toMatchObject({
      kind: "sign-out-pending",
    });
    expect(
      JSON.parse(await readFile(statePath, "utf8")).signIns[`${EXTENSION}:${COMPONENT}`]
        .credentialRef,
    ).toBe(CREDENTIAL);
    fail = false;
    expect(await service.signOut(EXTENSION, COMPONENT, "local-window")).toEqual({
      kind: "signed-out",
    });
  });

  it.each(["complete", "cancel"])(
    "retains an attempt after real service status timeout and permits later explicit %s",
    async (action) => {
      const entered = Promise.withResolvers<void>();
      const held = Promise.withResolvers<Response>();
      let statusCalls = 0;
      let begins = 0;
      let cancels = 0;
      let descriptorId = "";
      const signedIn = () => ({
        kind: "signed-in",
        attemptId: ATTEMPT,
        descriptorId,
        credentialRef: CREDENTIAL,
      });
      const broker = makeHostOAuthBrokerClient({
        url: "http://127.0.0.1:9",
        token: "synthetic-broker-token",
        fetch: async (input, init) => {
          const path = new URL(String(input)).pathname;
          if (path === "/v1/oauth/begin") {
            begins++;
            descriptorId = JSON.parse(String(init?.body)).descriptor.descriptorId;
            return json({
              kind: "awaiting-consent",
              attemptId: ATTEMPT,
              descriptorId,
              flow: "authorization-code-pkce",
              authorizationUrl: `${ISSUER}/authorize`,
              expiresAt: "2026-11-02T01:00:00.000Z",
            });
          }
          if (path === "/v1/oauth/status") {
            if (statusCalls++ === 0) {
              entered.resolve();
              return held.promise;
            }
            return json(signedIn());
          }
          if (path === "/v1/oauth/cancel") {
            cancels++;
            return json({ kind: "cancelled" });
          }
          throw new Error("Unexpected broker fixture request");
        },
      });
      const oauth = createHostOAuthService({ broker, journal: { append: () => undefined } });
      const { service, statePath } = await signIn({ fetchImpl: issuerFetch().fetchImpl, oauth });
      await service.begin(EXTENSION, COMPONENT, "local-window");
      vi.useFakeTimers();
      try {
        const checking = service.status(EXTENSION, COMPONENT, "local-window");
        await entered.promise;
        const cancelling =
          action === "cancel" ? service.signOut(EXTENSION, COMPONENT, "local-window") : undefined;
        await vi.advanceTimersByTimeAsync(10_001);
        expect(await checking).toMatchObject({ kind: "status-unavailable" });
        if (cancelling !== undefined) {
          expect(await cancelling).toEqual({ kind: "signed-out" });
          expect(cancels).toBe(1);
        } else {
          expect(await service.begin(EXTENSION, COMPONENT, "local-window")).toMatchObject({
            kind: "status-unavailable",
          });
          expect(await service.status(EXTENSION, COMPONENT, "local-window")).toMatchObject({
            kind: "signed-in",
          });
          expect(
            JSON.parse(await readFile(statePath, "utf8")).signIns[`${EXTENSION}:${COMPONENT}`]
              .credentialRef,
          ).toBe(CREDENTIAL);
        }
        held.resolve(json(signedIn()));
        await Promise.resolve();
        await Promise.resolve();
        expect(begins).toBe(1);
        expect(await service.status(EXTENSION, COMPONENT, "remote-device")).toMatchObject({
          kind: action === "cancel" ? "signed-out" : "signed-in",
        });
      } finally {
        held.resolve(json(signedIn()));
        vi.useRealTimers();
      }
    },
  );
  it("releases the server's queue when the broker never answers Begin and cancels the late attempt", async () => {
    const LATE = "55000000-0000-4000-8000-000000000009";
    const held = Promise.withResolvers<HostOAuthSignInState>();
    const { oauth } = fakeOauth();
    vi.mocked(oauth.begin).mockImplementationOnce(() => held.promise);
    const { service } = await signIn({
      fetchImpl: issuerFetch().fetchImpl,
      oauth,
      beginTimeoutMs: 20,
    });
    expect(await service.begin(EXTENSION, COMPONENT, "local-window")).toMatchObject({
      kind: "refused",
      reason: "unavailable",
    });
    expect(await service.begin(EXTENSION, COMPONENT, "local-window")).toMatchObject({
      kind: "awaiting-consent",
      attemptId: ATTEMPT,
    });
    held.resolve({
      kind: "awaiting-consent",
      attemptId: LATE,
      descriptorId: "x",
      flow: "authorization-code-pkce",
      authorizationUrl: `${ISSUER}/authorize`,
      expiresAt: "2026-10-20T12:10:00.000Z",
    } as never);
    await vi.waitFor(() =>
      expect(oauth.cancel).toHaveBeenCalledWith(expect.objectContaining({ attemptId: LATE })),
    );
    expect(oauth.cancel).toHaveBeenCalledTimes(1);
    expect(await service.status(EXTENSION, COMPONENT, "remote-device")).toMatchObject({
      kind: "awaiting-consent",
      attemptId: ATTEMPT,
    });
  });
  it("keeps sibling operations live while cancellation is held and prevents a new status poll", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<{ kind: "cancelled" }>();
    const { oauth } = fakeOauth();
    vi.mocked(oauth.cancel).mockImplementation(async () => {
      entered.resolve();
      return release.promise;
    });
    const state = await signIn({ fetchImpl: issuerFetch().fetchImpl, oauth });
    const other = "https://other.example/mcp";
    const primary = issuerFetch();
    const sibling = issuerFetch({ server: other });
    const fetchImpl: typeof fetch = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new URL(String(input)).origin === "https://other.example"
          ? sibling.fetchImpl(input, init)
          : primary.fetchImpl(input, init),
      { preconnect: () => undefined },
    );
    const service = new McpServerSignIn({
      statePath: state.statePath,
      oauth,
      serverUrl: async (_id, component) => (component === "other" ? other : SERVER),
      fetch: fetchImpl,
      actorId: CREDENTIAL,
      access: async () => ({ kind: "granted", tokenType: "Bearer", accessToken: "synthetic" }),
      pickPort: async () => 43125,
    });
    await service.begin(EXTENSION, COMPONENT, "local-window");
    const cancelling = service.signOut(EXTENSION, COMPONENT, "local-window");
    await entered.promise;
    expect(await service.begin(EXTENSION, "other", "local-window")).toMatchObject({
      kind: "awaiting-consent",
    });
    expect(await service.status(EXTENSION, COMPONENT, "local-window")).toMatchObject({
      kind: "cancel-pending",
    });
    expect(oauth.status).not.toHaveBeenCalled();
    release.resolve({ kind: "cancelled" });
    expect(await cancelling).toEqual({ kind: "signed-out" });
    expect(await service.status(EXTENSION, COMPONENT, "local-window")).toEqual({
      kind: "signed-out",
    });
    const launch = {
      name: "fixture",
      transport: "streamable-http" as const,
      url: SERVER,
      headers: {},
    };
    expect(await service.attachBearer(EXTENSION, COMPONENT, launch)).toEqual(launch);
  });
  it("reuses a registered client and exact callback after sign-out and a host restart", async () => {
    const { fetchImpl, calls } = issuerFetch({ registration: false });
    const { oauth, begun } = fakeOauth();
    const { service, statePath } = await signIn({ fetchImpl, oauth });
    expect(
      await service.configureClient(
        {
          kind: "registered",
          resource: SERVER,
          issuer: ISSUER,
          clientId: "owned-client",
          redirectPort: 43126,
          clientAuthentication: {
            method: "client_secret_post",
            secretRef: CREDENTIAL,
            tokenEndpoint: `${ISSUER}/token`,
          },
        },
        "local-window",
      ),
    ).toEqual({ kind: "configured" });
    await service.begin(EXTENSION, COMPONENT, "local-window");
    await service.poll(EXTENSION, COMPONENT, ATTEMPT, "local-window");
    await service.signOut(EXTENSION, COMPONENT, "local-window");
    const restarted = new McpServerSignIn({
      statePath,
      oauth,
      access: async () => ({}),
      serverUrl: async () => SERVER,
      fetch: fetchImpl,
      actorId: CREDENTIAL,
      pickPort: async () => {
        throw new Error("must use registered callback");
      },
    });
    expect((await restarted.begin(EXTENSION, COMPONENT, "local-window")).kind).toBe(
      "awaiting-consent",
    );
    expect(begun).toHaveLength(2);
    expect(begun[1]).toMatchObject({
      clientId: "owned-client",
      redirectPort: 43126,
      clientAuthentication: {
        method: "client_secret_post",
        secretRef: CREDENTIAL,
        tokenEndpoint: `${ISSUER}/token`,
      },
    });
    expect(calls.some((call) => call.url === `${ISSUER}/register`)).toBe(false);
  });

  it("refuses remote setup, registration bound to another issuer and unadvertised metadata clients", async () => {
    const { fetchImpl } = issuerFetch({ registration: false });
    const { oauth } = fakeOauth();
    const { service } = await signIn({ fetchImpl, oauth });
    const registration = {
      kind: "registered",
      resource: SERVER,
      issuer: "https://other.example",
      clientId: "owned-client",
      redirectPort: 43126,
    };
    expect((await service.configureClient(registration, "remote-device")).kind).toBe("refused");
    expect(await service.configureClient(registration, "local-window")).toEqual({
      kind: "configured",
    });
    expect((await service.begin(EXTENSION, COMPONENT, "local-window")).kind).toBe("refused");
    expect(
      await service.configureClient(
        {
          ...registration,
          kind: "metadata-document",
          issuer: ISSUER,
          clientId: "https://client.example/oauth.json",
        },
        "local-window",
      ),
    ).toEqual({ kind: "configured" });
    expect((await service.begin(EXTENSION, COMPONENT, "local-window")).kind).toBe("refused");
    expect(oauth.begin).not.toHaveBeenCalled();
  });

  it("uses advertised metadata client identity without dynamic registration", async () => {
    const { fetchImpl, calls } = issuerFetch({ registration: false, metadataClient: true });
    const { oauth, begun } = fakeOauth();
    const { service } = await signIn({ fetchImpl, oauth });
    expect(
      (
        await service.configureForServer(
          EXTENSION,
          COMPONENT,
          {
            kind: "metadata-document",
            resource: SERVER,
            issuer: ISSUER,
            clientId: "https://client.example/oauth.json",
            redirectPort: 43126,
          },
          "local-window",
        )
      ).kind,
    ).toBe("signed-out");
    expect((await service.begin(EXTENSION, COMPONENT, "local-window")).kind).toBe(
      "awaiting-consent",
    );
    expect(begun[0]?.clientId).toBe("https://client.example/oauth.json");
    expect(calls.some((call) => call.url.endsWith("/register"))).toBe(false);
  });

  it("refuses mismatched resources, invalid setup and a changed confidential token endpoint", async () => {
    const { fetchImpl } = issuerFetch({ registration: false });
    const { oauth } = fakeOauth();
    const { service } = await signIn({ fetchImpl, oauth });
    const registration = {
      kind: "registered" as const,
      clientId: "owned-client",
      resource: "https://other.example/mcp",
      issuer: ISSUER,
      redirectPort: 43126,
    };
    expect(
      (await service.configureForServer(EXTENSION, COMPONENT, registration, "local-window")).kind,
    ).toBe("refused");
    expect(
      (await service.configureClient({ ...registration, issuer: "invalid" }, "local-window")).kind,
    ).toBe("refused");
    expect(
      await service.configureClient(
        {
          ...registration,
          resource: SERVER,
          clientAuthentication: {
            method: "client_secret_post",
            secretRef: CREDENTIAL,
            tokenEndpoint: "https://other.example/token",
          },
        },
        "local-window",
      ),
    ).toEqual({ kind: "configured" });
    expect((await service.begin(EXTENSION, COMPONENT, "local-window")).kind).toBe("refused");
    expect(oauth.begin).not.toHaveBeenCalled();
  });

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

describe("application setup without account consent", () => {
  it("prepares one exact callback across concurrent requests and restarts without registration or consent", async () => {
    const { fetchImpl, calls } = issuerFetch({ registration: false, metadataClient: true });
    const { oauth, begun } = fakeOauth();
    const pickPort = vi.fn(async () => 43125);
    const { service, statePath } = await signIn({ fetchImpl, oauth, pickPort });
    const [first, second] = await Promise.all([
      service.prepareClient(EXTENSION, COMPONENT, "local-window"),
      service.prepareClient(EXTENSION, COMPONENT, "local-window"),
    ]);
    expect(first).toMatchObject({
      kind: "client-setup",
      resource: SERVER,
      issuer: ISSUER,
      callback: "http://127.0.0.1:43125/oauth/callback",
      metadataClientSupported: true,
    });
    expect(second).toEqual(first);
    expect(pickPort).toHaveBeenCalledTimes(1);
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect((await readdir(dirname(statePath))).some((name) => name.endsWith(".tmp"))).toBe(false);
    const restarted = new McpServerSignIn({
      statePath,
      oauth,
      access: async () => ({}),
      serverUrl: async () => SERVER,
      fetch: fetchImpl,
      actorId: CREDENTIAL,
      pickPort: async () => {
        throw new Error("the prepared callback must be retained");
      },
    });
    expect(await restarted.prepareClient(EXTENSION, COMPONENT, "local-window")).toEqual(first);
    expect(begun).toHaveLength(0);
    expect(calls.some((call) => call.url.endsWith("/register"))).toBe(false);
    expect(JSON.parse(await readFile(statePath, "utf8")).signIns).toEqual({});
  });

  it("saves a public identity without consent, then uses it only after Sign in and retains it on sign-out", async () => {
    const { fetchImpl, calls } = issuerFetch({ registration: false });
    const { oauth, begun } = fakeOauth();
    const { service, statePath } = await signIn({ fetchImpl, oauth });
    expect(await service.saveClient(EXTENSION, COMPONENT, publicSetup, "local-window")).toEqual({
      kind: "client-configured",
    });
    expect(begun).toHaveLength(0);
    expect(await service.prepareClient(EXTENSION, COMPONENT, "local-window")).toMatchObject({
      registration: { clientId: publicSetup.clientId },
    });
    await service.begin(EXTENSION, COMPONENT, "local-window");
    expect(begun[0]).toMatchObject({ clientId: publicSetup.clientId, redirectPort: 43125 });
    await service.poll(EXTENSION, COMPONENT, ATTEMPT, "local-window");
    await service.signOut(EXTENSION, COMPONENT, "local-window");
    expect(JSON.parse(await readFile(statePath, "utf8")).registrations[SERVER].clientId).toBe(
      publicSetup.clientId,
    );
    expect(calls.some((call) => call.url.endsWith("/register"))).toBe(false);
  });

  it("saves only advertised metadata identities and refuses malformed client IDs", async () => {
    const { oauth } = fakeOauth();
    const unsupported = await signIn({ fetchImpl: issuerFetch().fetchImpl, oauth });
    const setup = {
      ...publicSetup,
      kind: "metadata-document",
      clientId: "https://client.example/oauth.json",
      authentication: "none",
    } as const;
    expect(
      await unsupported.service.saveClient(EXTENSION, COMPONENT, setup, "local-window"),
    ).toMatchObject({ kind: "refused", reason: "issuer-unsupported" });
    const supported = await signIn({
      fetchImpl: issuerFetch({ metadataClient: true }).fetchImpl,
      oauth,
    });
    expect(await supported.service.saveClient(EXTENSION, COMPONENT, setup, "local-window")).toEqual(
      { kind: "client-configured" },
    );
    expect(
      await supported.service.saveClient(
        EXTENSION,
        COMPONENT,
        { ...setup, clientId: "http://client.example/oauth.json" },
        "local-window",
      ),
    ).toMatchObject({ kind: "refused", reason: "invalid" });
    expect(
      await supported.service.prepareClient(EXTENSION, COMPONENT, "local-window"),
    ).toMatchObject({ registration: { clientId: setup.clientId } });
  });

  it("refuses paired setup before discovery and rejects mismatched resource or issuer metadata", async () => {
    const { oauth } = fakeOauth();
    const { fetchImpl } = issuerFetch();
    const { service } = await signIn({ fetchImpl, oauth });
    expect(await service.prepareClient(EXTENSION, COMPONENT, "remote-device")).toMatchObject({
      kind: "refused",
      reason: "local-host-required",
    });
    expect(
      await service.saveClient(EXTENSION, COMPONENT, publicSetup, "remote-device"),
    ).toMatchObject({ kind: "refused", reason: "local-host-required" });
    expect(fetchImpl).not.toHaveBeenCalled();
    for (const options of [
      { resource: "https://other.example/mcp" },
      { issuerClaim: "https://other.example" },
    ]) {
      const invalid = await signIn({ fetchImpl: issuerFetch(options).fetchImpl, oauth });
      expect(
        await invalid.service.prepareClient(EXTENSION, COMPONENT, "local-window"),
      ).toMatchObject({ kind: "refused", reason: "issuer-unsupported" });
    }
  });

  it("rejects a stale discovery binding before creating or reusing any secret", async () => {
    const { oauth } = fakeOauth();
    const point = vi.fn<LinkedSecretPointers["point"]>(async () => ({ status: "pointed" }));
    const { service, statePath } = await signIn({
      fetchImpl: issuerFetch().fetchImpl,
      oauth,
      linkedSecrets: { point, forget: async () => undefined },
    });
    for (const field of ["issuer", "resource", "tokenEndpoint", "callback"] as const) {
      const binding = { ...publicSetup.binding, [field]: "https://changed.example/" };
      expect(
        await service.saveClient(
          EXTENSION,
          COMPONENT,
          {
            ...publicSetup,
            binding,
            authentication: "client_secret_post",
            secret: { store: "onepassword", reference: "op://Private/App/secret" },
          },
          "local-window",
        ),
      ).toMatchObject({ kind: "refused", reason: "invalid" });
    }
    expect(point).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(statePath, "utf8")).registrations).toEqual({});
  });

  it("links a confidential client's item in the existing broker namespace without carrying its value", async () => {
    const point = vi.fn<LinkedSecretPointers["point"]>(async () => ({ status: "pointed" }));
    const forget = vi.fn(async () => undefined);
    const { oauth, begun } = fakeOauth();
    const { service, statePath } = await signIn({
      fetchImpl: issuerFetch().fetchImpl,
      oauth,
      linkedSecrets: { point, forget },
    });
    const secret = {
      store: "onepassword",
      reference: "op://Private/Owned app/client secret",
    } as const;
    const input = { ...publicSetup, authentication: "client_secret_basic", secret } as const;
    expect(await service.saveClient(EXTENSION, COMPONENT, input, "local-window")).toEqual({
      kind: "client-configured",
    });
    expect(point).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f-]{36}$/), secret);
    const persisted = await readFile(statePath, "utf8");
    expect(persisted).not.toContain(secret.reference);
    expect(JSON.parse(persisted).registrations[SERVER]).toMatchObject({
      clientAuthentication: {
        method: "client_secret_basic",
        tokenEndpoint: `${ISSUER}/token`,
        secretRef: point.mock.calls[0]?.[0],
      },
    });
    expect(begun).toHaveLength(0);
    // Editing an unchanged identity does not ask for or overwrite the existing item.
    expect(
      await service.saveClient(
        EXTENSION,
        COMPONENT,
        { ...publicSetup, authentication: "client_secret_basic" },
        "local-window",
      ),
    ).toEqual({ kind: "client-configured" });
    expect(point).toHaveBeenCalledTimes(1);
    expect(
      await service.saveClient(
        EXTENSION,
        COMPONENT,
        { ...publicSetup, clientId: "a-different-app", authentication: "client_secret_basic" },
        "local-window",
      ),
    ).toMatchObject({ kind: "refused", reason: "unavailable" });
    await service.begin(EXTENSION, COMPONENT, "local-window");
    expect(begun[0]?.clientAuthentication?.secretRef).toBe(point.mock.calls[0]?.[0]);
    expect(
      await service.saveClient(EXTENSION, COMPONENT, publicSetup, "local-window"),
    ).toMatchObject({ kind: "refused", reason: "unavailable" });
    expect(forget).not.toHaveBeenCalled();
  });

  it("refuses missing, locked and invalid secret references without persisting a client", async () => {
    const { oauth } = fakeOauth();
    const input = { ...publicSetup, authentication: "client_secret_post" } as const;
    const missing = await signIn({ fetchImpl: issuerFetch().fetchImpl, oauth });
    expect(
      await missing.service.saveClient(EXTENSION, COMPONENT, input, "local-window"),
    ).toMatchObject({ kind: "refused", reason: "unavailable" });
    for (const message of ["Unlock the linked store.", "That item reference is invalid."]) {
      const { service, statePath } = await signIn({
        fetchImpl: issuerFetch().fetchImpl,
        oauth,
        linkedSecrets: {
          point: async () => ({ status: "refused", message }),
          forget: async () => undefined,
        },
      });
      expect(
        await service.saveClient(
          EXTENSION,
          COMPONENT,
          { ...input, secret: { store: "onepassword", reference: "op://Private/App/secret" } },
          "local-window",
        ),
      ).toMatchObject({ kind: "refused", message });
      expect(JSON.parse(await readFile(statePath, "utf8")).registrations).toEqual({});
    }
  });

  it("refuses before linking a pointer when its durable reservation cannot be saved", async () => {
    const point = vi.fn<LinkedSecretPointers["point"]>(async () => ({ status: "pointed" }));
    const forget = vi.fn(async () => undefined);
    const { oauth } = fakeOauth();
    const { service, statePath } = await signIn({
      fetchImpl: issuerFetch().fetchImpl,
      oauth,
      linkedSecrets: { point, forget },
    });
    await service.saveClient(EXTENSION, COMPONENT, publicSetup, "local-window");
    await rm(statePath);
    await mkdir(statePath);
    expect(
      await service.saveClient(
        EXTENSION,
        COMPONENT,
        {
          ...publicSetup,
          authentication: "client_secret_post",
          secret: { store: "onepassword", reference: "op://Private/App/secret" },
        },
        "local-window",
      ),
    ).toMatchObject({ kind: "refused", reason: "unavailable" });
    expect(point).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
    expect(await service.prepareClient(EXTENSION, COMPONENT, "local-window")).toMatchObject({
      registration: { clientId: publicSetup.clientId },
    });
  });
  it("serializes a failed pending write before a later Save, retaining only the committed secret owner", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const point = vi.fn<LinkedSecretPointers["point"]>(async () => ({ status: "pointed" }));
    const forget = vi.fn(async (_id: string) => undefined);
    const { oauth } = fakeOauth();
    const { service, statePath } = await signIn({
      fetchImpl: issuerFetch().fetchImpl,
      oauth,
      linkedSecrets: { point, forget },
      replaceState: async (path, contents) => {
        if (JSON.parse(contents).registrations[SERVER]?.clientId === "client-a") {
          entered.resolve();
          await release.promise;
          throw new Error("controlled first write failure");
        }
        await writeFile(path, contents, { mode: 0o600 });
      },
    });
    const secret = { store: "onepassword", reference: "op://Private/App/secret" } as const;
    const first = service.saveClient(
      EXTENSION,
      COMPONENT,
      { ...publicSetup, clientId: "client-a", authentication: "client_secret_post", secret },
      "local-window",
    );
    await entered.promise;
    const second = service.saveClient(
      EXTENSION,
      COMPONENT,
      { ...publicSetup, clientId: "client-b", authentication: "client_secret_post", secret },
      "local-window",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(point).toHaveBeenCalledTimes(1);
    release.resolve();
    expect(await first).toMatchObject({ kind: "refused", reason: "unavailable" });
    expect(await second).toEqual({ kind: "client-configured" });
    const firstRef = point.mock.calls[0]?.[0];
    const committedRef = point.mock.calls[1]?.[0];
    expect(forget).toHaveBeenCalledExactlyOnceWith(firstRef);
    expect(forget).not.toHaveBeenCalledWith(committedRef);
    expect(JSON.parse(await readFile(statePath, "utf8")).registrations[SERVER]).toMatchObject({
      clientId: "client-b",
      clientAuthentication: { secretRef: committedRef },
    });
    expect(await service.prepareClient(EXTENSION, COMPONENT, "local-window")).toMatchObject({
      registration: { clientId: "client-b", clientAuthentication: { secretRef: committedRef } },
    });
    const restarted = new McpServerSignIn({
      statePath,
      oauth,
      access: async () => ({}),
      serverUrl: async () => SERVER,
      fetch: issuerFetch().fetchImpl,
      actorId: CREDENTIAL,
    });
    expect(await restarted.prepareClient(EXTENSION, COMPONENT, "local-window")).toMatchObject({
      registration: { clientId: "client-b" },
      callback: publicSetup.binding.callback,
    });
  });

  it("excludes same-resource Begin during secret linking while sibling consent and ordinary bearer reads stay usable", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const point = vi.fn<LinkedSecretPointers["point"]>(async () => {
      entered.resolve();
      await release.promise;
      return { status: "pointed" };
    });
    const { oauth, begun } = fakeOauth();
    const fixture = await signIn({ fetchImpl: issuerFetch().fetchImpl, oauth });
    const other = "https://other.example/mcp";
    const primary = issuerFetch();
    const sibling = issuerFetch({ server: other });
    const fetchImpl: typeof fetch = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new URL(String(input)).origin === "https://other.example"
          ? sibling.fetchImpl(input, init)
          : primary.fetchImpl(input, init),
      { preconnect: () => undefined },
    );
    const service = new McpServerSignIn({
      statePath: fixture.statePath,
      oauth,
      serverUrl: async (_extension, component) => (component === "other" ? other : SERVER),
      fetch: fetchImpl,
      actorId: CREDENTIAL,
      pickPort: async () => 43125,
      linkedSecrets: { point, forget: async () => undefined },
      access: async () => ({ kind: "granted", tokenType: "Bearer", accessToken: "fixture-token" }),
    });
    await service.saveClient(EXTENSION, COMPONENT, publicSetup, "local-window");
    await service.begin(EXTENSION, COMPONENT, "local-window");
    await service.poll(EXTENSION, COMPONENT, ATTEMPT, "local-window");
    const saving = service.saveClient(
      EXTENSION,
      COMPONENT,
      {
        ...publicSetup,
        clientId: "replacement-client",
        authentication: "client_secret_post",
        secret: { store: "onepassword", reference: "op://Private/App/secret" },
      },
      "local-window",
    );
    await entered.promise;
    const beginning = service.begin(EXTENSION, COMPONENT, "local-window");
    expect(await service.status(EXTENSION, COMPONENT, "local-window")).toMatchObject({
      kind: "signed-in",
    });
    expect(
      await service.attachBearer(EXTENSION, COMPONENT, {
        transport: "streamable-http",
        name: "fixture-server",
        headers: {},
        url: SERVER,
      }),
    ).toMatchObject({ headers: { Authorization: "Bearer fixture-token" } });
    expect(await service.begin(EXTENSION, "other", "local-window")).toMatchObject({
      kind: "awaiting-consent",
    });
    expect(begun).toHaveLength(2);
    release.resolve();
    expect(await saving).toEqual({ kind: "client-configured" });
    expect(await beginning).toMatchObject({ kind: "signed-in" });
    expect(begun).toHaveLength(2);
    await service.signOut(EXTENSION, COMPONENT, "local-window");
    expect(await service.begin(EXTENSION, COMPONENT, "local-window")).toMatchObject({
      kind: "awaiting-consent",
    });
    expect(begun[2]?.clientId).toBe("replacement-client");
  });

  it("refuses a Save queued behind a pending Begin before linking any secret", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const issuer = issuerFetch();
    const fetchImpl: typeof fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        if (String(input) === SERVER) {
          entered.resolve();
          await release.promise;
        }
        return issuer.fetchImpl(input, init);
      },
      { preconnect: () => undefined },
    );
    const point = vi.fn<LinkedSecretPointers["point"]>(async () => ({ status: "pointed" }));
    const { oauth } = fakeOauth();
    const { service } = await signIn({
      fetchImpl,
      oauth,
      linkedSecrets: { point, forget: async () => undefined },
    });
    const beginning = service.begin(EXTENSION, COMPONENT, "local-window");
    await entered.promise;
    const saving = service.saveClient(
      EXTENSION,
      COMPONENT,
      {
        ...publicSetup,
        authentication: "client_secret_post",
        secret: { store: "onepassword", reference: "op://Private/App/secret" },
      },
      "local-window",
    );
    release.resolve();
    expect(await beginning).toMatchObject({ kind: "awaiting-consent" });
    expect(await saving).toMatchObject({ kind: "refused", reason: "unavailable" });
    expect(point).not.toHaveBeenCalled();
  });

  it("cleans the fresh pointer and refuses Save when its server disappears during linking", async () => {
    let available = true;
    const point = vi.fn<LinkedSecretPointers["point"]>(async () => {
      available = false;
      return { status: "pointed" };
    });
    const forget = vi.fn(async (_id: string) => undefined);
    const { oauth } = fakeOauth();
    const fixture = await signIn({ fetchImpl: issuerFetch().fetchImpl, oauth });
    const service = new McpServerSignIn({
      statePath: fixture.statePath,
      oauth,
      fetch: issuerFetch().fetchImpl,
      actorId: CREDENTIAL,
      access: async () => ({}),
      serverUrl: async () => (available ? SERVER : undefined),
      pickPort: async () => 43125,
      linkedSecrets: { point, forget },
    });
    expect(
      await service.saveClient(
        EXTENSION,
        COMPONENT,
        {
          ...publicSetup,
          authentication: "client_secret_post",
          secret: { store: "onepassword", reference: "op://Private/App/secret" },
        },
        "local-window",
      ),
    ).toMatchObject({ kind: "refused", reason: "unavailable" });
    expect(forget).toHaveBeenCalledExactlyOnceWith(point.mock.calls[0]?.[0]);
    expect(JSON.parse(await readFile(fixture.statePath, "utf8")).registrations).toEqual({});
  });

  it("retires replaced setup pointers only after their last retained grant stops owning them", async () => {
    const point = vi.fn<LinkedSecretPointers["point"]>(async () => ({ status: "pointed" }));
    const forget = vi.fn(async (_id: string) => undefined);
    const { oauth } = fakeOauth();
    const { service } = await signIn({
      fetchImpl: issuerFetch().fetchImpl,
      oauth,
      linkedSecrets: { point, forget },
    });
    const setup = {
      ...publicSetup,
      authentication: "client_secret_basic",
      secret: { store: "onepassword", reference: "op://Private/App/secret" },
    } as const;
    await service.saveClient(EXTENSION, COMPONENT, setup, "local-window");
    const oldRef = point.mock.calls[0]?.[0];
    await service.begin(EXTENSION, COMPONENT, "local-window");
    await service.poll(EXTENSION, COMPONENT, ATTEMPT, "local-window");
    await service.saveClient(
      EXTENSION,
      COMPONENT,
      { ...setup, clientId: "replacement-client" },
      "local-window",
    );
    expect(forget).not.toHaveBeenCalled();
    const currentRef = point.mock.calls[1]?.[0];
    await service.signOut(EXTENSION, COMPONENT, "local-window");
    expect(forget).toHaveBeenCalledExactlyOnceWith(oldRef);
    expect(forget).not.toHaveBeenCalledWith(currentRef);
    await service.saveClient(EXTENSION, COMPONENT, publicSetup, "local-window");
    expect(forget).toHaveBeenLastCalledWith(currentRef);
  });

  it.each([
    { kind: "granted", tokenType: "Bearer", accessToken: "late-old-token" },
    { kind: "sign-in-again", reason: "revoked" },
  ])("ignores a late bearer or refusal after its original grant was replaced", async (answer) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { oauth } = fakeOauth();
    const { service } = await signIn({
      fetchImpl: issuerFetch().fetchImpl,
      oauth,
      access: async () => {
        entered.resolve();
        await release.promise;
        return answer;
      },
    });
    await service.saveClient(EXTENSION, COMPONENT, publicSetup, "local-window");
    await service.begin(EXTENSION, COMPONENT, "local-window");
    await service.poll(EXTENSION, COMPONENT, ATTEMPT, "local-window");
    const launch = {
      transport: "streamable-http",
      name: "fixture-server",
      headers: {},
      url: SERVER,
    } as const;
    const attaching = service.attachBearer(EXTENSION, COMPONENT, launch);
    await entered.promise;
    await service.signOut(EXTENSION, COMPONENT, "local-window");
    await service.begin(EXTENSION, COMPONENT, "local-window");
    await service.poll(EXTENSION, COMPONENT, ATTEMPT, "local-window");
    release.resolve();
    expect(await attaching).toEqual(launch);
    expect(await service.status(EXTENSION, COMPONENT, "local-window")).toMatchObject({
      kind: "signed-in",
    });
  });
  it("commits concurrent prepared callbacks for separate resources without losing either on restart", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let writes = 0;
    let port = 43124;
    const { oauth } = fakeOauth();
    const fixture = await signIn({ fetchImpl: issuerFetch().fetchImpl, oauth });
    const other = "https://other.example/mcp";
    const primary = issuerFetch();
    const sibling = issuerFetch({ server: other });
    const fetchImpl: typeof fetch = Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new URL(String(input)).origin === "https://other.example"
          ? sibling.fetchImpl(input, init)
          : primary.fetchImpl(input, init),
      { preconnect: () => undefined },
    );
    const serverUrl = async (_extension: string, component: string) =>
      component === "other" ? other : SERVER;
    const service = new McpServerSignIn({
      statePath: fixture.statePath,
      oauth,
      access: async () => ({}),
      serverUrl,
      fetch: fetchImpl,
      actorId: CREDENTIAL,
      pickPort: async () => ++port,
      replaceState: async (path, contents) => {
        if (++writes === 1) {
          entered.resolve();
          await release.promise;
        }
        await writeFile(path, contents, { mode: 0o600 });
      },
    });
    const first = service.prepareClient(EXTENSION, COMPONENT, "local-window");
    await entered.promise;
    const second = service.prepareClient(EXTENSION, "other", "local-window");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writes).toBe(1);
    release.resolve();
    const views = await Promise.all([first, second]);
    expect(views[0]).toMatchObject({
      kind: "client-setup",
      callback: "http://127.0.0.1:43125/oauth/callback",
    });
    expect(views[1]).toMatchObject({
      kind: "client-setup",
      callback: "http://127.0.0.1:43126/oauth/callback",
    });
    expect(JSON.parse(await readFile(fixture.statePath, "utf8")).callbackPorts).toEqual({
      [SERVER]: 43125,
      [other]: 43126,
    });
    const restarted = new McpServerSignIn({
      statePath: fixture.statePath,
      oauth,
      access: async () => ({}),
      serverUrl,
      fetch: fetchImpl,
      actorId: CREDENTIAL,
      pickPort: async () => {
        throw new Error("must retain both callbacks");
      },
    });
    expect(await restarted.prepareClient(EXTENSION, COMPONENT, "local-window")).toEqual(views[0]);
    expect(await restarted.prepareClient(EXTENSION, "other", "local-window")).toEqual(views[1]);
  });
  it.each(["cleared", "uncertain"] as const)(
    "bounds held cleanup without blocking siblings or reusing a retired id (%s)",
    async (outcome) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<"cleared" | "uncertain">();
      const point = vi.fn<LinkedSecretPointers["point"]>(async () => ({ status: "pointed" }));
      const retire = vi.fn<NonNullable<LinkedSecretPointers["retire"]>>(async () => {
        entered.resolve();
        return release.promise;
      });
      const { oauth } = fakeOauth();
      const { service, statePath } = await signIn({
        fetchImpl: issuerFetch().fetchImpl,
        oauth,
        retirementTimeoutMs: 10,
        linkedSecrets: { point, retire, forget: async () => undefined },
      });
      await service.saveClient(
        EXTENSION,
        COMPONENT,
        {
          ...publicSetup,
          authentication: "client_secret_post",
          secret: { store: "onepassword", reference: "op://Private/App/secret" },
        },
        "local-window",
      );
      const ref = point.mock.calls[0]?.[0];
      expect(ref).toBeTypeOf("string");
      const replacing = service.saveClient(EXTENSION, COMPONENT, publicSetup, "local-window");
      await entered.promise;
      // A different resource can persist, and even the same resource's Save has a finite wait.
      expect(
        await service.configureClient(
          {
            kind: "registered",
            resource: "https://other.example/mcp",
            issuer: ISSUER,
            clientId: "sibling",
            redirectPort: 43126,
          },
          "local-window",
        ),
      ).toEqual({ kind: "configured" });
      expect(await replacing).toEqual({ kind: "client-configured" });
      const reclaim = {
        kind: "registered",
        resource: SERVER,
        issuer: ISSUER,
        clientId: "wrong-reclaim",
        redirectPort: 43125,
        clientAuthentication: {
          method: "client_secret_post",
          secretRef: ref,
          tokenEndpoint: `${ISSUER}/token`,
        },
      };
      expect(await service.configureClient(reclaim, "local-window")).toMatchObject({
        kind: "refused",
        reason: "invalid",
      });
      expect(JSON.parse(await readFile(statePath, "utf8")).retiredClientSecrets).toContain(ref);
      release.resolve(outcome);
      if (outcome === "cleared") {
        await vi.waitFor(async () =>
          expect(JSON.parse(await readFile(statePath, "utf8")).retiredClientSecrets).not.toContain(
            ref,
          ),
        );
      } else {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const restarted = new McpServerSignIn({
          statePath,
          oauth,
          access: async () => ({}),
          serverUrl: async () => SERVER,
          fetch: issuerFetch().fetchImpl,
          actorId: CREDENTIAL,
        });
        expect(await restarted.configureClient(reclaim, "local-window")).toMatchObject({
          kind: "refused",
          reason: "invalid",
        });
      }
      expect(retire).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses another secret before provisioning when the bounded ownership/reservation budget is full", async () => {
    const point = vi.fn<LinkedSecretPointers["point"]>(async () => ({ status: "pointed" }));
    const { oauth } = fakeOauth();
    const { service, statePath } = await signIn({
      fetchImpl: issuerFetch().fetchImpl,
      oauth,
      linkedSecrets: { point, forget: async () => undefined },
    });
    const retiredClientSecrets = Array.from(
      { length: 256 },
      (_, index) => `55000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        signIns: {},
        registrations: {},
        callbackPorts: { [SERVER]: 43125 },
        retiredClientSecrets,
      }),
      { mode: 0o600 },
    );
    expect(
      await service.saveClient(
        EXTENSION,
        COMPONENT,
        {
          ...publicSetup,
          authentication: "client_secret_post",
          secret: { store: "onepassword", reference: "op://Private/App/secret" },
        },
        "local-window",
      ),
    ).toMatchObject({
      kind: "refused",
      reason: "unavailable",
      message: expect.stringContaining("Recover retired client-secret references"),
    });
    expect(point).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(statePath, "utf8")).retiredClientSecrets).toEqual(
      retiredClientSecrets,
    );
    // Public setup and existing account access are not refused by a secret budget.
    expect(await service.saveClient(EXTENSION, COMPONENT, publicSetup, "local-window")).toEqual({
      kind: "client-configured",
    });
  });

  it.each(["refuse", "cancel"] as const)(
    "protects a shared registration while another component awaits consent, then releases its last owner (%s)",
    async (end) => {
      const point = vi.fn<LinkedSecretPointers["point"]>(async () => ({ status: "pointed" }));
      const forget = vi.fn(async (_ref: string) => undefined);
      const { oauth } = fakeOauth({
        afterPoll: {
          kind: "refused",
          attemptId: ATTEMPT,
          descriptorId: "fixture",
          reason: "denied",
        } as never,
      });
      const { service } = await signIn({
        fetchImpl: issuerFetch().fetchImpl,
        oauth,
        linkedSecrets: { point, forget },
      });
      await service.saveClient(
        EXTENSION,
        COMPONENT,
        {
          ...publicSetup,
          authentication: "client_secret_post",
          secret: { store: "onepassword", reference: "op://Private/App/secret" },
        },
        "local-window",
      );
      await service.begin(EXTENSION, COMPONENT, "local-window");
      expect(
        await service.saveClient(EXTENSION, "other-component", publicSetup, "local-window"),
      ).toMatchObject({ kind: "refused", reason: "unavailable" });
      expect(forget).not.toHaveBeenCalled();
      if (end === "refuse") await service.poll(EXTENSION, COMPONENT, ATTEMPT, "local-window");
      else
        expect(await service.signOut(EXTENSION, COMPONENT, "local-window")).toEqual({
          kind: "signed-out",
        });
      expect(forget).not.toHaveBeenCalled(); // The saved registration still owns the reference.
      expect(
        await service.saveClient(EXTENSION, "other-component", publicSetup, "local-window"),
      ).toEqual({ kind: "client-configured" });
      expect(forget).toHaveBeenCalledExactlyOnceWith(point.mock.calls[0]?.[0]);
    },
  );
  it("keeps an unknown point reserved when transport loss precedes a late broker set", async () => {
    const release = Promise.withResolvers<void>();
    const written = Promise.withResolvers<void>();
    const stored = new Set<string>();
    let pointedRef: string | undefined;
    const clear = vi.fn<SecretStoreBrokerClient["clear"]>(async ({ id }) =>
      stored.delete(id)
        ? { status: "cleared", store: "onepassword", reference: "op://Private/App/secret" }
        : { status: "none" },
    );
    const linked = makeConnectorLinkedSecrets({
      broker: {
        point: async ({ id }) => {
          pointedRef = id;
          void release.promise.then(() => {
            stored.add(id);
            written.resolve();
          });
          return { status: "broker-unavailable" };
        },
        clear,
      },
      journal: { record: () => undefined },
    });
    const { oauth, begun } = fakeOauth();
    const { service, statePath } = await signIn({
      fetchImpl: issuerFetch().fetchImpl,
      oauth,
      linkedSecrets: linked,
    });
    expect(
      await service.saveClient(
        EXTENSION,
        COMPONENT,
        {
          ...publicSetup,
          authentication: "client_secret_post",
          secret: { store: "onepassword", reference: "op://Private/App/secret" },
        },
        "local-window",
      ),
    ).toMatchObject({ kind: "refused", reason: "unavailable" });
    // clear would answer none before the in-flight original point writes; it must not run.
    expect(clear).not.toHaveBeenCalled();
    expect(stored.size).toBe(0);
    release.resolve();
    await written.promise;
    expect(stored.has(pointedRef ?? "missing")).toBe(true);
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    expect(persisted.registrations).toEqual({});
    expect(persisted.retiredClientSecrets).toContain(pointedRef);
    const restarted = new McpServerSignIn({
      statePath,
      oauth,
      access: async () => ({}),
      serverUrl: async () => SERVER,
      fetch: issuerFetch().fetchImpl,
      actorId: CREDENTIAL,
    });
    expect(
      await restarted.configureClient(
        {
          kind: "registered",
          resource: SERVER,
          issuer: ISSUER,
          clientId: "unsafe-reclaim",
          redirectPort: 43125,
          clientAuthentication: {
            method: "client_secret_post",
            tokenEndpoint: `${ISSUER}/token`,
            secretRef: pointedRef,
          },
        },
        "local-window",
      ),
    ).toMatchObject({ kind: "refused", reason: "invalid" });
    expect(begun).toHaveLength(0);
  });

  it("bounds a held point, allows the next explicit Save, and retires late success without configuring or consenting", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stored = new Set<string>();
    let calls = 0;
    const point = vi.fn<LinkedSecretPointers["point"]>(async (id) => {
      if (++calls === 1) {
        entered.resolve();
        await release.promise;
      }
      stored.add(id);
      return { status: "pointed" };
    });
    const retire = vi.fn<NonNullable<LinkedSecretPointers["retire"]>>(async (id) => {
      stored.delete(id);
      return "cleared";
    });
    const { oauth, begun } = fakeOauth();
    const { service, statePath } = await signIn({
      fetchImpl: issuerFetch().fetchImpl,
      oauth,
      pointTimeoutMs: 10,
      retirementTimeoutMs: 10,
      linkedSecrets: { point, retire, forget: async () => undefined },
    });
    const input = {
      ...publicSetup,
      authentication: "client_secret_post",
      secret: { store: "onepassword", reference: "op://Private/App/secret" },
    } as const;
    const saving = service.saveClient(EXTENSION, COMPONENT, input, "local-window");
    await entered.promise;
    expect(await saving).toMatchObject({ kind: "refused", reason: "unavailable" });
    const oldRef = point.mock.calls[0]?.[0];
    expect(retire).not.toHaveBeenCalled();
    expect(
      await service.saveClient(
        EXTENSION,
        COMPONENT,
        { ...input, clientId: "next-explicit-client" },
        "local-window",
      ),
    ).toEqual({ kind: "client-configured" });
    const newRef = point.mock.calls[1]?.[0];
    release.resolve();
    await vi.waitFor(() => expect(retire).toHaveBeenCalledExactlyOnceWith(oldRef));
    await vi.waitFor(async () =>
      expect(JSON.parse(await readFile(statePath, "utf8")).retiredClientSecrets).not.toContain(
        oldRef,
      ),
    );
    expect(stored.has(oldRef ?? "missing")).toBe(false);
    expect(stored.has(newRef ?? "missing")).toBe(true);
    expect(await service.prepareClient(EXTENSION, COMPONENT, "local-window")).toMatchObject({
      registration: {
        clientId: "next-explicit-client",
        clientAuthentication: { secretRef: newRef },
      },
    });
    expect(begun).toHaveLength(0);
  });
});
