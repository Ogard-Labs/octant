import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeEventActor,
  decodeProviderInstance,
  decodeProviderInstanceId,
  decodeWindowId,
  PROVIDER_ACP_AGENT_INSTALL_SCRIPTS_RAN,
  type AddedAcpAgentProviderInstance,
  type EventActor,
  type ProviderInstance,
} from "@octant/contracts";
import type {
  ProviderApprovalAnswer,
  ProviderConnection,
  ProviderDriver,
  ProviderSessionStart,
} from "@octant/provider-sdk/driver";
import { Cause, Effect, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makePersistenceLive,
  Persistence,
  type PersistenceService,
} from "../persistence/persistenceService";
import { rebuildProjection } from "../persistence/projection";
import type { AcpAgentInstallResult, AcpAgentInstallScriptsResult } from "./acpAgentInstall";
import { ACP_PACKAGE_NEEDS_INSTALL_SCRIPT_MESSAGE, withAddedAcpAgentLaunch } from "./addedAcpAgent";
import { ProviderProjection } from "./providerProjection";
import {
  ProviderExecutableUpdateRejected,
  ProviderRuntimeRegistry,
} from "./providerRuntimeRegistry";
import { ProviderService } from "./providerService";

const tempDirs: string[] = [];
afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const windowId = decodeWindowId("80000000-0000-4000-8000-000000000060");
const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000061");
const now = "2026-11-18T10:00:00.000Z";

