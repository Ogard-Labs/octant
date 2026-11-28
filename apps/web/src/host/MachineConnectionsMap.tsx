import { LOCAL_HOST_ID } from "@octant/contracts/host";
import {
  buildMachineConnectionMap,
  planMachinePairLink,
  planSelectedMachinesLinks,
  type MachineConnectionMapInput,
  type MachineConnectionNode,
  type MachinePairLinkPlan,
  type MachineRosterEntryInput,
} from "@octant/domain";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { failureMessage } from "../lib/failureMessage";
import { SettingsFactList, SettingsSection, SettingsState } from "../settings/primitives";
import type { HubAdministrationBridge, PrivateListenerPublicStatus } from "../shell/hostBridge";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { PairingCodeQr } from "./PairingCodeQr";
import { useHostFederationStack } from "./useHostFederationLifecycle";
import "../styles/machine-connections-map.css";

interface HubRosterSnapshot {
  readonly localRole: "hub" | "spoke" | "standalone";
  readonly localHubMemberId?: string | undefined;
  readonly roster: ReadonlyArray<MachineRosterEntryInput>;
  readonly heldMemberIds: ReadonlyArray<string>;
}

const EMPTY_ROSTER: HubRosterSnapshot = {
  localRole: "standalone",
  roster: [],
  heldMemberIds: [],
};

const EMPTY_REFUSALS: ReadonlyArray<{ readonly memberId: string; readonly kind: string }> = [];

function field(record: unknown, key: string): unknown {
  return typeof record === "object" && record !== null && key in record
    ? (record as Record<string, unknown>)[key]
    : undefined;
}

function readRosterMembers(
  raw: unknown,
  acceptedIds: ReadonlySet<string> | undefined,
): ReadonlyArray<MachineRosterEntryInput> {
  if (!Array.isArray(raw)) return [];
  const members: MachineRosterEntryInput[] = [];
  for (const item of raw) {
    const memberId = field(item, "memberId");
    const name = field(item, "name");
    const role = field(item, "role");
    if (
      typeof memberId !== "string" ||
      typeof name !== "string" ||
      (role !== "hub" && role !== "standby-hub" && role !== "spoke" && role !== "guest")
    ) {
      continue;
    }
    const rawAddresses = field(item, "addresses");
    const addresses = Array.isArray(rawAddresses)
      ? rawAddresses.filter((address): address is string => typeof address === "string")
      : [];
    const port = field(item, "port");
    members.push({
      memberId,
      name,
      role,
      addresses,
      ...(typeof port === "number" ? { port } : {}),
      // On a spoke, `acceptedMemberIds` tracks peer grants only; the hub holds
      // its own hub grant and must not be marked as an unconfirmed peer.
      ...(acceptedIds === undefined || role === "hub"
        ? {}
        : { accepted: acceptedIds.has(memberId) }),
    });
  }
  return members;
}

function readHubRosterSnapshot(
  body: unknown,
  listenerHostname: string | null | undefined,
): HubRosterSnapshot {
  const hub = field(body, "hub");
  const spoke = field(body, "spoke");
  const hubEnabled = field(hub, "enabled") === true;
  if (hubEnabled) {
    const members = readRosterMembers(
      field(field(field(hub, "roster"), "roster"), "members"),
      undefined,
    );
    const self = members.find((member) => member.role === "hub");
    return {
      localRole: "hub",
      ...(self === undefined ? {} : { localHubMemberId: self.memberId }),
      roster: members,
      heldMemberIds: [],
    };
  }
  const membership = field(spoke, "membership");
  if (membership === "member") {
    const rawAccepted = field(spoke, "acceptedMemberIds");
    const accepted = Array.isArray(rawAccepted)
      ? new Set(rawAccepted.filter((id): id is string => typeof id === "string"))
      : undefined;
    const members = readRosterMembers(
      field(field(field(spoke, "roster"), "roster"), "members"),
      accepted,
    );
    const rawHeld = field(spoke, "heldMembers");
    const heldMemberIds = Array.isArray(rawHeld)
      ? rawHeld
          .map((entry) => field(entry, "memberId"))
          .filter((id): id is string => typeof id === "string")
      : [];
    const rawAwaiting = field(spoke, "awaitingConfirmation");
    if (Array.isArray(rawAwaiting)) {
      for (const id of rawAwaiting) {
        if (typeof id === "string" && !heldMemberIds.includes(id)) heldMemberIds.push(id);
      }
    }
    const normalizedHostname = listenerHostname?.trim().toLowerCase();
    const self =
      normalizedHostname === undefined || normalizedHostname.length === 0
        ? undefined
        : members.find((member) =>
            member.addresses.some((address) => address.trim().toLowerCase() === normalizedHostname),
          );
    return {
      localRole: "spoke",
      ...(self === undefined ? {} : { localHubMemberId: self.memberId }),
      roster: members,
      heldMemberIds,
    };
  }
  return EMPTY_ROSTER;
}

