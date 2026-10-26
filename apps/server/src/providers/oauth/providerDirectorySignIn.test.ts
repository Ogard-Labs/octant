import {
  decodeDirectoryClientId,
  decodeDirectoryIssuer,
  decodeDirectoryIssuerClientId,
  decodeDirectoryResourceScope,
  decodeDirectoryTenantId,
  decodeProviderInstance,
  decodeWindowId,
  type ProviderInstanceId,
} from "@octant/contracts";
import {
  decodeHostOAuthDescriptor,
  decodeHostOAuthTermsAcknowledgment,
} from "@octant/contracts/host-oauth";
import {
  AZURE_FOUNDRY_DIRECTORY_SIGN_IN,
  GATEWAY_DIRECTORY_SIGN_IN,
  azureFoundryDirectoryDescriptor,
} from "@octant/domain";
import {
  encodeDirectoryOAuthCredential,
  readDirectoryOAuthCredential,
} from "@octant/provider-sdk/directory-oauth";
import { describe, expect, it } from "vitest";
import { WindowAuthorityStore } from "../../windowAuthorityStore";
import type { ProviderCredentialStore } from "../credentialBrokerClient";
import type { HostOAuthBrokerPort } from "./hostOAuthBrokerClient";
import { createHostOAuthService } from "./hostOAuthService";
import { createProviderOAuthRouteHandler } from "./providerOAuthRoutes";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("80000000-0000-4000-8000-000000000020");
const instanceId = "00000000-0000-4000-8000-000000000911" as ProviderInstanceId;
const attemptId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT = decodeDirectoryTenantId("6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f");
const CLIENT = decodeDirectoryClientId("0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d");
const OLD_GRANT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NEW_GRANT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const foundry = decodeProviderInstance({
  id: instanceId,
  displayName: "Contoso Foundry",
  driverKind: "azure-foundry",
  configuration: {
    kind: "azure-foundry-openai-http",
    baseUrl: "https://contoso.openai.azure.com/openai/v1/",
    authentication: "directory-oauth",
    protocol: "auto",
    manualModelIds: ["deployment-a"],
    directory: { tenantId: TENANT, clientId: CLIENT },
  },
  enabled: true,
  environmentPolicy: "inherit-host",
  version: 1,
  createdAt: "2026-10-26T10:00:00.000Z",
  updatedAt: "2026-10-26T10:00:00.000Z",
});

const ISSUER = decodeDirectoryIssuer("https://login.example.test/oauth2/gateway");
const ISSUER_CLIENT = decodeDirectoryIssuerClientId("0oa1octantDesktop");
const SCOPE = decodeDirectoryResourceScope("gateway.models");

const gatewayInstance = (driverKind: "openai-compatible" | "anthropic-compatible") =>
  decodeProviderInstance({
    id: instanceId,
    displayName: "Gateway",
    driverKind,
    configuration:
      driverKind === "openai-compatible"
        ? {
            kind: "openai-compatible-http",
            baseUrl: "https://openrouter.ai/api/v1/",
            authentication: "directory-oauth",
            protocol: "auto",
            manualModelIds: [],
            directory: { issuer: ISSUER, clientId: ISSUER_CLIENT, scope: SCOPE },
          }
        : {
            kind: "anthropic-compatible-http",
            baseUrl: "https://openrouter.ai/api/v1/",
            authentication: "directory-oauth",
            protocol: "auto",
            protocolVersion: "2023-06-01",
            manualModelIds: [],
            directory: { issuer: ISSUER, clientId: ISSUER_CLIENT, scope: SCOPE },
          },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: "2026-10-26T10:00:00.000Z",
    updatedAt: "2026-10-26T10:00:00.000Z",
  });

const pointerFor = (credentialRef: string) =>
  encodeDirectoryOAuthCredential({
    kind: "directory-oauth",
    credentialRef,
    tenantId: TENANT,
    clientId: CLIENT,
    audience: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.audience,
    endpointOrigin: "https://contoso.openai.azure.com",
    accountLabel: "Earlier Person",
  });

