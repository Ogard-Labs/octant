// Who a thread move is between, as this host's role judges it. A spoke knows
// its members through the roster it holds and its peer grants; the hub through
// the roster it signs and the key each member joined with, and it keeps no peer
// grants, so its Accept moved threads switch stands where a spoke's Move in item
// does. A host whose hub role is on answers as the hub alone, as its owner
// routes do: a spoke that turned its hub role on keeps its old link, and its
// peer grants must not let a move in past Accept moved threads. Either way the
// move itself is authorized by an owner's own fresh unlock on the destination,
// not by the sender. Canonical:
// docs/design/hub-and-spokes.md "Moving a thread to another member".

import { HubMemberId } from "@octant/contracts";
import { peerGrantAllowsMoveIn } from "@octant/domain";
import { Schema } from "effect";
import { HubLinkVerifier } from "./hubLink";
import type { HubService } from "./hubService";
import type { SpokeLinkService, MemberTarget } from "./spokeLinkService";
import type { MoveSender, SignedRequest } from "./threadMoveService";

const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);

export interface ThreadMoveSenders {
  readonly authenticate: (request: SignedRequest) => MoveSender;
  readonly target: (memberId: string) => MemberTarget;
  readonly ownerIsCurrent: (ownerMemberId: string) => boolean;
}

/** What either role's owner list says about an owner, as far as a move reads it. */
interface OwnerListing {
  readonly owners: ReadonlyArray<{ readonly memberId: unknown }>;
  readonly inactiveDeviceMemberIds: ReadonlyArray<string>;
}

export function createThreadMoveSenders(options: {
  readonly spoke: Pick<SpokeLinkService, "authenticatePeer" | "memberTarget"> & {
    readonly ownerContext: () => OwnerListing | undefined;
  };
  readonly hub: Pick<HubService, "status" | "memberKey" | "hubMemberId" | "acceptsMovedThreads"> & {
    readonly ownerContext: () => OwnerListing | undefined;
  };
  readonly now: () => number;
}): ThreadMoveSenders {
  const verifier = new HubLinkVerifier({ now: options.now });
  const hubRoleOn = () => options.hub.status().enabled;
  const hubRoster = () => {
    const status = options.hub.status();
    return status.enabled ? status.roster?.roster : undefined;
  };

  return {
    authenticate: (request) => {
      if (!hubRoleOn()) {
        const peer = options.spoke.authenticatePeer(request);
        if (peer.status === "refused" || peer.peer.member.role === "guest") {
          return { status: "refused" };
        }
        return {
          status: "member",
          memberId: String(peer.peer.member.memberId),
          moveIn: peerGrantAllowsMoveIn(peer.peer.grant),
        };
      }
      const roster = hubRoster();
      if (roster === undefined) return { status: "refused" };
      const verified = verifier.verify({
        header: request.header,
        method: request.method,
        path: request.path,
        body: request.body,
        recipientMemberId: options.hub.hubMemberId(),
        publicKeyFor: (sender) => options.hub.memberKey(sender, request.publicKey ?? undefined),
      });
      if (verified.status === "refused") return { status: "refused" };
      const member = roster.members.find(
        (entry) => String(entry.memberId) === verified.senderMemberId,
      );
      // Only a spoke moves a thread; a guest runs none and a standby moves as the spoke it is.
      if (member === undefined || (member.role !== "spoke" && member.role !== "standby-hub")) {
        return { status: "refused" };
      }
      return {
        status: "member",
        memberId: String(member.memberId),
        moveIn: options.hub.acceptsMovedThreads(),
      };
    },
    target: (memberId) => {
      if (!hubRoleOn()) return options.spoke.memberTarget(memberId);
      const roster = hubRoster();
      const member = roster?.members.find((entry) => String(entry.memberId) === memberId);
      if (member === undefined) return { status: "refused", kind: "not-in-roster" };
      return {
        status: "member",
        self: decodeMemberId(options.hub.hubMemberId()),
        member,
      };
    },
    ownerIsCurrent: (ownerMemberId) => {
      const listed = (context: OwnerListing | undefined) =>
        context !== undefined &&
        context.owners.some((owner) => String(owner.memberId) === ownerMemberId) &&
        !context.inactiveDeviceMemberIds.includes(ownerMemberId);
      return hubRoleOn()
        ? listed(options.hub.ownerContext())
        : listed(options.spoke.ownerContext());
    },
  };
}
