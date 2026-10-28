import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import {
  APP_STORE_CONNECT_KEY_REF,
  createAppStoreConnectKeyRouteHandler,
} from "./appStoreConnectKeyRoutes";

const windowId = decodeWindowId("33333333-3333-4333-8333-333333333333");
const capability = "A".repeat(43);
const secret = "desktop-secret";
const ISSUER = "69A6DE70-03DB-47E3-E053-5B8C7C11A4D1";
const KEY_ID = "2x9r4hdu7w";

const SET = "/api/desktop/app-store-connect-key/set";
const STATUS = "/api/desktop/app-store-connect-key/status";
const REMOVE = "/api/desktop/app-store-connect-key/remove";

function pem(curve: "prime256v1" | "secp384r1" = "prime256v1"): string {
  return generateKeyPairSync("ec", { namedCurve: curve })
    .privateKey.export({ format: "pem", type: "pkcs8" })
    .toString();
}

function setup(
  input: {
    readonly macos?: boolean;
    readonly distributionEnabled?: boolean;
    readonly storeAvailable?: boolean;
  } = {},
) {
  const authority = new WindowAuthorityStore();
  authority.register({ windowId, capability, now: Date.now() });
  const stored = new Map<string, string>();
  const handle = createAppStoreConnectKeyRouteHandler({
    desktopBridgeSecret: secret,
    windowAuthorityStore: authority,
    macos: input.macos ?? true,
    distributionEnabled: input.distributionEnabled ?? true,
    keys:
      input.storeAvailable === false
        ? undefined
        : {
            has: async (id) => stored.has(id),
            set: async (id, value) => {
              stored.set(id, value);
            },
            delete: async (id) => {
              stored.delete(id);
            },
          },
  });
  return { handle, stored };
}

