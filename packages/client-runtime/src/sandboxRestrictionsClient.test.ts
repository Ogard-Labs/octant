import { describe, expect, it, vi } from "vitest";
import { decodeSandboxRestrictionsSnapshot } from "@octant/contracts/sandbox-policy";
import { createSandboxRestrictionsClient } from "./sandboxRestrictionsClient";
const threadId = "82000000-0000-4000-8000-000000000002";
const snapshot = () =>
  decodeSandboxRestrictionsSnapshot({
    kind: "sandbox-restrictions",
    scope: { kind: "session", threadId },
    version: 4,
    source: "legacy",
    inherited: false,
    running: false,
    summary: "Existing sandbox",
    limitations: [],
    capabilities: {
      folders: true,
      protectedPaths: false,
      isolatedCredentials: false,
      blockedHostServices: true,
    },
    denials: [],
  });
describe("sandbox settings transport", () => {
  it("binds the scope, window authority and cancellation without placing capabilities in the URL", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(snapshot()));
    const client = createSandboxRestrictionsClient({
      baseUrl: "http://127.0.0.1",
      windowCapability: "private-capability",
      fetch,
    });
    const controller = new AbortController();
    expect(await client.settings({ kind: "session", threadId }, controller.signal)).toEqual(
      snapshot(),
    );
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      `http://127.0.0.1/api/sandbox-restrictions?threadId=${threadId}`,
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      signal: controller.signal,
      headers: { "x-octant-window-capability": "private-capability" },
    });
    fetch.mockImplementation(async () =>
      Response.json({ ...snapshot(), scope: { kind: "settings", mode: "code" } }),
    );
    await expect(client.settings({ kind: "session", threadId })).rejects.toThrow(/different scope/);
  });
  it("returns a version refusal without inventing a successful save", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json(
        {
          kind: "sandbox-restrictions-refused",
          reason: "stale-version",
          message: "Reload before saving.",
        },
        { status: 409 },
      ),
    );
    const client = createSandboxRestrictionsClient({
      baseUrl: "http://127.0.0.1",
      windowCapability: "capability",
      fetch,
    });
    const command = {
      kind: "inherit-policy",
      scope: { kind: "session", threadId },
      expectedVersion: 4,
    } as const;
    expect(await client.change(command)).toMatchObject({ reason: "stale-version" });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(command);
  });
});
