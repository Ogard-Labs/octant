import { askRemoteSessionStanding, createRemoteProductFetch } from "@octant/client-runtime";
import type { HostFederationLifecycle } from "@octant/client-runtime/host-federation-lifecycle";
import type { HostFederationTransports } from "@octant/client-runtime/host-federation-transports";
import {
  createProviderClient,
  ProviderClientFailure,
  type ProviderClient,
} from "@octant/client-runtime/provider-client";
import type { ShieldServersClient } from "@octant/client-runtime/shield-servers-client";
import { LOCAL_HOST_ID, type ProviderInstanceId } from "@octant/contracts";
import type { AppUpdateState } from "@octant/contracts/app-updates";
import type { ProviderRegistrySnapshot } from "@octant/contracts/providers";
import type {
  MemberBuildDownload,
  MemberComputer,
  MemberUpdateDrain,
  MemberUpdateFailure,
  MemberUpdatePlan,
  MemberUpdateProgress,
  ShieldServer,
} from "@octant/contracts/shield-servers";
import {
  isNewerProviderRelease,
  providerLatestVersionNpmPackage,
  supportsProviderCliUpdate,
} from "@octant/domain";
import {
  resolveProviderCliChannelTimeout,
  type FleetUpdateHostInventory,
  type FleetUpdateOctantInventory,
  type FleetUpdatePlan,
  type FleetUpdateProviderInventoryItem,
  type FleetUpdateStep,
} from "@octant/domain/fleet-update-policy";
import type { AppUpdateInstallOutcome } from "../shell/hostBridge";

const REMOTE_CLIENT_BASE_URL = "http://127.0.0.1";
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_LOCAL_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_DOWNLOAD_POLLS = 900;
const MAX_UPDATE_POLLS = 1_200;

export interface FleetUpdateLocalAppSource {
  readonly displayName: string;
  readonly state: AppUpdateState | undefined;
  readonly checkForAppUpdate?: (() => Promise<AppUpdateState>) | undefined;
  readonly downloadAppUpdate?: (() => Promise<AppUpdateState>) | undefined;
  readonly subscribeAppUpdateState?:
    | ((listener: (state: AppUpdateState) => void) => () => void)
    | undefined;
  readonly installAppUpdate?: (() => Promise<AppUpdateInstallOutcome>) | undefined;
  /** Test seam for waiting on native updater staging. Defaults to 10 minutes. */
  readonly localDownloadTimeoutMs?: number | undefined;
}

export interface FleetUpdateSources {
  readonly localApp: FleetUpdateLocalAppSource;
  readonly localProviderClient?: Pick<ProviderClient, "bootstrap" | "execute"> | undefined;
  readonly localProviderSnapshot?: ProviderRegistrySnapshot | undefined;
  readonly localLatestVersions?: ReadonlyMap<ProviderInstanceId, string> | undefined;
  readonly hostFederationLifecycle?: Pick<HostFederationLifecycle, "list"> | undefined;
  readonly hostFederationTransports?:
    | Pick<HostFederationTransports, "get" | "remoteTransportFor">
    | undefined;
  readonly shieldServersClient?: Pick<ShieldServersClient, "read" | "memberInstall"> | undefined;
  /** Test seam for polling waits. Defaults to `setTimeout`. */
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  /** Test seam for poll interval. Defaults to 1 s. */
  readonly pollMs?: number | undefined;
}

export interface FleetUpdateInventorySnapshot {
  readonly hosts: ReadonlyArray<FleetUpdateHostInventory>;
  readonly remoteProviderClients: ReadonlyMap<
    string,
    Pick<ProviderClient, "bootstrap" | "execute">
  >;
  readonly sshServersById: ReadonlyMap<string, ShieldServer>;
}

export type FleetUpdateStepStatus =
  | "waiting"
  | "running"
  | "succeeded"
  | "failed"
  | "held"
  | "waiting-for-work";

export interface FleetUpdateStepState {
  readonly step: FleetUpdateStep;
  readonly status: FleetUpdateStepStatus;
  readonly message?: string;
  readonly retryable?: boolean;
}

export const SSH_ROLLBACK_REASONS: Readonly<Record<MemberUpdateFailure, string>> = {
  "server-unreachable": "the server could not be reached",
  "digest-mismatch": "the copy did not match the build checked here",
  "build-mismatch": "what arrived was not the build checked here",
  "command-failed": "the update did not apply",
  "timed-out": "a step did not finish in time",
  "recovery-required": "its store needs restoring",
  "rollback-unsafe": "its store was migrated",
  "health-check-failed": "it did not pass its health check",
  "hello-unproven": "its hello was not signed by its own key",
  "version-mismatch": "its hello named another version",
  "protocol-not-covered": "its protocol range does not cover this computer",
};

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function originForMember(member: MemberComputer): string {
  const host =
    member.listenAddress.includes(":") && !member.listenAddress.startsWith("[")
      ? `[${member.listenAddress}]`
      : member.listenAddress;
  return `https://${host}:${member.listenPort}`;
}

