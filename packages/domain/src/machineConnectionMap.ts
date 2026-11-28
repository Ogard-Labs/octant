import { classifyRemoteListenerAddress, remoteListenerOrigin } from "./remoteAccessPolicy";

export type MachineConnectionPath = "lan" | "tailscale" | "unknown";

export type MachineConnectionTrust = "paired" | "hub-introduced";

export type MachineConnectionRole = "hub" | "standby-hub" | "spoke" | "guest" | "standalone";

export type MachineConnectionStatus =
  | "this-computer"
  | "connected"
  | "connecting"
  | "waiting-confirmation"
  | "unconfirmed-here"
  | "offline";

export type MachineRegistryLifecycleState =
  | "ready"
  | "connecting"
  | "stale"
  | "incompatible"
  | "unauthorized"
  | "unavailable";

export interface MachineLocalInput {
  readonly hostId: string;
  readonly displayName: string;
  readonly role: "hub" | "spoke" | "standalone";
  readonly listenerOrigin?: string | undefined;
  /** This computer's member id on the hub roster, when it belongs to or acts as a hub. */
  readonly hubMemberId?: string | undefined;
  /** This window's own guest member id on the hub roster, excluded as a separate peer node. */
  readonly windowGuestMemberId?: string | undefined;
}

export interface MachineRegistryEntryInput {
  readonly hostId: string;
  readonly displayName: string;
  readonly origin?: string | undefined;
  readonly through?: "hub" | undefined;
  readonly role?: "hub" | undefined;
  readonly state: MachineRegistryLifecycleState;
}

export interface MachineRosterEntryInput {
  readonly memberId: string;
  readonly name: string;
  readonly role: "hub" | "standby-hub" | "spoke" | "guest";
  readonly addresses: ReadonlyArray<string>;
  readonly port?: number | undefined;
  /** False when this computer holds the member unconfirmed under Confirm new members. */
  readonly accepted?: boolean | undefined;
}

export interface MachineConnectionMapInput {
  readonly local: MachineLocalInput;
  readonly registry: ReadonlyArray<MachineRegistryEntryInput>;
  readonly roster: ReadonlyArray<MachineRosterEntryInput>;
  /** Roster member ids held on this computer awaiting local confirmation. */
  readonly heldMemberIds?: ReadonlyArray<string> | undefined;
  /** Roster member ids that refused this window with `guest-not-confirmed`. */
  readonly unconfirmedByMemberIds?: ReadonlyArray<string> | undefined;
}

export interface MachineConnectionNode {
  readonly id: string;
  readonly kind: "this-computer" | "remote";
  readonly displayName: string;
  readonly role: MachineConnectionRole;
  readonly origin?: string | undefined;
  readonly path: MachineConnectionPath;
  readonly pathLabel: string;
  readonly trust?: MachineConnectionTrust | undefined;
  readonly trustLabel?: string | undefined;
  readonly inHub: boolean;
  readonly status: MachineConnectionStatus;
  readonly statusLabel: string;
}

export interface DirectMachineConnectionEdge {
  readonly id: string;
  readonly kind: "direct";
  readonly fromId: string;
  readonly toId: string;
  readonly path: MachineConnectionPath;
  readonly pathLabel: string;
  readonly trust: MachineConnectionTrust;
  readonly trustLabel: string;
  readonly label: string;
  readonly status: Exclude<MachineConnectionStatus, "this-computer">;
  readonly statusLabel: string;
  readonly measured: true;
}

export interface HubRosterPeerEdge {
  readonly id: string;
  readonly kind: "hub-roster";
  readonly fromId: string;
  readonly toId: string;
  readonly label: "Both in the hub";
  /** Peer-to-peer reachability is not probed between two other computers. */
  readonly measured: false;
}

export type MachineConnectionEdge = DirectMachineConnectionEdge | HubRosterPeerEdge;

export interface MachineConnectionMap {
  readonly nodes: ReadonlyArray<MachineConnectionNode>;
  readonly edges: ReadonlyArray<MachineConnectionEdge>;
}

