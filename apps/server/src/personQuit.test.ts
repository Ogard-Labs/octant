import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeWindowId } from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { NATIVE_MAIN_AUTHORITY_HEADER } from "./desktopBrokerAdmission";
import {
  consumePersonQuit,
  createPersonQuitRouteHandler,
  PERSON_QUIT_ROUTE,
  recordPersonQuit,
} from "./personQuit";
import { bindPrincipalRouteContext } from "./principalRouteContext";

const secret = "desktop-bridge-secret";
const directories: string[] = [];

function dataDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "octant-person-quit-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function request(
  headers: Record<string, string>,
  options: { readonly origin?: string; readonly method?: string } = {},
): Request {
  return new Request(`${options.origin ?? "http://127.0.0.1:4567"}${PERSON_QUIT_ROUTE}`, {
    method: options.method ?? "POST",
    headers,
  });
}

describe("a person's quit", () => {
  it("is answered by the next start only, then forgotten", () => {
    const directory = dataDirectory();
    expect(consumePersonQuit(directory)).toBe(false);
    recordPersonQuit(directory, () => new Date("2026-11-12T09:00:00.000Z"));
    expect(consumePersonQuit(directory)).toBe(true);
    // A second start without a new quit, after a crash say, continues as before.
    expect(consumePersonQuit(directory)).toBe(false);
  });

  it("reads an unreadable record as no quit, and still removes it", () => {
    const directory = dataDirectory();
    writeFileSync(join(directory, "person-quit.json"), "not json");
    expect(consumePersonQuit(directory)).toBe(false);
    expect(existsSync(join(directory, "person-quit.json"))).toBe(false);
  });

  it("is recorded when this host's desktop reports it with its bridge secret", async () => {
    const directory = dataDirectory();
    const handle = createPersonQuitRouteHandler({
      desktopBridgeSecret: secret,
      dataDirectory: directory,
    });
    const response = await handle(request({ "x-octant-desktop-secret": secret }));
    expect(response?.status).toBe(204);
    expect(consumePersonQuit(directory)).toBe(true);
  });

  it("is refused from anything but the local desktop, and nothing is recorded", async () => {
    const directory = dataDirectory();
    const handle = createPersonQuitRouteHandler({
      desktopBridgeSecret: secret,
      dataDirectory: directory,
    });
    const forwarded = request({ "x-octant-desktop-secret": secret });
    bindPrincipalRouteContext(forwarded, {
      principal: { kind: "remote-device" } as never,
      scopeId: decodeWindowId("2b6f0a43-61c4-4c57-9b4e-3f1d7e5f8a10"),
    });
    const refused = [
      // A paired device or remote client, rebuilt as loopback by the gateway.
      forwarded,
      request({}),
      request({ "x-octant-desktop-secret": "guessed" }),
      // A browser page, even one that learned the secret.
      request({ "x-octant-desktop-secret": secret, origin: "http://127.0.0.1:4567" }),
      // A Nightly window's main token opens only its allowlisted routes.
      request({ [NATIVE_MAIN_AUTHORITY_HEADER]: "main-token", "x-octant-window-capability": "c" }),
      request({ "x-octant-desktop-secret": secret }, { origin: "http://192.168.1.20:4567" }),
    ];
    for (const attempt of refused) expect((await handle(attempt))?.status).toBe(401);
    expect(
      (await handle(request({ "x-octant-desktop-secret": secret }, { method: "GET" })))?.status,
    ).toBe(400);
    expect(consumePersonQuit(directory)).toBe(false);
  });

  it("is refused on a host the desktop gave no bridge secret", async () => {
    const directory = dataDirectory();
    const handle = createPersonQuitRouteHandler({
      desktopBridgeSecret: undefined,
      dataDirectory: directory,
    });
    expect((await handle(request({ "x-octant-desktop-secret": secret })))?.status).toBe(401);
    expect(consumePersonQuit(directory)).toBe(false);
  });

  it("leaves other routes to their own handlers", async () => {
    const handle = createPersonQuitRouteHandler({
      desktopBridgeSecret: secret,
      dataDirectory: dataDirectory(),
    });
    expect(
      await handle(new Request("http://127.0.0.1:4567/api/desktop/other", { method: "POST" })),
    ).toBeUndefined();
  });
});
