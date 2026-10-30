// Direct sending is a person's act in a window on the hub. These tests drive the
// real administration routes and the real service over a test host, and look for
// the credential everywhere it must not be: the answers, the journal, and the
// hub's state file.

import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createDirectPushRouteHandler } from "./directPushRoutes";
import {
  HUB_ADMINISTRATION_ROUTES,
  createHubAdministrationRouteHandler,
} from "./hubAdministrationRoutes";
import { HubTestNetwork, startHubTestHost } from "./hubHost.test-support";
import {
  TailscaleCertificateService,
  createTailscaleCertificateSetting,
  type TailscaleDaemonPort,
} from "./tailscaleCertificate";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const windowId = decodeWindowId("33333333-3333-4333-8333-333333333333");
const capability = "A".repeat(43);
const secret = "desktop-secret";
const window = { kind: "local-window" } as const;
const unreachableTailscaleDaemon: TailscaleDaemonPort = {
  certificateFor: async () => ({ status: "unavailable", kind: "daemon-not-reachable" }),
};

const exportPem = (key: KeyObject) => String(key.export({ type: "pkcs8", format: "pem" }));
const applePem = exportPem(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey);
const googlePem = exportPem(generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey);
const serviceAccount = JSON.stringify({
  type: "service_account",
  project_id: "demo-project",
  client_email: "push@demo-project.iam.gserviceaccount.com",
  private_key: googlePem,
  token_uri: "https://attacker.example/token",
});