function roleLabel(role: MachineConnectionNode["role"]): string {
  switch (role) {
    case "hub":
      return "Hub";
    case "standby-hub":
      return "Standby hub";
    case "spoke":
      return "Spoke";
    case "guest":
      return "Guest";
    case "standalone":
      return "Computer";
  }
}

interface NodeCoordinate {
  readonly x: number;
  readonly y: number;
}

function layoutNodes(
  nodes: ReadonlyArray<MachineConnectionNode>,
): ReadonlyMap<string, NodeCoordinate> {
  const positions = new Map<string, NodeCoordinate>();
  const local = nodes.find((node) => node.kind === "this-computer");
  const remotes = nodes.filter((node) => node.kind === "remote");
  const centerX = 320;
  const centerY = 120;
  if (local !== undefined) {
    positions.set(local.id, { x: centerX, y: remotes.length === 0 ? centerY : 44 });
  }
  const spacing = remotes.length <= 1 ? 0 : 520 / (remotes.length - 1);
  remotes.forEach((node, index) => {
    const x = remotes.length === 1 ? centerX : 60 + index * spacing;
    const y = index % 2 === 0 ? 186 : 146;
    positions.set(node.id, { x, y });
  });
  return positions;
}

export interface MachineConnectionsMapProps {
  readonly listenerStatus?: PrivateListenerPublicStatus | undefined;
  readonly hub?: HubAdministrationBridge | undefined;
  /** Bumped when hub administration actions change roster/role state on this page. */
  readonly hubRevision?: number | undefined;
  /** Starts the existing direct pairing flow for a target computer. */
  readonly onStartDirectPairing?: (node: MachineConnectionNode) => void;
  /**
   * Optional explicit map input, used by tests and previews to render
   * deterministic LAN, Tailscale, introduced, held, and offline fixtures.
   */
  readonly fixture?: MachineConnectionMapInput | undefined;
}

interface MintedHubJoinCode {
  readonly targetName: string;
  readonly code: string;
  readonly expiresAt?: number | undefined;
}

/**
 * Visual map and keyboard-accessible list of this computer, paired computers,
 * and hub roster members in Settings › Remote access. Every direct edge shows
 * its transport path (LAN or Tailscale) separately from its trust reason
 * ("Paired by you" or "Introduced by the hub"). Peer edges between two other
 * hub members come strictly from the roster and are labelled "Both in the hub".
 * Dragging or multi-selecting starts only existing local pairing or hub
 * join-code flows and never performs a remote join.
 */