async function readProvidersInventory(input: {
  readonly client: Pick<ProviderClient, "bootstrap" | "execute">;
  readonly snapshot?: ProviderRegistrySnapshot | undefined;
  readonly cachedLatest?: ReadonlyMap<ProviderInstanceId, string> | undefined;
}): Promise<ReadonlyArray<FleetUpdateProviderInventoryItem>> {
  let snapshot = input.snapshot;
  if (snapshot === undefined) {
    try {
      snapshot = await input.client.bootstrap();
    } catch {
      return [];
    }
  }
  const observedById = new Map(
    snapshot.observedStates.map((state) => [String(state.instanceId), state]),
  );
  const latestById = new Map<string, string>();
  if (input.cachedLatest !== undefined) {
    for (const [id, version] of input.cachedLatest) {
      latestById.set(String(id), version);
    }
  }

  const checkTargets = snapshot.instances.filter(
    (instance) =>
      instance.enabled &&
      providerLatestVersionNpmPackage(instance.driverKind) !== undefined &&
      !latestById.has(String(instance.id)),
  );
  await Promise.allSettled(
    checkTargets.map(async (instance) => {
      const result = await input.client.execute({
        kind: "check-provider-latest-version",
        instanceId: instance.id,
      });
      if (result.kind === "provider-latest-version" && result.latestVersion !== undefined) {
        latestById.set(String(instance.id), result.latestVersion);
      }
    }),
  );

  return snapshot.instances
    .filter((instance) => instance.enabled && supportsProviderCliUpdate(instance.driverKind))
    .map((instance) => {
      const currentVersion = observedById.get(String(instance.id))?.detectedVersion;
      const latestVersion = latestById.get(String(instance.id));
      const outdated =
        currentVersion !== undefined &&
        latestVersion !== undefined &&
        isNewerProviderRelease(latestVersion, currentVersion);
      return {
        instanceId: String(instance.id),
        displayName: instance.displayName,
        driverKind: instance.driverKind,
        ...(currentVersion === undefined ? {} : { currentVersion }),
        ...(latestVersion === undefined ? {} : { latestVersion }),
        supportsCliUpdate: true,
        outdated,
      };
    });
}

async function waitForMemberBuildDownload(input: {
  readonly client: Pick<ShieldServersClient, "memberInstall">;
  readonly initial: MemberBuildDownload;
  readonly signal?: AbortSignal | undefined;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollMs: number;
}): Promise<MemberBuildDownload> {
  let download = input.initial;
  for (let attempt = 0; attempt < MAX_DOWNLOAD_POLLS; attempt += 1) {
    if (download.state === "ready" || download.state === "refused") return download;
    if (input.signal?.aborted) {
      await input.client
        .memberInstall({ kind: "leave-member-build-download", downloadId: download.downloadId })
        .catch(() => undefined);
      return download;
    }
    try {
      await input.sleep(input.pollMs);
    } catch {
      await input.client
        .memberInstall({ kind: "leave-member-build-download", downloadId: download.downloadId })
        .catch(() => undefined);
      return download;
    }
    try {
      const next = await input.client.memberInstall(
        { kind: "read-member-build-download", downloadId: download.downloadId },
        input.signal,
      );
      if (next.kind === "member-build-download") {
        download = next.download;
      } else if (next.kind === "member-install-refused") {
        return {
          ...download,
          state: "refused",
          refusal: "unreachable",
          message: next.message,
        };
      }
    } catch {
      if (input.signal?.aborted) {
        await input.client
          .memberInstall({ kind: "leave-member-build-download", downloadId: download.downloadId })
          .catch(() => undefined);
        return download;
      }
    }
  }
  return {
    ...download,
    state: "refused",
    refusal: "unreachable",
    message: "Timed out waiting for the signed headless build download.",
  };
}

