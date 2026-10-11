/**
 * What Settings › Sync shows about this host's replica, derived from the
 * membership facts the projection holds.
 *
 * Nothing here reads the store or journals anything: the view is a pure
 * function of the held records, the pinned founder, and the clock, so it
 * shows what this computer already read. Matching codes are computed here
 * from the same inputs the approve and confirm commands check them against,
 * so the code a screen shows is the code the command accepts.
 */

import {
  ReplicaDisplayName,
  type ReplicaApproverView,
  type ReplicaInstanceId,
  type ReplicaJoinRequestEntry,
  type ReplicaMemberView,
  type ReplicaMembershipView,
  type ReplicaRestoreProgress,
  type ReplicaSyncStatus,
  type ReplicaSyncStatusView,
  type ReplicaThisComputer,
} from "@octant/contracts";
import {
  deriveReplicaMembership,
  isReplicaAncestor,
  replicaApprovalOf,
  replicaFounderReachedFrom,
  replicaInGoodStanding,
  replicaJoinRequestIsFresh,
  replicaMembershipNode,
} from "@octant/domain/replica-membership-policy";
import { Schema } from "effect";
import type { ReplicaMembershipState } from "./replicaMembershipProjection";
import { deriveReplicaJoinMatchingCode } from "./replicaMembershipService";

const isDisplayName = Schema.is(ReplicaDisplayName);

/**
 * The name a computer suggests for itself: its host name without the
 * `.local` suffix macOS adds. A name the record format would refuse falls back
 * to the generic one, and the person can change it before anything is written.
 */
export function replicaComputerName(hostname: string, fallback: string): ReplicaDisplayName {
  const trimmed = hostname
    .replace(/\.local$/i, "")
    .trim()
    .slice(0, 128)
    .trim();
  if (isDisplayName(trimmed)) return trimmed;
  if (isDisplayName(fallback)) return fallback;
  throw new Error("The fallback computer name is not a valid replica display name.");
}

export function replicaMembershipView(input: {
  readonly state: ReplicaMembershipState;
  readonly now: number;
  readonly computerName: ReplicaDisplayName;
  /** The restore of this computer's current identity, once one started. */
  readonly restore?: ReplicaRestoreProgress | undefined;
  /** This identity's join confirmation read, once one started. */
  readonly joinRead?: ReplicaRestoreProgress | undefined;
}): ReplicaMembershipView {
  const { state } = input;
  const local = state.local;
  const founder = state.founder;
  const localStanding =
    local !== undefined && replicaInGoodStanding(state.membership, local.instanceId);
  return {
    kind: "replica-membership-view",
    computerName: input.computerName,
    thisComputer: thisComputer(state, input.now),
    members: state.members.map((node): ReplicaMemberView => {
      const parent =
        node.parent === undefined
          ? undefined
          : replicaMembershipNode(state.membership, node.parent);
      return {
        instanceId: node.instanceId,
        displayName: node.displayName,
        role:
          parent === undefined
            ? { kind: "founder" }
            : { kind: "approved", approver: parent.instanceId, approverName: parent.displayName },
        revoked: node.cut !== undefined,
        thisComputer: local !== undefined && same(node.instanceId, local.instanceId),
        revocable:
          localStanding &&
          node.cut === undefined &&
          isReplicaAncestor(state.membership, local.instanceId, node.instanceId),
      };
    }),
    joinRequests:
      !localStanding || founder === undefined
        ? []
        : state.joinRequests.flatMap((request) =>
            replicaJoinRequestIsFresh(request.requestedAt, input.now)
              ? [
                  {
                    request,
                    matchingCode: deriveReplicaJoinMatchingCode({
                      joinRequest: request,
                      approver: local,
                      founder,
                    }),
                    approvedByThisComputer:
                      replicaApprovalOf(
                        state.records,
                        local.instanceId,
                        request.origin.instanceId,
                      ) !== undefined,
                  },
                ]
              : [],
          ),
    status: syncStatus(state, input.restore, input.joinRead),
  };
}

