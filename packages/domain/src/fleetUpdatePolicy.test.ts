import { describe, expect, it } from "vitest";
import {
  FLEET_UPDATE_SKIP_REASONS,
  fleetUpdateSkipMessage,
  planFleetUpdate,
  resolveProviderCliChannelTimeout,
  type FleetUpdateHostInventory,
} from "./fleetUpdatePolicy";

function localHost(overrides: Partial<FleetUpdateHostInventory> = {}): FleetUpdateHostInventory {
  return {
    hostId: "local",
    displayName: "This Mac",
    kind: "local",
    connectionState: "ready",
    actsAsHostPerson: true,
    currentVersion: "0.1.0",
    octant: {
      kind: "local-app",
      status: "available",
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      ring: "stable",
    },
    providers: [
      {
        instanceId: "p-local-claude",
        displayName: "Claude Code",
        driverKind: "claude",
        currentVersion: "2.1.300",
        latestVersion: "2.1.314",
        supportsCliUpdate: true,
        outdated: true,
      },
    ],
    ...overrides,
  };
}

function sshHeadlessHost(
  overrides: Partial<FleetUpdateHostInventory> = {},
): FleetUpdateHostInventory {
  return {
    hostId: "member-devbox",
    displayName: "devbox01",
    kind: "remote",
    isHeadless: true,
    connectionState: "ready",
    through: "hub",
    actsAsHostPerson: false,
    currentVersion: "0.1.0",
    octant: {
      kind: "ssh-member",
      serverId: "srv-1",
      alias: "devbox01",
      target: "linux-x64",
      fromVersion: "0.1.0",
      toVersion: "0.2.0",
      ring: "stable",
      planId: "plan-1",
      storeMigration: false,
      state: "update-available",
    },
    providers: [],
    ...overrides,
  };
}