async function prepareSshMemberOctantInventory(input: {
  readonly client: Pick<ShieldServersClient, "memberInstall">;
  readonly member: MemberComputer;
  readonly server: ShieldServer | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollMs: number;
}): Promise<Extract<FleetUpdateOctantInventory, { readonly kind: "ssh-member" }>> {
  const alias = input.server?.alias ?? input.member.listenAddress;
  const base = {
    kind: "ssh-member" as const,
    serverId: String(input.member.serverId),
    alias,
    target: input.member.target,
    fromVersion: input.member.artifactVersion,
  };

  for (let pass = 0; pass < 2; pass += 1) {
    let result;
    try {
      result = await input.client.memberInstall(
        { kind: "prepare-member-update", serverId: input.member.serverId },
        input.signal,
      );
    } catch {
      return {
        ...base,
        state: "unavailable",
        message: "Octant could not read this server over SSH.",
      };
    }

    if (result.kind === "member-update-plan") {
      return sshInventoryFromPlan(result.plan);
    }
    if (result.kind === "member-build-download") {
      const settled = await waitForMemberBuildDownload({
        client: input.client,
        initial: result.download,
        signal: input.signal,
        sleep: input.sleep,
        pollMs: input.pollMs,
      });
      if (settled.state === "ready") continue;
      if (settled.refusal === "no-release") {
        return {
          ...base,
          ring: settled.ring,
          state: "ring-no-headless-build",
          ...(settled.message === undefined ? {} : { message: settled.message }),
        };
      }
      if (settled.refusal === "no-newer-release") {
        return { ...base, ring: settled.ring, state: "up-to-date" };
      }
      return {
        ...base,
        ring: settled.ring,
        state: "unavailable",
        ...(settled.message === undefined ? {} : { message: settled.message }),
      };
    }
    if (result.kind === "member-install-refused") {
      switch (result.reason) {
        case "no-newer-build":
          return { ...base, state: "up-to-date" };
        case "already-installing":
          return { ...base, state: "already-updating", message: result.message };
        case "not-the-person":
          return { ...base, state: "no-permission", message: result.message };
        case "server-unreachable":
          return { ...base, state: "offline", message: result.message };
        case "no-build":
          return { ...base, state: "ring-no-headless-build", message: result.message };
        default:
          return { ...base, state: "unavailable", message: result.message };
      }
    }
  }

  return {
    ...base,
    state: "unavailable",
    message: "Octant could not prepare the server update.",
  };
}

function sshInventoryFromPlan(
  plan: MemberUpdatePlan,
): Extract<FleetUpdateOctantInventory, { readonly kind: "ssh-member" }> {
  return {
    kind: "ssh-member",
    serverId: String(plan.serverId),
    alias: plan.alias,
    target: plan.target,
    fromVersion: plan.fromVersion,
    toVersion: plan.toVersion,
    ring: plan.ring,
    planId: String(plan.planId),
    storeMigration: plan.storeMigration,
    state: "update-available",
  };
}

/**
 * Collect the fleet update inventory across this computer, every connected
 * paired or hub computer, and every over-SSH headless server installed by this
 * hub. Each host is read independently so one unreachable host never blocks
 * another.
 */
