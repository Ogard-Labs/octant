import type { AppReleaseRing } from "@octant/contracts/app-updates";
import { isNewerProviderRelease } from "./providerPolicy";

/**
 * Pure inventory, skip-reason, and execution-order policy for updating Octant
 * and provider CLIs across connected computers from one confirmation.
 *
 * A connected headless server is never skipped merely because it has no
 * desktop app: every skip reason below names a concrete connectivity,
 * permission, ring, or install-path fact.
 */

export const FLEET_UPDATE_SKIP_REASONS = [
  "offline",
  "connecting",
  "no-permission",
  "pair-to-update",
  "ring-no-headless-build",
  "remote-desktop-not-yet-supported",
  "manual-update-required",
  "incompatible",
  "already-updating",
] as const;

export type FleetUpdateSkipReason = (typeof FLEET_UPDATE_SKIP_REASONS)[number];

const SKIP_MESSAGES: Readonly<Record<FleetUpdateSkipReason, string>> = {
  offline: "This computer is offline.",
  connecting: "Still connecting to this computer.",
  "no-permission": "This device does not have permission to update this computer.",
  "pair-to-update": "Pair this computer to update it.",
  "ring-no-headless-build": "Its release ring publishes no headless build.",
  "remote-desktop-not-yet-supported": "Update on that machine.",
  "manual-update-required": "Update this computer once by hand, then it can update from here.",
  incompatible: "This computer's protocol range does not cover this app.",
  "already-updating": "An update is already running on this computer.",
};

export function fleetUpdateSkipMessage(reason: FleetUpdateSkipReason): string {
  return SKIP_MESSAGES[reason];
}

export type FleetUpdateHostConnectionState =
  | "ready"
  | "connecting"
  | "stale"
  | "incompatible"
  | "unauthorized"
  | "unavailable";

export interface FleetUpdateProviderInventoryItem {
  readonly instanceId: string;
  readonly displayName: string;
  readonly driverKind: string;
  readonly currentVersion?: string;
  readonly latestVersion?: string;
  readonly supportsCliUpdate: boolean;
  readonly outdated: boolean;
}

export type FleetUpdateOctantInventory =
  | {
      readonly kind: "local-app";
      readonly status:
        | "idle"
        | "checking"
        | "up-to-date"
        | "available"
        | "downloading"
        | "ready"
        | "refused"
        | "failed"
        | "unsupported";
      readonly currentVersion?: string;
      readonly availableVersion?: string;
      readonly ring?: AppReleaseRing;
      readonly message?: string;
    }
  | {
      readonly kind: "ssh-member";
      readonly serverId: string;
      readonly alias: string;
      readonly target: string;
      readonly fromVersion: string;
      readonly toVersion?: string;
      readonly ring?: AppReleaseRing;
      readonly planId?: string;
      readonly storeMigration?: boolean;
      readonly state:
        | "update-available"
        | "up-to-date"
        | "ring-no-headless-build"
        | "already-updating"
        | "offline"
        | "no-permission"
        | "unavailable";
      readonly message?: string;
    }
  | {
      readonly kind: "remote-desktop";
      readonly currentVersion?: string;
      readonly availableVersion?: string;
      readonly ring?: AppReleaseRing;
      readonly requestId?: string;
      readonly state?:
        | "update-available"
        | "up-to-date"
        | "already-updating"
        | "manual-update-required"
        | "offline"
        | "no-permission"
        | "unavailable";
      readonly message?: string;
    }
  | {
      readonly kind: "standalone-headless";
      readonly currentVersion?: string;
      readonly toVersion?: string;
      readonly ring?: AppReleaseRing;
      readonly requestId?: string;
      readonly storeMigration?: boolean;
      readonly state?:
        | "update-available"
        | "up-to-date"
        | "ring-no-headless-build"
        | "already-updating"
        | "manual-update-required"
        | "offline"
        | "no-permission"
        | "unavailable";
      readonly message?: string;
    }
  | {
      readonly kind: "none";
      readonly currentVersion?: string;
    };

