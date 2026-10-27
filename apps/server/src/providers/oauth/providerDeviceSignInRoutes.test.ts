import {
  decodeDirectoryClientId,
  decodeDirectoryTenantId,
  decodeProviderInstance,
  decodeWindowId,
  type ProviderInstance,
} from "@octant/contracts";
import { AZURE_FOUNDRY_DIRECTORY_SIGN_IN } from "@octant/domain";
import { readDirectoryOAuthCredential } from "@octant/provider-sdk/directory-oauth";
import { describe, expect, it } from "vitest";
import { WindowAuthorityStore } from "../../windowAuthorityStore";
import type { ProviderCredentialStore } from "../credentialBrokerClient";
import type { HostOAuthBrokerPort } from "./hostOAuthBrokerClient";
import { createHostOAuthService } from "./hostOAuthService";
import { createProviderDeviceSignInRouteHandler } from "./providerDeviceSignInRoutes";
import { createProviderOAuthRouteHandler } from "./providerOAuthRoutes";

const secret = "desktop-secret";
const capability = "A".repeat(43);
const otherCapability = "E".repeat(43);
const windowId = decodeWindowId("80000000-0000-4000-8000-000000000031");
const otherWindowId = decodeWindowId("80000000-0000-4000-8000-000000000032");
const instanceId = "00000000-0000-4000-8000-000000000912";
const attemptId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const GRANT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const TENANT = decodeDirectoryTenantId("6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f");
const CLIENT = decodeDirectoryClientId("0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d");

/** A Foundry instance; a field set to undefined is left out of its configuration. */
function foundry(
  configuration: Record<string, unknown> = {},
  displayName = "Contoso Foundry",
): ProviderInstance {
  const merged: Record<string, unknown> = {
    kind: "azure-foundry-openai-http",
    baseUrl: "https://contoso.openai.azure.com/openai/v1/",
    authentication: "directory-oauth",
    protocol: "auto",
    manualModelIds: ["deployment-a"],
    directory: { tenantId: TENANT, clientId: CLIENT },
    deviceCodeSignIn: true,
    ...configuration,
  };
  return decodeProviderInstance({
    id: instanceId,
    displayName,
    driverKind: "azure-foundry",
    configuration: Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined),
    ),
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: "2026-10-26T10:00:00.000Z",
    updatedAt: "2026-10-26T10:00:00.000Z",
  });
}

type Call =
  | { readonly name: "begin"; readonly descriptor: unknown }
  | { readonly name: "status" }
  | { readonly name: "forget"; readonly credentialRef: string };

/**
 * The organization sign-in behind a broker double that answers as the real
 * broker does for a device code: awaiting until the person enters the code on
 * another device, then signed in with the account the directory named.
 */