function serviceWith(
  install: () => Promise<AcpAgentInstallResult>,
  options: {
    readonly runInstallScripts?: (
      instance: AddedAcpAgentProviderInstance,
    ) => Promise<AcpAgentInstallScriptsResult>;
    readonly probe?: (instance: ProviderInstance) => Promise<never>;
  } = {},
) {
  let instances: ProviderInstance[] = [];
  const append = vi.fn(
    (request: {
      readonly aggregate: { readonly aggregateType: string; readonly aggregateId: string };
      readonly events: ReadonlyArray<{
        readonly eventName: string;
        readonly actor: EventActor;
        readonly occurredAt: string;
        readonly payload: any;
      }>;
    }) => {
      const payload = request.events[0]?.payload;
      if (payload?.instance !== undefined) {
        instances = [
          ...instances.filter((item) => item.id !== payload.instance.id),
          decodeProviderInstance(payload.instance),
        ];
      } else if (
        payload?.instanceId !== undefined &&
        payload?.version !== undefined &&
        payload?.outcome === undefined
      ) {
        instances = instances.filter((item) => item.id !== payload.instanceId);
      }
      return { aggregateVersion: payload?.instance?.version ?? payload?.version ?? 1 };
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
  const runtimeRegistry = new ProviderRuntimeRegistry();
  const runInstallScripts =
    options.runInstallScripts === undefined ? undefined : vi.fn(options.runInstallScripts);
  const service = new ProviderService({
    persistence,
    runtimeRegistry,
    probe:
      options.probe ??
      (async () => {
        throw new Error("not probed here");
      }),
    acpAgentInstall: {
      install: vi.fn(install),
      ...(runInstallScripts === undefined ? {} : { runInstallScripts }),
      remove,
    },
    uuid: () => crypto.randomUUID(),
    clock: () => now,
  });
  const current = () => instances.find((item) => item.id === instanceId);
  return { service, append, remove, current, runtimeRegistry, runInstallScripts };
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

  it("refuses Google Antigravity added as any ACP agent, pointing to its built-in provider", async () => {
    const fixture = serviceWith(installed);
    const add = (source: unknown) =>
      fixture.service.execute(windowId, {
        kind: "add-acp-agent",
        instanceId,
        expectedVersion: 0 as never,
        source: source as never,
      });
    for (const source of [
      { kind: "registry", registryId: "antigravity-acp" },
      { kind: "local", displayName: "agy", command: "/opt/homebrew/bin/agy", args: ["acp"] },
      { kind: "local", displayName: "agy", command: "/Users/me/bin/AGY.exe", args: [] },
    ])
      await expect(add(source)).rejects.toMatchObject({
        failure: { category: "invalid-configuration", message: ANTIGRAVITY_ADDED_REFUSAL },
      });
    expect(fixture.append).not.toHaveBeenCalled();
  });
});

const ANTIGRAVITY_ADDED_REFUSAL =
  "Google Antigravity runs only as its built-in provider, which keeps it to the use its vendor supports on a personal sign-in. Add Google Antigravity in Settings › Providers & Models instead.";

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
              Effect.andThen(
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

  it("starts nothing for an Antigravity agent added before such agents were refused", async () => {
    const { driver } = recordingDriver();
    const agent = addedAgent(true);
    const agy = {
      ...agent,
      configuration: {
        ...agent.configuration,
        source: { kind: "local" as const, command: "/usr/local/bin/agy" },
      },
    } as AddedAcpAgentProviderInstance;
    const exit = await Effect.runPromiseExit(
      Effect.scoped(withAddedAcpAgentLaunch(driver, agy).acquire({ instanceId } as never)),
    );
    expect(JSON.stringify(exit)).toContain(ANTIGRAVITY_ADDED_REFUSAL);
  });

  it("starts nothing for an agent that is not on", async () => {
    const { driver } = recordingDriver();
    const off = { ...addedAgent(true), enabled: false };
    const exit = await Effect.runPromiseExit(
      Effect.scoped(withAddedAcpAgentLaunch(driver, off).acquire({ instanceId } as never)),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("reports the deferred install-script message when Connection Check fails before Trust for a package needing its install script", async () => {
    const failingDriver = {
      kind: "acp-agent",
      probe: () =>
        Effect.fail({
          category: "unavailable" as const,
          message: "spawn ENOENT",
        }),
      acquire: () => Effect.die("unused"),
    } as unknown as ProviderDriver;
    const untrustedPackage = decodeProviderInstance({
      id: instanceId,
      displayName: "Factory Droid",
      driverKind: "acp-agent",
      configuration: {
        kind: "acp-agent",
        source: {
          kind: "registry",
          registryId: "factory-droid",
          version: "1.12.1",
          distribution: "npx",
        },
        args: ["exec", "--output-format", "acp-daemon"],
        install: {
          executable: "/data/acp-agent-installs/droid/1.12.1-abcd1234/node_modules/.bin/droid",
          integrity: "package-manager",
          hasInstallScripts: true,
        },
        trusted: false,
      },
      enabled: true,
      environmentPolicy: "inherit-host",
      version: 3,
      createdAt: now,
      updatedAt: now,
    });
    if (untrustedPackage.driverKind !== "acp-agent") throw new Error("not an added agent");

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        withAddedAcpAgentLaunch(failingDriver, untrustedPackage).probe({ instanceId } as never),
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      const failure = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toEqual({
          category: "unavailable",
          message: ACP_PACKAGE_NEEDS_INSTALL_SCRIPT_MESSAGE,
        });
      }
    }

    // An unauthenticated reply proves the binary ran and asked for sign-in, so
    // it keeps its auth failure instead of blaming deferred install scripts.
    const unauthDriver = {
      kind: "acp-agent",
      probe: () =>
        Effect.fail({
          category: "unauthenticated" as const,
          message: "Sign in first.",
        }),
      acquire: () => Effect.die("unused"),
    } as unknown as ProviderDriver;
    const unauthExit = await Effect.runPromiseExit(
      Effect.scoped(
        withAddedAcpAgentLaunch(unauthDriver, untrustedPackage).probe({ instanceId } as never),
      ),
    );
    expect(unauthExit._tag).toBe("Failure");
    if (unauthExit._tag === "Failure") {
      const failure = Cause.findErrorOption(unauthExit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toEqual({
          category: "unauthenticated",
          message: "Sign in first.",
        });
      }
    }
  });
});

describe("trusting an added ACP package with install scripts", () => {
  const packageInstalled = async (): Promise<AcpAgentInstallResult> => ({
    status: "installed",
    executable: "/data/acp-agent-installs/droid/1.12.1-abcd1234/node_modules/.bin/droid",
    integrity: "package-manager",
    hasInstallScripts: true,
  });

  it("runs install scripts on Trust with no further prompt, journals outcome, actor, timestamp and sandboxed mode, and replays cleanly", async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "octant-acp-trust-replay-"));
    tempDirs.push(dataDirectory);
    await Effect.runPromise(
      Effect.gen(function* () {
        const persistence = yield* Persistence;
        const pairedDeviceId = "80000000-0000-4000-8000-000000000099";
        const pairedActor: EventActor = decodeEventActor({
          kind: "remote-device",
          actorId: pairedDeviceId,
          deviceId: pairedDeviceId,
        });
        const runInstallScripts = vi.fn(
          async (): Promise<AcpAgentInstallScriptsResult> => ({
            status: "completed",
            sandboxed: true,
            completedAt: now,
          }),
        );
        const runtimeRegistry = new ProviderRuntimeRegistry();
        const service = new ProviderService({
          persistence,
          runtimeRegistry,
          probe: async () => {
            throw { category: "unavailable", message: "missing downloaded binary" };
          },
          acpAgentInstall: {
            install: vi.fn(packageInstalled),
            runInstallScripts,
            remove: vi.fn(async () => undefined),
          },
          uuid: () => crypto.randomUUID(),
          clock: () => now,
        });

        yield* Effect.promise(async () => {
          await service.execute(
            windowId,
            {
              kind: "add-acp-agent",
              instanceId,
              expectedVersion: 0 as never,
              source: { kind: "registry", registryId: "factory-droid" },
            },
            pairedActor,
          );
          await service.execute(
            windowId,
            { kind: "install-acp-agent", instanceId, expectedVersion: 1 as never },
            pairedActor,
          );
          expect(runInstallScripts).not.toHaveBeenCalled();

          // Clicking Trust runs the package's install script with no further prompt.
          const trusted = await service.execute(
            windowId,
            {
              kind: "set-acp-agent-trust",
              instanceId,
              expectedVersion: 2 as never,
              trusted: true,
            },
            pairedActor,
          );
          expect(runInstallScripts).toHaveBeenCalledTimes(1);
          expect(trusted).toMatchObject({
            kind: "provider-updated",
            instance: {
              configuration: {
                trusted: true,
                install: { hasInstallScripts: true, installScriptsCompleted: true },
              },
            },
          });

          // Enable, then reinstall: reinstall drops trust and clears completion, so
          // Connection Check before Trust reports the exact pre-trust message.
          await service.execute(
            windowId,
            {
              kind: "set-provider-enabled",
              instanceId,
              expectedVersion: 3 as never,
              enabled: true,
            },
            pairedActor,
          );
          await service.execute(
            windowId,
            { kind: "install-acp-agent", instanceId, expectedVersion: 4 as never },
            pairedActor,
          );
          await expect(service.probe(windowId, instanceId)).rejects.toMatchObject({
            failure: {
              category: "unavailable",
              message: ACP_PACKAGE_NEEDS_INSTALL_SCRIPT_MESSAGE,
            },
          });
          expect(runtimeRegistry.observedState(instanceId)).toMatchObject({
            readiness: "unavailable",
            message: ACP_PACKAGE_NEEDS_INSTALL_SCRIPT_MESSAGE,
          });
        });

        // Verify the journaled install-script event carries outcome, actor, timestamp and sandboxed.
        const journalEvents = persistence.journal.replay({
          afterSequence: 0 as never,
          limit: 100,
        });
        const scriptEvents = journalEvents.filter(
          (event) => event.eventName === PROVIDER_ACP_AGENT_INSTALL_SCRIPTS_RAN,
        );
        expect(scriptEvents).toHaveLength(1);
        expect(scriptEvents[0]).toMatchObject({
          eventName: PROVIDER_ACP_AGENT_INSTALL_SCRIPTS_RAN,
          actor: pairedActor,
          occurredAt: now,
          payload: {
            instanceId,
            registryId: "factory-droid",
            version: "1.12.1",
            distribution: "npx",
            outcome: "succeeded",
            sandboxed: true,
            completedAt: now,
          },
        });

        // Rebuild ProviderProjection from the journal and verify clean replay.
        rebuildProjection({
          connection: persistence.connection,
          journal: persistence.journal,
          projection: new ProviderProjection(),
          clock: () => now,
        });
        const replayed = persistence.readProviderInstance(instanceId);
        expect(replayed).toMatchObject({
          id: instanceId,
          enabled: true,
          configuration: {
            trusted: false,
            install: { hasInstallScripts: true },
          },
        });
      }).pipe(Effect.provide(makePersistenceLive({ dataDirectory, clock: () => now }))),
    );
    // Reopen the database on a fresh PersistenceService to prove cold-start
    // journal schema verification accepts the new install-script event.
    await Effect.runPromise(
      Effect.gen(function* () {
        const reopened = yield* Persistence;
        expect(reopened.status()).toMatchObject({ state: "current", integrity: "ok" });
        expect(reopened.readProviderInstance(instanceId)).toMatchObject({
          id: instanceId,
          enabled: true,
          configuration: {
            trusted: false,
            install: { hasInstallScripts: true },
          },
        });
      }).pipe(Effect.provide(makePersistenceLive({ dataDirectory, clock: () => now }))),
    );
  });

  it("journals a failed install script without marking the agent trusted, and lets the person retry Trust", async () => {
    let attempt = 0;
    const fixture = serviceWith(packageInstalled, {
      runInstallScripts: async () => {
        attempt += 1;
        return attempt === 1
          ? {
              status: "failed",
              sandboxed: false,
              completedAt: now,
              reason: "script-failed",
              message: "The package's install script failed.",
            }
          : {
              status: "completed",
              sandboxed: false,
              completedAt: now,
            };
      },
    });
    await fixture.service.execute(windowId, {
      kind: "add-acp-agent",
      instanceId,
      expectedVersion: 0 as never,
      source: { kind: "registry", registryId: "factory-droid" },
    });
    await fixture.service.execute(windowId, {
      kind: "install-acp-agent",
      instanceId,
      expectedVersion: 1 as never,
    });

    await expect(
      fixture.service.execute(windowId, {
        kind: "set-acp-agent-trust",
        instanceId,
        expectedVersion: 2 as never,
        trusted: true,
      }),
    ).rejects.toMatchObject({
      failure: { category: "unavailable", message: "The package's install script failed." },
    });

    // Agent stays untrusted and version stays at 2 so retry works cleanly.
    expect(fixture.current()).toMatchObject({
      version: 2,
      configuration: { trusted: false },
    });
    const failedEvent = fixture.append.mock.calls.find(
      ([request]) => request.events[0]?.eventName === PROVIDER_ACP_AGENT_INSTALL_SCRIPTS_RAN,
    )?.[0]?.events[0];
    expect(failedEvent?.payload).toMatchObject({
      instanceId,
      outcome: "failed",
      sandboxed: false,
      reason: "script-failed",
      completedAt: now,
    });

    // Retrying Trust succeeds and marks the agent trusted.
    await expect(
      fixture.service.execute(windowId, {
        kind: "set-acp-agent-trust",
        instanceId,
        expectedVersion: 2 as never,
        trusted: true,
      }),
    ).resolves.toMatchObject({
      kind: "provider-updated",
      instance: {
        version: 3,
        configuration: { trusted: true, install: { installScriptsCompleted: true } },
      },
    });
  });

  it("keeps Trust a clean no-op with no install-script event when the package has no install script", async () => {
    const fixture = serviceWith(
      async () => ({
        status: "installed",
        executable: "/data/acp-agent-installs/droid/1.12.1-abcd1234/node_modules/.bin/droid",
        integrity: "package-manager",
        hasInstallScripts: false,
      }),
      {
        runInstallScripts: async () => ({ status: "not-needed" }),
      },
    );
    await fixture.service.execute(windowId, {
      kind: "add-acp-agent",
      instanceId,
      expectedVersion: 0 as never,
      source: { kind: "registry", registryId: "factory-droid" },
    });
    await fixture.service.execute(windowId, {
      kind: "install-acp-agent",
      instanceId,
      expectedVersion: 1 as never,
    });
    await fixture.service.execute(windowId, {
      kind: "set-acp-agent-trust",
      instanceId,
      expectedVersion: 2 as never,
      trusted: true,
    });
    expect(
      fixture.append.mock.calls.some(
        ([request]) => request.events[0]?.eventName === PROVIDER_ACP_AGENT_INSTALL_SCRIPTS_RAN,
      ),
    ).toBe(false);
    expect(fixture.current()).toMatchObject({ configuration: { trusted: true } });
  });

  it("refuses Trust before running deferred install scripts when an active or leased session is running", async () => {
    const runInstallScripts = vi.fn(
      async (): Promise<AcpAgentInstallScriptsResult> => ({
        status: "completed",
        sandboxed: false,
        completedAt: now,
      }),
    );
    const fixture = serviceWith(packageInstalled, { runInstallScripts });
    await fixture.service.execute(windowId, {
      kind: "add-acp-agent",
      instanceId,
      expectedVersion: 0 as never,
      source: { kind: "registry", registryId: "factory-droid" },
    });
    await fixture.service.execute(windowId, {
      kind: "install-acp-agent",
      instanceId,
      expectedVersion: 1 as never,
    });

    // Active session prevents Trust before install scripts run.
    fixture.runtimeRegistry.setActiveSessionCount(instanceId, 1);
    await expect(
      fixture.service.execute(windowId, {
        kind: "set-acp-agent-trust",
        instanceId,
        expectedVersion: 2 as never,
        trusted: true,
      }),
    ).rejects.toMatchObject({
      failure: {
        category: "invalid-configuration",
        message: "Stop active sessions before changing trust for this agent.",
      },
    });
    expect(runInstallScripts).not.toHaveBeenCalled();

    // Leased native session also prevents Trust before install scripts run.
    fixture.runtimeRegistry.setActiveSessionCount(instanceId, 0);
    const lease = fixture.runtimeRegistry.claimNativeSession(instanceId, "native-session-1");
    expect(lease.status).toBe("claimed");
    if (lease.status !== "claimed") return;
    await expect(
      fixture.service.execute(windowId, {
        kind: "set-acp-agent-trust",
        instanceId,
        expectedVersion: 2 as never,
        trusted: true,
      }),
    ).rejects.toMatchObject({
      failure: {
        category: "invalid-configuration",
        message: "Stop active sessions before changing trust for this agent.",
      },
    });
    expect(runInstallScripts).not.toHaveBeenCalled();
    expect(
      fixture.append.mock.calls.some(
        ([request]) => request.events[0]?.eventName === PROVIDER_ACP_AGENT_INSTALL_SCRIPTS_RAN,
      ),
    ).toBe(false);

    // Once sessions stop, Trust runs the script and commits installScriptsCompleted cleanly.
    lease.release();
    await expect(
      fixture.service.execute(windowId, {
        kind: "set-acp-agent-trust",
        instanceId,
        expectedVersion: 2 as never,
        trusted: true,
      }),
    ).resolves.toMatchObject({
      kind: "provider-updated",
      instance: {
        configuration: { trusted: true, install: { installScriptsCompleted: true } },
      },
    });
    expect(runInstallScripts).toHaveBeenCalledTimes(1);
  });

  it("blocks new session and runtime acquisitions while Trust install scripts are running, then releases the hold", async () => {
    let scriptStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      scriptStarted = resolve;
    });
    let finishScript!: (result: AcpAgentInstallScriptsResult) => void;
    const scriptPromise = new Promise<AcpAgentInstallScriptsResult>((resolve) => {
      finishScript = resolve;
    });
    const fixture = serviceWith(packageInstalled, {
      runInstallScripts: async () => {
        scriptStarted();
        return scriptPromise;
      },
    });
    await fixture.service.execute(windowId, {
      kind: "add-acp-agent",
      instanceId,
      expectedVersion: 0 as never,
      source: { kind: "registry", registryId: "factory-droid" },
    });
    await fixture.service.execute(windowId, {
      kind: "install-acp-agent",
      instanceId,
      expectedVersion: 1 as never,
    });

    const trustPromise = fixture.service.execute(windowId, {
      kind: "set-acp-agent-trust",
      instanceId,
      expectedVersion: 2 as never,
      trusted: true,
    });
    await started;

    // While deferred install scripts run, starting a session or acquiring a runtime is refused.
    expect(() => fixture.runtimeRegistry.setActiveSessionCount(instanceId, 1)).toThrow(
      ProviderExecutableUpdateRejected,
    );
    expect(
      fixture.runtimeRegistry.claimNativeSession(instanceId, "native-session-2"),
    ).toMatchObject({
      status: "refused",
      failure: {
        category: "unavailable",
        message: "Wait for this agent's Trust step to finish before starting a session.",
      },
    });
    const acquireExit = await Effect.runPromiseExit(
      Effect.scoped(
        fixture.runtimeRegistry.acquireRuntime(instanceId, {
          idleMs: 0,
          start: async () => ({ value: {}, close: async () => undefined }),
        }),
      ),
    );
    expect(acquireExit._tag).toBe("Failure");

    // Completing the script commits Trust and releases the quiescence hold.
    finishScript({ status: "completed", sandboxed: false, completedAt: now });
    await expect(trustPromise).resolves.toMatchObject({
      kind: "provider-updated",
      instance: {
        configuration: { trusted: true, install: { installScriptsCompleted: true } },
      },
    });
    expect(() => fixture.runtimeRegistry.setActiveSessionCount(instanceId, 1)).not.toThrow();
    fixture.runtimeRegistry.setActiveSessionCount(instanceId, 0);
  });
});
