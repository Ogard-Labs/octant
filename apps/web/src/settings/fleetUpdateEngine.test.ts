import type { ProviderClient } from "@octant/client-runtime/provider-client";
import { ProviderClientFailure } from "@octant/client-runtime/provider-client";
import type { ShieldServersClient } from "@octant/client-runtime/shield-servers-client";
import type {
  AggregateId,
  HostId,
  HubMemberId,
  ProviderInstanceId,
  ProviderRegistrySnapshot,
  UtcTimestamp,
} from "@octant/contracts";
import type { AppUpdateState } from "@octant/contracts/app-updates";
import type {
  MemberInstallCommand,
  MemberInstallResult,
  MemberUpdateDrain,
  ShieldServer,
} from "@octant/contracts/shield-servers";
import { planFleetUpdate } from "@octant/domain/fleet-update-policy";
import { describe, expect, it, vi } from "vitest";
import {
  collectFleetUpdateInventory,
  retryFleetUpdateStep,
  runFleetUpdatePlan,
  type FleetUpdateSources,
  type FleetUpdateStepState,
} from "./fleetUpdateEngine";

const SERVER_A_ID = "70000000-0000-4000-8000-000000000001" as AggregateId;
const SERVER_B_ID = "70000000-0000-4000-8000-000000000002" as AggregateId;
const MEMBER_A_ID = "70000000-0000-4000-8000-000000000011" as HubMemberId;
const MEMBER_B_ID = "70000000-0000-4000-8000-000000000012" as HubMemberId;
const PLAN_A_ID = "70000000-0000-4000-8000-000000000021" as AggregateId;
const PLAN_B_ID = "70000000-0000-4000-8000-000000000022" as AggregateId;
const PLAN_A_RETRY_ID = "70000000-0000-4000-8000-000000000023" as AggregateId;
const UPDATE_A_ID = "70000000-0000-4000-8000-000000000031" as AggregateId;
const UPDATE_B_ID = "70000000-0000-4000-8000-000000000032" as AggregateId;
const LOCAL_CLAUDE_ID = "80000000-0000-4000-8000-000000000001" as ProviderInstanceId;
const REMOTE_CODEX_ID = "80000000-0000-4000-8000-000000000002" as ProviderInstanceId;

function localAppState(overrides: Partial<AppUpdateState> = {}): AppUpdateState {
  return {
    status: "available",
    currentVersion: "0.1.0" as AppUpdateState["currentVersion"],
    automaticChecks: true,
    ring: "stable",
    available: {
      product: "octant",
      version: "0.2.0" as AppUpdateState["currentVersion"],
      platform: "darwin",
      arch: "arm64",
      ring: "stable",
      url: "https://updates.example.test/Octant.zip",
      sha256: "a".repeat(64),
      releasedAt: "2026-11-28T09:00:00.000Z" as UtcTimestamp,
    },
    ...overrides,
  };
}

function providerSnapshot(
  instanceId: ProviderInstanceId,
  driverKind: "claude" | "codex",
  displayName: string,
  detectedVersion: string,
): ProviderRegistrySnapshot {
  return {
    instances: [
      {
        id: instanceId,
        driverKind,
        displayName,
        enabled: true,
      },
    ],
    observedStates: [
      {
        instanceId,
        readiness: "ready",
        detectedVersion,
      },
    ],
  } as unknown as ProviderRegistrySnapshot;
}

function shieldServer(serverId: AggregateId, alias: string): ShieldServer {
  return {
    serverId,
    alias,
    user: "deploy",
    profile: "operate",
    deployCommands: [],
  };
}

