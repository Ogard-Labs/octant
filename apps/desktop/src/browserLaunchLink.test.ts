import { describe, expect, it, vi } from "vitest";
import { createBrowserLaunchLink } from "./browserLaunchLink";

const desktopBridgeSecret = `${"S".repeat(42)}A`;
const launchToken = `${"T".repeat(42)}A`;

describe("createBrowserLaunchLink", () => {
  it("opens the host with a one-time token minted with the bridge secret for the host's origin", async () => {
    const fetch = vi.fn(async (_input: string, _init: RequestInit) =>
      Response.json({ launchToken, expiresAt: 1 }, { status: 201 }),
    );

    const link = await createBrowserLaunchLink({
      hostUrl: "http://127.0.0.1:13773/",
      desktopBridgeSecret,
      fetch,
    });

    expect(link).toBe(`http://127.0.0.1:13773/#launchToken=${launchToken}`);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:13773/api/desktop/launch-sessions");
    expect(init?.headers).toMatchObject({ "x-octant-desktop-secret": desktopBridgeSecret });
    expect(JSON.parse(String(init?.body))).toMatchObject({ origin: "http://127.0.0.1:13773" });
  });

  it("opens nothing when the host refuses to mint a token", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 401 }));
    await expect(
      createBrowserLaunchLink({ hostUrl: "http://127.0.0.1:13773/", desktopBridgeSecret, fetch }),
    ).rejects.toThrow("Octant could not create a browser launch link.");
  });

  it("opens nothing when the host answers with a malformed token", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ launchToken: "short", expiresAt: 1 }, { status: 201 }),
    );
    await expect(
      createBrowserLaunchLink({ hostUrl: "http://127.0.0.1:13773/", desktopBridgeSecret, fetch }),
    ).rejects.toThrow("Octant could not create a browser launch link.");
  });
});
