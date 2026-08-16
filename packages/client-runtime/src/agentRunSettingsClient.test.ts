import { describe, expect, it, vi } from "vitest";
import {
  AgentRunSettingsClientFailure,
  createAgentRunSettingsClient,
} from "./agentRunSettingsClient";

describe("agentRunSettingsClient", () => {
  it("reads the current posture", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/api/agent-run-settings");
      expect(init?.method ?? "GET").toBe("GET");
      return new Response(
        JSON.stringify({
          settings: { creationPosture: "ask", version: 2, updatedAt: "2026-08-01T10:00:00.000Z" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = createAgentRunSettingsClient({
      baseUrl: "http://127.0.0.1:8787",
      fetch: fetchImpl as unknown as typeof fetch,
      windowCapability: "cap",
    });
    const settings = await client.current();
    expect(settings.creationPosture).toBe("ask");
    expect(settings.version).toBe(2);
  });

  it("updates the posture with the expected version", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toContain("/api/agent-run-settings");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({
        creationPosture: "automatic",
        expectedVersion: 2,
      });
      return new Response(
        JSON.stringify({
          settings: {
            creationPosture: "automatic",
            version: 3,
            updatedAt: "2026-08-01T10:01:00.000Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = createAgentRunSettingsClient({
      baseUrl: "http://127.0.0.1:8787",
      fetch: fetchImpl as unknown as typeof fetch,
      windowCapability: "cap",
    });
    const settings = await client.update({ creationPosture: "automatic", expectedVersion: 2 });
    expect(settings.version).toBe(3);
  });

  it("surfaces a conflict as a typed failure rather than throwing raw JSON", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "stale" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = createAgentRunSettingsClient({
      baseUrl: "http://127.0.0.1:8787",
      fetch: fetchImpl as unknown as typeof fetch,
      windowCapability: "cap",
    });
    await expect(
      client.update({ creationPosture: "off", expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(AgentRunSettingsClientFailure);
  });
});