export function MachineConnectionsMap({
  listenerStatus,
  hub,
  hubRevision,
  onStartDirectPairing,
  fixture,
}: MachineConnectionsMapProps) {
  const federation = useHostFederationStack();
  const lifecycleHosts = useSyncExternalStore(
    (listener) => federation?.lifecycle.subscribe(listener) ?? (() => {}),
    () => federation?.lifecycle.list(),
    () => federation?.lifecycle.list(),
  );
  const windowRefusals = useSyncExternalStore(
    (listener) => federation?.hubWindowRefusals?.subscribe(listener) ?? (() => {}),
    () => federation?.hubWindowRefusals?.list() ?? EMPTY_REFUSALS,
    () => EMPTY_REFUSALS,
  );
  const [rosterSnapshot, setRosterSnapshot] = useState<HubRosterSnapshot>(EMPTY_ROSTER);
  const [selectedIds, setSelectedIds] = useState<ReadonlyArray<string>>([]);
  const [draggedId, setDraggedId] = useState<string | undefined>();
  const [dropTargetId, setDropTargetId] = useState<string | undefined>();
  const [activePlans, setActivePlans] = useState<ReadonlyArray<MachinePairLinkPlan>>([]);
  const [actionMessage, setActionMessage] = useState<string>();
  const [mintedJoinCode, setMintedJoinCode] = useState<MintedHubJoinCode>();
  const [busyJoinCode, setBusyJoinCode] = useState(false);

  const listenerHostname = listenerStatus?.hostname;
  useEffect(() => {
    if (fixture !== undefined || hub === undefined) return;
    let cancelled = false;
    void hub
      .hubAdministrationRequest("status")
      .then((reply) => {
        if (cancelled || reply.status !== 200) return;
        setRosterSnapshot(readHubRosterSnapshot(reply.body, listenerHostname));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [fixture, hub, hubRevision, listenerHostname]);

  const mapInput = useMemo<MachineConnectionMapInput>(() => {
    if (fixture !== undefined) return fixture;
    const localHost = lifecycleHosts?.find((host) => host.kind === "local");
    const remoteRegistry = (lifecycleHosts ?? [])
      .filter((host) => host.kind === "remote")
      .map((host) => ({
        hostId: String(host.hostId),
        displayName: host.displayName,
        ...(host.origin === undefined ? {} : { origin: host.origin }),
        ...(host.through === undefined ? {} : { through: host.through }),
        ...(host.role === undefined ? {} : { role: host.role }),
        state: host.state,
      }));
    const unconfirmedByMemberIds = windowRefusals
      .filter((entry) => entry.kind === "guest-not-confirmed")
      .map((entry) => entry.memberId);
    const windowGuestMemberId = federation?.hubWindowRefusals?.windowGuestMemberId();
    return {
      local: {
        hostId: String(localHost?.hostId ?? LOCAL_HOST_ID),
        displayName: localHost?.displayName ?? "This computer",
        role: rosterSnapshot.localRole,
        ...(listenerStatus?.origin === null || listenerStatus?.origin === undefined
          ? {}
          : { listenerOrigin: listenerStatus.origin }),
        ...(rosterSnapshot.localHubMemberId === undefined
          ? {}
          : { hubMemberId: rosterSnapshot.localHubMemberId }),
        ...(windowGuestMemberId === undefined ? {} : { windowGuestMemberId }),
      },
      registry: remoteRegistry,
      roster: rosterSnapshot.roster,
      heldMemberIds: rosterSnapshot.heldMemberIds,
      unconfirmedByMemberIds,
    };
  }, [federation, fixture, lifecycleHosts, listenerStatus?.origin, rosterSnapshot, windowRefusals]);

  const connectionMap = useMemo(() => buildMachineConnectionMap(mapInput), [mapInput]);
  const nodeById = useMemo(
    () => new Map(connectionMap.nodes.map((node) => [node.id, node])),
    [connectionMap.nodes],
  );
  const directEdgeByTarget = useMemo(
    () =>
      new Map(
        connectionMap.edges
          .filter((edge) => edge.kind === "direct")
          .map((edge) => [edge.toId, edge]),
      ),
    [connectionMap.edges],
  );
  const peerEdges = useMemo(
    () => connectionMap.edges.filter((edge) => edge.kind === "hub-roster"),
    [connectionMap.edges],
  );
  const coordinates = useMemo(() => layoutNodes(connectionMap.nodes), [connectionMap.nodes]);
  const localNode = connectionMap.nodes.find((node) => node.kind === "this-computer");

  const toggleSelected = useCallback((nodeId: string, checked: boolean) => {
    setSelectedIds((current) =>
      checked
        ? current.includes(nodeId)
          ? current
          : [...current, nodeId]
        : current.filter((id) => id !== nodeId),
    );
  }, []);

  const linkPair = useCallback(
    (sourceId: string, targetId: string) => {
      if (sourceId === targetId) return;
      const from = nodeById.get(sourceId);
      const to = nodeById.get(targetId);
      if (from === undefined || to === undefined) return;
      setActionMessage(undefined);
      setMintedJoinCode(undefined);
      setActivePlans([planMachinePairLink(from, to)]);
    },
    [nodeById],
  );

  const linkSelected = useCallback(() => {
    setActionMessage(undefined);
    setMintedJoinCode(undefined);
    setActivePlans(planSelectedMachinesLinks(connectionMap.nodes, selectedIds));
  }, [connectionMap.nodes, selectedIds]);

  const startJoinCode = useCallback(
    async (targetName: string) => {
      if (hub === undefined) {
        setActionMessage("Open Hub settings on this computer to make a join code.");
        return;
      }
      setBusyJoinCode(true);
      setActionMessage(undefined);
      setMintedJoinCode(undefined);
      try {
        const reply = await hub.hubAdministrationRequest("join-code", { owner: false });
        const status = field(reply.body, "status");
        const code = field(reply.body, "code");
        const expiresAt = field(reply.body, "expiresAt");
        if (reply.status === 200 && status === "minted" && typeof code === "string") {
          setMintedJoinCode({
            targetName,
            code,
            ...(typeof expiresAt === "number" ? { expiresAt } : {}),
          });
          return;
        }
        const message = field(reply.body, "message");
        setActionMessage(
          typeof message === "string" && message.length > 0
            ? message
            : "Octant could not make a hub join code.",
        );
      } catch (error) {
        setActionMessage(failureMessage(error, "Octant could not make a hub join code."));
      } finally {
        setBusyJoinCode(false);
      }
    },
    [hub],
  );

  const runPlanAction = useCallback(
    (plan: MachinePairLinkPlan) => {
      if (plan.action === "pair-directly") {
        const target = nodeById.get(plan.targetNodeId);
        if (target === undefined) return;
        if (onStartDirectPairing !== undefined) {
          onStartDirectPairing(target);
          setActionMessage(
            `Paste ${target.displayName}'s pairing code under Other computers to pair directly.`,
          );
        } else {
          setActionMessage(plan.summary);
        }
        return;
      }
      if (plan.action === "join-hub") {
        void startJoinCode(plan.targetName);
      }
    },
    [nodeById, onStartDirectPairing, startJoinCode],
  );

  return (
    <SettingsSection
      description="How this computer reaches each machine (LAN or Tailscale) and why it may connect. Drag between two machines or select several to start a local pairing or hub join-code flow."
      title="Connections map"
    >
      <div className="connections-map" data-setting-id="machine-connections-map">
        <div className="connections-map__toolbar">
          <p className="connections-map__hint">
            Drag one computer onto another, or select two or more and choose Link selected.
          </p>
          <div className="connections-map__actions">
            <OctantButton
              disabled={selectedIds.length < 2}
              onClick={linkSelected}
              size="sm"
              type="button"
              variant="secondary"
            >
              Link selected ({selectedIds.length})
            </OctantButton>
            {selectedIds.length > 0 ? (
              <OctantButton
                onClick={() => {
                  setSelectedIds([]);
                  setActivePlans([]);
                  setMintedJoinCode(undefined);
                  setActionMessage(undefined);
                }}
                size="sm"
                type="button"
                variant="secondary"
              >
                Clear selection
              </OctantButton>
            ) : null}
          </div>
        </div>

        <div
          aria-label="Machine connections diagram"
          className="connections-map__canvas"
          role="region"
        >
          <svg aria-hidden="true" className="connections-map__diagram" viewBox="0 0 640 224">
            {connectionMap.edges.map((edge) => {
              const from = coordinates.get(edge.fromId);
              const to = coordinates.get(edge.toId);
              if (from === undefined || to === undefined) return null;
              const midX = (from.x + to.x) / 2;
              const midY = (from.y + to.y) / 2 - 6;
              const className =
                edge.kind === "hub-roster"
                  ? "connections-map__edge-line connections-map__edge-line--unmeasured"
                  : edge.status === "connected"
                    ? "connections-map__edge-line connections-map__edge-line--connected"
                    : "connections-map__edge-line";
              return (
                <g key={edge.id}>
                  <line className={className} x1={from.x} x2={to.x} y1={from.y} y2={to.y} />
                  <text
                    className="connections-map__edge-text"
                    textAnchor="middle"
                    x={midX}
                    y={midY}
                  >
                    {edge.label}
                  </text>
                </g>
              );
            })}
            {connectionMap.nodes.map((node) => {
              const pos = coordinates.get(node.id);
              if (pos === undefined) return null;
              return (
                <g key={node.id}>
                  <circle
                    className={
                      node.kind === "this-computer"
                        ? "connections-map__node-svg connections-map__node-svg--local"
                        : "connections-map__node-svg"
                    }
                    cx={pos.x}
                    cy={pos.y}
                    r={14}
                  />
                  <text
                    className="connections-map__node-title-svg"
                    textAnchor="middle"
                    x={pos.x}
                    y={pos.y + 28}
                  >
                    {node.displayName}
                  </text>
                </g>
              );
            })}
          </svg>

          <div className="connections-map__nodes">
            {connectionMap.nodes.map((node) => {
              const edge = directEdgeByTarget.get(node.id);
              const selected = selectedIds.includes(node.id);
              return (
                <div
                  aria-label={`${node.displayName} map node`}
                  className="connections-map__node"
                  data-drop-target={dropTargetId === node.id ? "true" : "false"}
                  data-node-id={node.id}
                  data-selected={selected ? "true" : "false"}
                  draggable
                  key={node.id}
                  onDragEnd={() => {
                    setDraggedId(undefined);
                    setDropTargetId(undefined);
                  }}
                  onDragLeave={() => {
                    if (dropTargetId === node.id) setDropTargetId(undefined);
                  }}
                  onDragOver={(event) => {
                    if (draggedId === undefined || draggedId === node.id) return;
                    event.preventDefault();
                    setDropTargetId(node.id);
                  }}
                  onDragStart={(event) => {
                    setDraggedId(node.id);
                    event.dataTransfer?.setData("text/plain", node.id);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const source =
                      draggedId ?? event.dataTransfer?.getData("text/plain") ?? undefined;
                    setDraggedId(undefined);
                    setDropTargetId(undefined);
                    if (source !== undefined && source.length > 0 && source !== node.id) {
                      linkPair(source, node.id);
                    }
                  }}
                >
                  <div className="connections-map__node-header">
                    <label className="connections-map__node-select">
                      <OctantCheckbox
                        aria-label={`Select ${node.displayName}`}
                        checked={selected}
                        onChange={(event) => toggleSelected(node.id, event.target.checked)}
                      />
                      <span>{node.displayName}</span>
                    </label>
                    <OctantBadge variant="outline">
                      {node.kind === "this-computer" ? "This computer" : roleLabel(node.role)}
                    </OctantBadge>
                  </div>
                  <p className="connections-map__node-meta">
                    {node.kind === "this-computer"
                      ? node.origin !== undefined
                        ? `Listener · ${node.pathLabel}`
                        : "Remote listener off"
                      : (edge?.label ?? node.trustLabel)}
                  </p>
                  <p className="connections-map__node-meta">{node.statusLabel}</p>
                  {node.origin === undefined ? null : (
                    <p className="connections-map__node-origin">{node.origin}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {activePlans.length === 0 ? null : (
          <div
            aria-label="Planned machine links"
            className="connections-map__plan-panel"
            role="region"
          >
            <h3 className="connections-map__subheading">
              {activePlans.length === 1 ? "Link machines" : "Selected pairs"}
            </h3>
            {activePlans.map((plan) => (
              <div className="connections-map__plan-row" key={`${plan.fromId}:${plan.toId}`}>
                <div className="connections-map__list-copy">
                  <span className="connections-map__plan-pair">
                    {plan.fromName} ↔ {plan.toName}
                  </span>
                  <p className="connections-map__node-meta">{plan.summary}</p>
                </div>
                {plan.action === "pair-directly" ? (
                  <OctantButton
                    onClick={() => runPlanAction(plan)}
                    size="sm"
                    type="button"
                    variant="default"
                  >
                    Pair with {plan.targetName}
                  </OctantButton>
                ) : plan.action === "join-hub" ? (
                  <OctantButton
                    disabled={busyJoinCode}
                    onClick={() => runPlanAction(plan)}
                    size="sm"
                    type="button"
                    variant="default"
                  >
                    Make hub join code for {plan.targetName}
                  </OctantButton>
                ) : null}
              </div>
            ))}
            {mintedJoinCode === undefined ? null : (
              <div className="settings-panel__stack">
                <PairingCodeQr code={mintedJoinCode.code} />
                <SettingsFactList
                  facts={[
                    { label: "For", value: mintedJoinCode.targetName },
                    {
                      label: "Join code",
                      value: (
                        <code aria-label="Hub join code" className="oct-meta--mono">
                          {mintedJoinCode.code}
                        </code>
                      ),
                    },
                  ]}
                />
              </div>
            )}
            {actionMessage === undefined ? null : (
              <SettingsState kind="empty">{actionMessage}</SettingsState>
            )}
          </div>
        )}

        <div className="connections-map__list-section">
          <h3 className="connections-map__subheading">Connections list</h3>
          <ul aria-label="Connections list" className="connections-map__list">
            {connectionMap.nodes.map((node) => {
              const edge = directEdgeByTarget.get(node.id);
              const pairWithLocal =
                localNode !== undefined && node.kind === "remote"
                  ? planMachinePairLink(localNode, node)
                  : undefined;
              return (
                <li className="connections-map__list-row" key={node.id}>
                  <div className="connections-map__list-copy">
                    <span>
                      <strong>{node.displayName}</strong> ·{" "}
                      {node.kind === "this-computer" ? "This computer" : roleLabel(node.role)}
                    </span>
                    <span className="connections-map__node-meta">
                      {node.kind === "this-computer"
                        ? node.origin !== undefined
                          ? `${node.pathLabel} · ${node.origin}`
                          : "Listener off"
                        : `${edge?.label ?? node.trustLabel ?? "Unknown"} · ${node.statusLabel}`}
                    </span>
                  </div>
                  {pairWithLocal === undefined ? null : (
                    <OctantButton
                      aria-label={`Link ${localNode?.displayName ?? "This computer"} with ${node.displayName}`}
                      onClick={() => {
                        if (localNode !== undefined) linkPair(localNode.id, node.id);
                      }}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      {pairWithLocal.action === "pair-directly"
                        ? "Pair directly…"
                        : pairWithLocal.action === "join-hub"
                          ? "Join hub…"
                          : "Connection details"}
                    </OctantButton>
                  )}
                </li>
              );
            })}
            {peerEdges.map((edge) => {
              const from = nodeById.get(edge.fromId);
              const to = nodeById.get(edge.toId);
              if (from === undefined || to === undefined) return null;
              return (
                <li className="connections-map__list-row" key={edge.id}>
                  <div className="connections-map__list-copy">
                    <span>
                      {from.displayName} ↔ {to.displayName}
                    </span>
                    <span className="connections-map__node-meta">
                      Both in the hub (from roster; not a measured connection)
                    </span>
                  </div>
                  <OctantButton
                    aria-label={`Inspect link between ${from.displayName} and ${to.displayName}`}
                    onClick={() => linkPair(from.id, to.id)}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    How to link
                  </OctantButton>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </SettingsSection>
  );
}