export async function collectFleetUpdateInventory(
  sources: FleetUpdateSources,
  signal?: AbortSignal,
): Promise<FleetUpdateInventorySnapshot> {
  const pollMs = sources.pollMs ?? DEFAULT_POLL_MS;
  const sleep = sources.sleep ?? ((ms: number) => defaultSleep(ms, signal));
  const remoteProviderClients = new Map<string, Pick<ProviderClient, "bootstrap" | "execute">>();
  const sshServersById = new Map<string, ShieldServer>();

  // 1. Read local desktop update state (refreshing check if desktop bridge supports it).
  let localAppState = sources.localApp.state;
  if (
    sources.localApp.checkForAppUpdate !== undefined &&
    (localAppState === undefined ||
      localAppState.status === "idle" ||
      localAppState.status === "up-to-date" ||
      localAppState.status === "failed")
  ) {
    try {
      localAppState = await sources.localApp.checkForAppUpdate();
    } catch {
      // Keep the last observed app update state when the check fails.
    }
  }

  const localProvidersPromise =
    sources.localProviderClient === undefined
      ? Promise.resolve<ReadonlyArray<FleetUpdateProviderInventoryItem>>([])
      : readProvidersInventory({
          client: sources.localProviderClient,
          snapshot: sources.localProviderSnapshot,
          cachedLatest: sources.localLatestVersions,
        });

  // 2. Read over-SSH headless servers managed by this hub (Slice 2).
  const sshMembersPromise = (async (): Promise<
    ReadonlyArray<{
      readonly member: MemberComputer;
      readonly server: ShieldServer | undefined;
      readonly octant: Extract<FleetUpdateOctantInventory, { readonly kind: "ssh-member" }>;
    }>
  > => {
    const shieldClient = sources.shieldServersClient;
    if (shieldClient === undefined) return [];
    try {
      const [serversView, membersResult] = await Promise.all([
        shieldClient.read().catch(() => undefined),
        shieldClient.memberInstall({ kind: "list-member-computers" }, signal),
      ]);
      for (const server of serversView?.servers ?? []) {
        sshServersById.set(String(server.serverId), server);
      }
      if (membersResult.kind !== "member-computers") return [];
      const prepared = await Promise.all(
        membersResult.members.map(async (member) => {
          const server = sshServersById.get(String(member.serverId));
          const octant = await prepareSshMemberOctantInventory({
            client: shieldClient,
            member,
            server,
            signal,
            sleep,
            pollMs,
          });
          return { member, server, octant };
        }),
      );
      return prepared;
    } catch {
      return [];
    }
  })();

  const [localProviders, sshMembers] = await Promise.all([
    localProvidersPromise,
    sshMembersPromise,
  ]);

  const localOctant: FleetUpdateOctantInventory =
    sources.localApp.downloadAppUpdate === undefined ||
    sources.localApp.installAppUpdate === undefined
      ? {
          kind: "local-app",
          status: "unsupported",
          ...(localAppState?.currentVersion === undefined
            ? {}
            : { currentVersion: String(localAppState.currentVersion) }),
          message: "This copy of Octant is not the desktop app, so it does not update itself.",
        }
      : {
          kind: "local-app",
          status: localAppState?.status ?? "idle",
          ...(localAppState?.currentVersion === undefined
            ? {}
            : { currentVersion: String(localAppState.currentVersion) }),
          ...(localAppState?.available?.version === undefined
            ? {}
            : { availableVersion: String(localAppState.available.version) }),
          ...(localAppState?.ring === undefined ? {} : { ring: localAppState.ring }),
          ...(localAppState?.message === undefined ? {} : { message: localAppState.message }),
        };

  const localHost: FleetUpdateHostInventory = {
    hostId: String(LOCAL_HOST_ID),
    displayName: sources.localApp.displayName,
    kind: "local",
    isHeadless: false,
    connectionState: "ready",
    actsAsHostPerson: true,
    ...(localAppState?.currentVersion === undefined
      ? {}
      : { currentVersion: String(localAppState.currentVersion) }),
    octant: localOctant,
    providers: localProviders,
  };

  // 3. Read federated remote computers and merge with over-SSH members.
  const matchedSshServerIds = new Set<string>();
  const federatedRemotes = (sources.hostFederationLifecycle?.list() ?? []).filter(
    (snapshot) => snapshot.kind === "remote",
  );

  const remoteHosts = await Promise.all(
    federatedRemotes.map(async (snapshot): Promise<FleetUpdateHostInventory> => {
      const hostId = String(snapshot.hostId);
      const matchedSsh = sshMembers.find(
        ({ member }) =>
          (member.memberId !== undefined && String(member.memberId) === hostId) ||
          (snapshot.origin !== undefined && originForMember(member) === snapshot.origin),
      );
      if (matchedSsh !== undefined) {
        matchedSshServerIds.add(String(matchedSsh.member.serverId));
      }

      let actsAsHostPerson = false;
      let providers: ReadonlyArray<FleetUpdateProviderInventoryItem> = [];
      const slot = sources.hostFederationTransports?.get(hostId);
      const transport = sources.hostFederationTransports?.remoteTransportFor(hostId);

      if (
        snapshot.state === "ready" &&
        snapshot.through !== "hub" &&
        transport !== undefined &&
        slot?.bridge !== undefined
      ) {
        const { standing } = await askRemoteSessionStanding(transport);
        actsAsHostPerson = standing.actsAsHostPerson;
        if (actsAsHostPerson) {
          const remoteClient = createProviderClient({
            baseUrl: REMOTE_CLIENT_BASE_URL,
            fetch: createRemoteProductFetch({ bridge: slot.bridge }),
            windowCapability: "",
          });
          remoteProviderClients.set(hostId, remoteClient);
          providers = await readProvidersInventory({ client: remoteClient });
        }
      }

      const currentVersion =
        snapshot.serverBuildVersion ?? slot?.serverBuildVersion ?? matchedSsh?.octant.fromVersion;

      const octant: FleetUpdateOctantInventory =
        matchedSsh !== undefined
          ? matchedSsh.octant
          : {
              kind: "standalone-headless",
              ...(currentVersion === undefined ? {} : { currentVersion }),
            };

      return {
        hostId,
        displayName: snapshot.displayName,
        kind: "remote",
        ...(matchedSsh !== undefined ? { isHeadless: true } : {}),
        connectionState: snapshot.state,
        ...(snapshot.through === undefined ? {} : { through: snapshot.through }),
        actsAsHostPerson,
        ...(currentVersion === undefined ? {} : { currentVersion }),
        octant,
        providers,
      };
    }),
  );

  // 4. Add any over-SSH headless servers not already present in the federation list.
  const unmatchedSshHosts: FleetUpdateHostInventory[] = sshMembers
    .filter(({ member }) => !matchedSshServerIds.has(String(member.serverId)))
    .map(({ member, server, octant }) => ({
      hostId:
        member.memberId !== undefined ? String(member.memberId) : `ssh-server:${member.serverId}`,
      displayName: server?.alias ?? member.listenAddress,
      kind: "remote",
      isHeadless: true,
      through: "hub" as const,
      connectionState: octant.state === "offline" ? "unavailable" : "ready",
      actsAsHostPerson: false,
      currentVersion: octant.fromVersion,
      octant,
      providers: [],
    }));

  return {
    hosts: [...remoteHosts, ...unmatchedSshHosts, localHost],
    remoteProviderClients,
    sshServersById,
  };
}