export interface FleetUpdateHostInventory {
  readonly hostId: string;
  readonly displayName: string;
  readonly kind: "local" | "remote";
  readonly isHeadless?: boolean;
  readonly connectionState: FleetUpdateHostConnectionState;
  readonly through?: "hub";
  /** True for the local desktop host, or a remote host whose own person paired this device at Full. */
  readonly actsAsHostPerson: boolean;
  readonly currentVersion?: string;
  readonly octant: FleetUpdateOctantInventory;
  readonly providers: ReadonlyArray<FleetUpdateProviderInventoryItem>;
  readonly alreadyUpdating?: boolean;
}

export type FleetUpdateStep =
  | {
      readonly phase: "provider-cli";
      readonly stepId: string;
      readonly hostId: string;
      readonly hostDisplayName: string;
      readonly hostKind: "local" | "remote";
      readonly instanceId: string;
      readonly providerDisplayName: string;
      readonly fromVersion?: string;
      readonly toVersion?: string;
    }
  | {
      readonly phase: "remote-octant-ssh";
      readonly stepId: string;
      readonly hostId: string;
      readonly hostDisplayName: string;
      readonly serverId: string;
      readonly alias: string;
      readonly target: string;
      readonly planId: string;
      readonly fromVersion: string;
      readonly toVersion: string;
      readonly storeMigration: boolean;
    }
  | {
      readonly phase: "remote-octant-host-control";
      readonly stepId: string;
      readonly hostId: string;
      readonly hostDisplayName: string;
      readonly remoteHostKind: "headless" | "desktop";
      readonly requestId: string;
      readonly fromVersion: string;
      readonly toVersion: string;
      readonly storeMigration: boolean;
    }
  | {
      readonly phase: "local-app";
      readonly stepId: string;
      readonly hostId: string;
      readonly hostDisplayName: string;
      readonly fromVersion: string;
      readonly toVersion?: string;
      readonly readyToInstall: boolean;
    };

export type FleetUpdateMachineDisposition =
  | "will-update"
  | "up-to-date"
  | "deferred-local-app"
  | "skipped";

export interface FleetUpdateMachinePlan {
  readonly hostId: string;
  readonly displayName: string;
  readonly kind: "local" | "remote";
  readonly isHeadless: boolean;
  readonly currentVersion?: string;
  readonly targetOctantVersion?: string;
  readonly disposition: FleetUpdateMachineDisposition;
  /** Whole-machine skip reason when nothing on this machine can run. */
  readonly skipReason?: FleetUpdateSkipReason;
  readonly skipMessage?: string;
  /** Note when Octant itself cannot update here even though provider CLIs can (or vice versa). */
  readonly octantNote?: string;
  readonly providerNote?: string;
  readonly providers: ReadonlyArray<FleetUpdateProviderInventoryItem>;
  readonly outdatedProviders: ReadonlyArray<FleetUpdateProviderInventoryItem>;
  readonly octantAction:
    | "local-app"
    | "remote-octant-ssh"
    | "remote-octant-host-control"
    | "up-to-date"
    | "deferred"
    | "skipped"
    | "none";
  readonly restartsLast: boolean;
}

export interface FleetUpdatePlan {
  readonly machines: ReadonlyArray<FleetUpdateMachinePlan>;
  readonly steps: ReadonlyArray<FleetUpdateStep>;
  readonly hasRemoteServerUpdates: boolean;
  readonly hasLocalAppUpdate: boolean;
  readonly actionableMachineCount: number;
  readonly skippedMachineCount: number;
}

export interface PlanFleetUpdateOptions {
  /** When true, "Later" defers only this local app; provider CLIs and remote servers still run. */
  readonly deferLocalApp?: boolean;
}

function connectionSkipReason(
  state: FleetUpdateHostConnectionState,
): FleetUpdateSkipReason | undefined {
  switch (state) {
    case "ready":
      return undefined;
    case "connecting":
      return "connecting";
    case "incompatible":
      return "incompatible";
    case "unauthorized":
      return "no-permission";
    case "stale":
    case "unavailable":
      return "offline";
  }
}

