import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CredentialStoreFailure,
  startCredentialBroker,
  GITHUB_MCP_OAUTH_APP as github,
  type CredentialStore,
} from "@octant/host-runtime";
import {
  createHostOAuthRuntime,
  exchangeAuthorizationCode,
  handleHostOAuthBrokerRoute,
} from "../../../../packages/host-runtime/src/hostOAuth";
import { decodeHostOAuthDescriptor } from "@octant/contracts/host-oauth";
import { makeHostOAuthBrokerClient } from "../providers/oauth/hostOAuthBrokerClient";
import { createHostOAuthService } from "../providers/oauth/hostOAuthService";
import { McpServerSignIn } from "./mcpServerSignIn";
import { ExtensionPackageState } from "@octant/contracts/extensions";
import { Schema } from "effect";
import { resolveExtensionActivation } from "@octant/plugin-host";
import { bindGeneratedMcpSignInPolicy } from "./generatedMcpSignInPolicy";

const extension = "44000000-0000-4000-8000-000000000002";
const component = "github-repositories";
const credentialRef = "55000000-0000-4000-8000-000000000001";
const secretRef = "55000000-0000-4000-8000-000000000002";
const now = 1_000_000;
const selected = { id: 777, nodeId: "R_synthetic777", owner: "owned-fixture", name: "repository" };
const descriptor = decodeHostOAuthDescriptor({
  descriptorId: "github-repository-source-fixture",
  dialect: github.dialect,
  clientId: "owned-app",
  flow: "authorization-code-pkce",
  authorizationEndpoint: github.authorizationEndpoint,
  tokenEndpoint: github.tokenEndpoint,
  resource: github.resource,
  mcpIssuer: github.issuer,
  mcpTransportUrl: github.transportUrl,
  mcpPermissionProfile: "github-repositories-read-write",
  scopes: ["read:user", "repo", "offline_access"],
  redirectPort: 43125,
  termsId: "mcp-sign-in-terms-1",
  clientAuthentication: {
    method: "client_secret_post",
    secretRef,
    tokenEndpoint: github.tokenEndpoint,
  },
});

type SourceActivation =
  | "effective"
  | "untrusted"
  | "plugin-disabled"
  | "component-disabled"
  | "not-installed"
  | "quarantined"
  | "missing-component"
  | "missing-witness";
function sourcePackageState(condition: SourceActivation, version = 1) {
  const activation = {
    installed: condition !== "not-installed",
    trusted: condition !== "untrusted",
    pluginDesired: condition !== "plugin-disabled",
    componentDesired: condition !== "component-disabled",
    compatible: true,
    policyAllowed: true,
    quarantined: condition === "quarantined",
    draining: false,
    broken: false,
    unavailable: false,
    interrupted: false,
    waiting: false,
  };
  return Schema.decodeUnknownSync(ExtensionPackageState)({
    extensionId: extension,
    packageId: "44000000-0000-4000-8000-000000000003",
    stateVersion: version,
    version: "1.0.0",
    digest: `sha256:${"a".repeat(64)}`,
    source: { kind: "user-added", sourceRef: "fixture-owned-generated-source" },
    compatibility: { platforms: ["linux", "macos"], modes: ["work"], providerFamilies: [] },
    activation,
    components:
      condition === "missing-component"
        ? []
        : [
            {
              component: {
                id: component,
                kind: "mcp-server",
                displayName: "GitHub repositories",
                declaredCapabilities: ["network"],
              },
              activation,
              effectiveState: resolveExtensionActivation({
                ...activation,
                hostAllowed: true,
                modeAllowed: true,
                projectAllowed: true,
                threadAllowed: true,
                catalogCurrent: true,
              }),
            },
          ],
    diagnostics: [],
  });
}