async function runProviderCliStep(input: {
  readonly step: Extract<FleetUpdateStep, { readonly phase: "provider-cli" }>;
  readonly client: Pick<ProviderClient, "bootstrap" | "execute"> | undefined;
}): Promise<{ readonly status: "succeeded" | "failed"; readonly message: string }> {
  const { step, client } = input;
  if (client === undefined) {
    return {
      status: "failed",
      message: `Cannot reach ${step.hostDisplayName} to update ${step.providerDisplayName}.`,
    };
  }
  const instanceId = step.instanceId as ProviderInstanceId;
  try {
    const result = await client.execute({ kind: "update-provider-cli", instanceId });
    if (result.kind !== "provider-cli-updated") {
      return {
        status: "failed",
        message: `${step.providerDisplayName} returned an unexpected update result.`,
      };
    }
    if (result.status === "probe-failed") {
      return {
        status: "failed",
        message:
          result.message ??
          `${step.providerDisplayName} finished updating, but its readiness check failed.`,
      };
    }
    const version = result.currentVersion ?? step.toVersion;
    return {
      status: "succeeded",
      message:
        version === undefined
          ? `${step.providerDisplayName} updated.`
          : `${step.providerDisplayName} is now on ${version}.`,
    };
  } catch (error) {
    // If the paired channel timed out or dropped, re-read the observed version
    // instead of posting `update-provider-cli` again.
    const channelTimeout =
      !(error instanceof ProviderClientFailure) || error.category === "unavailable";
    if (channelTimeout) {
      try {
        const snapshot = await client.bootstrap();
        const observed = snapshot.observedStates.find(
          (item) => String(item.instanceId) === step.instanceId,
        )?.detectedVersion;
        const resolved = resolveProviderCliChannelTimeout({
          providerDisplayName: step.providerDisplayName,
          ...(step.fromVersion === undefined ? {} : { previousVersion: step.fromVersion }),
          ...(step.toVersion === undefined ? {} : { targetVersion: step.toVersion }),
          ...(observed === undefined ? {} : { observedVersion: observed }),
        });
        return {
          status: resolved.status === "observed-updated" ? "succeeded" : "failed",
          message: resolved.message,
        };
      } catch {
        return {
          status: "failed",
          message: `The connection timed out while updating ${step.providerDisplayName}.`,
        };
      }
    }
    return {
      status: "failed",
      message: error.message,
    };
  }
}

async function pollSshMemberUpdate(input: {
  readonly client: Pick<ShieldServersClient, "memberInstall">;
  readonly initial: MemberUpdateProgress;
  readonly alias: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollMs: number;
}): Promise<{ readonly status: "succeeded" | "failed"; readonly message: string }> {
  let progress = input.initial;
  for (let attempt = 0; attempt < MAX_UPDATE_POLLS; attempt += 1) {
    if (progress.state === "updated") {
      return { status: "succeeded", message: `${input.alias} runs Octant ${input.toVersion}.` };
    }
    if (progress.state === "rolled-back") {
      const reason =
        progress.rollbackReason === undefined
          ? "the update did not apply"
          : SSH_ROLLBACK_REASONS[progress.rollbackReason];
      return {
        status: "failed",
        message: `${input.alias} rolled back to ${input.fromVersion} because ${reason}.`,
      };
    }
    if (progress.state === "failed") {
      const failedStep = progress.steps.find((item) => item.state === "failed");
      return {
        status: "failed",
        message:
          failedStep?.message ??
          `${input.alias} could not finish updating and stayed on ${input.fromVersion}.`,
      };
    }
    await input.sleep(input.pollMs);
    try {
      const next = await input.client.memberInstall({
        kind: "read-member-update",
        updateId: progress.updateId,
      });
      if (next.kind === "member-update-progress") {
        progress = next.progress;
      } else if (next.kind === "member-install-refused") {
        return { status: "failed", message: next.message };
      }
    } catch {
      // Transient read error while the server restarts; keep polling.
    }
  }
  return {
    status: "failed",
    message: `Timed out waiting for ${input.alias} to confirm Octant ${input.toVersion}.`,
  };
}