function octantSkipForHost(
  host: FleetUpdateHostInventory,
): { readonly reason: FleetUpdateSkipReason; readonly message: string } | undefined {
  if (host.octant.kind === "ssh-member") {
    switch (host.octant.state) {
      case "ring-no-headless-build":
        return {
          reason: "ring-no-headless-build",
          message: host.octant.message ?? fleetUpdateSkipMessage("ring-no-headless-build"),
        };
      case "already-updating":
        return {
          reason: "already-updating",
          message: host.octant.message ?? fleetUpdateSkipMessage("already-updating"),
        };
      case "offline":
        return {
          reason: "offline",
          message: host.octant.message ?? fleetUpdateSkipMessage("offline"),
        };
      case "no-permission":
        return {
          reason: "no-permission",
          message: host.octant.message ?? fleetUpdateSkipMessage("no-permission"),
        };
      case "unavailable":
        return {
          reason: "offline",
          message: host.octant.message ?? fleetUpdateSkipMessage("offline"),
        };
      case "update-available":
      case "up-to-date":
        return undefined;
    }
  }
  if (host.octant.kind === "remote-desktop") {
    switch (host.octant.state) {
      case "update-available":
      case "up-to-date":
        return undefined;
      case "already-updating":
        return {
          reason: "already-updating",
          message: host.octant.message ?? fleetUpdateSkipMessage("already-updating"),
        };
      case "manual-update-required":
        return {
          reason: "manual-update-required",
          message: host.octant.message ?? fleetUpdateSkipMessage("manual-update-required"),
        };
      case "no-permission":
        return {
          reason: "no-permission",
          message: host.octant.message ?? fleetUpdateSkipMessage("no-permission"),
        };
      case "offline":
      case "unavailable":
        return {
          reason: "offline",
          message: host.octant.message ?? fleetUpdateSkipMessage("offline"),
        };
      case undefined:
        return {
          reason: "remote-desktop-not-yet-supported",
          message:
            host.octant.message ?? fleetUpdateSkipMessage("remote-desktop-not-yet-supported"),
        };
    }
  }
  if (host.octant.kind === "standalone-headless") {
    switch (host.octant.state) {
      case "update-available":
      case "up-to-date":
        return undefined;
      case "ring-no-headless-build":
        return {
          reason: "ring-no-headless-build",
          message: host.octant.message ?? fleetUpdateSkipMessage("ring-no-headless-build"),
        };
      case "already-updating":
        return {
          reason: "already-updating",
          message: host.octant.message ?? fleetUpdateSkipMessage("already-updating"),
        };
      case "no-permission":
        return {
          reason: "no-permission",
          message: host.octant.message ?? fleetUpdateSkipMessage("no-permission"),
        };
      case "offline":
      case "unavailable":
        return {
          reason: "offline",
          message: host.octant.message ?? fleetUpdateSkipMessage("offline"),
        };
      case "manual-update-required":
      case undefined: {
        const reason: FleetUpdateSkipReason =
          host.octant.ring === "preview" ? "ring-no-headless-build" : "manual-update-required";
        return { reason, message: host.octant.message ?? fleetUpdateSkipMessage(reason) };
      }
    }
  }
  return undefined;
}

/**
 * Build the fleet update confirmation view and deterministic execution plan.
 *
 * Order is strictly:
 * 1. Outdated provider CLIs (existing `update-provider-cli` per host/instance)
 * 2. Remote Octant server updates (over-SSH headless servers via hub upkeep)
 * 3. This local app last (omitted when `deferLocalApp` is true)
 *
 * Machines are ordered with remote computers first and this local app last so
 * the list reflects execution order and keeps "This app, restarts last" at the end.
 */
