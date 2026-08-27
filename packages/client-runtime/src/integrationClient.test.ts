import { describe, expect, it, vi } from "vitest";
import { createIntegrationClient, IntegrationClientFailure } from "./integrationClient";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function client(fetch: ReturnType<typeof vi.fn>) {
  return createIntegrationClient({
    baseUrl: "http://127.0.0.1:4317",
    fetch: fetch as never,
    windowCapability: "capability-token",
    slug: "linear",
  });
}

describe("createIntegrationClient", () => {
  it("reads the authentication snapshot from the generic integration route", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ state: "unauthorized", capabilities: [] }));
    await expect(client(fetch).authenticationSnapshot()).resolves.toMatchObject({
      state: "unauthorized",
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:4317/api/integrations/linear/authentication");
    expect(init.method).toBe("GET");
    expect(init.headers["x-octant-window-capability"]).toBe("capability-token");
  });

  it("posts authentication commands without sending token material", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ state: "unauthorized", capabilities: [] }));
    await client(fetch).executeAuthenticationCommand({ kind: "setup" });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "http://127.0.0.1:4317/api/integrations/linear/authentication/commands",
    );
    expect(JSON.parse(init.body)).toEqual({ kind: "setup" });
    expect(init.body).not.toMatch(/access_token|refresh_token|lin_api_/);
  });

  it("refuses a non-loopback base URL", () => {
    expect(() =>
      createIntegrationClient({
        baseUrl: "https://example.test",
        fetch: vi.fn() as never,
        windowCapability: "capability-token",
        slug: "linear",
      }),
    ).toThrow(IntegrationClientFailure);
  });
});