async function setup() {
  const host = await startHubTestHost({
    name: "Mac mini",
    address: "100.101.102.103",
    network: new HubTestNetwork(),
    cleanups,
  });
  const authority = new WindowAuthorityStore();
  authority.register({ windowId, capability, now: Date.now() });
  const handle = createHubAdministrationRouteHandler({
    desktopBridgeSecret: secret,
    windowAuthorityStore: authority,
    hub: host.hub,
    spoke: host.spoke,
    failover: host.failover,
    wake: host.wake,
    spokeWake: host.spokeWake,
    push: host.push,
    spokePush: host.spokePush,
    directPush: host.directPush,
    provision: host.provision,
    spokeProvision: host.spokeProvision,
    signIn: host.signIn,
    spokeSignIn: host.spokeSignIn,
    certificate: new TailscaleCertificateService({
      setting: createTailscaleCertificateSetting(host.directory),
      daemon: unreachableTailscaleDaemon,
      sink: {
        install: async () => ({ status: "refused", kind: "could-not-apply" }),
        remove: async () => ({ status: "removed" }),
        holdsCertificate: () => false,
      },
      listener: () => host.listener,
      now: Date.now,
    }),
  });
  return { host, handle };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: {
      "x-octant-desktop-secret": secret,
      "x-octant-window-capability": capability,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const statusRequest = () =>
  new Request(`http://127.0.0.1${HUB_ADMINISTRATION_ROUTES.status}`, {
    headers: { "x-octant-desktop-secret": secret, "x-octant-window-capability": capability },
  });

/** Every file under a directory that holds `needle`. */
function filesHolding(directory: string, needle: string): string[] {
  const found: string[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (readFileSync(full).includes(needle)) found.push(full);
    }
  };
  visit(directory);
  return found;
}

describe("direct sending on the hub", () => {
  it("is off until a window on the hub turns it on, and shows only whether each credential is stored", async () => {
    const { host, handle } = await setup();
    host.hub.enable(window);

    const before = await handle(statusRequest());
    const enabled = await handle(post(HUB_ADMINISTRATION_ROUTES.directPush, { enabled: true }));
    const environment = await handle(
      post(HUB_ADMINISTRATION_ROUTES.directPushEnvironment, { environment: "development" }),
    );
    const after = await handle(statusRequest());

    expect(((await before!.json()) as { directPush: unknown }).directPush).toEqual({
      enabled: false,
      environment: "production",
      ios: "not-stored",
      android: "not-stored",
    });
    expect(await enabled?.json()).toEqual({ status: "changed" });
    expect(await environment?.json()).toEqual({ status: "changed" });
    expect(((await after!.json()) as { directPush: unknown }).directPush).toEqual({
      enabled: true,
      environment: "development",
      ios: "not-stored",
      android: "not-stored",
    });
    expect(host.records.map((record) => record.change)).toEqual(
      expect.arrayContaining(["direct-push-switch-changed", "direct-push-environment-changed"]),
    );
  });

  it("refuses to turn on while this computer is not a hub", async () => {
    const { handle } = await setup();

    const response = await handle(post(HUB_ADMINISTRATION_ROUTES.directPush, { enabled: true }));

    expect(response?.status).toBe(409);
    expect(await response?.json()).toEqual({ status: "refused", kind: "hub-role-off" });
  });

  it("keeps the credentials out of every answer, the journal, and the state file", async () => {
    const { host, handle } = await setup();
    host.hub.enable(window);

    const apple = await handle(
      post(HUB_ADMINISTRATION_ROUTES.directPushCredential, {
        platform: "ios",
        keyId: "ABCDE12345",
        teamId: "TEAM123456",
        bundleId: "com.example.octant",
        privateKey: applePem,
      }),
    );
    const google = await handle(
      post(HUB_ADMINISTRATION_ROUTES.directPushCredential, {
        platform: "android",
        serviceAccount,
      }),
    );
    const status = await handle(statusRequest());

    const statusBody = JSON.stringify(await status?.json());
    const answers = [JSON.stringify(await apple?.json()), JSON.stringify(await google?.json())];
    expect(JSON.parse(statusBody).directPush).toMatchObject({ ios: "stored", android: "stored" });
    answers.push(statusBody);
    const keyBody = applePem.split("\n")[1] ?? "";
    const googleBody = googlePem.split("\n")[1] ?? "";
    for (const needle of [keyBody, googleBody, "TEAM123456", "ABCDE12345", "attacker.example"]) {
      expect(answers.join("\n")).not.toContain(needle);
      expect(JSON.stringify(host.records)).not.toContain(needle);
      expect(filesHolding(host.directory, needle)).toEqual([]);
    }
    expect(
      host.records.filter((record) => record.change === "direct-push-credential-changed"),
    ).toEqual([
      expect.objectContaining({ pushPlatform: "ios", actingPrincipal: window }),
      expect.objectContaining({ pushPlatform: "android", actingPrincipal: window }),
    ]);
  });

  it("stores only the fields signing needs from a service account, and never its own token address", async () => {
    const { host, handle } = await setup();
    host.hub.enable(window);
    await handle(
      post(HUB_ADMINISTRATION_ROUTES.directPushCredential, { platform: "android", serviceAccount }),
    );

    const stored = await host.directPush.credentialSource().google();

    expect(stored).toEqual({
      clientEmail: "push@demo-project.iam.gserviceaccount.com",
      projectId: "demo-project",
      privateKey: googlePem,
    });
    expect(JSON.stringify(stored)).not.toContain("attacker.example");
  });

  it("refuses a credential that is not a key Apple or Google issues, and stores nothing", async () => {
    const { host, handle } = await setup();
    host.hub.enable(window);
    const notAKey = ["-----BEGIN", "PRIVATE KEY-----\nbm9wZQ==\n-----END", "PRIVATE KEY-----"].join(
      " ",
    );

    const refusedKey = await handle(
      post(HUB_ADMINISTRATION_ROUTES.directPushCredential, {
        platform: "ios",
        keyId: "ABCDE12345",
        teamId: "TEAM123456",
        bundleId: "com.example.octant",
        privateKey: notAKey,
      }),
    );
    const wrongKind = await handle(
      post(HUB_ADMINISTRATION_ROUTES.directPushCredential, {
        platform: "android",
        serviceAccount: JSON.stringify({ project_id: "demo-project" }),
      }),
    );
    const stray = await handle(
      post(HUB_ADMINISTRATION_ROUTES.directPushCredential, {
        platform: "android",
        serviceAccount,
        extra: true,
      }),
    );

    expect(refusedKey?.status).toBe(409);
    expect(await refusedKey?.json()).toEqual({ status: "refused", kind: "invalid-credential" });
    expect(await wrongKind?.json()).toEqual({ status: "refused", kind: "invalid-credential" });
    expect(stray?.status).toBe(400);
    expect(await host.directPush.status()).toMatchObject({
      ios: "not-stored",
      android: "not-stored",
    });
  });

  it("removes a stored credential", async () => {
    const { host, handle } = await setup();
    host.hub.enable(window);
    await handle(
      post(HUB_ADMINISTRATION_ROUTES.directPushCredential, { platform: "android", serviceAccount }),
    );

    const removed = await handle(
      post(HUB_ADMINISTRATION_ROUTES.directPushCredentialRemove, { platform: "android" }),
    );

    expect(await removed?.json()).toEqual({ status: "changed" });
    expect(await host.directPush.status()).toMatchObject({ android: "not-stored" });
  });

  it("answers no request that lacks the window's capability or the bridge secret, carries an Origin header, or comes from off the host", async () => {
    const { host, handle } = await setup();
    host.hub.enable(window);

    const withoutCapability = await handle(
      post(
        HUB_ADMINISTRATION_ROUTES.directPush,
        { enabled: true },
        { "x-octant-window-capability": "" },
      ),
    );
    const withoutSecret = await handle(
      post(
        HUB_ADMINISTRATION_ROUTES.directPush,
        { enabled: true },
        { "x-octant-desktop-secret": "" },
      ),
    );
    const fromAPage = await handle(
      post(
        HUB_ADMINISTRATION_ROUTES.directPushCredential,
        { platform: "android", serviceAccount },
        { origin: "https://page.example" },
      ),
    );
    const outsideTheHost = await handle(
      new Request(`http://100.101.102.103${HUB_ADMINISTRATION_ROUTES.directPush}`, {
        method: "POST",
        headers: {
          "x-octant-desktop-secret": secret,
          "x-octant-window-capability": capability,
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      }),
    );

    for (const response of [withoutCapability, withoutSecret, fromAPage, outsideTheHost]) {
      expect(response?.status).toBe(401);
    }
    expect(host.directPush.enabled()).toBe(false);
  });

  it("is not reachable by a peer, a guest, or a device through the member routes", async () => {
    const { host } = await setup();
    host.hub.enable(window);

    for (const path of Object.values(HUB_ADMINISTRATION_ROUTES).filter((route) =>
      route.includes("direct-push"),
    )) {
      const answered = await host.hubLink(
        new Request(`${host.origin}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        }),
      );
      expect(answered).toBeUndefined();
    }
    expect(host.directPush.enabled()).toBe(false);
  });

  it("answers unavailable on the gateway routes while the switch is off, and serves them once it is on", async () => {
    const { host } = await setup();
    host.hub.enable(window);
    const routes = createDirectPushRouteHandler({ gateway: host.directGateway });
    const body = JSON.stringify({
      platform: "ios",
      token: "ab".repeat(32),
      hostKeyFingerprint: "f".repeat(64),
    });
    const capabilities = () =>
      routes(
        new Request("https://hub.example/v1/capabilities", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
        { sourceKey: "phone" },
      );

    const off = await capabilities();
    host.directPush.setEnabled(true, window);
    const on = await capabilities();
    const wrongMethod = await routes(new Request("https://hub.example/v1/deliveries"));
    const unrelated = await routes(new Request("https://hub.example/api/threads"));

    expect([off?.status, await off?.json()]).toEqual([503, { code: "unavailable" }]);
    expect(on?.status).toBe(200);
    expect(await on?.json()).toEqual({ capability: expect.stringMatching(/^v1\.hub1\./) });
    expect(wrongMethod?.status).toBe(405);
    expect(unrelated).toBeUndefined();
  });
});