export function planFleetUpdate(
  inventory: ReadonlyArray<FleetUpdateHostInventory>,
  options: PlanFleetUpdateOptions = {},
): FleetUpdatePlan {
  const deferLocalApp = options.deferLocalApp === true;
  // Remote machines first, local app last.
  const orderedHosts = [
    ...inventory.filter((host) => host.kind === "remote"),
    ...inventory.filter((host) => host.kind === "local"),
  ];

  const machines: FleetUpdateMachinePlan[] = [];
  const providerSteps: Array<Extract<FleetUpdateStep, { readonly phase: "provider-cli" }>> = [];
  const remoteServerSteps: Array<
    Extract<FleetUpdateStep, { readonly phase: "remote-octant-ssh" | "remote-octant-host-control" }>
  > = [];
  const localAppSteps: Array<Extract<FleetUpdateStep, { readonly phase: "local-app" }>> = [];

  let hasLocalAppUpdate = false;

  for (const host of orderedHosts) {
    const isHeadless =
      host.isHeadless ??
      (host.octant.kind === "ssh-member" || host.octant.kind === "standalone-headless");
    const currentVersion =
      host.currentVersion ??
      (host.octant.kind === "ssh-member" ? host.octant.fromVersion : host.octant.currentVersion);

    if (host.alreadyUpdating === true) {
      machines.push({
        hostId: host.hostId,
        displayName: host.displayName,
        kind: host.kind,
        isHeadless,
        ...(currentVersion === undefined ? {} : { currentVersion }),
        disposition: "skipped",
        skipReason: "already-updating",
        skipMessage: fleetUpdateSkipMessage("already-updating"),
        providers: host.providers,
        outdatedProviders: [],
        octantAction: "skipped",
        restartsLast: false,
      });
      continue;
    }

    // Over-SSH headless servers are updated by this hub over SSH even when the
    // federated connection is absent or introduced through the hub roster.
    const isSshMember = host.octant.kind === "ssh-member";
    const connSkip =
      host.kind === "remote" ? connectionSkipReason(host.connectionState) : undefined;

    if (host.kind === "remote" && !isSshMember) {
      const wholeSkip: FleetUpdateSkipReason | undefined =
        connSkip ??
        (host.through === "hub"
          ? "pair-to-update"
          : !host.actsAsHostPerson
            ? "no-permission"
            : undefined);
      if (wholeSkip !== undefined) {
        machines.push({
          hostId: host.hostId,
          displayName: host.displayName,
          kind: host.kind,
          isHeadless,
          ...(currentVersion === undefined ? {} : { currentVersion }),
          disposition: "skipped",
          skipReason: wholeSkip,
          skipMessage: fleetUpdateSkipMessage(wholeSkip),
          providers: host.providers,
          outdatedProviders: [],
          octantAction: "skipped",
          restartsLast: false,
        });
        continue;
      }
    }

    const canUpdateProviders =
      host.kind === "local" ||
      (connSkip === undefined && host.through !== "hub" && host.actsAsHostPerson);
    const outdatedProviders = canUpdateProviders
      ? host.providers.filter((provider) => provider.supportsCliUpdate && provider.outdated)
      : [];
    const providerNote =
      !canUpdateProviders && isSshMember
        ? host.through === "hub"
          ? "Pair this computer directly to update its provider CLIs."
          : connSkip !== undefined
            ? undefined
            : !host.actsAsHostPerson
              ? "This device does not have permission to update provider CLIs on this computer."
              : undefined
        : undefined;

    for (const provider of outdatedProviders) {
      providerSteps.push({
        phase: "provider-cli",
        stepId: `provider:${host.hostId}:${provider.instanceId}`,
        hostId: host.hostId,
        hostDisplayName: host.displayName,
        hostKind: host.kind,
        instanceId: provider.instanceId,
        providerDisplayName: provider.displayName,
        ...(provider.currentVersion === undefined ? {} : { fromVersion: provider.currentVersion }),
        ...(provider.latestVersion === undefined ? {} : { toVersion: provider.latestVersion }),
      });
    }

    let octantAction: FleetUpdateMachinePlan["octantAction"] = "none";
    let targetOctantVersion: string | undefined;
    let octantNote: string | undefined;
    let octantSkipReason: FleetUpdateSkipReason | undefined;
    let restartsLast = false;

    if (host.octant.kind === "local-app") {
      const localUpdatable = host.octant.status === "available" || host.octant.status === "ready";
      if (localUpdatable) {
        hasLocalAppUpdate = true;
        targetOctantVersion = host.octant.availableVersion;
        if (deferLocalApp) {
          octantAction = "deferred";
          octantNote = "Deferred — restart this app later from Settings › Updates.";
        } else {
          octantAction = "local-app";
          restartsLast = true;
          localAppSteps.push({
            phase: "local-app",
            stepId: `local-app:${host.hostId}`,
            hostId: host.hostId,
            hostDisplayName: host.displayName,
            fromVersion: host.octant.currentVersion ?? currentVersion ?? "current",
            ...(host.octant.availableVersion === undefined
              ? {}
              : { toVersion: host.octant.availableVersion }),
            readyToInstall: host.octant.status === "ready",
          });
        }
      } else if (host.octant.status === "up-to-date") {
        octantAction = "up-to-date";
      } else if (host.octant.status === "unsupported") {
        octantAction = "none";
        octantNote =
          host.octant.message ?? "This copy is not the desktop app, so it does not update itself.";
      } else if (host.octant.status === "refused" || host.octant.status === "failed") {
        octantAction = "skipped";
        octantNote = host.octant.message;
      }
    } else if (host.octant.kind === "ssh-member") {
      if (
        host.octant.state === "update-available" &&
        host.octant.planId !== undefined &&
        host.octant.toVersion !== undefined
      ) {
        octantAction = "remote-octant-ssh";
        targetOctantVersion = host.octant.toVersion;
        remoteServerSteps.push({
          phase: "remote-octant-ssh",
          stepId: `ssh-member:${host.octant.serverId}`,
          hostId: host.hostId,
          hostDisplayName: host.displayName,
          serverId: host.octant.serverId,
          alias: host.octant.alias,
          target: host.octant.target,
          planId: host.octant.planId,
          fromVersion: host.octant.fromVersion,
          toVersion: host.octant.toVersion,
          storeMigration: host.octant.storeMigration === true,
        });
      } else if (host.octant.state === "up-to-date") {
        octantAction = "up-to-date";
      } else {
        const skipped = octantSkipForHost(host);
        octantAction = "skipped";
        octantSkipReason = skipped?.reason;
        octantNote = skipped?.message;
      }
    } else if (host.octant.kind === "standalone-headless") {
      if (
        host.octant.state === "update-available" &&
        host.octant.requestId !== undefined &&
        host.octant.toVersion !== undefined
      ) {
        octantAction = "remote-octant-host-control";
        targetOctantVersion = host.octant.toVersion;
        remoteServerSteps.push({
          phase: "remote-octant-host-control",
          stepId: `host-control:${host.hostId}`,
          hostId: host.hostId,
          hostDisplayName: host.displayName,
          remoteHostKind: "headless",
          requestId: host.octant.requestId,
          fromVersion: host.octant.currentVersion ?? currentVersion ?? "current",
          toVersion: host.octant.toVersion,
          storeMigration: host.octant.storeMigration === true,
        });
      } else if (host.octant.state === "up-to-date") {
        octantAction = "up-to-date";
      } else {
        const skipped = octantSkipForHost(host);
        octantAction = "skipped";
        octantSkipReason = skipped?.reason;
        octantNote = skipped?.message;
      }
    } else if (host.octant.kind === "remote-desktop") {
      if (
        host.octant.state === "update-available" &&
        host.octant.requestId !== undefined &&
        host.octant.availableVersion !== undefined
      ) {
        octantAction = "remote-octant-host-control";
        targetOctantVersion = host.octant.availableVersion;
        remoteServerSteps.push({
          phase: "remote-octant-host-control",
          stepId: `host-control:${host.hostId}`,
          hostId: host.hostId,
          hostDisplayName: host.displayName,
          remoteHostKind: "desktop",
          requestId: host.octant.requestId,
          fromVersion: host.octant.currentVersion ?? currentVersion ?? "current",
          toVersion: host.octant.availableVersion,
          storeMigration: false,
        });
      } else if (host.octant.state === "up-to-date") {
        octantAction = "up-to-date";
      } else {
        const skipped = octantSkipForHost(host);
        octantAction = "skipped";
        octantSkipReason = skipped?.reason;
        octantNote = skipped?.message;
      }
    } else {
      const skipped = octantSkipForHost(host);
      if (skipped !== undefined) {
        octantAction = "skipped";
        octantSkipReason = skipped.reason;
        octantNote = skipped.message;
      }
    }

    const hasMachineWork =
      outdatedProviders.length > 0 ||
      octantAction === "local-app" ||
      octantAction === "remote-octant-ssh" ||
      octantAction === "remote-octant-host-control";

    let disposition: FleetUpdateMachineDisposition;
    let skipReason: FleetUpdateSkipReason | undefined;
    let skipMessage: string | undefined;

    if (hasMachineWork) {
      disposition = "will-update";
    } else if (octantAction === "deferred") {
      disposition = "deferred-local-app";
    } else if (octantAction === "skipped" && octantSkipReason !== undefined) {
      disposition = "skipped";
      skipReason = octantSkipReason;
      skipMessage = octantNote ?? fleetUpdateSkipMessage(octantSkipReason);
    } else {
      disposition = "up-to-date";
    }

    machines.push({
      hostId: host.hostId,
      displayName: host.displayName,
      kind: host.kind,
      isHeadless,
      ...(currentVersion === undefined ? {} : { currentVersion }),
      ...(targetOctantVersion === undefined ? {} : { targetOctantVersion }),
      disposition,
      ...(skipReason === undefined ? {} : { skipReason }),
      ...(skipMessage === undefined ? {} : { skipMessage }),
      ...(octantNote === undefined || disposition === "skipped" ? {} : { octantNote }),
      ...(providerNote === undefined ? {} : { providerNote }),
      providers: host.providers,
      outdatedProviders,
      octantAction,
      restartsLast,
    });
  }

  const steps: ReadonlyArray<FleetUpdateStep> = [
    ...providerSteps,
    ...remoteServerSteps,
    ...localAppSteps,
  ];
  const actionableMachineCount = machines.filter(
    (machine) => machine.disposition === "will-update",
  ).length;
  const skippedMachineCount = machines.filter(
    (machine) => machine.disposition === "skipped",
  ).length;

  return {
    machines,
    steps,
    hasRemoteServerUpdates: remoteServerSteps.length > 0,
    hasLocalAppUpdate,
    actionableMachineCount,
    skippedMachineCount,
  };
}

