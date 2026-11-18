import {
  decodeProviderInstance,
  decodeProviderInstanceId,
  decodeWindowId,
  type AddedAcpAgentProviderInstance,
  type ProviderInstance,
} from "@octant/contracts";
import type {
  ProviderApprovalAnswer,
  ProviderConnection,
  ProviderDriver,
  ProviderSessionStart,
} from "@octant/provider-sdk/driver";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { PersistenceService } from "../persistence/persistenceService";
import type { AcpAgentInstallResult } from "./acpAgentInstall";
import { withAddedAcpAgentLaunch } from "./addedAcpAgent";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";
import { ProviderService } from "./providerService";

const windowId = decodeWindowId("80000000-0000-4000-8000-000000000060");
const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000061");
const now = "2026-11-18T10:00:00.000Z";

function serviceWith(install: () => Promise<AcpAgentInstallResult>) {
  let instances: ProviderInstance[] = [];
  const append = vi.fn(
    (request: {
      readonly events: ReadonlyArray<{ readonly eventName: string; readonly payload: any }>;
    }) => {
      const payload = request.events[0]?.payload;
      if (payload?.instance !== undefined) {
        instances = [
          ...instances.filter((item) => item.id !== payload.instance.id),
          decodeProviderInstance(payload.instance),
        ];
      } else if (payload?.instanceId !== undefined) {
        instances = instances.filter((item) => item.id !== payload.instanceId);
      }
      return { aggregateVersion: payload?.instance?.version ?? payload?.version };
    },
  );
  const persistence = {
    journal: { append, firstAggregateEvent: () => undefined },
    readProviderInstance: (id: string) => instances.find((item) => item.id === id),
    readProviderInstances: () => instances,
    readProviderDefaults: () => ({ permissionPersistence: "current-session", version: 0 }),
    status: () => ({ state: "current", integrity: "ok" }),
  } as unknown as PersistenceService;
  const remove = vi.fn(async () => undefined);
  const service = new ProviderService({
    persistence,
    runtimeRegistry: new ProviderRuntimeRegistry(),
    probe: async () => {
      throw new Error("not probed here");
    },
    acpAgentInstall: { install: vi.fn(install), remove },
    uuid: () => crypto.randomUUID(),
    clock: () => now,
  });
  const current = () => instances.find((item) => item.id === instanceId);
  return { service, append, remove, current };
}

const installed = async (): Promise<AcpAgentInstallResult> => ({
  status: "installed",
  executable: "/data/acp-agent-installs/cursor/2026.11.13/dist-package/cursor-agent",
  integrity: "unverified-download",
});