function fixture(options: { readonly instance?: ProviderInstance } = {}) {
  const calls: Call[] = [];
  let stored: string | undefined;
  let personFinished = false;
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
  const awaiting = {
    kind: "awaiting-consent",
    attemptId,
    descriptorId: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.descriptorId,
    flow: "device-code",
    verificationUri: "https://microsoft.com/devicelogin",
    userCode: "F7QK2M9XZ",
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  } as const;
  const broker: HostOAuthBrokerPort = {
    begin: async (input) => {
      calls.push({ name: "begin", descriptor: input.descriptor });
      return input.descriptor.flow === "device-code"
        ? awaiting
        : {
            kind: "awaiting-consent",
            attemptId,
            descriptorId: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.descriptorId,
            flow: "authorization-code-pkce",
            authorizationUrl: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
            expiresAt: awaiting.expiresAt,
          };
    },
    status: async () => {
      calls.push({ name: "status" });
      return personFinished
        ? {
            kind: "signed-in",
            attemptId,
            descriptorId: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.descriptorId,
            credentialRef: GRANT,
            accountLabel: "ada@contoso.example",
          }
        : awaiting;
    },
    refresh: async () => ({ kind: "refreshed" }),
    access: async () => ({ kind: "unavailable" }),
    revoke: async () => ({ kind: "not-revoked" }),
    forget: async (credentialRef) => void calls.push({ name: "forget", credentialRef }),
  };
  const service = createHostOAuthService({ journal: { append: () => undefined }, broker });
  const authority = new WindowAuthorityStore();
  authority.register({ windowId, capability, now: Date.now() });
  authority.register({ windowId: otherWindowId, capability: otherCapability, now: Date.now() });
  let instance: ProviderInstance | undefined = options.instance ?? foundry();
  const signIn = {
    service,
    windowAuthorityStore: authority,
    credentials,
    readInstance: () => instance,
  };
  const route = createProviderDeviceSignInRouteHandler({
    desktopBridgeSecret: secret,
    windowAuthorityStore: authority,
    readProviderInstances: () => (instance === undefined ? [] : [instance]),
    signIn,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    followIntervalMs: 1,
  });
  const send = async (
    path: "begin" | "poll",
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
    host = "127.0.0.1",
  ): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> => {
    const response = await route(
      new Request(`http://${host}/api/desktop/provider-sign-in/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-desktop-secret": secret,
          "x-octant-window-capability": capability,
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );
    if (response === undefined) throw new Error("the route did not answer");
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return {
    calls,
    stored: () => stored,
    removeInstance: () => {
      instance = undefined;
    },
    finishOnAnotherDevice: () => {
      personFinished = true;
    },
    send,
    browserRoute: createProviderOAuthRouteHandler(signIn),
  };
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("host-local device-code sign-in", () => {
  it("signs an opted-in organization endpoint in with a device code and keeps the pointer for its own binding", async () => {
    const scene = fixture();

    // The consent line comes first, from the host, before any code exists.
    const unacknowledged = await scene.send("begin", {
      instance: "Contoso Foundry",
      acknowledgeTerms: false,
    });
    expect(unacknowledged).toEqual({
      status: 200,
      body: {
        outcome: "terms-required",
        instanceId,
        displayName: "Contoso Foundry",
        termsSummary: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.termsSummary,
      },
    });
    expect(scene.calls).toEqual([]);

    const begun = await scene.send("begin", {
      instance: "Contoso Foundry",
      acknowledgeTerms: true,
    });
    expect(begun.body).toEqual({
      outcome: "awaiting-code",
      instanceId,
      displayName: "Contoso Foundry",
      attemptId,
      verificationUri: "https://microsoft.com/devicelogin",
      userCode: "F7QK2M9XZ",
      expiresAt: expect.any(String),
      warning: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.deviceCodeWarning,
    });
    // The descriptor is the instance's own binding with the device-code flow,
    // and still names no URL the broker would otherwise build.
    expect(scene.calls[0]).toEqual({
      name: "begin",
      descriptor: {
        descriptorId: "azure-foundry-directory",
        dialect: "directory-oidc",
        flow: "device-code",
        clientId: CLIENT,
        tenantId: TENANT,
        audience: "https://cognitiveservices.azure.com",
        endpointOrigin: "https://contoso.openai.azure.com",
        scopes: [],
        termsId: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.termsId,
      },
    });
    expect(await scene.send("poll", { instance: instanceId, attemptId })).toEqual({
      status: 200,
      body: { outcome: "waiting", instanceId, displayName: "Contoso Foundry" },
    });

    scene.finishOnAnotherDevice();
    await eventually(() => scene.stored() !== undefined);

    expect(await scene.send("poll", { instance: instanceId, attemptId })).toEqual({
      status: 200,
      body: {
        outcome: "signed-in",
        instanceId,
        displayName: "Contoso Foundry",
        accountLabel: "ada@contoso.example",
      },
    });
    expect(readDirectoryOAuthCredential(scene.stored() ?? "")).toEqual({
      kind: "directory-oauth",
      credentialRef: GRANT,
      tenantId: TENANT,
      clientId: CLIENT,
      audience: "https://cognitiveservices.azure.com",
      endpointOrigin: "https://contoso.openai.azure.com",
      accountLabel: "ada@contoso.example",
    });
  });

  it("stores a sign-in the person finishes after the command stopped waiting", async () => {
    const scene = fixture();
    await scene.send("begin", { instance: instanceId, acknowledgeTerms: true });

    // Nobody polls: the command was interrupted. The host follows the attempt.
    scene.finishOnAnotherDevice();
    await eventually(() => scene.stored() !== undefined);

    expect(readDirectoryOAuthCredential(scene.stored() ?? "")?.credentialRef).toBe(GRANT);
  });

  it("forgets the grant of a sign-in finished after its endpoint was removed", async () => {
    const scene = fixture();
    await scene.send("begin", { instance: instanceId, acknowledgeTerms: true });

    scene.removeInstance();
    scene.finishOnAnotherDevice();
    await eventually(() => scene.calls.some((call) => call.name === "forget"));

    expect(scene.calls).toContainEqual({ name: "forget", credentialRef: GRANT });
    expect(scene.stored()).toBeUndefined();
  });

  it.each([
    [
      "an organization endpoint that has not opted in",
      foundry({ deviceCodeSignIn: undefined }),
      "device-code-not-enabled",
    ],
    [
      "an endpoint that signs in with an API key",
      foundry({ authentication: "api-key", directory: undefined, deviceCodeSignIn: undefined }),
      "no-organization-sign-in",
    ],
  ])("refuses %s before any broker call", async (_, instance, category) => {
    const scene = fixture({ instance });

    const begun = await scene.send("begin", { instance: instanceId, acknowledgeTerms: true });

    expect(begun).toMatchObject({ status: 409, body: { category } });
    expect(scene.calls).toEqual([]);
    expect(scene.stored()).toBeUndefined();
  });

  it.each([
    ["a caller without the host's bridge secret", { "x-octant-desktop-secret": "" }, "127.0.0.1"],
    ["a browser page", { origin: "http://127.0.0.1:13773" }, "127.0.0.1"],
    ["a request addressed to another host", {}, "octant.example"],
    ["a caller without a window authority", { "x-octant-window-capability": "" }, "127.0.0.1"],
  ])("refuses %s before any broker call", async (_, headers, host) => {
    const scene = fixture();

    const begun = await scene.send(
      "begin",
      { instance: instanceId, acknowledgeTerms: true },
      headers,
      host,
    );

    expect(begun).toMatchObject({ status: 401, body: { category: "unauthorized" } });
    expect(scene.calls).toEqual([]);
  });

  it("answers a poll only for the command that began the attempt", async () => {
    const scene = fixture();
    await scene.send("begin", { instance: instanceId, acknowledgeTerms: true });

    const fromAnotherCommand = await scene.send(
      "poll",
      { instance: instanceId, attemptId },
      { "x-octant-window-capability": otherCapability },
    );

    expect(fromAnotherCommand).toMatchObject({
      status: 404,
      body: { category: "unknown-attempt" },
    });
  });

  it("refuses a device code for a gateway that signs in at its organization's own issuer", async () => {
    const gateway = decodeProviderInstance({
      id: instanceId,
      displayName: "Company gateway",
      driverKind: "openai-compatible",
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://llm.example.test/v1/",
        authentication: "directory-oauth",
        protocol: "auto",
        manualModelIds: [],
        directory: {
          issuer: "https://login.example.test/oauth2/gateway",
          clientId: "0oa1octantDesktop",
          scope: "gateway.models",
        },
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 1,
      createdAt: "2026-10-26T10:00:00.000Z",
      updatedAt: "2026-10-26T10:00:00.000Z",
    });
    const scene = fixture({ instance: gateway });

    const refused = await scene.send("begin", {
      instance: "Company gateway",
      acknowledgeTerms: true,
    });

    expect(refused).toMatchObject({
      status: 409,
      body: { category: "device-code-not-enabled" },
    });
    expect(scene.calls).toEqual([]);
  });

  it("never begins a device code from Settings' sign-in route, even when asked for one", async () => {
    const scene = fixture();
    const command = (kind: "acknowledge" | "begin") =>
      new Request("http://127.0.0.1/api/providers/oauth", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": capability },
        body: JSON.stringify({
          kind,
          instanceId,
          descriptorId: AZURE_FOUNDRY_DIRECTORY_SIGN_IN.descriptorId,
          flow: "device-code",
        }),
      });
    await scene.browserRoute(command("acknowledge"));
    await scene.browserRoute(command("begin"));

    expect(scene.calls).toEqual([
      { name: "begin", descriptor: expect.objectContaining({ flow: "authorization-code-pkce" }) },
    ]);
  });
});
