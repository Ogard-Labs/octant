import { describe, expect, it, vi } from "vitest";
import {
  AppStoreConnectKeyControlFailure,
  sendAppStoreConnectKeyOperation,
} from "./appStoreConnectKeyControls";

function runtime(respond: (url: string, init: RequestInit | undefined) => Response) {
  const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
  return {
    calls,
    runtime: {
      serverUrl: "http://127.0.0.1:4317",
      desktopBridgeSecret: "bridge-secret",
      windowCapability: "A".repeat(43),
      fetch: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        return respond(url, init);
      }) as unknown as typeof globalThis.fetch,
    },
  };
}

describe("App Store Connect key controls", () => {
  it("sends a window's key to the fixed local route with this window's authority, and hands back a refusal as an answer", async () => {
    const { calls, runtime: controls } = runtime(() =>
      Response.json({ category: "already-stored" }, { status: 409 }),
    );
    const body = { issuerId: "issuer", keyId: "KEY", privateKey: "pem", replace: false };
    expect(await sendAppStoreConnectKeyOperation(controls, "set", body)).toEqual({
      status: 409,
      body: { category: "already-stored" },
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:4317/api/desktop/app-store-connect-key/set");
    expect(calls[0]?.init?.headers).toEqual({
      "x-octant-desktop-secret": "bridge-secret",
      "x-octant-window-capability": "A".repeat(43),
      "content-type": "application/json",
    });
    expect(calls[0]?.init?.body).toBe(JSON.stringify(body));
  });

  it("refuses an operation it does not name and a body past its bound, sending nothing", async () => {
    const { calls, runtime: controls } = runtime(() => Response.json({}));
    for (const operation of ["../provider-credentials/set", "__proto__", "toString", 7]) {
      await expect(sendAppStoreConnectKeyOperation(controls, operation, {})).rejects.toBeInstanceOf(
        AppStoreConnectKeyControlFailure,
      );
    }
    await expect(
      sendAppStoreConnectKeyOperation(controls, "set", { privateKey: "x".repeat(9 * 1_024) }),
    ).rejects.toBeInstanceOf(AppStoreConnectKeyControlFailure);
    expect(calls).toEqual([]);
  });
});