describe("fleetUpdateEngine", () => {
  it("runs provider CLIs via update-provider-cli first, then over-SSH headless servers, then this local app last", async () => {
    const events: string[] = [];
    const localCommands: string[] = [];
    const remoteCommands: string[] = [];

    const localProviderClient: Pick<ProviderClient, "bootstrap" | "execute"> = {
      bootstrap: vi.fn(async () =>
        providerSnapshot(LOCAL_CLAUDE_ID, "claude", "Claude Code", "2.1.300"),
      ),
      execute: vi.fn(async (command) => {
        localCommands.push(command.kind);
        if (command.kind === "check-provider-latest-version") {
          return {
            kind: "provider-latest-version" as const,
            instanceId: command.instanceId,
            latestVersion: "2.1.314",
          };
        }
        events.push(`provider:local:${command.kind}`);
        return {
          kind: "provider-cli-updated" as const,
          instanceId: command.instanceId,
          status: "updated" as const,
          previousVersion: "2.1.300",
          currentVersion: "2.1.314",
        };
      }),
    };

    const remoteProviderClient: Pick<ProviderClient, "bootstrap" | "execute"> = {
      bootstrap: vi.fn(async () => providerSnapshot(REMOTE_CODEX_ID, "codex", "Codex", "0.25.0")),
      execute: vi.fn(async (command) => {
        remoteCommands.push(command.kind);
        events.push(`provider:remote:${command.kind}`);
        return {
          kind: "provider-cli-updated" as const,
          instanceId: command.instanceId,
          status: "updated" as const,
          previousVersion: "0.25.0",
          currentVersion: "0.26.0",
        };
      }),
    };

    const memberInstall = vi.fn(
      async (command: MemberInstallCommand): Promise<MemberInstallResult> => {
        if (command.kind === "list-member-computers") {
          return {
            kind: "member-computers",
            members: [
              {
                serverId: SERVER_A_ID,
                target: "linux-x64",
                artifactVersion: "0.1.0",
                listenAddress: "100.64.0.10",
                listenPort: 8443,
                memberId: MEMBER_A_ID,
              },
            ],
          };
        }
        if (command.kind === "prepare-member-update") {
          return {
            kind: "member-update-plan",
            plan: {
              planId: PLAN_A_ID,
              serverId: SERVER_A_ID,
              alias: "devbox01",
              user: "deploy",
              target: "linux-x64",
              fromVersion: "0.1.0",
              toVersion: "0.2.0",
              ring: "stable",
              signature: "verified",
              installRoot: "/home/deploy/.local/state/octant/install",
              storeMigration: false,
              drains: ["wait", "stop-now"],
            },
          };
        }
        if (command.kind === "confirm-member-update") {
          events.push(`ssh:devbox01:${command.drain.kind}`);
          return {
            kind: "member-update-progress",
            progress: {
              updateId: UPDATE_A_ID,
              serverId: SERVER_A_ID,
              state: "running",
              steps: [],
            },
          };
        }
        if (command.kind === "read-member-update") {
          events.push("ssh:devbox01:updated");
          return {
            kind: "member-update-progress",
            progress: {
              updateId: UPDATE_A_ID,
              serverId: SERVER_A_ID,
              state: "updated",
              steps: [],
            },
          };
        }
        throw new Error(`Unexpected command ${command.kind}`);
      },
    );

    const downloadAppUpdate = vi.fn(async () => {
      events.push("local-app:download");
      return localAppState({ status: "ready" });
    });
    const installAppUpdate = vi.fn(async () => {
      events.push("local-app:install");
      return { kind: "installing" as const };
    });

    const sources: FleetUpdateSources = {
      localApp: {
        displayName: "This Mac",
        state: localAppState(),
        downloadAppUpdate,
        installAppUpdate,
      },
      localProviderClient,
      shieldServersClient: {
        read: vi.fn(async () => ({
          servers: [shieldServer(SERVER_A_ID, "devbox01")],
          sshAgent: "available" as const,
        })),
        memberInstall,
      },
      sleep: async () => undefined,
      pollMs: 0,
    };

    const inventory = await collectFleetUpdateInventory(sources);
    // Attach a person-paired remote host with an outdated provider CLI to prove
    // remote provider execution runs in Phase 1 alongside local providers.
    const remoteHostId = "remote-studio";
    const extendedInventory = {
      ...inventory,
      hosts: [
        {
          hostId: remoteHostId,
          displayName: "Studio Mac",
          kind: "remote" as const,
          connectionState: "ready" as const,
          actsAsHostPerson: true,
          currentVersion: "0.1.0",
          octant: { kind: "remote-desktop" as const, currentVersion: "0.1.0" },
          providers: [
            {
              instanceId: String(REMOTE_CODEX_ID),
              displayName: "Codex",
              driverKind: "codex",
              currentVersion: "0.25.0",
              latestVersion: "0.26.0",
              supportsCliUpdate: true,
              outdated: true,
            },
          ],
        },
        ...inventory.hosts,
      ],
      remoteProviderClients: new Map([[remoteHostId, remoteProviderClient]]),
    };

    const plan = planFleetUpdate(extendedInventory.hosts);
    const drain: MemberUpdateDrain = { kind: "wait", minutes: 10 };
    const finalStates = await runFleetUpdatePlan({
      plan,
      inventory: extendedInventory,
      sources,
      drain,
      onStepStatesChange: () => undefined,
    });

    // Strict phase order: provider CLIs first, then remote SSH server, then local app last.
    const providerIndices = [
      events.indexOf("provider:local:update-provider-cli"),
      events.indexOf("provider:remote:update-provider-cli"),
    ];
    const sshStartIndex = events.indexOf("ssh:devbox01:wait");
    const sshDoneIndex = events.indexOf("ssh:devbox01:updated");
    const localDownloadIndex = events.indexOf("local-app:download");
    const localInstallIndex = events.indexOf("local-app:install");

    expect(Math.max(...providerIndices)).toBeLessThan(sshStartIndex);
    expect(sshStartIndex).toBeLessThan(sshDoneIndex);
    expect(sshDoneIndex).toBeLessThan(localDownloadIndex);
    expect(localDownloadIndex).toBeLessThan(localInstallIndex);

    // Fleet execution posts only update-provider-cli (never arbitrary commands).
    expect(remoteCommands).toEqual(["update-provider-cli"]);
    expect(localCommands.filter((kind) => kind !== "check-provider-latest-version")).toEqual([
      "update-provider-cli",
    ]);
    expect(finalStates.every((state) => state.status === "succeeded")).toBe(true);
  });

  it("re-reads the observed version on a provider channel timeout instead of re-posting update-provider-cli", async () => {
    const execute = vi.fn(async () => {
      throw new ProviderClientFailure({
        category: "unavailable",
        message: "That computer's answer was too large or too slow.",
      });
    });
    const bootstrap = vi.fn(async () =>
      providerSnapshot(REMOTE_CODEX_ID, "codex", "Codex", "0.26.0"),
    );

    const sources: FleetUpdateSources = {
      localApp: { displayName: "This Mac", state: localAppState({ status: "up-to-date" }) },
      sleep: async () => undefined,
      pollMs: 0,
    };
    const hosts = [
      {
        hostId: "remote-1",
        displayName: "Build Box",
        kind: "remote" as const,
        connectionState: "ready" as const,
        actsAsHostPerson: true,
        currentVersion: "0.1.0",
        octant: { kind: "standalone-headless" as const, currentVersion: "0.1.0" },
        providers: [
          {
            instanceId: String(REMOTE_CODEX_ID),
            displayName: "Codex",
            driverKind: "codex",
            currentVersion: "0.25.0",
            latestVersion: "0.26.0",
            supportsCliUpdate: true,
            outdated: true,
          },
        ],
      },
    ];
    const plan = planFleetUpdate(hosts);
    const states = await runFleetUpdatePlan({
      plan,
      inventory: {
        hosts,
        remoteProviderClients: new Map([["remote-1", { bootstrap, execute }]]),
        remoteHostControlClients: new Map(),
        sshServersById: new Map(),
      },
      sources,
      drain: { kind: "stop-now" },
      onStepStatesChange: () => undefined,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({
      kind: "update-provider-cli",
      instanceId: REMOTE_CODEX_ID,
    });
    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(states[0]?.status).toBe("succeeded");
    expect(states[0]?.message).toContain("0.26.0");
  });

  it("lets another host finish when one SSH server rolls back, holds local relaunch, and retries the failed server", async () => {
    let retryPrepared = false;
    const memberInstall = vi.fn(
      async (command: MemberInstallCommand): Promise<MemberInstallResult> => {
        if (command.kind === "prepare-member-update" && command.serverId === SERVER_A_ID) {
          retryPrepared = true;
          return {
            kind: "member-update-plan",
            plan: {
              planId: PLAN_A_RETRY_ID,
              serverId: SERVER_A_ID,
              alias: "devbox01",
              user: "deploy",
              target: "linux-x64",
              fromVersion: "0.1.0",
              toVersion: "0.2.0",
              ring: "stable",
              signature: "verified",
              installRoot: "/home/deploy/.local/state/octant/install",
              storeMigration: false,
              drains: ["wait", "stop-now"],
            },
          };
        }
        if (command.kind === "confirm-member-update") {
          if (command.planId === PLAN_A_ID) {
            return {
              kind: "member-update-progress",
              progress: {
                updateId: UPDATE_A_ID,
                serverId: SERVER_A_ID,
                state: "rolled-back",
                rollbackReason: "health-check-failed",
                steps: [],
              },
            };
          }
          if (command.planId === PLAN_A_RETRY_ID) {
            return {
              kind: "member-update-progress",
              progress: {
                updateId: UPDATE_A_ID,
                serverId: SERVER_A_ID,
                state: "updated",
                steps: [],
              },
            };
          }
          return {
            kind: "member-update-progress",
            progress: {
              updateId: UPDATE_B_ID,
              serverId: SERVER_B_ID,
              state: "updated",
              steps: [],
            },
          };
        }
        throw new Error(`Unexpected command ${command.kind}`);
      },
    );

    const installAppUpdate = vi.fn(async () => ({ kind: "installing" as const }));
    const sources: FleetUpdateSources = {
      localApp: {
        displayName: "This Mac",
        state: localAppState({ status: "ready" }),
        downloadAppUpdate: vi.fn(async () => localAppState({ status: "ready" })),
        installAppUpdate,
      },
      shieldServersClient: {
        read: vi.fn(async () => ({ servers: [], sshAgent: "available" as const })),
        memberInstall,
      },
      sleep: async () => undefined,
      pollMs: 0,
    };

    const hosts = [
      {
        hostId: String(MEMBER_A_ID),
        displayName: "devbox01",
        kind: "remote" as const,
        isHeadless: true,
        connectionState: "ready" as const,
        actsAsHostPerson: false,
        currentVersion: "0.1.0",
        octant: {
          kind: "ssh-member" as const,
          serverId: String(SERVER_A_ID),
          alias: "devbox01",
          target: "linux-x64",
          fromVersion: "0.1.0",
          toVersion: "0.2.0",
          ring: "stable" as const,
          planId: String(PLAN_A_ID),
          storeMigration: false,
          state: "update-available" as const,
        },
        providers: [],
      },
      {
        hostId: String(MEMBER_B_ID),
        displayName: "devbox02",
        kind: "remote" as const,
        isHeadless: true,
        connectionState: "ready" as const,
        actsAsHostPerson: false,
        currentVersion: "0.1.0",
        octant: {
          kind: "ssh-member" as const,
          serverId: String(SERVER_B_ID),
          alias: "devbox02",
          target: "linux-x64",
          fromVersion: "0.1.0",
          toVersion: "0.2.0",
          ring: "stable" as const,
          planId: String(PLAN_B_ID),
          storeMigration: false,
          state: "update-available" as const,
        },
        providers: [],
      },
      {
        hostId: "local",
        displayName: "This Mac",
        kind: "local" as const,
        connectionState: "ready" as const,
        actsAsHostPerson: true,
        currentVersion: "0.1.0",
        octant: {
          kind: "local-app" as const,
          status: "ready" as const,
          currentVersion: "0.1.0",
          availableVersion: "0.2.0",
          ring: "stable" as const,
        },
        providers: [],
      },
    ];

    const inventory = {
      hosts,
      remoteProviderClients: new Map(),
      remoteHostControlClients: new Map(),
      sshServersById: new Map(),
    };
    const plan = planFleetUpdate(hosts);
    let latest: ReadonlyArray<FleetUpdateStepState> = [];
    await runFleetUpdatePlan({
      plan,
      inventory,
      sources,
      drain: { kind: "stop-now" },
      onStepStatesChange: (next) => {
        latest = next;
      },
    });

    const byHost = new Map(latest.map((entry) => [entry.step.hostId, entry]));
    expect(byHost.get(String(MEMBER_A_ID))?.status).toBe("failed");
    expect(byHost.get(String(MEMBER_A_ID))?.message).toContain("rolled back to 0.1.0");
    // The second headless server still completed despite the first rolling back.
    expect(byHost.get(String(MEMBER_B_ID))?.status).toBe("succeeded");
    // Local app was held rather than forced to relaunch over a failed remote update.
    expect(byHost.get("local")?.status).toBe("held");
    expect(installAppUpdate).not.toHaveBeenCalled();

    // Retrying the failed server re-prepares and succeeds cleanly.
    const failedStep = byHost.get(String(MEMBER_A_ID))?.step;
    expect(failedStep).toBeDefined();
    if (failedStep !== undefined) {
      const retried = await retryFleetUpdateStep({
        step: failedStep,
        inventory,
        sources,
        drain: { kind: "stop-now" },
      });
      expect(retryPrepared).toBe(true);
      expect(retried.status).toBe("succeeded");
    }
  });

  it("includes hub-introduced computers as pair-to-update while still updating an over-SSH server through this hub", async () => {
    const memberInstall: ShieldServersClient["memberInstall"] = vi.fn(
      async (command: MemberInstallCommand): Promise<MemberInstallResult> => {
        if (command.kind === "list-member-computers") {
          return {
            kind: "member-computers",
            members: [
              {
                serverId: SERVER_A_ID,
                target: "linux-x64",
                artifactVersion: "0.1.0",
                listenAddress: "100.64.0.10",
                listenPort: 8443,
                memberId: MEMBER_A_ID,
              },
            ],
          };
        }
        return {
          kind: "member-update-plan",
          plan: {
            planId: PLAN_A_ID,
            serverId: SERVER_A_ID,
            alias: "devbox01",
            user: "deploy",
            target: "linux-x64",
            fromVersion: "0.1.0",
            toVersion: "0.2.0",
            ring: "stable",
            signature: "verified",
            installRoot: "/home/deploy/.local/state/octant/install",
            storeMigration: false,
            drains: ["wait", "stop-now"],
          },
        };
      },
    );

    const inventory = await collectFleetUpdateInventory({
      localApp: { displayName: "This Mac", state: localAppState({ status: "up-to-date" }) },
      hostFederationLifecycle: {
        list: () => [
          {
            hostId: MEMBER_A_ID as unknown as HostId,
            kind: "remote",
            displayName: "devbox01",
            origin: "https://100.64.0.10:8443",
            serverBuildVersion: "0.1.0",
            through: "hub",
            state: "ready",
            health: "healthy",
            actions: { canReconnect: false, canRevoke: true, canRemove: true },
          },
          {
            hostId: MEMBER_B_ID as unknown as HostId,
            kind: "remote",
            displayName: "hub-peer",
            origin: "https://100.64.0.20:8443",
            serverBuildVersion: "0.1.0",
            through: "hub",
            state: "ready",
            health: "healthy",
            actions: { canReconnect: false, canRevoke: true, canRemove: true },
          },
        ],
      },
      shieldServersClient: {
        read: vi.fn(async () => ({
          servers: [shieldServer(SERVER_A_ID, "devbox01")],
          sshAgent: "available" as const,
        })),
        memberInstall,
      },
      sleep: async () => undefined,
      pollMs: 0,
    });

    const plan = planFleetUpdate(inventory.hosts);
    const devbox = plan.machines.find((machine) => machine.displayName === "devbox01");
    const peer = plan.machines.find((machine) => machine.displayName === "hub-peer");

    expect(devbox?.disposition).toBe("will-update");
    expect(devbox?.octantAction).toBe("remote-octant-ssh");
    expect(peer?.disposition).toBe("skipped");
    expect(peer?.skipReason).toBe("pair-to-update");
  });

  it("waits for the native updater subscription to finish staging when downloadAppUpdate returns downloading", async () => {
    let listener: ((state: AppUpdateState) => void) | undefined;
    const subscribeAppUpdateState = vi.fn((cb: (state: AppUpdateState) => void) => {
      listener = cb;
      return () => {
        listener = undefined;
      };
    });
    const downloadAppUpdate = vi.fn(async () => {
      setTimeout(() => {
        listener?.(localAppState({ status: "ready" }));
      }, 0);
      return localAppState({ status: "downloading" });
    });
    const installAppUpdate = vi.fn(async () => ({ kind: "installing" as const }));

    const sources: FleetUpdateSources = {
      localApp: {
        displayName: "This Mac",
        state: localAppState({ status: "available" }),
        downloadAppUpdate,
        subscribeAppUpdateState,
        installAppUpdate,
        localDownloadTimeoutMs: 5_000,
      },
      sleep: async () => undefined,
      pollMs: 0,
    };

    const inventory = await collectFleetUpdateInventory(sources);
    const plan = planFleetUpdate(inventory.hosts);
    const states = await runFleetUpdatePlan({
      plan,
      inventory,
      sources,
      drain: { kind: "stop-now" },
      onStepStatesChange: () => undefined,
    });

    expect(subscribeAppUpdateState).toHaveBeenCalledTimes(1);
    expect(downloadAppUpdate).toHaveBeenCalledTimes(1);
    expect(installAppUpdate).toHaveBeenCalledTimes(1);
    expect(states.find((entry) => entry.step.phase === "local-app")?.status).toBe("succeeded");
  });

  it("treats not-ready from installAppUpdate as a retryable failure instead of success", async () => {
    const downloadAppUpdate = vi.fn(async () => localAppState({ status: "ready" }));
    const installAppUpdate = vi.fn(async () => ({ kind: "not-ready" as const }));
    const sources: FleetUpdateSources = {
      localApp: {
        displayName: "This Mac",
        state: localAppState({ status: "ready" }),
        downloadAppUpdate,
        installAppUpdate,
      },
      sleep: async () => undefined,
      pollMs: 0,
    };

    const inventory = await collectFleetUpdateInventory(sources);
    const plan = planFleetUpdate(inventory.hosts);
    const states = await runFleetUpdatePlan({
      plan,
      inventory,
      sources,
      drain: { kind: "stop-now" },
      onStepStatesChange: () => undefined,
    });

    const localStep = states.find((entry) => entry.step.phase === "local-app");
    expect(localStep?.status).toBe("failed");
    expect(localStep?.retryable).toBe(true);
  });

  it("marks an SSH step failed and holds the local app when refreshing an expired plan throws", async () => {
    const installAppUpdate = vi.fn(async () => ({ kind: "installing" as const }));
    let prepareCount = 0;
    const memberInstall: ShieldServersClient["memberInstall"] = vi.fn(
      async (command: MemberInstallCommand): Promise<MemberInstallResult> => {
        if (command.kind === "list-member-computers") {
          return {
            kind: "member-computers",
            members: [
              {
                serverId: SERVER_A_ID,
                target: "linux-x64",
                artifactVersion: "0.1.0",
                listenAddress: "100.64.0.10",
                listenPort: 8443,
                memberId: MEMBER_A_ID,
              },
            ],
          };
        }
        if (command.kind === "prepare-member-update") {
          prepareCount += 1;
          if (prepareCount === 1) {
            return {
              kind: "member-update-plan",
              plan: {
                planId: PLAN_A_ID,
                serverId: SERVER_A_ID,
                alias: "devbox01",
                user: "deploy",
                target: "linux-x64",
                fromVersion: "0.1.0",
                toVersion: "0.2.0",
                ring: "stable",
                signature: "verified",
                installRoot: "/home/deploy/.local/state/octant/install",
                storeMigration: false,
                drains: ["wait", "stop-now"],
              },
            };
          }
          throw new Error("transport disconnected");
        }
        return {
          kind: "member-install-refused",
          reason: "plan-expired",
          message: "Plan expired",
        };
      },
    );

    const sources: FleetUpdateSources = {
      localApp: {
        displayName: "This Mac",
        state: localAppState({ status: "ready" }),
        downloadAppUpdate: vi.fn(async () => localAppState({ status: "ready" })),
        installAppUpdate,
      },
      shieldServersClient: {
        read: vi.fn(async () => ({
          servers: [shieldServer(SERVER_A_ID, "devbox01")],
          sshAgent: "available" as const,
        })),
        memberInstall,
      },
      sleep: async () => undefined,
      pollMs: 0,
    };

    const inventory = await collectFleetUpdateInventory(sources);
    const plan = planFleetUpdate(inventory.hosts);
    const states = await runFleetUpdatePlan({
      plan,
      inventory,
      sources,
      drain: { kind: "stop-now" },
      onStepStatesChange: () => undefined,
    });

    const sshStep = states.find((entry) => entry.step.phase === "remote-octant-ssh");
    const localStep = states.find((entry) => entry.step.phase === "local-app");
    expect(sshStep?.status).toBe("failed");
    expect(sshStep?.retryable).toBe(true);
    expect(localStep?.status).toBe("held");
    expect(installAppUpdate).not.toHaveBeenCalled();
  });

  it("updates standalone headless hosts and remote desktop apps via /api/host-control/update, maps 404 to manual-update-required, and isolates failures", async () => {
    const installAppUpdate = vi.fn(async () => ({ kind: "installing" as const }));
    const executionOrder: string[] = [];

    const makeBridgeFor = (
      handler: (path: string, body: unknown) => { readonly status: number; readonly json: unknown },
    ) => {
      const authenticatedFetch = vi.fn(
        async (input: { readonly path: string; readonly body?: string | Uint8Array }) => {
          const parsed =
            typeof input.body === "string"
              ? JSON.parse(input.body)
              : input.body instanceof Uint8Array
                ? JSON.parse(new TextDecoder().decode(input.body))
                : undefined;
          const result = handler(input.path, parsed);
          return new Response(JSON.stringify(result.json), {
            status: result.status,
            headers: { "content-type": "application/json" },
          });
        },
      );
      return {
        connection: () => ({
          session: () => ({ token: "session-token" }),
          authenticatedFetch,
        }),
      };
    };

    const standingTransport = {
      authenticatedFetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              deviceId: "22222222-2222-4222-8222-222222222222",
              deviceLabel: "This Mac",
              origin: "https://remote.example.test",
              credentialGeneration: 1,
              createdAt: "2026-11-01T00:00:00.000Z",
              expiresAt: "2027-11-01T00:00:00.000Z",
              lastSeenAt: "2026-11-28T07:00:00.000Z",
              state: "active",
              actsAsHostPerson: true,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    };

    const headlessBridge = makeBridgeFor((path, body) => {
      if (path === "/api/providers/bootstrap") {
        return { status: 200, json: { instances: [], observedStates: [], defaults: {} } };
      }
      if (path === "/api/host-control/update") {
        const req = body as { readonly action: string; readonly requestId?: string };
        if (req.action === "prepare") {
          return {
            status: 200,
            json: {
              requestId: req.requestId,
              hostKind: "headless",
              state: "update-available",
              fromVersion: "0.1.0",
              toVersion: "0.2.0",
              ring: "stable",
              storeMigration: false,
            },
          };
        }
        if (req.action === "start") {
          executionOrder.push("headless-start");
          return {
            status: 200,
            json: {
              requestId: req.requestId,
              hostKind: "headless",
              state: "updated",
              fromVersion: "0.1.0",
              toVersion: "0.2.0",
              ring: "stable",
            },
          };
        }
      }
      return { status: 404, json: { message: "not found" } };
    });

    const remoteDesktopBridge = makeBridgeFor((path, body) => {
      if (path === "/api/providers/bootstrap") {
        return { status: 200, json: { instances: [], observedStates: [], defaults: {} } };
      }
      if (path === "/api/host-control/update") {
        const req = body as { readonly action: string; readonly requestId?: string };
        if (req.action === "prepare") {
          return {
            status: 200,
            json: {
              requestId: req.requestId,
              hostKind: "desktop",
              state: "update-available",
              fromVersion: "0.1.0",
              toVersion: "0.2.0",
              ring: "stable",
            },
          };
        }
        if (req.action === "start") {
          executionOrder.push("desktop-start");
          return {
            status: 200,
            json: {
              requestId: req.requestId,
              hostKind: "desktop",
              state: "installing",
              fromVersion: "0.1.0",
              toVersion: "0.2.0",
              ring: "stable",
            },
          };
        }
      }
      return { status: 404, json: { message: "not found" } };
    });

    const olderHostBridge = makeBridgeFor((path) => {
      if (path === "/api/providers/bootstrap") {
        return { status: 200, json: { instances: [], observedStates: [], defaults: {} } };
      }
      // Older host does not know `/api/host-control/update` -> 404.
      return { status: 404, json: { message: "Not Found" } };
    });

    const snapshots = [
      {
        hostId: "headless-1",
        displayName: "Linux Box",
        kind: "remote" as const,
        state: "ready" as const,
        serverBuildVersion: "0.1.0",
      },
      {
        hostId: "desktop-2",
        displayName: "Studio Mac",
        kind: "remote" as const,
        state: "ready" as const,
        serverBuildVersion: "0.1.0",
      },
      {
        hostId: "older-3",
        displayName: "Older Box",
        kind: "remote" as const,
        state: "ready" as const,
        serverBuildVersion: "0.0.9",
      },
    ];
    const bridges = new Map([
      ["headless-1", { bridge: headlessBridge, serverBuildVersion: "0.1.0" }],
      ["desktop-2", { bridge: remoteDesktopBridge, serverBuildVersion: "0.1.0" }],
      ["older-3", { bridge: olderHostBridge, serverBuildVersion: "0.0.9" }],
    ]);

    const sources: FleetUpdateSources = {
      localApp: {
        displayName: "This Mac",
        state: localAppState({ status: "ready" }),
        downloadAppUpdate: vi.fn(async () => localAppState({ status: "ready" })),
        installAppUpdate: vi.fn(async () => {
          executionOrder.push("local-app");
          return installAppUpdate();
        }),
      },
      hostFederationLifecycle: {
        list: () => snapshots as never,
      },
      hostFederationTransports: {
        get: (id) => bridges.get(id) as never,
        remoteTransportFor: () => standingTransport as never,
      },
      sleep: async () => undefined,
      pollMs: 0,
    };

    const inventory = await collectFleetUpdateInventory(sources);
    const plan = planFleetUpdate(inventory.hosts);
    const byId = new Map(plan.machines.map((m) => [m.hostId, m]));

    // Neither headless nor remote desktop is skipped; older host gets exact 404 guidance.
    expect(byId.get("headless-1")?.disposition).toBe("will-update");
    expect(byId.get("headless-1")?.octantAction).toBe("remote-octant-host-control");
    expect(byId.get("desktop-2")?.disposition).toBe("will-update");
    expect(byId.get("desktop-2")?.octantAction).toBe("remote-octant-host-control");
    expect(byId.get("older-3")?.disposition).toBe("skipped");
    expect(byId.get("older-3")?.skipReason).toBe("manual-update-required");
    expect(byId.get("older-3")?.skipMessage).toBe(
      "Update this computer once by hand, then it can update from here.",
    );
    expect(plan.machines.every((m) => m.skipReason !== ("headless" as string))).toBe(true);

    const states = await runFleetUpdatePlan({
      plan,
      inventory,
      sources,
      drain: { kind: "wait", minutes: 10 },
      onStepStatesChange: () => undefined,
    });
    expect(states.every((s) => s.status === "succeeded")).toBe(true);
    // Remote headless + remote desktop run BEFORE this local app restarts last.
    expect(executionOrder.at(-1)).toBe("local-app");
    expect(executionOrder).toContain("headless-start");
    expect(executionOrder).toContain("desktop-start");
  });

  it("reports post-update protocol incompatibility clearly without stopping other hosts", async () => {
    let incompatibleNow = false;
    const sources: FleetUpdateSources = {
      localApp: {
        displayName: "This Mac",
        state: localAppState({ status: "up-to-date" }),
      },
      hostFederationLifecycle: {
        list: () =>
          [
            {
              hostId: "headless-incompat",
              displayName: "Newer Host",
              kind: "remote" as const,
              state: incompatibleNow ? ("incompatible" as const) : ("ready" as const),
              serverBuildVersion: "0.1.0",
            },
            {
              hostId: "headless-ok",
              displayName: "Healthy Host",
              kind: "remote" as const,
              state: "ready" as const,
              serverBuildVersion: "0.1.0",
            },
          ] as never,
      },
      sleep: async () => undefined,
      pollMs: 0,
    };

    const hosts = [
      {
        hostId: "headless-incompat",
        displayName: "Newer Host",
        kind: "remote" as const,
        isHeadless: true,
        connectionState: "ready" as const,
        actsAsHostPerson: true,
        currentVersion: "0.1.0",
        octant: {
          kind: "standalone-headless" as const,
          currentVersion: "0.1.0",
          toVersion: "0.3.0",
          requestId: "11111111-1111-4111-8111-111111111111",
          state: "update-available" as const,
        },
        providers: [],
      },
      {
        hostId: "headless-ok",
        displayName: "Healthy Host",
        kind: "remote" as const,
        isHeadless: true,
        connectionState: "ready" as const,
        actsAsHostPerson: true,
        currentVersion: "0.1.0",
        octant: {
          kind: "standalone-headless" as const,
          currentVersion: "0.1.0",
          toVersion: "0.2.0",
          requestId: "22222222-2222-4222-8222-222222222222",
          state: "update-available" as const,
        },
        providers: [],
      },
    ];
    const plan = planFleetUpdate(hosts);
    const states = await runFleetUpdatePlan({
      plan,
      inventory: {
        hosts,
        remoteProviderClients: new Map(),
        remoteHostControlClients: new Map([
          [
            "headless-incompat",
            {
              update: async () => {
                incompatibleNow = true;
                return {
                  hostKind: "headless",
                  state: "updated",
                  fromVersion: "0.1.0",
                  toVersion: "0.3.0",
                };
              },
            },
          ],
          [
            "headless-ok",
            {
              update: async () => ({
                hostKind: "headless",
                state: "updated",
                fromVersion: "0.1.0",
                toVersion: "0.2.0",
              }),
            },
          ],
        ]),
        sshServersById: new Map(),
      },
      sources,
      drain: { kind: "stop-now" },
      onStepStatesChange: () => undefined,
    });
    const byHost = new Map(states.map((s) => [s.step.hostId, s]));
    expect(byHost.get("headless-incompat")?.status).toBe("failed");
    expect(byHost.get("headless-incompat")?.message).toBe(
      "This computer's protocol range does not cover this app.",
    );
    expect(byHost.get("headless-ok")?.status).toBe("succeeded");
  });
});