async function runSshMemberStep(input: {
  readonly step: Extract<FleetUpdateStep, { readonly phase: "remote-octant-ssh" }>;
  readonly client: Pick<ShieldServersClient, "memberInstall"> | undefined;
  readonly drain: MemberUpdateDrain;
  readonly reprepareFirst: boolean;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollMs: number;
}): Promise<{ readonly status: "succeeded" | "failed"; readonly message: string }> {
  const { step, client, drain } = input;
  if (client === undefined) {
    return { status: "failed", message: "Server update control is unavailable on this computer." };
  }
  let planId = step.planId;
  const confirm = async (id: string) =>
    client.memberInstall({
      kind: "confirm-member-update",
      planId: id as MemberUpdatePlan["planId"],
      drain,
    });

  if (input.reprepareFirst) {
    let refreshed;
    try {
      refreshed = await client.memberInstall({
        kind: "prepare-member-update",
        serverId: step.serverId as MemberUpdatePlan["serverId"],
      });
    } catch {
      return { status: "failed", message: `Octant could not prepare an update for ${step.alias}.` };
    }
    if (refreshed.kind === "member-update-plan") {
      planId = String(refreshed.plan.planId);
    } else if (refreshed.kind === "member-install-refused") {
      return { status: "failed", message: refreshed.message };
    } else {
      return {
        status: "failed",
        message: `${step.alias} is not ready to retry yet. Open the dialog again to download its build.`,
      };
    }
  }

  let confirmed;
  try {
    confirmed = await confirm(planId);
  } catch {
    return { status: "failed", message: `Octant could not start updating ${step.alias}.` };
  }

  if (confirmed.kind === "member-install-refused" && confirmed.reason === "plan-expired") {
    let refreshed;
    try {
      refreshed = await client.memberInstall({
        kind: "prepare-member-update",
        serverId: step.serverId as MemberUpdatePlan["serverId"],
      });
    } catch {
      return {
        status: "failed",
        message: `Octant could not refresh the expired update plan for ${step.alias}.`,
      };
    }
    if (
      refreshed.kind === "member-update-plan" &&
      refreshed.plan.fromVersion === step.fromVersion &&
      refreshed.plan.toVersion === step.toVersion
    ) {
      try {
        confirmed = await confirm(String(refreshed.plan.planId));
      } catch {
        return { status: "failed", message: `Octant could not start updating ${step.alias}.` };
      }
    } else if (refreshed.kind === "member-install-refused") {
      return { status: "failed", message: refreshed.message };
    } else {
      return {
        status: "failed",
        message: `The update plan for ${step.alias} changed while waiting. Close and try again.`,
      };
    }
  }

  if (confirmed.kind === "member-install-refused") {
    return { status: "failed", message: confirmed.message };
  }
  if (confirmed.kind !== "member-update-progress") {
    return { status: "failed", message: `Octant could not start updating ${step.alias}.` };
  }
  return pollSshMemberUpdate({
    client,
    initial: confirmed.progress,
    alias: step.alias,
    fromVersion: step.fromVersion,
    toVersion: step.toVersion,
    sleep: input.sleep,
    pollMs: input.pollMs,
  });
}