function hostLocal(
  path: string,
  body: unknown,
  overrides: { readonly headers?: Record<string, string>; readonly host?: string } = {},
): Request {
  return new Request(`http://${overrides.host ?? "127.0.0.1:3773"}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-desktop-secret": secret,
      "x-octant-window-capability": capability,
      ...overrides.headers,
    },
    body: JSON.stringify(body),
  });
}

async function json(response: Response | undefined): Promise<{ status: number; text: string }> {
  if (response === undefined) throw new Error("route did not answer");
  return { status: response.status, text: await response.text() };
}

describe("App Store Connect key routes", () => {
  it("stores a valid key in the broker and answers only that it is stored", async () => {
    const { handle, stored } = setup();
    const privateKey = pem();
    const answer = await json(
      await handle(hostLocal(SET, { issuerId: ISSUER, keyId: KEY_ID, privateKey, replace: false })),
    );
    expect(answer).toEqual({ status: 200, text: JSON.stringify({ outcome: "stored" }) });
    expect(JSON.parse(stored.get(APP_STORE_CONNECT_KEY_REF) ?? "")).toEqual({
      version: 1,
      issuerId: ISSUER.toLowerCase(),
      keyId: KEY_ID.toUpperCase(),
      privateKey: `${privateKey.trim()}\n`,
    });
    expect(await json(await handle(hostLocal(STATUS, {})))).toEqual({
      status: 200,
      text: JSON.stringify({ outcome: "stored" }),
    });
  });

  it("stores a 1Password reference in the key's place, and never both or a malformed one", async () => {
    const { handle, stored } = setup();
    const reference = "op://Developer/App Store Connect/private key";
    const answer = await json(
      await handle(
        hostLocal(SET, {
          issuerId: ISSUER,
          keyId: KEY_ID,
          onePasswordReference: reference,
          replace: false,
        }),
      ),
    );
    expect(answer).toEqual({ status: 200, text: JSON.stringify({ outcome: "stored" }) });
    expect(JSON.parse(stored.get(APP_STORE_CONNECT_KEY_REF) ?? "")).toEqual({
      version: 1,
      issuerId: ISSUER.toLowerCase(),
      keyId: KEY_ID.toUpperCase(),
      onePasswordReference: reference,
    });

    stored.clear();
    for (const body of [
      { onePasswordReference: "Developer/App Store Connect/private key" },
      { onePasswordReference: "op://Developer/item" },
      { onePasswordReference: "op://Developer/item/field?attribute=otp" },
    ]) {
      const refused = await json(
        await handle(hostLocal(SET, { issuerId: ISSUER, keyId: KEY_ID, ...body, replace: false })),
      );
      expect(JSON.parse(refused.text)).toMatchObject({ category: "invalid-key" });
    }
    const both = await json(
      await handle(
        hostLocal(SET, {
          issuerId: ISSUER,
          keyId: KEY_ID,
          privateKey: pem(),
          onePasswordReference: reference,
          replace: false,
        }),
      ),
    );
    expect(JSON.parse(both.text)).toMatchObject({ category: "invalid" });
    expect(stored.size).toBe(0);
  });

  it("refuses to overwrite a stored key unless the person asks to replace it", async () => {
    const { handle, stored } = setup();
    const first = pem();
    await handle(
      hostLocal(SET, { issuerId: ISSUER, keyId: KEY_ID, privateKey: first, replace: false }),
    );
    const second = { issuerId: ISSUER, keyId: "ABCDEFGHIJ", privateKey: pem() };
    const refused = await json(await handle(hostLocal(SET, { ...second, replace: false })));
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.text)).toMatchObject({ category: "already-stored" });
    expect(stored.get(APP_STORE_CONNECT_KEY_REF)).toContain(KEY_ID.toUpperCase());

    expect((await json(await handle(hostLocal(SET, { ...second, replace: true })))).status).toBe(
      200,
    );
    expect(stored.get(APP_STORE_CONNECT_KEY_REF)).toContain("ABCDEFGHIJ");
  });

  it("refuses anything that is not an App Store Connect key without echoing it", async () => {
    const { handle, stored } = setup();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString();
    for (const body of [
      { issuerId: "not-an-issuer", keyId: KEY_ID, privateKey: pem() },
      { issuerId: ISSUER, keyId: "short", privateKey: pem() },
      { issuerId: ISSUER, keyId: KEY_ID, privateKey: "secret-looking-text" },
      { issuerId: ISSUER, keyId: KEY_ID, privateKey: pem("secp384r1") },
      { issuerId: ISSUER, keyId: KEY_ID, privateKey: rsa },
    ]) {
      const answer = await json(await handle(hostLocal(SET, { ...body, replace: false })));
      expect(answer.status).toBe(400);
      expect(JSON.parse(answer.text)).toMatchObject({ category: "invalid-key" });
      expect(answer.text).not.toContain(body.privateKey.slice(0, 40));
    }
    expect(stored.size).toBe(0);
  });

  it("refuses a browser, a request without the bridge secret, and a non-loopback host before reading the key", async () => {
    const { handle, stored } = setup();
    const body = { issuerId: ISSUER, keyId: KEY_ID, privateKey: pem(), replace: false };
    for (const request of [
      hostLocal(SET, body, { headers: { origin: "http://127.0.0.1:3773" } }),
      hostLocal(SET, body, { headers: { "x-octant-desktop-secret": "wrong" } }),
      hostLocal(SET, body, { headers: { "x-octant-window-capability": "B".repeat(43) } }),
      hostLocal(SET, body, { host: "octant.example:3773" }),
    ]) {
      const answer = await json(await handle(request));
      expect(answer.status).toBe(401);
      expect(JSON.parse(answer.text)).toMatchObject({ category: "unauthorized" });
    }
    expect(stored.size).toBe(0);
  });

  it("takes no key while the release boundary does not admit distribution, but still removes one", async () => {
    const { handle, stored } = setup({ distributionEnabled: false });
    stored.set(APP_STORE_CONNECT_KEY_REF, "earlier");
    const body = { issuerId: ISSUER, keyId: KEY_ID, privateKey: pem(), replace: true };
    for (const request of [hostLocal(SET, body), hostLocal(STATUS, {})]) {
      const answer = await json(await handle(request));
      expect(answer.status).toBe(409);
      expect(JSON.parse(answer.text)).toMatchObject({ category: "distribution-not-enabled" });
    }
    expect(stored.get(APP_STORE_CONNECT_KEY_REF)).toBe("earlier");
    expect(await json(await handle(hostLocal(REMOVE, {})))).toEqual({
      status: 200,
      text: JSON.stringify({ outcome: "removed" }),
    });
    expect(stored.size).toBe(0);
  });

  it("takes no key on a host that is not a Mac", async () => {
    const { handle, stored } = setup({ macos: false });
    const answer = await json(
      await handle(
        hostLocal(SET, { issuerId: ISSUER, keyId: KEY_ID, privateKey: pem(), replace: false }),
      ),
    );
    expect(JSON.parse(answer.text)).toMatchObject({ category: "unsupported-host" });
    expect(stored.size).toBe(0);
  });

  it("says the store is unavailable when the host has no broker for the key", async () => {
    const { handle } = setup({ storeAvailable: false });
    const answer = await json(await handle(hostLocal(STATUS, {})));
    expect(answer.status).toBe(503);
    expect(JSON.parse(answer.text)).toMatchObject({ category: "credential-store-unavailable" });
  });

  it("leaves every other path to the next route", async () => {
    const { handle } = setup();
    expect(await handle(hostLocal("/api/desktop/provider-credentials/set", {}))).toBeUndefined();
  });
});
