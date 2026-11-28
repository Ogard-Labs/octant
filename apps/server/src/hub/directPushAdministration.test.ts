// Direct push sending works on ANY host (standalone or hub) through
// `/api/desktop/push-sender*` over the local desktop bridge. Credentials never
// appear in answers, the journal, or files under the host data directory.

import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import { createPushSenderRouteHandler, PUSH_SENDER_ROUTES } from "../push/pushSenderRoutes";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { HubTestNetwork, startHubTestHost } from "./hubHost.test-support";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const windowId = decodeWindowId("33333333-3333-4333-8333-333333333333");
const capability = "A".repeat(43);
const secret = "desktop-secret";

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
  const handle = createPushSenderRouteHandler({
    desktopBridgeSecret: secret,
    windowAuthorityStore: authority,
    pushSender: host.directPush,
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
  new Request(`http://127.0.0.1${PUSH_SENDER_ROUTES.status}`, {
    headers: { "x-octant-desktop-secret": secret, "x-octant-window-capability": capability },
  });

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

describe("direct push sender administration on any host", () => {
  it("works on a standalone non-hub host, starts off, and reports only credential presence", async () => {
    const { host, handle } = await setup();
    // Hub role stays OFF — direct push works on any host now.
    expect(host.hub.status().enabled).toBe(false);

    const before = await handle(statusRequest());
    const enabled = await handle(post(PUSH_SENDER_ROUTES.status, { enabled: true }));
    const environment = await handle(
      post(PUSH_SENDER_ROUTES.environment, { environment: "development" }),
    );
    const after = await handle(statusRequest());

    expect(((await before!.json()) as { pushSender: unknown }).pushSender).toEqual({
      enabled: false,
      environment: "production",
      ios: "not-stored",
      android: "not-stored",
    });
    expect(await enabled?.json()).toEqual({ status: "changed" });
    expect(await environment?.json()).toEqual({ status: "changed" });
    expect(((await after!.json()) as { pushSender: unknown }).pushSender).toEqual({
      enabled: true,
      environment: "development",
      ios: "not-stored",
      android: "not-stored",
    });
    expect(await host.directPush.pushStatusForPhone(false)).toEqual({
      status: "unavailable",
      reason: "no-credentials",
    });
  });

  it("keeps credentials out of every answer, the journal, and the data directory, and drops token_uri", async () => {
    const { host, handle } = await setup();

    const apple = await handle(
      post(PUSH_SENDER_ROUTES.credential, {
        platform: "ios",
        keyId: "ABCDE12345",
        teamId: "TEAM123456",
        bundleId: "com.example.octant",
        privateKey: applePem,
      }),
    );
    const google = await handle(
      post(PUSH_SENDER_ROUTES.credential, {
        platform: "android",
        serviceAccount,
      }),
    );
    await handle(post(PUSH_SENDER_ROUTES.status, { enabled: true }));
    const status = await handle(statusRequest());

    const statusBody = JSON.stringify(await status?.json());
    const answers = [
      JSON.stringify(await apple?.json()),
      JSON.stringify(await google?.json()),
      statusBody,
    ];
    expect(JSON.parse(statusBody).pushSender).toMatchObject({ ios: "stored", android: "stored" });
    expect(await host.directPush.pushStatusForPhone(false)).toEqual({
      status: "available",
      platforms: { ios: true, android: true },
    });

    const keyBody = applePem.split("\n")[1] ?? "";
    const googleBody = googlePem.split("\n")[1] ?? "";
    for (const needle of [keyBody, googleBody, "TEAM123456", "ABCDE12345", "attacker.example"]) {
      expect(answers.join("\n")).not.toContain(needle);
      expect(filesHolding(host.directory, needle)).toEqual([]);
    }

    const stored = await host.directPush.credentialSource().google();
    expect(stored).toEqual({
      clientEmail: "push@demo-project.iam.gserviceaccount.com",
      projectId: "demo-project",
      privateKey: googlePem,
    });
  });

  it("refuses malformed credentials, removes stored credentials, and enforces loopback bridge authentication", async () => {
    const { host, handle } = await setup();
    const notAKey = ["-----BEGIN", "PRIVATE KEY-----\nbm9wZQ==\n-----END", "PRIVATE KEY-----"].join(
      " ",
    );

    const refusedKey = await handle(
      post(PUSH_SENDER_ROUTES.credential, {
        platform: "ios",
        keyId: "ABCDE12345",
        teamId: "TEAM123456",
        bundleId: "com.example.octant",
        privateKey: notAKey,
      }),
    );
    const wrongKind = await handle(
      post(PUSH_SENDER_ROUTES.credential, {
        platform: "android",
        serviceAccount: JSON.stringify({ project_id: "demo-project" }),
      }),
    );
    const stray = await handle(
      post(PUSH_SENDER_ROUTES.credential, {
        platform: "android",
        serviceAccount,
        extra: true,
      }),
    );
    expect(refusedKey?.status).toBe(409);
    expect(await refusedKey?.json()).toEqual({ status: "refused", reason: "invalid-credential" });
    expect(await wrongKind?.json()).toEqual({ status: "refused", reason: "invalid-credential" });
    expect(stray?.status).toBe(400);

    await handle(post(PUSH_SENDER_ROUTES.credential, { platform: "android", serviceAccount }));
    const removed = await handle(
      post(PUSH_SENDER_ROUTES.credentialRemove, { platform: "android" }),
    );
    expect(await removed?.json()).toEqual({ status: "changed" });
    expect(await host.directPush.status()).toMatchObject({ android: "not-stored" });

    for (const request of [
      post(PUSH_SENDER_ROUTES.status, { enabled: true }, { "x-octant-window-capability": "" }),
      post(PUSH_SENDER_ROUTES.status, { enabled: true }, { "x-octant-desktop-secret": "" }),
      post(
        PUSH_SENDER_ROUTES.credential,
        { platform: "android", serviceAccount },
        { origin: "https://page.example" },
      ),
      new Request(`http://100.101.102.103${PUSH_SENDER_ROUTES.status}`, {
        method: "POST",
        headers: {
          "x-octant-desktop-secret": secret,
          "x-octant-window-capability": capability,
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      }),
    ]) {
      const response = await handle(request);
      expect(response?.status).toBeGreaterThanOrEqual(400);
      expect(response?.status).toBeLessThan(500);
    }
  });
});