describe("organization sign-in routes", () => {
  it("signs in for the instance's own tenant, client, and endpoint and keeps a pointer named for the account", async () => {
    const scene = fixture();
    expect(await scene.send("status")).toMatchObject({
      kind: "signed-out",
      termsRequired: true,
      termsSummary: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.termsSummary,
    });
    expect(await scene.send("acknowledge")).toMatchObject({
      kind: "signed-out",
      termsRequired: false,
    });
    expect(await scene.send("begin")).toMatchObject({ kind: "awaiting-consent", attemptId });
    // The descriptor comes from the instance, never from the request: no URL,
    // no scope, and the binding the broker will hold the grant to.
    expect(scene.calls[0]).toEqual({
      name: "begin",
      descriptor: {
        descriptorId: "azure-foundry-directory",
        dialect: "directory-oidc",
        flow: "authorization-code-pkce",
        clientId: CLIENT,
        tenantId: TENANT,
        audience: "https://cognitiveservices.azure.com",
        endpointOrigin: "https://contoso.openai.azure.com",
        scopes: [],
        termsId: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.termsId,
      },
    });

    expect(await scene.send("poll")).toEqual({
      kind: "signed-in",
      accountLabel: "person@contoso.example",
    });
    expect(readDirectoryOAuthCredential(scene.stored() ?? "")).toEqual({
      kind: "directory-oauth",
      credentialRef: NEW_GRANT,
      tenantId: TENANT,
      clientId: CLIENT,
      audience: "https://cognitiveservices.azure.com",
      endpointOrigin: "https://contoso.openai.azure.com",
      accountLabel: "person@contoso.example",
    });
  });

  it("keeps a sign-in the organization wants repeated in person, and forgets one that ended", async () => {
    const kept = fixture({ stored: pointerFor(OLD_GRANT), refresh: "interaction-required" });
    expect(await kept.send("status")).toEqual({
      kind: "expired",
      accountLabel: "Earlier Person",
      reason: "interaction-required",
    });
    expect(kept.stored()).toBe(pointerFor(OLD_GRANT));

    const ended = fixture({ stored: pointerFor(OLD_GRANT), refresh: "revoked" });
    expect(await ended.send("status")).toEqual({ kind: "expired", accountLabel: "Earlier Person" });
    expect(ended.stored()).toBeUndefined();
  });

  it("replaces a kept grant with the new sign-in's grant and forgets the kept one", async () => {
    const scene = fixture({ stored: pointerFor(OLD_GRANT), acknowledged: true });
    await scene.send("begin");
    await scene.send("poll");

    expect(scene.calls).toContainEqual({ name: "forget", credentialRef: OLD_GRANT });
    expect(readDirectoryOAuthCredential(scene.stored() ?? "")?.credentialRef).toBe(NEW_GRANT);
  });

  it("signs out on this computer only, forgetting the grant, and says the organization was not told", async () => {
    const scene = fixture({ stored: pointerFor(OLD_GRANT) });

    expect(await scene.send("sign-out")).toMatchObject({ kind: "signed-out-locally" });
    expect(scene.calls).toEqual([{ name: "forget", credentialRef: OLD_GRANT }]);
    expect(scene.stored()).toBeUndefined();
  });

  it("refuses a sign-in for an instance that does not sign in with its organization", async () => {
    const keyed = decodeProviderInstance({
      ...foundry,
      configuration: {
        kind: "azure-foundry-openai-http",
        baseUrl: "https://contoso.openai.azure.com/openai/v1/",
        authentication: "api-key",
        protocol: "auto",
        manualModelIds: ["deployment-a"],
      },
    });
    const scene = fixture({ instance: keyed, acknowledged: true });

    expect(await scene.send("begin")).toEqual({ kind: "refused", reason: "unsupported-driver" });
    expect(scene.calls).toEqual([]);
  });

  it.each(["openai-compatible", "anthropic-compatible"] as const)(
    "signs an organization gateway (%s) in at its own issuer for its client, scope, and origin, and keeps a pointer named for the account",
    async (driverKind) => {
      const scene = fixture({
        instance: gatewayInstance(driverKind),
        descriptorId: GATEWAY_DIRECTORY_SIGN_IN.descriptorId,
      });
      expect(await scene.send("status")).toMatchObject({
        kind: "signed-out",
        termsRequired: true,
        termsSummary: GATEWAY_DIRECTORY_SIGN_IN.termsSummary,
      });
      await scene.send("acknowledge");
      expect(await scene.send("begin")).toMatchObject({ kind: "awaiting-consent", attemptId });
      // The descriptor comes from the instance, never from the request.
      expect(scene.calls[0]).toEqual({
        name: "begin",
        descriptor: {
          descriptorId: "gateway-directory",
          dialect: "issuer-oidc",
          flow: "authorization-code-pkce",
          clientId: ISSUER_CLIENT,
          issuer: ISSUER,
          endpointOrigin: "https://openrouter.ai",
          scopes: [SCOPE],
          termsId: GATEWAY_DIRECTORY_SIGN_IN.termsId,
        },
      });

      expect(await scene.send("poll")).toEqual({
        kind: "signed-in",
        accountLabel: "person@contoso.example",
      });
      expect(readDirectoryOAuthCredential(scene.stored() ?? "")).toEqual({
        kind: "directory-oauth",
        credentialRef: NEW_GRANT,
        issuer: ISSUER,
        clientId: ISSUER_CLIENT,
        scope: SCOPE,
        endpointOrigin: "https://openrouter.ai",
        accountLabel: "person@contoso.example",
      });
    },
  );

  it("refuses a command that names another kind's sign-in for the instance, or a catalog sign-in over an organization one", async () => {
    const gateway = fixture({ instance: gatewayInstance("openai-compatible"), acknowledged: true });
    expect(await gateway.send("begin")).toEqual({ kind: "refused", reason: "invalid" });
    const foundryWithGatewayId = fixture({ descriptorId: GATEWAY_DIRECTORY_SIGN_IN.descriptorId });
    expect(await foundryWithGatewayId.send("begin")).toEqual({
      kind: "refused",
      reason: "invalid",
    });
    // The gateway sits at the catalog offer's own address, yet a catalog
    // sign-in would store its pointer over the organization sign-in's.
    const catalog = fixture({
      instance: gatewayInstance("openai-compatible"),
      descriptorId: "openrouter",
      stored: pointerFor(OLD_GRANT),
    });
    expect(await catalog.send("begin")).toEqual({ kind: "refused", reason: "unsupported-driver" });

    expect([...gateway.calls, ...foundryWithGatewayId.calls, ...catalog.calls]).toEqual([]);
    expect(catalog.stored()).toBe(pointerFor(OLD_GRANT));
  });

  it("refuses a remote principal's organization sign-in before any broker call", async () => {
    const calls: string[] = [];
    const service = createHostOAuthService({
      journal: { append: () => undefined },
      broker: recordingBroker(calls),
    });
    const descriptor = azureFoundryDirectoryDescriptor({
      baseUrl: "https://contoso.openai.azure.com/openai/v1/",
      directory: { tenantId: TENANT, clientId: CLIENT },
    });
    if (descriptor === undefined) throw new Error("expected a directory descriptor");

    const begun = await service.begin({
      principalKind: "remote-device",
      actorId: String(windowId),
      descriptor: decodeHostOAuthDescriptor(descriptor),
    });

    expect(begun).toMatchObject({ kind: "refused", reason: "local-host-required" });
    expect(calls).toEqual([]);
  });
});

