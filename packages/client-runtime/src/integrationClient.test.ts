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

  it("posts issue browse operations on the quoted Linear operations path", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        kind: "ok",
        value: {
          rows: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              identifier: "ENG-12",
              title: "Browse issues in the workspace",
              state: { name: "In Progress", type: "started" },
              url: "https://linear.app/ogard-labs/issue/ENG-12",
            },
          ],
          hasNextPage: false,
        },
      }),
    );
    const page = await client(fetch).listIssues({ search: "browse" });
    expect(page.rows[0]?.identifier).toBe("ENG-12");
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("http://127.0.0.1:4317/api/integrations/linear/operations");
    expect(JSON.parse(init.body)).toEqual({
      kind: "operation",
      operationId: "list-issues",
      input: { search: "browse" },
    });
    expect(init.body).not.toMatch(/access_token|refresh_token|lin_api_/);
  });

  it("surfaces a refused issue read without token material", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ kind: "refused", reason: "Connect Linear to authorize this host." }),
      );
    await expect(client(fetch).listIssues()).rejects.toThrow(
      "Connect Linear to authorize this host.",
    );
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