async function waitForStagedLocalAppUpdate(
  localApp: FleetUpdateLocalAppSource,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> {
  if (localApp.downloadAppUpdate === undefined) {
    return { ok: false, message: "Octant could not download the app update." };
  }
  // Subscribe before kicking off the native download so a fast transition from
  // "downloading" to "ready" or "failed" cannot land in the gap between calls.
  let observedAfterStart: AppUpdateState | undefined;
  let sawDownloading = false;
  let resolveWait: ((state: AppUpdateState) => void) | undefined;
  let downloadStarted = false;
  const unsubscribe = localApp.subscribeAppUpdateState?.((next) => {
    if (!downloadStarted) return;
    if (next.status === "downloading") {
      sawDownloading = true;
      return;
    }
    if (
      sawDownloading ||
      next.status === "ready" ||
      next.status === "failed" ||
      next.status === "refused"
    ) {
      observedAfterStart = next;
      resolveWait?.(next);
    }
  });

  try {
    downloadStarted = true;
    const downloaded = await localApp.downloadAppUpdate();
    if (downloaded.status === "ready") {
      return { ok: true };
    }
    if (downloaded.status !== "downloading") {
      return {
        ok: false,
        message: downloaded.message ?? "Octant could not stage the app update.",
      };
    }
    sawDownloading = true;
    if (observedAfterStart !== undefined) {
      if (observedAfterStart.status === "ready") {
        return { ok: true };
      }
      return {
        ok: false,
        message: observedAfterStart.message ?? "Octant could not stage the app update.",
      };
    }
    if (unsubscribe === undefined) {
      return {
        ok: false,
        message: downloaded.message ?? "Octant could not stage the app update.",
      };
    }
    const timeoutMs = localApp.localDownloadTimeoutMs ?? DEFAULT_LOCAL_DOWNLOAD_TIMEOUT_MS;
    const settled = await new Promise<AppUpdateState | "timed-out">((resolve) => {
      const timer = setTimeout(() => {
        resolveWait = undefined;
        resolve("timed-out");
      }, timeoutMs);
      resolveWait = (next) => {
        clearTimeout(timer);
        resolveWait = undefined;
        resolve(next);
      };
    });
    if (settled === "timed-out") {
      return {
        ok: false,
        message: "The app update did not finish staging in time. Try again.",
      };
    }
    if (settled.status === "ready") {
      return { ok: true };
    }
    return {
      ok: false,
      message: settled.message ?? "Octant could not stage the app update.",
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Octant could not download the app update.",
    };
  } finally {
    resolveWait = undefined;
    unsubscribe?.();
  }
}

async function runLocalAppStep(input: {
  readonly step: Extract<FleetUpdateStep, { readonly phase: "local-app" }>;
  readonly localApp: FleetUpdateLocalAppSource;
}): Promise<{
  readonly status: "succeeded" | "failed" | "waiting-for-work";
  readonly message: string;
}> {
  const { step, localApp } = input;
  if (localApp.installAppUpdate === undefined) {
    return {
      status: "failed",
      message: "This copy of Octant does not update itself.",
    };
  }
  if (!step.readyToInstall) {
    const staged = await waitForStagedLocalAppUpdate(localApp);
    if (!staged.ok) {
      return { status: "failed", message: staged.message };
    }
  }
  try {
    const outcome = await localApp.installAppUpdate();
    switch (outcome.kind) {
      case "wait":
        return {
          status: "waiting-for-work",
          message:
            outcome.activeAgentCount > 0
              ? `Octant will not relaunch while ${outcome.activeAgentCount} ${outcome.activeAgentCount === 1 ? "agent is" : "agents are"} still working. Let the work finish or checkpoint it, then relaunch.`
              : "Octant could not check what is running, so it did not relaunch. Try again in a moment.",
        };
      case "installing":
        return {
          status: "succeeded",
          message:
            step.toVersion === undefined
              ? "Relaunching this app…"
              : `Relaunching this app to ${step.toVersion}…`,
        };
      case "not-ready":
        return {
          status: "failed",
          message: "The app update is not ready to install. Try again to stage and relaunch.",
        };
    }
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "Octant could not install the app update.",
    };
  }
}

export interface RunFleetUpdateInput {
  readonly plan: FleetUpdatePlan;
  readonly inventory: FleetUpdateInventorySnapshot;
  readonly sources: FleetUpdateSources;
  readonly drain: MemberUpdateDrain;
  readonly onStepStatesChange: (states: ReadonlyArray<FleetUpdateStepState>) => void;
}

/**
 * Execute the fleet update plan in strict phase order:
 * 1. Provider CLIs (per host, isolated so one host failing never stops another)
 * 2. Remote Octant servers over SSH (isolated per server)
 * 3. This local app last (held if a remote server failed so the person can
 *    review and retry instead of losing the dialog to an immediate relaunch)
 */