async function fixture(socket = false, activation: SourceActivation = "effective") {
  const directory = await mkdtemp(join(tmpdir(), "octant-github-actions-source-"));
  const values = new Map<string, string>();
  let writeGate: (() => Promise<void>) | undefined;
  let responseOverride: ((url: URL) => Promise<Response | undefined>) | undefined;
  const store: CredentialStore = {
    set: async (id, value) => {
      if (id === credentialRef) await writeGate?.();
      values.set(id, value);
    },
    has: async (id) => values.has(id),
    delete: async (id) => void values.delete(id),
    resolve: async (id) => {
      const value = values.get(id);
      if (value === undefined) throw new CredentialStoreFailure("missing");
      return value;
    },
  };
  const issuerCalls: Array<{ readonly url: string; readonly authorization: string | null }> = [];
  const fetchPort = new Proxy(globalThis.fetch, {
    apply: async (_target, _receiver, args: Parameters<typeof fetch>) => {
      const [input, init] = args;
      const url = new URL(String(input));
      issuerCalls.push({
        url: url.href,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      expect(init?.redirect).toBe("error");
      if (url.href === github.tokenEndpoint)
        return Response.json({
          access_token: "synthetic-access",
          refresh_token: "synthetic-refresh",
          token_type: "bearer",
          expires_in: 28800,
          scope: "read:user repo",
        });
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-access");
      expect(new Headers(init?.headers).get("user-agent")).toBe(github.userAgent);
      expect(new Headers(init?.headers).get("x-github-api-version")).toBe(github.apiVersion);
      const overridden = await responseOverride?.(url);
      if (overridden !== undefined) return overridden;
      if (url.href === github.identityEndpoint)
        return Response.json(
          { id: 12345, email: "never-expose@example.invalid" },
          { headers: { "x-oauth-scopes": "read:user,repo" } },
        );
      if (url.pathname === `/repos/${selected.owner}/${selected.name}`)
        return Response.json({
          id: selected.id,
          node_id: selected.nodeId,
          name: selected.name,
          owner: { login: selected.owner },
          private: true,
          permissions: { pull: true },
          token: "never-expose",
        });
      if (url.pathname === `/repos/${selected.owner}/${selected.name}/actions/runs`) {
        expect(url.searchParams.get("status")).toBe("completed");
        return Response.json({
          total_count: 1,
          workflow_runs: [
            {
              id: 456,
              run_attempt: 2,
              workflow_id: 89,
              head_sha: "a".repeat(40),
              head_branch: "development",
              status: "completed",
              conclusion: "failure",
              created_at: "2026-11-03T10:00:00Z",
              updated_at: "2026-11-03T10:01:00Z",
              html_url: `https://github.com/${selected.owner}/${selected.name}/actions/runs/456`,
              repository: { id: selected.id, node_id: selected.nodeId },
              logs_url: "https://never-follow.invalid",
              actor: { email: "never-expose@example.invalid" },
            },
          ],
        });
      }
      throw new Error(`Unexpected source endpoint: ${url.origin}${url.pathname}`);
    },
  });
  const verifier = "x".repeat(43);
  const exchanged = await exchangeAuthorizationCode({
    dialect: github.dialect,
    resource: github.resource,
    mcpTransportUrl: github.transportUrl,
    mcpIssuer: github.issuer,
    mcpPermissionProfile: "github-repositories-read-write",
    clientId: "owned-app",
    tokenEndpoint: github.tokenEndpoint,
    code: "synthetic-code",
    redirectUri: "http://127.0.0.1:43125/oauth/callback",
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
    clientAuthentication: {
      method: "client_secret_post",
      secretRef,
      tokenEndpoint: github.tokenEndpoint,
    },
    resolveClientSecret: async () => "synthetic-app-secret",
    fetch: fetchPort,
    now: () => now,
  });
  if (exchanged.kind !== "tokens")
    throw new Error(`Expected valid synthetic grant: ${exchanged.kind}`);
  await store.set(credentialRef, JSON.stringify(exchanged.grant));
  const runtime = createHostOAuthRuntime({
    store,
    fetch: fetchPort,
    now: () => now,
    resolveClientSecret: async () => "synthetic-app-secret",
  });
  const ownedBroker = socket
    ? await startCredentialBroker(store, undefined, { fetch: fetchPort, now: () => now })
    : undefined;
  const brokerCalls: string[] = [];
  const broker = makeHostOAuthBrokerClient({
    url: ownedBroker?.url ?? "http://127.0.0.1:9",
    token: ownedBroker?.token ?? "synthetic-broker-capability",
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      brokerCalls.push(path);
      if (ownedBroker !== undefined) return fetch(request);
      expect(
        request.headers.get("x-octant-credential-broker-token") === "synthetic-broker-capability",
      ).toBe(true);
      return handleHostOAuthBrokerRoute(path, request, runtime);
    },
  });
  const read = broker.githubActionsSource;
  if (read === undefined) throw new Error("Expected current broker source operation");
  const statePath = join(directory, "sign-ins.json");
  await writeFile(
    statePath,
    JSON.stringify({
      schemaVersion: 1,
      signIns: {
        [`${extension}:${component}`]: {
          credentialRef,
          descriptor,
          issuer: github.issuer,
          account: { userId: "12345", grantedScopes: ["read:user", "repo"] },
        },
      },
    }),
  );
  let packageState = sourcePackageState(activation);
  const policy = () =>
    bindGeneratedMcpSignInPolicy({
      policy: {
        url: github.transportUrl,
        mcpPermissionProfile: "github-repositories-read-write",
        current: () => true,
      },
      packageState,
      componentId: component,
      readPackage: () => packageState,
    });
  const service = new McpServerSignIn({
    statePath,
    oauth: createHostOAuthService({ broker, journal: { append: () => undefined } }),
    access: (ref) => broker.access(ref),
    refresh: (ref) => broker.refresh(ref),
    githubActionsSource: read,
    actorId: credentialRef,
    now: () => new Date(now),
    serverUrl: async () => github.transportUrl,
    serverPolicy: async () =>
      activation === "missing-witness"
        ? {
            url: github.transportUrl,
            mcpPermissionProfile: "github-repositories-read-write",
            current: () => true,
          }
        : policy(),
  });
  return {
    service,
    policy,
    socketUrl: ownedBroker?.url,
    issuerCalls,
    brokerCalls,
    disable: () => {
      packageState = sourcePackageState("component-disabled", packageState.stateVersion + 1);
    },
    deactivateWithoutRevision: () => {
      packageState = sourcePackageState("component-disabled", packageState.stateVersion);
    },
    read,
    values,
    runtime,
    respond: (reply: typeof responseOverride) => {
      responseOverride = reply;
    },
    holdWrite: (gate: typeof writeGate) => {
      writeGate = gate;
    },
    close: async () => {
      try {
        await runtime.close();
      } finally {
        try {
          await ownedBroker?.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
  };
}

describe("selected registered GitHub Actions source real broker path", () => {
  it("keeps setup current while a source-specific effective witness retires", async () => {
    const host = await fixture();
    try {
      const source = await host.service.bindGithubActionsSource(extension, component, selected);
      if (source === undefined) throw new Error("Expected selected active source");
      const setup = host.policy();
      host.deactivateWithoutRevision();
      expect(setup.current()).toBe(true);
      expect(setup.sourceCurrent?.()).toBe(false);
      expect(source.current()).toBe(false);
      const before = host.issuerCalls.length;
      const brokerBefore = host.brokerCalls.length;
      expect(await source.runs()).toEqual({ kind: "refused", reason: "connection-unavailable" });
      expect(host.issuerCalls).toHaveLength(before);
      expect(host.brokerCalls).toHaveLength(brokerBefore);
    } finally {
      await host.close();
    }
  });

  it("does not publish a newly bound source after Disable during repository preparation", async () => {
    const host = await fixture();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    host.respond(async (url) => {
      if (url.pathname !== `/repos/${selected.owner}/${selected.name}`) return undefined;
      entered = true;
      await held;
      return Response.json({
        id: selected.id,
        node_id: selected.nodeId,
        name: selected.name,
        owner: { login: selected.owner },
      });
    });
    try {
      const pending = host.service.bindGithubActionsSource(extension, component, selected);
      await vi.waitFor(() => expect(entered).toBe(true));
      host.disable();
      release?.();
      expect(await pending).toBeUndefined();
    } finally {
      release?.();
      await host.close();
    }
  });

  it.each([
    "untrusted",
    "plugin-disabled",
    "component-disabled",
    "not-installed",
    "quarantined",
    "missing-component",
    "missing-witness",
  ] as const)(
    "refuses a fresh %s source before broker/API reads using production owner policy",
    async (activation) => {
      const host = await fixture(false, activation);
      try {
        const before = host.issuerCalls.length;
        const brokerBefore = host.brokerCalls.length;
        expect(
          await host.service.bindGithubActionsSource(extension, component, selected),
        ).toBeUndefined();
        expect(host.issuerCalls).toHaveLength(before);
        expect(host.brokerCalls).toHaveLength(brokerBefore);
        if (activation !== "not-installed") expect(host.policy().current()).toBe(true);
      } finally {
        await host.close();
      }
    },
  );

  it.each(["oversized", "held"] as const)(
    "bounds a %s GitHub response body without publishing partial metadata",
    async (variant) => {
      const host = await fixture();
      let releaseBody: (() => void) | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          releaseBody = () => {
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify({ total_count: 0, workflow_runs: [] })),
            );
            controller.close();
          };
        },
      });
      try {
        const source = await host.service.bindGithubActionsSource(extension, component, selected);
        if (source === undefined) throw new Error("Expected source");
        host.respond(async (url) =>
          url.pathname.endsWith("/actions/runs")
            ? new Response(variant === "held" ? body : new Uint8Array(2 * 1024 * 1024 + 1))
            : undefined,
        );
        if (variant === "held") vi.useFakeTimers();
        const pending = host.runtime.githubActionsSource({
          kind: "runs",
          credentialRef,
          clientId: "owned-app",
          secretRef,
          accountId: "12345",
          repository: selected,
          page: 1,
        });
        if (variant === "held") {
          await vi.waitFor(() => expect(body.locked).toBe(true));
          await vi.advanceTimersByTimeAsync(20_001);
        }
        expect(await pending).toMatchObject({ kind: "refused" });
        if (variant === "held") {
          releaseBody?.();
          await vi.advanceTimersByTimeAsync(1);
          expect(await pending).toMatchObject({ kind: "refused" });
        }
      } finally {
        vi.useRealTimers();
        await host.close();
      }
    },
  );

  it("keeps a grant on malformed identity but retires a proven changed account", async () => {
    const host = await fixture();
    try {
      const source = await host.service.bindGithubActionsSource(extension, component, selected);
      if (source === undefined) throw new Error("Expected source");
      host.respond(async (url) =>
        url.href === github.identityEndpoint ? Response.json({ id: null }) : undefined,
      );
      expect(await source.runs()).toEqual({ kind: "refused", reason: "source-unavailable" });
      expect(host.values.has(credentialRef)).toBe(true);
      expect(source.current()).toBe(true);
      host.respond(async (url) =>
        url.href === github.identityEndpoint ? Response.json({ id: 54321 }) : undefined,
      );
      expect(await source.runs()).toEqual({ kind: "refused", reason: "account-changed" });
      expect(host.values.has(credentialRef)).toBe(false);
      expect(source.current()).toBe(false);
    } finally {
      await host.close();
    }
  });

  it.runIf(process.env.OCTANT_RUN_GITHUB_ACTIONS_SOCKET === "1")(
    "uses the actual protected broker transport and rejects a wrong capability before GitHub reads",
    async () => {
      const host = await fixture(true);
      try {
        const source = await host.service.bindGithubActionsSource(extension, component, selected);
        if (source === undefined) throw new Error("Expected actual transport source");
        expect(await source.runs()).toMatchObject({
          kind: "page",
          repository: selected,
          runs: [{ id: 456, attempt: 2 }],
        });
        const before = host.issuerCalls.length;
        const refused = await fetch(new URL("/v1/oauth/github-actions-source", host.socketUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-credential-broker-token": "wrong-capability",
          },
          body: JSON.stringify({
            kind: "repository",
            credentialRef,
            clientId: "owned-app",
            secretRef,
            accountId: "12345",
            owner: selected.owner,
            name: selected.name,
          }),
        });
        expect(refused.status).toBe(401);
        expect(host.issuerCalls).toHaveLength(before);
      } finally {
        await host.close();
      }
    },
  );

  it.each(["primary", "secondary"] as const)(
    "keeps a healthy source current after a throttled 403 %s response",
    async (kind) => {
      const host = await fixture();
      try {
        const source = await host.service.bindGithubActionsSource(extension, component, selected);
        if (source === undefined) throw new Error("Expected original source");
        host.respond(
          async () =>
            new Response(null, {
              status: 403,
              headers:
                kind === "primary"
                  ? {
                      "x-ratelimit-remaining": "0",
                      "x-ratelimit-reset": String(now / 1000 + 60),
                    }
                  : { "retry-after": "60" },
            }),
        );
        expect(await source.runs()).toEqual({
          kind: "refused",
          reason: "rate-limited",
          retryAfterSeconds: 60,
        });
        expect(source.current()).toBe(true);
        host.respond(undefined);
        expect(await source.runs()).toMatchObject({ kind: "page" });
      } finally {
        await host.close();
      }
    },
  );

  it.each(["next page", "foreign Link", "missing Link"] as const)(
    "uses closed same-repository pagination and refuses %s coverage errors",
    async (variant) => {
      const host = await fixture();
      try {
        const source = await host.service.bindGithubActionsSource(extension, component, selected);
        if (source === undefined) throw new Error("Expected source");
        host.respond(async (url) => {
          if (!url.pathname.endsWith("/actions/runs")) return undefined;
          const page = Number(url.searchParams.get("page"));
          const rows = Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => ({
            id: 456 + (page === 1 ? index : 100),
            run_attempt: 2,
            workflow_id: 89,
            head_sha: "a".repeat(40),
            head_branch: "development",
            status: "completed",
            conclusion: "success",
            created_at: "2026-11-03T10:00:00Z",
            updated_at: "2026-11-03T10:01:00Z",
            html_url: `https://github.com/${selected.owner}/${selected.name}/actions/runs/${456 + (page === 1 ? index : 100)}`,
            repository: { id: selected.id, node_id: selected.nodeId },
          }));
          const next = new URL(url);
          next.searchParams.set("page", "2");
          return Response.json(
            { total_count: 101, workflow_runs: rows },
            {
              headers:
                page === 1 && variant !== "missing Link"
                  ? {
                      link: `<${variant === "foreign Link" ? "https://other.invalid/collect" : next.href}>; rel="next"`,
                    }
                  : {},
            },
          );
        });
        const first = await source.runs({ branch: "development", workflowId: 89 });
        if (variant !== "next page") {
          expect(first).toMatchObject({ kind: "refused" });
          return;
        }
        expect(first).toMatchObject({ kind: "page", totalCount: 101, nextPage: 2 });
        if (first.kind !== "page" || first.nextPage === undefined)
          throw new Error("Expected completed page with its next-page receipt");
        expect(first.runs).toHaveLength(100);
        expect(
          await source.runs({ page: first.nextPage, branch: "development", workflowId: 89 }),
        ).toMatchObject({ kind: "page", runs: [{ id: 556, attempt: 2 }], totalCount: 101 });
        const before = host.issuerCalls.length;
        expect(await source.runs({ page: 6 })).toMatchObject({ kind: "refused" });
        expect(host.issuerCalls).toHaveLength(before);
      } finally {
        await host.close();
      }
    },
  );

  it("keeps an original selected repository assertion during held preparation and never adopts a caller edit", async () => {
    const host = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      host.respond(async (url) => {
        if (url.pathname === `/repos/${selected.owner}/${selected.name}`) {
          entered.resolve();
          await release.promise;
        }
        return undefined;
      });
      const expected = { ...selected, id: 888 };
      const pending = host.service.bindGithubActionsSource(extension, component, {
        ...selected,
        expected,
      });
      await entered.promise;
      expected.id = selected.id;
      release.resolve();
      expect(await pending).toBeUndefined();
    } finally {
      release.resolve();
      await host.close();
    }
  });

  it("bounds an uncooperative broker read and ignores its late metadata response", async () => {
    const held = Promise.withResolvers<Response>();
    const broker = makeHostOAuthBrokerClient({
      url: "http://127.0.0.1:9",
      token: "synthetic-capability",
      fetch: async () => held.promise,
    });
    const read = broker.githubActionsSource;
    if (read === undefined) throw new Error("Expected source capability");
    vi.useFakeTimers();
    try {
      const pending = read({
        kind: "repository",
        credentialRef,
        clientId: "owned-app",
        secretRef,
        accountId: "12345",
        owner: selected.owner,
        name: selected.name,
      });
      await vi.advanceTimersByTimeAsync(20_001);
      expect(await pending).toEqual({ kind: "refused", reason: "connection-unavailable" });
      held.resolve(Response.json({ kind: "repository", accountId: "12345", repository: selected }));
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ kind: "refused", reason: "connection-unavailable" });
    } finally {
      vi.useRealTimers();
      held.resolve(new Response(null, { status: 503 }));
    }
  });

  it("bounds a noncooperative GitHub response at the real runtime without releasing late source metadata", async () => {
    const host = await fixture();
    const held = Promise.withResolvers<Response>();
    const entered = Promise.withResolvers<void>();
    try {
      const source = await host.service.bindGithubActionsSource(extension, component, selected);
      if (source === undefined) throw new Error("Expected source");
      host.respond(async (url) => {
        if (url.pathname.endsWith("/actions/runs")) {
          entered.resolve();
          return held.promise;
        }
        return undefined;
      });
      vi.useFakeTimers();
      const pending = host.runtime.githubActionsSource({
        kind: "runs",
        credentialRef,
        clientId: "owned-app",
        secretRef,
        accountId: "12345",
        repository: selected,
        page: 1,
      });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(20_001);
      expect(await pending).toMatchObject({ kind: "refused" });
      held.resolve(Response.json({ total_count: 0, workflow_runs: [] }));
      expect(await pending).toMatchObject({ kind: "refused" });
    } finally {
      vi.useRealTimers();
      held.resolve(new Response(null, { status: 503 }));
      await host.close();
    }
  });

  it.each([
    "wrong client",
    "wrong secret",
    "wrong account",
    "legacy profile",
    "wrong issuer",
    "wrong resource",
  ] as const)("refuses %s before using a bearer at GitHub", async (variant) => {
    const host = await fixture();
    try {
      const owner = { credentialRef, clientId: "owned-app", secretRef, accountId: "12345" };
      if (
        variant === "legacy profile" ||
        variant === "wrong issuer" ||
        variant === "wrong resource"
      ) {
        const grant = JSON.parse(host.values.get(credentialRef) ?? "{}");
        if (variant === "legacy profile") delete grant.mcpPermissionProfile;
        if (variant === "wrong issuer") grant.mcpIssuer = "https://other.invalid";
        if (variant === "wrong resource") grant.resource = "https://other.invalid/mcp";
        host.values.set(credentialRef, JSON.stringify(grant));
      }
      const before = host.issuerCalls.length;
      expect(
        await host.read({
          ...owner,
          ...(variant === "wrong client" ? { clientId: "other-app" } : {}),
          ...(variant === "wrong secret"
            ? { secretRef: "55000000-0000-4000-8000-000000000099" }
            : {}),
          ...(variant === "wrong account" ? { accountId: "54321" } : {}),
          kind: "repository",
          owner: selected.owner,
          name: selected.name,
        }),
      ).toMatchObject({ kind: "refused" });
      expect(host.issuerCalls).toHaveLength(before);
    } finally {
      await host.close();
    }
  });

  it.each([
    "repository changed",
    "node changed",
    "invalid attempt",
    "redirect",
    "forbidden",
    "rate limit",
  ] as const)(
    "keeps %s unavailable rather than treating it as a completed source page",
    async (variant) => {
      const host = await fixture();
      try {
        const source = await host.service.bindGithubActionsSource(extension, component, selected);
        if (source === undefined) throw new Error("Expected original source");
        host.respond(async (url) => {
          if (variant === "redirect")
            return new Response(null, {
              status: 302,
              headers: { location: "https://never-follow.invalid" },
            });
          if (variant === "forbidden")
            return new Response(null, {
              status: 403,
              headers: {
                "x-ratelimit-remaining": "99",
                "x-ratelimit-reset": String(now / 1000 + 60),
              },
            });
          if (variant === "rate limit")
            return new Response(null, { status: 429, headers: { "retry-after": "60" } });
          if (
            url.pathname === `/repos/${selected.owner}/${selected.name}` &&
            (variant === "repository changed" || variant === "node changed")
          )
            return Response.json({
              id: variant === "repository changed" ? 888 : selected.id,
              node_id: variant === "node changed" ? "R_other" : selected.nodeId,
              owner: { login: selected.owner },
              name: selected.name,
            });
          if (url.pathname.endsWith("/actions/runs") && variant === "invalid attempt")
            return Response.json({ total_count: 1, workflow_runs: [{ id: 456, run_attempt: 0 }] });
          return undefined;
        });
        expect(await source.runs()).toMatchObject({ kind: "refused" });
        if (
          variant === "repository changed" ||
          variant === "node changed" ||
          variant === "forbidden"
        )
          expect(source.current()).toBe(false);
        expect(
          host.issuerCalls.some((call) => call.url.startsWith("https://never-follow.invalid")),
        ).toBe(false);
      } finally {
        await host.close();
      }
    },
  );

  it("cannot publish a held old source response after its host policy is disabled", async () => {
    const host = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      const source = await host.service.bindGithubActionsSource(extension, component, selected);
      if (source === undefined) throw new Error("Expected source");
      host.respond(async (url) => {
        if (url.pathname.endsWith("/actions/runs")) {
          entered.resolve();
          await release.promise;
        }
        return undefined;
      });
      const pending = source.runs();
      await entered.promise;
      host.disable();
      release.resolve();
      expect(await pending).toEqual({ kind: "refused", reason: "connection-unavailable" });
      expect(source.current()).toBe(false);
    } finally {
      release.resolve();
      await host.close();
    }
  });

  it("joins the selected grant's held refresh write before actual Sign out and cannot recreate a usable source", async () => {
    const host = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      const source = await host.service.bindGithubActionsSource(extension, component, selected);
      if (source === undefined) throw new Error("Expected source");
      const grant = JSON.parse(host.values.get(credentialRef) ?? "{}");
      const sibling = "55000000-0000-4000-8000-000000000099";
      host.values.set(sibling, JSON.stringify(grant));
      host.values.set(credentialRef, JSON.stringify({ ...grant, expiresAt: now - 1 }));
      host.holdWrite(async () => {
        entered.resolve();
        await release.promise;
      });
      const pending = source.runs();
      await entered.promise;
      let signedOut = false;
      const signingOut = host.service
        .signOut(extension, component, "local-window")
        .then((result) => {
          signedOut = true;
          return result;
        });
      await vi.waitFor(async () => {
        expect(await host.runtime.access(credentialRef)).toEqual({ kind: "unavailable" });
      });
      expect(signedOut).toBe(false);
      expect(source.current()).toBe(false);
      const before = host.issuerCalls.length;
      release.resolve();
      expect(await signingOut).toEqual({ kind: "signed-out" });
      expect(await pending).toMatchObject({ kind: "refused" });
      expect(host.values.has(credentialRef)).toBe(false);
      expect(await host.runtime.access(sibling)).toMatchObject({ kind: "granted" });
      expect(host.issuerCalls).toHaveLength(before);
      expect(source.current()).toBe(false);
      expect(await source.runs()).toMatchObject({ kind: "refused" });
    } finally {
      release.resolve();
      await host.close();
    }
  });

  it("prepares the same grant's repository and returns only completed attempt metadata", async () => {
    const host = await fixture();
    try {
      const source = await host.service.bindGithubActionsSource(extension, component, selected);
      expect(host.brokerCalls).toEqual(["/v1/oauth/github-actions-source"]);
      expect(source?.repository).toEqual(selected);
      if (source === undefined) throw new Error("Expected bound source");
      const result = await source.runs();
      expect(result).toMatchObject({
        kind: "page",
        accountId: "12345",
        repository: selected,
        runs: [{ id: 456, attempt: 2, workflowId: 89, conclusion: "failure" }],
      });
      expect(host.brokerCalls).toContain("/v1/oauth/github-actions-source");
      expect(JSON.stringify(result)).not.toContain("synthetic-access");
      expect(JSON.stringify(result)).not.toContain("never-expose");
      expect(JSON.stringify(result)).not.toContain("logs_url");
      const calls = host.issuerCalls.length;
      host.disable();
      expect(await source.runs()).toEqual({ kind: "refused", reason: "connection-unavailable" });
      expect(host.issuerCalls).toHaveLength(calls);
    } finally {
      await host.close();
    }
  });
});
