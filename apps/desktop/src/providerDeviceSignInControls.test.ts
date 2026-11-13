import { describe, expect, it, vi } from "vitest";
import { sendProviderDeviceSignInRequest } from "./providerDeviceSignInControls";

function runtime(fetch: typeof globalThis.fetch) {
  return {
    serverUrl: "http://127.0.0.1:47401",
    desktopBridgeSecret: "secret",
    windowCapability: "capability",
    fetch,
  };
}

const instance = "71000000-0000-4000-8000-000000000001";
const attemptId = "71000000-0000-4000-8000-000000000002";

describe("device-code sign-in from a local desktop window", () => {
  it("begins and polls on the host-local routes with the desktop secret and the window's capability", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const fetch: typeof globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ outcome: "waiting" });
    };
    const begun = await sendProviderDeviceSignInRequest(runtime(fetch), {
      kind: "begin",
      instance,
      acknowledgeTerms: true,
    });
    expect(begun).toEqual({ status: 200, body: { outcome: "waiting" } });
    await sendProviderDeviceSignInRequest(runtime(fetch), { kind: "poll", instance, attemptId });

    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:47401/api/desktop/provider-sign-in/begin",
      "http://127.0.0.1:47401/api/desktop/provider-sign-in/poll",
    ]);
    for (const call of calls) {
      expect(call.init?.method).toBe("POST");
      expect(call.init?.headers).toMatchObject({
        "x-octant-desktop-secret": "secret",
        "x-octant-window-capability": "capability",
        "content-type": "application/json",
      });
      // A browser page's request carries an Origin, which the routes refuse.
      expect(call.init?.headers).not.toHaveProperty("origin");
    }
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ instance, acknowledgeTerms: true });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ instance, attemptId });
  });

  it("refuses a request it does not recognize before the host sees it", async () => {
    const fetch = vi.fn(async () => Response.json({ outcome: "waiting" }));
    for (const request of [
      { kind: "begin", instance },
      { kind: "begin", instance, acknowledgeTerms: true, address: "http://example.com" },
      { kind: "poll", instance, attemptId: "not-an-attempt" },
      { kind: "sign-out", instance },
      "begin",
    ]) {
      expect(await sendProviderDeviceSignInRequest(runtime(fetch), request)).toMatchObject({
        status: 400,
        body: { category: "invalid" },
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
