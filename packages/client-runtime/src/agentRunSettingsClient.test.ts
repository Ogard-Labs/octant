import { DEFAULT_HOST_RESOURCE_POLICY } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  AgentRunSettingsClientFailure,
  createAgentRunSettingsClient,
} from "./agentRunSettingsClient";

describe("agentRunSettingsClient", () => {
  it("reads effective host capacity through the authenticated settings route", async () => {
    const snapshot = {
      policy: DEFAULT_HOST_RESOURCE_POLICY,
      cores: 8,
      totalMemoryBytes: 16 * 2 ** 30,
      availableMemoryBytes: 8 * 2 ** 30,
      cpuPercent: 80,
      commands: 0,
      workers: 1,
      agents: 0,
      activeCommands: 1,
      queuedCommands: 2,
      reason: "cpu-pressure",
    };
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:8787/api/agent-run-settings/resources");
      expect(init?.headers).toEqual({ "x-octant-window-capability": "cap" });
      return Response.json(snapshot);
    });
    const client = createAgentRunSettingsClient({
      baseUrl: "http://127.0.0.1:8787",
      windowCapability: "cap",
      fetch: fetchImpl as typeof fetch,
    });
    expect(await client.resources?.()).toEqual(snapshot);
  });

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