describe("fleetUpdatePolicy", () => {
  it("never lists headless as a skip reason and includes over-SSH headless servers in the run", () => {
    expect(FLEET_UPDATE_SKIP_REASONS).not.toContain("headless");
    for (const reason of FLEET_UPDATE_SKIP_REASONS) {
      expect(fleetUpdateSkipMessage(reason).toLowerCase()).not.toContain("because it is headless");
      expect(fleetUpdateSkipMessage(reason).toLowerCase()).not.toContain("headless server");
    }

    const plan = planFleetUpdate([localHost(), sshHeadlessHost()]);
    const devbox = plan.machines.find((machine) => machine.hostId === "member-devbox");
    expect(devbox).toMatchObject({
      disposition: "will-update",
      isHeadless: true,
      octantAction: "remote-octant-ssh",
      currentVersion: "0.1.0",
      targetOctantVersion: "0.2.0",
    });
    expect(devbox?.skipReason).toBeUndefined();
    expect(plan.hasRemoteServerUpdates).toBe(true);
  });

  it("orders execution as provider CLIs first, then remote Octant servers, then this local app last", () => {
    const pairedRemote: FleetUpdateHostInventory = {
      hostId: "remote-studio",
      displayName: "Studio Mac",
      kind: "remote",
      connectionState: "ready",
      actsAsHostPerson: true,
      currentVersion: "0.1.0",
      octant: { kind: "remote-desktop", currentVersion: "0.1.0" },
      providers: [
        {
          instanceId: "p-remote-codex",
          displayName: "Codex",
          driverKind: "codex",
          currentVersion: "0.25.0",
          latestVersion: "0.26.0",
          supportsCliUpdate: true,
          outdated: true,
        },
      ],
    };

    const plan = planFleetUpdate([localHost(), pairedRemote, sshHeadlessHost()]);

    expect(plan.steps.map((step) => `${step.phase}:${step.hostId}`)).toEqual([
      "provider-cli:remote-studio",
      "provider-cli:local",
      "remote-octant-ssh:member-devbox",
      "local-app:local",
    ]);
    // Local app is displayed last and marked as restarting last.
    expect(plan.machines.at(-1)).toMatchObject({
      hostId: "local",
      restartsLast: true,
      octantAction: "local-app",
    });
    // The paired remote desktop updates its outdated provider CLI while noting
    // that its desktop app itself is updated on that machine.
    const studio = plan.machines.find((machine) => machine.hostId === "remote-studio");
    expect(studio?.disposition).toBe("will-update");
    expect(studio?.octantNote).toBe("Update on that machine.");
  });

  it("defers only this local app when Later is chosen, while still running providers and remote servers", () => {
    const plan = planFleetUpdate([localHost(), sshHeadlessHost()], { deferLocalApp: true });

    expect(plan.hasLocalAppUpdate).toBe(true);
    expect(plan.steps.map((step) => `${step.phase}:${step.hostId}`)).toEqual([
      "provider-cli:local",
      "remote-octant-ssh:member-devbox",
    ]);
    expect(plan.steps.some((step) => step.phase === "local-app")).toBe(false);
    const local = plan.machines.find((machine) => machine.hostId === "local");
    expect(local?.octantAction).toBe("deferred");
    expect(local?.restartsLast).toBe(false);
    // Local machine still has a provider CLI update to run.
    expect(local?.disposition).toBe("will-update");

    // When local has no outdated providers and Later is chosen, it shows deferred-local-app.
    const localOnlyDeferred = planFleetUpdate([localHost({ providers: [] })], {
      deferLocalApp: true,
    });
    expect(localOnlyDeferred.steps).toEqual([]);
    expect(localOnlyDeferred.machines[0]?.disposition).toBe("deferred-local-app");
  });

  it("records each concrete skip reason honestly without ever skipping for being headless", () => {
    const hosts: ReadonlyArray<FleetUpdateHostInventory> = [
      {
        hostId: "h-offline",
        displayName: "Offline Box",
        kind: "remote",
        connectionState: "unavailable",
        actsAsHostPerson: true,
        octant: { kind: "standalone-headless", currentVersion: "0.1.0" },
        providers: [],
      },
      {
        hostId: "h-connecting",
        displayName: "Connecting Box",
        kind: "remote",
        connectionState: "connecting",
        actsAsHostPerson: true,
        octant: { kind: "standalone-headless" },
        providers: [],
      },
      {
        hostId: "h-no-perm",
        displayName: "Read-Only Paired",
        kind: "remote",
        connectionState: "ready",
        actsAsHostPerson: false,
        octant: { kind: "standalone-headless", currentVersion: "0.1.0" },
        providers: [],
      },
      {
        hostId: "h-hub-guest",
        displayName: "Hub Member",
        kind: "remote",
        connectionState: "ready",
        through: "hub",
        actsAsHostPerson: false,
        octant: { kind: "standalone-headless", currentVersion: "0.1.0" },
        providers: [],
      },
      {
        hostId: "h-preview-ring",
        displayName: "Preview Server",
        kind: "remote",
        isHeadless: true,
        connectionState: "ready",
        actsAsHostPerson: true,
        octant: {
          kind: "ssh-member",
          serverId: "srv-preview",
          alias: "preview-srv",
          target: "linux-x64",
          fromVersion: "0.1.0",
          ring: "preview",
          state: "ring-no-headless-build",
        },
        providers: [],
      },
      {
        hostId: "h-desktop",
        displayName: "Second Mac",
        kind: "remote",
        connectionState: "ready",
        actsAsHostPerson: true,
        octant: { kind: "remote-desktop", currentVersion: "0.1.0" },
        providers: [],
      },
      {
        hostId: "h-manual",
        displayName: "Older Host",
        kind: "remote",
        isHeadless: true,
        connectionState: "ready",
        actsAsHostPerson: true,
        octant: { kind: "standalone-headless", currentVersion: "0.0.9", ring: "stable" },
        providers: [],
      },
      {
        hostId: "h-incompatible",
        displayName: "Protocol Mismatch",
        kind: "remote",
        connectionState: "incompatible",
        actsAsHostPerson: true,
        octant: { kind: "standalone-headless" },
        providers: [],
      },
      {
        hostId: "h-busy",
        displayName: "Busy Host",
        kind: "remote",
        connectionState: "ready",
        actsAsHostPerson: true,
        alreadyUpdating: true,
        octant: { kind: "standalone-headless", currentVersion: "0.1.0" },
        providers: [],
      },
    ];

    const plan = planFleetUpdate(hosts);
    const byId = new Map(plan.machines.map((machine) => [machine.hostId, machine]));

    expect(byId.get("h-offline")?.skipReason).toBe("offline");
    expect(byId.get("h-connecting")?.skipReason).toBe("connecting");
    expect(byId.get("h-no-perm")?.skipReason).toBe("no-permission");
    expect(byId.get("h-hub-guest")?.skipReason).toBe("pair-to-update");
    expect(byId.get("h-hub-guest")?.skipMessage).toBe("Pair this computer to update it.");
    expect(byId.get("h-preview-ring")?.skipReason).toBe("ring-no-headless-build");
    expect(byId.get("h-desktop")?.skipReason).toBe("remote-desktop-not-yet-supported");
    expect(byId.get("h-desktop")?.skipMessage).toBe("Update on that machine.");
    expect(byId.get("h-manual")?.skipReason).toBe("manual-update-required");
    expect(byId.get("h-manual")?.skipMessage).toBe(
      "Update this computer once by hand, then it can update from here.",
    );
    expect(byId.get("h-incompatible")?.skipReason).toBe("incompatible");
    expect(byId.get("h-busy")?.skipReason).toBe("already-updating");
    expect(plan.skippedMachineCount).toBe(hosts.length);
  });

  it("confirms a timed-out provider CLI update from the re-read version instead of re-posting", () => {
    expect(
      resolveProviderCliChannelTimeout({
        providerDisplayName: "Claude Code",
        previousVersion: "2.1.300",
        targetVersion: "2.1.314",
        observedVersion: "2.1.314",
      }),
    ).toEqual({
      status: "observed-updated",
      currentVersion: "2.1.314",
      message: "Claude Code is now on 2.1.314.",
    });

    expect(
      resolveProviderCliChannelTimeout({
        providerDisplayName: "Claude Code",
        previousVersion: "2.1.300",
        targetVersion: "2.1.314",
        observedVersion: "2.1.300",
      }),
    ).toMatchObject({
      status: "unconfirmed",
      currentVersion: "2.1.300",
    });
  });
});
