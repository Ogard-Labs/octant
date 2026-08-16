import { decodeProviderInstanceId, decodeProviderRegistryCommand } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { createProviderClient, ProviderClientFailure } from "./providerClient";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000031");
const command = decodeProviderRegistryCommand({
  kind: "create-opencode-provider",
  instanceId,
  expectedVersion: 0,
  displayName: "OpenCode local",
  binaryPath: "/opt/homebrew/bin/opencode",
});

describe("ProviderClient", () => {
  it("uses only the scoped capability for bootstrap, commands, and probe", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("bootstrap")) return Response.json(snapshot());
      if (path.endsWith("probe")) return Response.json(observation());
      return Response.json({ kind: "provider-created", instance: provider() });
    });
    const client = createProviderClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    await expect(client.bootstrap()).resolves.toEqual(snapshot());
    await expect(client.execute(command)).resolves.toMatchObject({ kind: "provider-created" });
    await expect(client.probe(instanceId)).resolves.toEqual(observation());
    for (const call of fetch.mock.calls) {
      expect(call[1]?.headers).toMatchObject({ "x-octant-window-capability": capability });
      expect(JSON.stringify(call[1])).not.toContain("windowId");
    }
  });

  it("strictly decodes successes and typed failures", async () => {
    const malformed = createProviderClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () => Response.json({ ...snapshot(), serverUrl: "http://secret" }),
    });
    await expect(malformed.bootstrap()).rejects.toMatchObject({ category: "protocol" });

    const typed = createProviderClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () =>
        Response.json({ category: "invalid-configuration", message: "Reload." }, { status: 400 }),
    });
    await expect(typed.execute(command)).rejects.toMatchObject({
      category: "invalid-configuration",
    });

    const invalidFailure = createProviderClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () =>
        Response.json(
          { category: "invalid-configuration", message: "No", token: "secret" },
          { status: 400 },
        ),
    });
    await expect(invalidFailure.bootstrap()).rejects.toMatchObject({ category: "protocol" });
  });

  it("preserves the typed persisted catalog snapshots returned by bootstrap", async () => {
    const catalog = {
      instanceId,
      version: 1,
      models: [],
      manualModelOrder: ["manual-model"],
      invalidated: false,
      updatedAt: "2026-07-21T10:00:00.000Z",
    } as const;
    const client = createProviderClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () => Response.json({ ...snapshot(), catalogs: [catalog] }),
    });

    await expect(client.bootstrap()).resolves.toMatchObject({ catalogs: [catalog] });
  });

  it("redacts transport and invalid-response details", async () => {
    const transport = createProviderClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () => {
        throw new Error("ECONNREFUSED token=secret");
      },
    });
    const failure = await rejected(transport.bootstrap());
    expect(failure).toMatchObject({
      category: "unavailable",
      message: "Octant Provider service is unavailable.",
    });
    expect(failure.message).not.toContain("secret");

    const invalidJson = createProviderClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch: async () => new Response("password=secret"),
    });
    await expect(invalidJson.bootstrap()).rejects.toMatchObject({ category: "protocol" });
  });

  it("rejects credential-bearing compatible commands before transport", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = createProviderClient({
      baseUrl: "http://localhost",
      windowCapability: capability,
      fetch,
    });
    const unsafe = {
      kind: "create-openai-compatible-provider",
      instanceId,
      expectedVersion: 0,
      displayName: "Private gateway",
      configuration: {
        kind: "openai-compatible-http",
        baseUrl: "https://gateway.example/v1",
        authentication: "bearer",
        protocol: "auto",
        manualModelIds: [],
      },
      apiKey: "private-value",
    } as never;

    await expect(client.execute(unsafe)).rejects.toMatchObject({
      category: "protocol",
      message: "Provider command is invalid.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["apiKey", "oauthToken", "credential", "account"] as const)(
    "rejects Claude commands containing excess %s before transport",
    async (field) => {
      const fetch = vi.fn<typeof globalThis.fetch>();
      const client = createProviderClient({
        baseUrl: "http://localhost",
        windowCapability: capability,
        fetch,
      });
      const unsafe = {
        kind: "create-claude-provider",
        instanceId,
        expectedVersion: 0,
        displayName: "Claude local",
        configuration: {
          kind: "claude-agent-sdk",
          binaryPath: "/opt/homebrew/bin/claude",
          authentication: "api-key",
        },
        [field]: "must-not-cross",
      } as never;

      await expect(client.execute(unsafe)).rejects.toMatchObject({
        category: "protocol",
        message: "Provider command is invalid.",
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

function snapshot() {
  return {
    instances: [provider()],
    defaults: { permissionPersistence: "current-session", version: 0 },
    observedStates: [observation()],
  };
}
function provider() {
  return {
    id: instanceId,
    displayName: "OpenCode local",
    driverKind: "opencode",
    configuration: { kind: "opencode-cli", binaryPath: "/opt/homebrew/bin/opencode" },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt: "2026-07-14T10:00:00.000Z",
    updatedAt: "2026-07-14T10:00:00.000Z",
  };
}
function observation() {
  const capabilities = {
    streaming: "supported",
    resume: "supported",
    interruption: "supported",
    approvals: "supported",
    userQuestions: "supported",
    reasoning: "supported",
    usage: "supported",
    toolActivity: "supported",
    fileChanges: "supported",
    diffs: "supported",
    taskProgress: "supported",
    nativeChildAgents: "supported",
    nativeAttachments: "supported",
    nativeWebResearch: "supported",
    appManagedTools: "supported",
    citations: "supported",
  };
  return {
    instanceId,
    readiness: "ready",
    processState: "running",
    models: [],
    capabilities,
    observedAt: "2026-07-14T10:00:00.000Z",
  };
}
async function rejected(value: Promise<unknown>): Promise<ProviderClientFailure> {
  try {
    await value;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderClientFailure);
    return error as ProviderClientFailure;
  }
  throw new Error("expected rejection");
}