export type MachinePairLinkPlan =
  | {
      readonly kind: "already-paired";
      readonly action: "none";
      readonly fromId: string;
      readonly toId: string;
      readonly fromName: string;
      readonly toName: string;
      readonly summary: string;
    }
  | {
      readonly kind: "pair-directly";
      readonly action: "pair-directly";
      readonly fromId: string;
      readonly toId: string;
      readonly fromName: string;
      readonly toName: string;
      readonly targetNodeId: string;
      readonly targetName: string;
      readonly summary: string;
    }
  | {
      readonly kind: "join-hub";
      readonly action: "join-hub";
      readonly fromId: string;
      readonly toId: string;
      readonly fromName: string;
      readonly toName: string;
      readonly targetNodeId: string;
      readonly targetName: string;
      readonly summary: string;
    }
  | {
      readonly kind: "both-in-hub";
      readonly action: "none";
      readonly fromId: string;
      readonly toId: string;
      readonly fromName: string;
      readonly toName: string;
      readonly summary: string;
    }
  | {
      readonly kind: "pair-on-other-computer";
      readonly action: "none";
      readonly fromId: string;
      readonly toId: string;
      readonly fromName: string;
      readonly toName: string;
      readonly summary: string;
    }
  | {
      readonly kind: "cannot-link-guest";
      readonly action: "none";
      readonly fromId: string;
      readonly toId: string;
      readonly fromName: string;
      readonly toName: string;
      readonly summary: string;
    };

function extractHostname(originOrAddress: string): string {
  const trimmed = originOrAddress.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.includes("://")) {
    try {
      const parsed = new URL(trimmed);
      return parsed.hostname.replace(/^\[(.*)\]$/, "$1");
    } catch {
      return "";
    }
  }
  return trimmed.replace(/^\[(.*)\]$/, "$1");
}

/**
 * Classifies how this window reaches a machine from its listener origin or address.
 * Distinguishes Tailscale vs private LAN; the hub is never a transport path.
 */
export function classifyMachineConnectionPath(
  originOrAddress: string | undefined,
): MachineConnectionPath {
  if (originOrAddress === undefined) return "unknown";
  const hostname = extractHostname(originOrAddress);
  if (hostname.length === 0) return "unknown";
  const addressClass = classifyRemoteListenerAddress(hostname);
  if (addressClass === "tailscale") return "tailscale";
  if (addressClass === "lan-private") return "lan";
  return "unknown";
}

export function machineConnectionPathLabel(path: MachineConnectionPath): string {
  switch (path) {
    case "lan":
      return "LAN";
    case "tailscale":
      return "Tailscale";
    case "unknown":
      return "Unknown network";
  }
}

export function machineConnectionTrustLabel(trust: MachineConnectionTrust): string {
  return trust === "paired" ? "Paired by you" : "Introduced by the hub";
}

export function machineConnectionStatusLabel(status: MachineConnectionStatus): string {
  switch (status) {
    case "this-computer":
      return "This computer";
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "waiting-confirmation":
      return "Waiting for that computer to confirm you";
    case "unconfirmed-here":
      return "Unconfirmed member";
    case "offline":
      return "Not connected";
  }
}

export function formatDirectConnectionEdgeLabel(
  trust: MachineConnectionTrust,
  path: MachineConnectionPath,
): string {
  const why = machineConnectionTrustLabel(trust);
  return path === "unknown" ? why : `${why} · ${machineConnectionPathLabel(path)}`;
}

function originFromRoster(member: MachineRosterEntryInput): string | undefined {
  const preferred =
    member.addresses.find((address) => classifyMachineConnectionPath(address) === "tailscale") ??
    member.addresses.find((address) => classifyMachineConnectionPath(address) === "lan") ??
    member.addresses[0];
  if (preferred === undefined || preferred.trim().length === 0) return undefined;
  return member.port !== undefined
    ? remoteListenerOrigin(preferred.trim(), member.port)
    : preferred.trim();
}

function statusFromRegistry(
  state: MachineRegistryLifecycleState,
): Exclude<MachineConnectionStatus, "this-computer"> {
  if (state === "ready") return "connected";
  if (state === "connecting") return "connecting";
  return "offline";
}

/**
 * Derives the connections map from this computer, this window's federation
 * registry, and the hub roster. Nothing is probed or persisted: direct edges
 * carry both transport path (LAN or Tailscale) and trust reason ("Paired by
 * you" or "Introduced by the hub"); edges between two other hub members are
 * drawn strictly as "Both in the hub" and never as measured connections.
 */
