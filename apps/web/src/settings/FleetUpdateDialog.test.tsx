import type {
  AggregateId,
  HostId,
  HubMemberId,
  ProviderInstanceId,
  ProviderRegistryCommand,
  ProviderRegistryCommandResult,
  ProviderRegistrySnapshot,
  UtcTimestamp,
} from "@octant/contracts";
import type { AppUpdateState } from "@octant/contracts/app-updates";
import type { MemberInstallCommand, MemberInstallResult } from "@octant/contracts/shield-servers";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FleetUpdateDialog } from "./FleetUpdateDialog";
import type { FleetUpdateSources } from "./fleetUpdateEngine";

const SERVER_ID = "70000000-0000-4000-8000-000000000001" as AggregateId;
const MEMBER_ID = "70000000-0000-4000-8000-000000000011" as HubMemberId;
const PLAN_ID = "70000000-0000-4000-8000-000000000021" as AggregateId;
const UPDATE_ID = "70000000-0000-4000-8000-000000000031" as AggregateId;
const LOCAL_CLAUDE_ID = "80000000-0000-4000-8000-000000000001" as ProviderInstanceId;

function makeSources(overrides: Partial<FleetUpdateSources> = {}): {
  readonly sources: FleetUpdateSources;
  readonly installAppUpdate: ReturnType<typeof vi.fn>;
  readonly memberInstall: ReturnType<typeof vi.fn>;
  readonly providerExecute: ReturnType<typeof vi.fn>;
} {
  const installAppUpdate = vi.fn(async () => ({ kind: "installing" as const }));
  const providerExecute = vi.fn(
    async (command: ProviderRegistryCommand): Promise<ProviderRegistryCommandResult> => {
      if (command.kind === "check-provider-latest-version") {
        return {
          kind: "provider-latest-version",
          instanceId: command.instanceId,
          latestVersion: "2.1.314",
        };
      }
      if (command.kind === "update-provider-cli") {
        return {
          kind: "provider-cli-updated",
          instanceId: command.instanceId,
          status: "updated",
          previousVersion: "2.1.300",
          currentVersion: "2.1.314",
        };
      }
      throw new Error(`Unexpected provider command ${command.kind}`);
    },
  );
  const memberInstall = vi.fn(
    async (command: MemberInstallCommand): Promise<MemberInstallResult> => {
      if (command.kind === "list-member-computers") {
        return {
          kind: "member-computers",
          members: [
            {
              serverId: SERVER_ID,
              target: "linux-x64",
              artifactVersion: "0.1.0",
              listenAddress: "100.64.0.10",
              listenPort: 8443,
              memberId: MEMBER_ID,
            },
          ],
        };
      }
      if (command.kind === "prepare-member-update") {
        return {
          kind: "member-update-plan",
          plan: {
            planId: PLAN_ID,
            serverId: SERVER_ID,
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
        return {
          kind: "member-update-progress",
          progress: {
            updateId: UPDATE_ID,
            serverId: SERVER_ID,
            state: "updated",
            steps: [],
          },
        };
      }
      throw new Error(`Unexpected command ${command.kind}`);
    },
  );

  const localState: AppUpdateState = {
    status: "ready",
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
  };

  const sources: FleetUpdateSources = {
    localApp: {
      displayName: "This Mac",
      state: localState,
      downloadAppUpdate: vi.fn(async () => localState),
      installAppUpdate,
    },
    localProviderClient: {
      bootstrap: vi.fn(
        async () =>
          ({
            instances: [
              {
                id: LOCAL_CLAUDE_ID,
                driverKind: "claude",
                displayName: "Claude Code",
                enabled: true,
              },
            ],
            observedStates: [
              {
                instanceId: LOCAL_CLAUDE_ID,
                readiness: "ready",
                detectedVersion: "2.1.300",
              },
            ],
          }) as unknown as ProviderRegistrySnapshot,
      ),
      execute: providerExecute,
    },
    hostFederationLifecycle: {
      list: () => [
        {
          hostId: "offline-box" as HostId,
          kind: "remote",
          displayName: "Offline Box",
          origin: "https://100.64.0.99:8443",
          serverBuildVersion: "0.1.0",
          state: "unavailable",
          health: "unavailable",
          actions: { canReconnect: true, canRevoke: false, canRemove: true },
        },
      ],
    },
    shieldServersClient: {
      read: vi.fn(async () => ({
        servers: [
          {
            serverId: SERVER_ID,
            alias: "devbox01",
            user: "deploy",
            profile: "operate" as const,
            deployCommands: [],
          },
        ],
        sshAgent: "available" as const,
      })),
      memberInstall,
    },
    sleep: async () => undefined,
    pollMs: 0,
    ...overrides,
  };

  return { sources, installAppUpdate, memberInstall, providerExecute };
}

describe("FleetUpdateDialog", () => {
  it("lists connected machines, over-SSH headless servers, provider CLIs, and skip reasons without ever skipping for headless", async () => {
    const { sources } = makeSources();
    render(<FleetUpdateDialog onClose={vi.fn()} open sources={sources} />);

    const list = await screen.findByRole("list", { name: "Connected computers" });
    const rows = within(list).getAllByRole("listitem");
    const rowByName = (name: string) => {
      const match = rows.find((row) => within(row).queryByText(name) !== null);
      expect(match).toBeDefined();
      return match!;
    };

    const devboxRow = rowByName("devbox01");
    expect(within(devboxRow).getByText("Headless server")).toBeTruthy();
    expect(within(devboxRow).getByText("Octant 0.1.0 → 0.2.0")).toBeTruthy();
    expect(devboxRow).toHaveAttribute("data-disposition", "will-update");

    const localRow = rowByName("This Mac");
    expect(within(localRow).getByText("This app, restarts last")).toBeTruthy();
    expect(within(localRow).getByText("Octant 0.1.0 → 0.2.0")).toBeTruthy();
    expect(within(localRow).getByText(/Claude Code 2\.1\.300 → 2\.1\.314/)).toBeTruthy();

    const offlineRow = rowByName("Offline Box");
    expect(within(offlineRow).getByText("Skipped")).toBeTruthy();
    expect(within(offlineRow).getByText("This computer is offline.")).toBeTruthy();
    expect(within(offlineRow).queryByText("Headless server")).toBeNull();

    // Single drain choice reuses Wait up to N minutes / Stop now.
    expect(screen.getByRole("radio", { name: /Wait up to 10 minutes/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Stop now" })).toBeTruthy();
    // Headless is never presented as a skip reason.
    expect(within(devboxRow).queryByText("Skipped")).toBeNull();
    expect(offlineRow.textContent).not.toMatch(/headless/i);
  });

  it("defers only this local app when Later is clicked, still updating providers and over-SSH servers with the chosen drain", async () => {
    const { sources, installAppUpdate, memberInstall, providerExecute } = makeSources();
    render(<FleetUpdateDialog onClose={vi.fn()} open sources={sources} />);

    await screen.findByRole("list", { name: "Connected computers" });
    fireEvent.click(screen.getByRole("radio", { name: "Stop now" }));
    fireEvent.click(screen.getByRole("button", { name: "Later" }));

    await waitFor(() => expect(screen.getByText(/This app's restart was deferred/)).toBeTruthy());
    expect(providerExecute).toHaveBeenCalledWith({
      kind: "update-provider-cli",
      instanceId: LOCAL_CLAUDE_ID,
    });
    expect(memberInstall).toHaveBeenCalledWith({
      kind: "confirm-member-update",
      planId: PLAN_ID,
      drain: { kind: "stop-now" },
    });
    expect(installAppUpdate).not.toHaveBeenCalled();
  });
});