function recordingBroker(calls: string[]): HostOAuthBrokerPort {
  const record = (name: string) => async () => {
    calls.push(name);
    return { kind: "unavailable" };
  };
  return {
    begin: record("begin"),
    status: record("status"),
    refresh: record("refresh"),
    access: record("access"),
    revoke: record("revoke"),
    forget: async () => void calls.push("forget"),
  };
}

type Call =
  | { readonly name: "begin"; readonly descriptor: unknown }
  | { readonly name: "forget"; readonly credentialRef: string };

function fixture(
  options: {
    readonly stored?: string;
    readonly refresh?: "interaction-required" | "revoked";
    readonly acknowledged?: boolean;
    readonly instance?: typeof foundry;
    readonly descriptorId?: string;
  } = {},
) {
  const descriptorId = options.descriptorId ?? AZURE_FOUNDRY_DIRECTORY_SIGN_IN.descriptorId;
  const calls: Call[] = [];
  let stored = options.stored;
  const credentials: ProviderCredentialStore = {
    has: async () => stored !== undefined,
    resolve: async () => {
      if (stored === undefined) throw { category: "unauthenticated", message: "missing" };
      return stored;
    },
    set: async (_id, value) => {
      stored = value;
    },
    delete: async () => {
      stored = undefined;
    },
  };
  const broker: HostOAuthBrokerPort = {
    begin: async (input) => {
      calls.push({ name: "begin", descriptor: input.descriptor });
      return {
        kind: "awaiting-consent",
        attemptId,
        descriptorId,
        flow: "authorization-code-pkce",
        authorizationUrl: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
        expiresAt: "2026-10-26T10:15:00.000Z",
      };
    },
    status: async () => ({
      kind: "signed-in",
      attemptId,
      descriptorId,
      credentialRef: NEW_GRANT,
      accountLabel: "person@contoso.example",
    }),
    refresh: async () =>
      options.refresh === undefined
        ? { kind: "refreshed" }
        : { kind: "sign-in-again", reason: options.refresh },
    access: async () => ({ kind: "unavailable" }),
    revoke: async () => ({ kind: "not-revoked" }),
    forget: async (credentialRef) => void calls.push({ name: "forget", credentialRef }),
  };
  const service = createHostOAuthService({ journal: { append: () => undefined }, broker });
  if (options.acknowledged === true) {
    service.restoreAcknowledgment(
      decodeHostOAuthTermsAcknowledgment({
        descriptorId,
        termsId:
          descriptorId === GATEWAY_DIRECTORY_SIGN_IN.descriptorId
            ? GATEWAY_DIRECTORY_SIGN_IN.termsId
            : AZURE_FOUNDRY_DIRECTORY_SIGN_IN.termsId,
        actorId: windowId,
        acknowledgedAt: "2026-10-26T09:00:00.000Z",
      }),
    );
  }
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const route = createProviderOAuthRouteHandler({
    service,
    windowAuthorityStore: store,
    now: () => 1,
    credentials,
    readInstance: (id) =>
      String(id) === String(instanceId) ? (options.instance ?? foundry) : undefined,
  });
  return {
    calls,
    stored: () => stored,
    send: async (
      kind: "status" | "acknowledge" | "begin" | "poll" | "sign-out",
    ): Promise<unknown> => {
      const response = await route(
        new Request("http://127.0.0.1/api/providers/oauth", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": capability,
          },
          body: JSON.stringify({
            kind,
            instanceId,
            descriptorId,
            ...(kind === "poll" ? { attemptId } : {}),
          }),
        }),
      );
      return response?.json();
    },
  };
}