export type ProviderCliTimeoutResolution =
  | {
      readonly status: "observed-updated";
      readonly currentVersion: string;
      readonly message: string;
    }
  | {
      readonly status: "unconfirmed";
      readonly currentVersion?: string;
      readonly message: string;
    };

/**
 * When a remote provider CLI update times out on the channel, the client
 * re-reads the observed version instead of posting `update-provider-cli` again.
 * If the observed version moved forward (or reached the target), count it as updated.
 */
export function resolveProviderCliChannelTimeout(input: {
  readonly providerDisplayName: string;
  readonly previousVersion?: string;
  readonly targetVersion?: string;
  readonly observedVersion?: string;
}): ProviderCliTimeoutResolution {
  const { providerDisplayName, previousVersion, targetVersion, observedVersion } = input;
  if (observedVersion !== undefined) {
    const reachedTarget = targetVersion !== undefined && observedVersion === targetVersion;
    const movedForward =
      previousVersion !== undefined && isNewerProviderRelease(observedVersion, previousVersion);
    if (reachedTarget || movedForward) {
      return {
        status: "observed-updated",
        currentVersion: observedVersion,
        message: `${providerDisplayName} is now on ${observedVersion}.`,
      };
    }
    return {
      status: "unconfirmed",
      currentVersion: observedVersion,
      message: `The connection timed out while updating ${providerDisplayName}; observed version is still ${observedVersion}.`,
    };
  }
  return {
    status: "unconfirmed",
    message: `The connection timed out while updating ${providerDisplayName}. Check its status or retry.`,
  };
}
