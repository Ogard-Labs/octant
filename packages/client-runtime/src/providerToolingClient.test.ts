import { describe, expect, it, vi } from "vitest";
import { createProviderToolingClient } from "./providerToolingClient";

const ACCOUNT = "80000000-0000-4000-8000-0000000000a1" as never;

function client(respond: (url: string, init: RequestInit) => Response) {
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) =>
    respond(String(url), init ?? {}),
  );
  return {
    fetch,
    api: createProviderToolingClient({
      baseUrl: "http://127.0.0.1:4000",
      fetch: fetch as unknown as typeof globalThis.fetch,
      windowCapability: "proof",
    }),
  };
}

describe("provider tooling client", () => {
  it("sends each step to its route with the window capability and reads the host's answer", async () => {
    const { api, fetch } = client(
      () =>
        new Response(
          JSON.stringify({
            status: "planned",
            planId: "11111111-1111-4111-8111-111111111111",
            digest: "a".repeat(64),
            expiresAt: "2026-11-01T10:00:00.000Z",
            provider: "claude",
            commandKind: "mcp-remove",
            commandLine: "claude mcp remove --scope user files",
            summary: "Removes it.",
            effects: [],
            usesSecret: false,
            runsAsItself: false,
          }),
          { status: 200 },
        ),
    );
    const plan = await api.plan(ACCOUNT, { kind: "mcp-remove", name: "files" });
    expect(plan.status).toBe("planned");
    const call = fetch.mock.calls[0];
    expect(String(call?.[0])).toBe("http://127.0.0.1:4000/api/provider-tooling/plan");
    expect(call?.[1]?.headers).toMatchObject({ "x-octant-window-capability": "proof" });
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      providerInstanceId: ACCOUNT,
      request: { kind: "mcp-remove", name: "files" },
    });
  });

  it("returns a refusal as an answer, including the host's refusal of a paired device", async () => {
    const { api } = client(
      () =>
        new Response(
          JSON.stringify({
            status: "refused",
            reason: "not-a-local-window",
            message: "Changing an account's tools requires the Octant window on this host.",
          }),
          { status: 401 },
        ),
    );
    expect(await api.list(ACCOUNT)).toMatchObject({
      status: "refused",
      reason: "not-a-local-window",
    });
  });

  it("throws on a failure that is not an answer, and on a base address that is not loopback", async () => {
    const down = client(() => new Response(JSON.stringify({ error: "nope" }), { status: 500 }));
    await expect(
      down.api.apply({ planId: "11111111-1111-4111-8111-111111111111", digest: "a".repeat(64) }),
    ).rejects.toMatchObject({
      status: 500,
      message: "nope",
    });
    const remote = createProviderToolingClient({
      baseUrl: "https://example.com",
      fetch: vi.fn() as never,
      windowCapability: "proof",
    });
    await expect(remote.list(ACCOUNT)).rejects.toThrow("loopback");
  });
});