/**
 * The part of the view a paired phone or remote window may read. Codes, join
 * requests, ids, and what this computer could revoke stay on the host.
 */
export function replicaSyncStatusView(view: ReplicaMembershipView): ReplicaSyncStatusView {
  return {
    kind: "replica-sync-status",
    thisComputer: view.thisComputer.kind,
    members: view.members.map((member) => ({
      displayName: member.displayName,
      role:
        member.role.kind === "founder"
          ? { kind: "founder" }
          : { kind: "approved", approverName: member.role.approverName },
      revoked: member.revoked,
      thisComputer: member.thisComputer,
    })),
    status: view.status,
  };
}

function thisComputer(state: ReplicaMembershipState, now: number): ReplicaThisComputer {
  const local = state.local;
  if (local === undefined) return { kind: "none" };
  const named = { instanceId: local.instanceId, displayName: local.displayName };
  if (local.role === "founder") return { kind: "founder", ...named };
  if (state.localFinished) return { kind: "left", ...named };
  if (state.localAccepted) return { kind: "member", ...named };
  const request = state.records.find(
    (record): record is typeof record & { readonly entry: ReplicaJoinRequestEntry } =>
      record.entry.kind === "join-request" &&
      same(record.entry.origin.instanceId, local.instanceId),
  )?.entry;
  return {
    kind: "joining",
    ...named,
    fresh: request !== undefined && replicaJoinRequestIsFresh(request.requestedAt, now),
    approvers: request === undefined ? [] : approvers(state, request),
  };
}

/**
 * Every computer in good standing in a replica this computer read, with the
 * code its screen shows for this request. Before a join is confirmed there is
 * no pinned founder, so each founder the store's records lead to is weighed on
 * its own; the person picks the computer they are standing at.
 */
function approvers(
  state: ReplicaMembershipState,
  request: ReplicaJoinRequestEntry,
): ReadonlyArray<ReplicaApproverView> {
  const subject = request.origin.instanceId;
  const byFounder = new Map<string, ReturnType<typeof deriveReplicaMembership>>();
  const seen = new Set<string>();
  const found: ReplicaApproverView[] = [];
  for (const { entry } of state.records) {
    const candidate = entry.origin.instanceId;
    if (seen.has(String(candidate)) || same(candidate, subject)) continue;
    seen.add(String(candidate));
    const root = replicaFounderReachedFrom(state.records, candidate);
    if (root === undefined) continue;
    const founderId = String(root.origin.instanceId);
    const membership =
      byFounder.get(founderId) ?? deriveReplicaMembership(root.origin.instanceId, state.records);
    byFounder.set(founderId, membership);
    const node = replicaMembershipNode(membership, candidate);
    if (node === undefined || !replicaInGoodStanding(membership, candidate)) continue;
    found.push({
      instanceId: node.instanceId,
      displayName: node.displayName,
      matchingCode: deriveReplicaJoinMatchingCode({
        joinRequest: request,
        approver: { instanceId: node.instanceId, publicKey: node.publicKey },
        founder: { instanceId: root.origin.instanceId, publicKey: root.origin.publicKey },
      }),
      approvedThisComputer: replicaApprovalOf(state.records, candidate, subject) !== undefined,
    });
  }
  return found.sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function syncStatus(
  state: ReplicaMembershipState,
  restore: ReplicaRestoreProgress | undefined,
  joinRead: ReplicaRestoreProgress | undefined,
): ReplicaSyncStatus {
  const failure = state.lastStoreFailure;
  return {
    lastPublish: { kind: "not-available" },
    lastPull: { kind: "not-available" },
    queued: { kind: "not-available" },
    ...(restore === undefined ? {} : { restore }),
    // A finished read has nothing left to show: the restore takes over.
    ...(joinRead === undefined || joinRead.state === "finished" ? {} : { joinRead }),
    ...(failure === undefined
      ? {}
      : { lastError: { at: failure.at, phase: failure.phase, reason: failure.reason } }),
  };
}

function same(left: ReplicaInstanceId, right: ReplicaInstanceId): boolean {
  return String(left) === String(right);
}