export async function runFleetUpdatePlan(
  input: RunFleetUpdateInput,
): Promise<ReadonlyArray<FleetUpdateStepState>> {
  const pollMs = input.sources.pollMs ?? DEFAULT_POLL_MS;
  const sleep = input.sources.sleep ?? ((ms: number) => defaultSleep(ms));
  const states: FleetUpdateStepState[] = input.plan.steps.map((step) => ({
    step,
    status: "waiting",
  }));
  const emit = () => input.onStepStatesChange([...states]);
  const updateState = (
    stepId: string,
    patch: Partial<Omit<FleetUpdateStepState, "step">>,
  ): void => {
    const index = states.findIndex((item) => item.step.stepId === stepId);
    if (index === -1) return;
    const current = states[index];
    if (current === undefined) return;
    states[index] = { ...current, ...patch };
    emit();
  };

  emit();

  // Phase 1: provider CLIs — hosts run concurrently; instances on one host run
  // sequentially so two instances sharing a binary never collide.
  const providerSteps = input.plan.steps.filter(
    (step): step is Extract<FleetUpdateStep, { readonly phase: "provider-cli" }> =>
      step.phase === "provider-cli",
  );
  const providersByHost = new Map<
    string,
    Array<Extract<FleetUpdateStep, { readonly phase: "provider-cli" }>>
  >();
  for (const step of providerSteps) {
    const list = providersByHost.get(step.hostId) ?? [];
    list.push(step);
    providersByHost.set(step.hostId, list);
  }
  await Promise.allSettled(
    Array.from(providersByHost.entries()).map(async ([hostId, hostSteps]) => {
      for (const step of hostSteps) {
        updateState(step.stepId, { status: "running" });
        const client =
          step.hostKind === "local"
            ? input.sources.localProviderClient
            : input.inventory.remoteProviderClients.get(hostId);
        let outcome: { readonly status: "succeeded" | "failed"; readonly message: string };
        try {
          outcome = await runProviderCliStep({ step, client });
        } catch (error) {
          outcome = {
            status: "failed",
            message:
              error instanceof Error
                ? error.message
                : `Octant could not update ${step.providerDisplayName} on ${step.hostDisplayName}.`,
          };
        }
        updateState(step.stepId, {
          status: outcome.status,
          message: outcome.message,
          retryable: outcome.status === "failed",
        });
      }
    }),
  );

  // Phase 2: remote Octant servers over SSH — run concurrently per server so
  // one server failing or rolling back never stops another.
  const sshSteps = input.plan.steps.filter(
    (step): step is Extract<FleetUpdateStep, { readonly phase: "remote-octant-ssh" }> =>
      step.phase === "remote-octant-ssh",
  );
  let anyRemoteServerFailed = false;
  await Promise.allSettled(
    sshSteps.map(async (step) => {
      updateState(step.stepId, { status: "running" });
      let outcome: { readonly status: "succeeded" | "failed"; readonly message: string };
      try {
        outcome = await runSshMemberStep({
          step,
          client: input.sources.shieldServersClient,
          drain: input.drain,
          reprepareFirst: false,
          sleep,
          pollMs,
        });
      } catch (error) {
        outcome = {
          status: "failed",
          message:
            error instanceof Error
              ? error.message
              : `Octant could not finish updating ${step.alias}.`,
        };
      }
      if (outcome.status === "failed") anyRemoteServerFailed = true;
      updateState(step.stepId, {
        status: outcome.status,
        message: outcome.message,
        retryable: outcome.status === "failed",
      });
    }),
  );

  // Phase 3: local app last.
  const localStep = input.plan.steps.find(
    (step): step is Extract<FleetUpdateStep, { readonly phase: "local-app" }> =>
      step.phase === "local-app",
  );
  if (localStep !== undefined) {
    if (anyRemoteServerFailed) {
      updateState(localStep.stepId, {
        status: "held",
        message:
          "Held while a remote server update failed. Retry the failed server or relaunch this app.",
        retryable: true,
      });
    } else {
      updateState(localStep.stepId, { status: "running" });
      const outcome = await runLocalAppStep({
        step: localStep,
        localApp: input.sources.localApp,
      });
      updateState(localStep.stepId, {
        status: outcome.status,
        message: outcome.message,
        retryable: outcome.status !== "succeeded",
      });
    }
  }

  return [...states];
}

/** Retry a single failed or held step without re-running steps that already succeeded. */
export async function retryFleetUpdateStep(input: {
  readonly step: FleetUpdateStep;
  readonly inventory: FleetUpdateInventorySnapshot;
  readonly sources: FleetUpdateSources;
  readonly drain: MemberUpdateDrain;
}): Promise<Omit<FleetUpdateStepState, "step">> {
  const pollMs = input.sources.pollMs ?? DEFAULT_POLL_MS;
  const sleep = input.sources.sleep ?? ((ms: number) => defaultSleep(ms));
  if (input.step.phase === "provider-cli") {
    const client =
      input.step.hostKind === "local"
        ? input.sources.localProviderClient
        : input.inventory.remoteProviderClients.get(input.step.hostId);
    const outcome = await runProviderCliStep({ step: input.step, client });
    return {
      status: outcome.status,
      message: outcome.message,
      retryable: outcome.status === "failed",
    };
  }
  if (input.step.phase === "remote-octant-ssh") {
    const outcome = await runSshMemberStep({
      step: input.step,
      client: input.sources.shieldServersClient,
      drain: input.drain,
      reprepareFirst: true,
      sleep,
      pollMs,
    });
    return {
      status: outcome.status,
      message: outcome.message,
      retryable: outcome.status === "failed",
    };
  }
  const outcome = await runLocalAppStep({
    step: input.step,
    localApp: input.sources.localApp,
  });
  return {
    status: outcome.status,
    message: outcome.message,
    retryable: outcome.status !== "succeeded",
  };
}