export function buildMachineConnectionMap(input: MachineConnectionMapInput): MachineConnectionMap {
  const heldSet = new Set(input.heldMemberIds ?? []);
  const unconfirmedBySet = new Set(input.unconfirmedByMemberIds ?? []);
  const localPath = classifyMachineConnectionPath(input.local.listenerOrigin);
  const localNode: MachineConnectionNode = {
    id: input.local.hostId,
    kind: "this-computer",
    displayName: input.local.displayName,
    role: input.local.role,
    ...(input.local.listenerOrigin === undefined ? {} : { origin: input.local.listenerOrigin }),
    path: localPath,
    pathLabel: machineConnectionPathLabel(localPath),
    inHub: input.local.role === "hub" || input.local.role === "spoke",
    status: "this-computer",
    statusLabel: machineConnectionStatusLabel("this-computer"),
  };

  const registryById = new Map<string, MachineRegistryEntryInput>();
  for (const entry of input.registry) {
    if (entry.hostId === input.local.hostId || entry.hostId === input.local.hubMemberId) continue;
    registryById.set(entry.hostId, entry);
  }

  const rosterById = new Map<string, MachineRosterEntryInput>();
  for (const member of input.roster) {
    if (
      member.memberId === input.local.hostId ||
      member.memberId === input.local.hubMemberId ||
      member.memberId === input.local.windowGuestMemberId
    ) {
      continue;
    }
    rosterById.set(member.memberId, member);
  }

  const remoteIds = new Set<string>([...registryById.keys(), ...rosterById.keys()]);
  const remoteNodes: MachineConnectionNode[] = [];
  const edges: MachineConnectionEdge[] = [];

  for (const id of remoteIds) {
    const registered = registryById.get(id);
    const rostered = rosterById.get(id);
    const displayName = registered?.displayName ?? rostered?.name ?? id;
    const trust: MachineConnectionTrust =
      registered !== undefined && registered.through !== "hub" ? "paired" : "hub-introduced";
    const origin =
      registered?.origin ?? (rostered === undefined ? undefined : originFromRoster(rostered));
    const path = classifyMachineConnectionPath(origin);
    const inHub = rostered !== undefined || registered?.through === "hub";
    const role: MachineConnectionRole =
      rostered?.role ?? (registered?.role === "hub" ? "hub" : inHub ? "spoke" : "standalone");

    let status: Exclude<MachineConnectionStatus, "this-computer">;
    if (trust === "hub-introduced" && unconfirmedBySet.has(id)) {
      status = "waiting-confirmation";
    } else if (heldSet.has(id) || rostered?.accepted === false) {
      status = "unconfirmed-here";
    } else if (registered !== undefined) {
      status = statusFromRegistry(registered.state);
    } else {
      status = "offline";
    }

    const trustLabel = machineConnectionTrustLabel(trust);
    const pathLabel = machineConnectionPathLabel(path);
    const statusLabel = machineConnectionStatusLabel(status);

    remoteNodes.push({
      id,
      kind: "remote",
      displayName,
      role,
      ...(origin === undefined ? {} : { origin }),
      path,
      pathLabel,
      trust,
      trustLabel,
      inHub,
      status,
      statusLabel,
    });

    edges.push({
      id: `direct:${localNode.id}:${id}`,
      kind: "direct",
      fromId: localNode.id,
      toId: id,
      path,
      pathLabel,
      trust,
      trustLabel,
      label: formatDirectConnectionEdgeLabel(trust, path),
      status,
      statusLabel,
      measured: true,
    });
  }

  remoteNodes.sort((left, right) => left.displayName.localeCompare(right.displayName));

  const hubComputerNodes = remoteNodes.filter((node) => node.inHub && node.role !== "guest");
  for (let i = 0; i < hubComputerNodes.length; i += 1) {
    const left = hubComputerNodes[i];
    if (left === undefined) continue;
    for (let j = i + 1; j < hubComputerNodes.length; j += 1) {
      const right = hubComputerNodes[j];
      if (right === undefined) continue;
      edges.push({
        id: `hub-roster:${left.id}:${right.id}`,
        kind: "hub-roster",
        fromId: left.id,
        toId: right.id,
        label: "Both in the hub",
        measured: false,
      });
    }
  }

  return {
    nodes: [localNode, ...remoteNodes],
    edges,
  };
}