describe("adding any ACP agent", () => {
  it("adds a registry agent from the host's listing, then installs, trusts and enables it as separate journaled steps", async () => {
    const fixture = serviceWith(installed);
    await expect(
      fixture.service.execute(windowId, {
        kind: "add-acp-agent",
        instanceId,
        expectedVersion: 0 as never,
        source: { kind: "registry", registryId: "cursor" },
      }),
    ).resolves.toMatchObject({
      kind: "provider-created",
      instance: {
        displayName: "Cursor",
        driverKind: "acp-agent",
        enabled: false,
        configuration: {
          source: {
            kind: "registry",
            registryId: "cursor",
            version: "2026.11.13",
            distribution: "binary",
          },
          args: ["acp"],
          trusted: false,
        },
      },
    });
    expect(fixture.current()?.configuration).not.toHaveProperty("install");

    const enable = (expectedVersion: number) =>
      fixture.service.execute(windowId, {
        kind: "set-provider-enabled",
        instanceId,
        expectedVersion: expectedVersion as never,
        enabled: true,
      });
    await expect(enable(1)).rejects.toMatchObject({
      failure: { message: "Install this agent before turning it on." },
    });

    await fixture.service.execute(windowId, {
      kind: "install-acp-agent",
      instanceId,
      expectedVersion: 1 as never,
    });
    expect(fixture.current()?.configuration).toMatchObject({
      install: { integrity: "unverified-download" },
      trusted: false,
    });
    await expect(enable(2)).rejects.toMatchObject({
      failure: { message: "Trust this agent before turning it on." },
    });

    await fixture.service.execute(windowId, {
      kind: "set-acp-agent-trust",
      instanceId,
      expectedVersion: 2 as never,
      trusted: true,
    });
    await expect(enable(3)).resolves.toMatchObject({ instance: { enabled: true } });

    // Untrusting leaves the agent on; its next launch is held in Octant's sandbox.
    await fixture.service.execute(windowId, {
      kind: "set-acp-agent-trust",
      instanceId,
      expectedVersion: 4 as never,
      trusted: false,
    });
    expect(fixture.current()).toMatchObject({ enabled: true, configuration: { trusted: false } });

    expect(fixture.append.mock.calls.map(([request]) => request.events[0]?.eventName)).toEqual([
      "provider.instance-created@1",
      "provider.instance-configuration-changed@1",
      "provider.instance-configuration-changed@1",
      "provider.instance-enabled-changed@1",
      "provider.instance-configuration-changed@1",
    ]);

    await fixture.service.execute(windowId, {
      kind: "remove-provider",
      instanceId,
      expectedVersion: 5 as never,
    });
    expect(fixture.remove).toHaveBeenCalledWith(instanceId);
  });

  it("records nothing when the download does not match the registry's checksum", async () => {
    const fixture = serviceWith(async () => ({
      status: "refused",
      reason: "checksum-mismatch",
      message: "The download does not match the checksum the ACP registry lists.",
    }));
    await fixture.service.execute(windowId, {
      kind: "add-acp-agent",
      instanceId,
      expectedVersion: 0 as never,
      source: { kind: "registry", registryId: "kiro" },
    });
    await expect(
      fixture.service.execute(windowId, {
        kind: "install-acp-agent",
        instanceId,
        expectedVersion: 1 as never,
      }),
    ).rejects.toMatchObject({ failure: { category: "unauthorized" } });
    expect(fixture.append).toHaveBeenCalledTimes(1);
    expect(fixture.current()?.configuration).not.toHaveProperty("install");
    await expect(
      fixture.service.execute(windowId, {
        kind: "set-acp-agent-trust",
        instanceId,
        expectedVersion: 1 as never,
        trusted: true,
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid-configuration" } });
  });

  it("refuses an agent missing from the listing, a relative command and an argument that carries a key", async () => {
    const fixture = serviceWith(installed);
    const add = (source: unknown) =>
      fixture.service.execute(windowId, {
        kind: "add-acp-agent",
        instanceId,
        expectedVersion: 0 as never,
        source: source as never,
      });
    await expect(add({ kind: "registry", registryId: "not-listed" })).rejects.toMatchObject({
      failure: { category: "invalid-configuration" },
    });
    await expect(
      add({ kind: "local", displayName: "Mine", command: "my-agent", args: [] }),
    ).rejects.toMatchObject({ failure: { category: "invalid-configuration" } });
    await expect(
      add({
        kind: "local",
        displayName: "Mine",
        command: "/opt/agent",
        args: ["acp", "--api-key=sk-live-secret"],
      }),
    ).rejects.toMatchObject({ failure: { category: "invalid-configuration" } });
    expect(fixture.append).not.toHaveBeenCalled();
  });
});

function addedAgent(trusted: boolean): AddedAcpAgentProviderInstance {
  const instance = decodeProviderInstance({
    id: instanceId,
    displayName: "My agent",
    driverKind: "acp-agent",
    configuration: {
      kind: "acp-agent",
      source: { kind: "local", command: "/opt/agent" },
      args: ["acp"],
      install: { executable: "/opt/agent", integrity: "local-command" },
      trusted,
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 3,
    createdAt: now,
    updatedAt: now,
  });
  if (instance.driverKind !== "acp-agent") throw new Error("not an added agent");
  return instance;
}

function recordingDriver() {
  const starts: ProviderSessionStart[] = [];
  const answers: ProviderApprovalAnswer[] = [];
  const connection = {
    start: (input: ProviderSessionStart) => {
      starts.push(input);
      return Effect.succeed({ sessionId: input.sessionId });
    },
    answerApproval: (input: ProviderApprovalAnswer) => {
      answers.push(input);
      return Effect.void;
    },
  } as unknown as ProviderConnection;
  const driver = {
    kind: "acp-agent",
    probe: () => Effect.die("unused"),
    acquire: () => Effect.succeed(connection),
  } as unknown as ProviderDriver;
  return { driver, starts, answers };
}

const sessionStart = {
  sessionId: "session-1",
  modelId: "model-1",
  executionPolicy: "full-access",
  strict: false,
  nativeSetup: {
    subagents: true,
    webTools: true,
    skills: true,
    toolServers: true,
    hooks: true,
    projectCode: true,
  },
  tools: [
    { name: "octant_acp_fs_read_text_file", description: "Read", inputSchema: {} },
    { name: "canvas_write", description: "Octant tool", inputSchema: {} },
  ],
} as unknown as ProviderSessionStart;

describe("an added agent's launch", () => {
  it("never starts an untrusted agent outside Octant's sandbox, with its own setup, Octant's tools or a remembered answer", async () => {
    const { driver, starts, answers } = recordingDriver();
    const held = withAddedAcpAgentLaunch(driver, addedAgent(false));
    await Effect.runPromise(
      Effect.scoped(
        held.acquire({ instanceId } as never).pipe(
          Effect.flatMap((connection) =>
            connection.start(sessionStart).pipe(
              Effect.zipRight(
                connection.answerApproval({
                  sessionId: "session-1",
                  requestId: "r1",
                  approved: true,
                } as never),
              ),
            ),
          ),
        ),
      ),
    );
    expect(starts[0]).toMatchObject({
      executionPolicy: "full-access",
      strict: true,
      fullAccessSandbox: true,
    });
    expect(starts[0]).not.toHaveProperty("nativeSetup");
    expect(starts[0]?.tools?.map((tool) => tool.name)).toEqual(["octant_acp_fs_read_text_file"]);
    expect(answers[0]).toMatchObject({ approved: true, scope: "once" });
  });

  it("passes a trusted agent's session through as the thread resolved it", async () => {
    const { driver, starts } = recordingDriver();
    const held = withAddedAcpAgentLaunch(driver, addedAgent(true));
    await Effect.runPromise(
      Effect.scoped(
        held
          .acquire({ instanceId } as never)
          .pipe(Effect.flatMap((connection) => connection.start(sessionStart))),
      ),
    );
    expect(starts[0]).toBe(sessionStart);
  });

  it("starts nothing for an agent that is not on", async () => {
    const { driver } = recordingDriver();
    const off = { ...addedAgent(true), enabled: false };
    const exit = await Effect.runPromiseExit(
      Effect.scoped(withAddedAcpAgentLaunch(driver, off).acquire({ instanceId } as never)),
    );
    expect(exit._tag).toBe("Failure");
  });
});