/**
 * Plans what linking two machines from the map can start.
 * Only pairs with this computer at one end can start a pairing or hub join-code
 * flow; linking two other computers never triggers a remote join.
 */
export function planMachinePairLink(
  from: MachineConnectionNode,
  to: MachineConnectionNode,
): MachinePairLinkPlan {
  if (from.kind === "this-computer" || to.kind === "this-computer") {
    const local = from.kind === "this-computer" ? from : to;
    const remote = from.kind === "this-computer" ? to : from;

    if (remote.role === "guest") {
      return {
        kind: "cannot-link-guest",
        action: "none",
        fromId: from.id,
        toId: to.id,
        fromName: from.displayName,
        toName: to.displayName,
        summary: `${remote.displayName} is a guest device and does not accept direct computer pairing.`,
      };
    }

    if (remote.trust === "paired") {
      if (local.role === "hub" && !remote.inHub) {
        return {
          kind: "join-hub",
          action: "join-hub",
          fromId: from.id,
          toId: to.id,
          fromName: from.displayName,
          toName: to.displayName,
          targetNodeId: remote.id,
          targetName: remote.displayName,
          summary: `Make a hub join code on ${local.displayName}, then paste it on ${remote.displayName} to join this hub.`,
        };
      }
      return {
        kind: "already-paired",
        action: "none",
        fromId: from.id,
        toId: to.id,
        fromName: from.displayName,
        toName: to.displayName,
        summary: `${local.displayName} is already paired directly with ${remote.displayName}.`,
      };
    }

    return {
      kind: "pair-directly",
      action: "pair-directly",
      fromId: from.id,
      toId: to.id,
      fromName: from.displayName,
      toName: to.displayName,
      targetNodeId: remote.id,
      targetName: remote.displayName,
      summary: `Pair ${local.displayName} directly with ${remote.displayName} using its pairing code so you can reply and act there.`,
    };
  }

  if (from.role === "guest" || to.role === "guest") {
    return {
      kind: "cannot-link-guest",
      action: "none",
      fromId: from.id,
      toId: to.id,
      fromName: from.displayName,
      toName: to.displayName,
      summary: `Guest devices connect from the device itself; ${from.displayName} and ${to.displayName} cannot be linked remotely.`,
    };
  }

  if (from.inHub && to.inHub) {
    return {
      kind: "both-in-hub",
      action: "none",
      fromId: from.id,
      toId: to.id,
      fromName: from.displayName,
      toName: to.displayName,
      summary: `${from.displayName} and ${to.displayName} are both in the hub. Open Settings → Remote access on one of them to pair directly or change its local grants.`,
    };
  }

  return {
    kind: "pair-on-other-computer",
    action: "none",
    fromId: from.id,
    toId: to.id,
    fromName: from.displayName,
    toName: to.displayName,
    summary: `Only a computer itself joins a hub or pairs directly. Open Settings → Remote access on ${from.displayName} or ${to.displayName} to link them.`,
  };
}

/**
 * Lists, per unique pair among the selected machines, the flow linking them would start.
 */
export function planSelectedMachinesLinks(
  nodes: ReadonlyArray<MachineConnectionNode>,
  selectedIds: ReadonlyArray<string>,
): ReadonlyArray<MachinePairLinkPlan> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const uniqueSelected: MachineConnectionNode[] = [];
  const seen = new Set<string>();
  for (const id of selectedIds) {
    if (seen.has(id)) continue;
    const node = byId.get(id);
    if (node === undefined) continue;
    seen.add(id);
    uniqueSelected.push(node);
  }
  const plans: MachinePairLinkPlan[] = [];
  for (let i = 0; i < uniqueSelected.length; i += 1) {
    const left = uniqueSelected[i];
    if (left === undefined) continue;
    for (let j = i + 1; j < uniqueSelected.length; j += 1) {
      const right = uniqueSelected[j];
      if (right === undefined) continue;
      plans.push(planMachinePairLink(left, right));
    }
  }
  return plans;
}
