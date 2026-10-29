// What an owner device asks of a host with a window's powers: the
// administration the loopback channel gives a window (hub grant, leave, Confirm
// new members, owner changes, and on the hub the hub role, join codes and
// Remove). It travels the same signed member request the hub link uses, on the
// private listener: the owner's host identity key signs the request, and a
// fresh unlock from the owner's unlock key signs a host challenge bound to this
// exact method, path, and body. The host checks its own owner list, the hub
// grant's Owners item, and the unlock before any side effect. The hub, a
// standby, a peer, and anything that is not on the owner list are refused; an
// agent or a routine holds no member key and reaches only the product routes.

import {
  OWNER_IDENTITY_KEY_HEADER,
  OWNER_UNLOCK_HEADER,
  decodeConfirmNewMembersRequest,
  decodeHubGrant,
  decodeHubRoleRequest,
  decodeNewMemberConfirmation,
  decodeOwnerAdditionRequest,
  decodeOwnerAlertRequest,
  decodeOwnerChallengeRequest,
  decodeOwnerJoinCodeRequest,
  decodeOwnerMemberRequest,
  decodeOwnerRemovalRequest,
  decodeOwnerUnlockProof,
  type AuditActingPrincipal,
  type HubGrant,
  type HubMemberId,
  type OwnerUnlockProof,
} from "@octant/contracts";
import { authorizeOwnerRequest, type OwnerRequestAuthorization } from "@octant/domain";
import { publicKeyFingerprint } from "./hubCrypto";
import { HUB_LINK_HEADER, HubLinkVerifier } from "./hubLink";
import type { HubService } from "./hubService";
import type { HostOwnerRecord } from "./hubStateStore";
import { ownerEntries } from "./ownerRecords";
import type { OwnerUnlockService } from "./ownerUnlock";
import type { SpokeLinkService } from "./spokeLinkService";

export const HUB_OWNER_ROUTE_PREFIX = "/api/hub/owner";

export const HUB_OWNER_ROUTES = {
  challenge: `${HUB_OWNER_ROUTE_PREFIX}/challenge`,
  alerts: `${HUB_OWNER_ROUTE_PREFIX}/alerts`,
  heldMembers: `${HUB_OWNER_ROUTE_PREFIX}/held-members`,
  alertDismiss: `${HUB_OWNER_ROUTE_PREFIX}/alerts/dismiss`,
  alertRemove: `${HUB_OWNER_ROUTE_PREFIX}/alerts/remove`,
  grant: `${HUB_OWNER_ROUTE_PREFIX}/grant`,
  leave: `${HUB_OWNER_ROUTE_PREFIX}/leave`,
  confirmNewMembers: `${HUB_OWNER_ROUTE_PREFIX}/confirm-new-members`,
  confirmMember: `${HUB_OWNER_ROUTE_PREFIX}/confirm-member`,
  ownersAdd: `${HUB_OWNER_ROUTE_PREFIX}/owners/add`,
  ownersRemove: `${HUB_OWNER_ROUTE_PREFIX}/owners/remove`,
  hubRole: `${HUB_OWNER_ROUTE_PREFIX}/hub-role`,
  joinCode: `${HUB_OWNER_ROUTE_PREFIX}/join-codes`,
  removeMember: `${HUB_OWNER_ROUTE_PREFIX}/members/remove`,
} as const;

type OwnerRoute = (typeof HUB_OWNER_ROUTES)[keyof typeof HUB_OWNER_ROUTES];
const OWNER_ROUTES: ReadonlySet<string> = new Set(Object.values(HUB_OWNER_ROUTES));

/** Reads: they change nothing, so they ask for no unlock. */
const READ_ROUTES: ReadonlySet<string> = new Set([
  HUB_OWNER_ROUTES.alerts,
  HUB_OWNER_ROUTES.heldMembers,
]);

/** The routes an unlock can be asked for: every one that changes something. */
const UNLOCKED_ROUTES: ReadonlySet<string> = new Set(
  Object.values(HUB_OWNER_ROUTES).filter(
    (route) => route !== HUB_OWNER_ROUTES.challenge && !READ_ROUTES.has(route),
  ),
);

/** Which role of this host an action works on. */
const HUB_ONLY: ReadonlySet<string> = new Set([
  HUB_OWNER_ROUTES.hubRole,
  HUB_OWNER_ROUTES.joinCode,
  HUB_OWNER_ROUTES.removeMember,
]);
const EITHER: ReadonlySet<string> = new Set([
  HUB_OWNER_ROUTES.challenge,
  HUB_OWNER_ROUTES.ownersAdd,
  HUB_OWNER_ROUTES.ownersRemove,
]);

const MAX_BODY_BYTES = 16 * 1_024;
const NO_STORE = { "cache-control": "no-store" } as const;

export interface HubOwnerRouteOptions {
  readonly hub: HubService;
  readonly spoke: SpokeLinkService;
  readonly unlock: OwnerUnlockService;
  readonly now?: () => number;
}

interface OwnerScope {
  readonly host: "hub" | "spoke";
  readonly roster: Parameters<typeof authorizeOwnerRequest>[0]["roster"];
  readonly owners: ReadonlyArray<HostOwnerRecord>;
  readonly grant: HubGrant | undefined;
  readonly inactiveDeviceMemberIds: ReadonlyArray<string>;
}

type Refusal = { readonly status: number; readonly kind: string };

export function createHubOwnerRouteHandler(
  options: HubOwnerRouteOptions,
): (request: Request) => Promise<Response | undefined> {
  const verifier = new HubLinkVerifier({ now: options.now ?? Date.now });

  const scopeFor = (route: OwnerRoute): OwnerScope | Refusal => {
    const hub = options.hub.ownerContext();
    const spoke = options.spoke.ownerContext();
    const hubScope: OwnerScope | undefined =
      hub === undefined
        ? undefined
        : {
            host: "hub",
            roster: hub.roster,
            owners: hub.owners,
            grant: undefined,
            inactiveDeviceMemberIds: hub.inactiveDeviceMemberIds,
          };
    const spokeScope: OwnerScope | undefined =
      spoke === undefined
        ? undefined
        : {
            host: "spoke",
            roster: spoke.roster,
            owners: spoke.owners,
            grant: spoke.grant,
            inactiveDeviceMemberIds: spoke.inactiveDeviceMemberIds,
          };
    if (HUB_ONLY.has(route)) {
      return hubScope ?? { status: 403, kind: "hub-role-off" };
    }
    if (EITHER.has(route)) {
      return hubScope ?? spokeScope ?? { status: 403, kind: "not-a-member" };
    }
    return spokeScope ?? { status: 403, kind: "not-a-spoke" };
  };

  return async (request) => {
    const url = new URL(request.url);
    if (!OWNER_ROUTES.has(url.pathname)) return undefined;
    const route = url.pathname as OwnerRoute;
    const expectedMethod = READ_ROUTES.has(route) ? "GET" : "POST";
    if (request.method !== expectedMethod || url.search !== "") return refused(405, "invalid");
    const body = await readBody(request);
    if (body === undefined) return refused(413, "invalid");

    const scope = scopeFor(route);
    if ("kind" in scope) return refused(scope.status, scope.kind);

    // Who is asking: a roster member whose request is signed with the identity
    // key it presents. The key must match the fingerprint this host recorded
    // for an owner, or else the one the held roster lists for that member.
    const presentedKey = request.headers.get(OWNER_IDENTITY_KEY_HEADER);
    const verified = verifier.verify({
      header: request.headers.get(HUB_LINK_HEADER),
      method: request.method,
      path: route,
      body,
      recipientMemberId: options.hub.hubMemberId(),
      publicKeyFor: (sender) => {
        if (presentedKey === null) return undefined;
        const owner = scope.owners.find((entry) => String(entry.memberId) === sender);
        const expected =
          owner?.identityKeyFingerprint ??
          scope.roster.members.find((member) => String(member.memberId) === sender)
            ?.identityKeyFingerprint;
        return expected !== undefined && publicKeyFingerprint(presentedKey) === expected
          ? presentedKey
          : undefined;
      },
    });
    if (verified.status === "refused") return refused(401, verified.kind);
    const senderId = verified.senderMemberId;
    const owner = scope.owners.find((entry) => String(entry.memberId) === senderId);
    const senderMember = scope.roster.members.find(
      (member) => String(member.memberId) === senderId,
    );
    if (senderMember === undefined || presentedKey === null) return refused(401, "unknown-sender");
    // Revoking a member's paired device on this host ends its owner powers here,
    // even while its owner entry and roster entry remain.
    if (scope.inactiveDeviceMemberIds.includes(senderId)) return refused(403, "device-revoked");

    // The unlock is checked here, before anything else is decided, because it
    // consumes the challenge whatever happens next.
    const needsUnlock = UNLOCKED_ROUTES.has(route);
    const proof = readUnlockProof(request);
    const unlockResult =
      !needsUnlock || owner === undefined || proof === undefined
        ? undefined
        : options.unlock.verify({
            ownerMemberId: senderId,
            unlockPublicKey: owner.unlockPublicKey,
            proof,
            request: { method: request.method, path: route, body },
          });

    const decision: OwnerRequestAuthorization = authorizeOwnerRequest({
      host: scope.host,
      grant: scope.grant,
      owners: ownerEntries(scope.owners),
      roster: scope.roster,
      memberId: senderMember.memberId,
      identityKeyFingerprint: publicKeyFingerprint(presentedKey),
      unlock: !needsUnlock ? "not-needed" : unlockResult?.status === "fresh" ? "fresh" : "absent",
    });
    if (decision.status === "refused") {
      // An unlock that failed is more useful to report than the missing one it left behind.
      if (
        decision.kind === "unlock-required" &&
        unlockResult !== undefined &&
        unlockResult.status === "refused"
      ) {
        return refused(403, `unlock-${unlockResult.kind}`);
      }
      return refused(403, decision.kind);
    }
    const principal: AuditActingPrincipal = {
      kind: "owner-unlock",
      memberId: senderMember.memberId,
    };

    try {
      return await act({ route, body, scope, senderMemberId: senderMember.memberId, principal });
    } catch {
      return refused(400, "invalid");
    }
  };

  async function act(input: {
    readonly route: OwnerRoute;
    readonly body: string;
    readonly scope: OwnerScope;
    readonly senderMemberId: HubMemberId;
    readonly principal: AuditActingPrincipal;
  }): Promise<Response> {
    const { route, body, scope, principal } = input;
    const json = (): unknown => JSON.parse(body);
    const empty = (): void => {
      if (body.trim() !== "") throw new Error("invalid");
    };
    switch (route) {
      case HUB_OWNER_ROUTES.challenge: {
        const asked = decodeOwnerChallengeRequest(json());
        // A challenge is for one of the actions below, never for itself or a read.
        if (!UNLOCKED_ROUTES.has(asked.path)) return refused(400, "invalid");
        const issued = options.unlock.issue({
          ownerMemberId: String(input.senderMemberId),
          request: asked,
        });
        return issued.status === "issued"
          ? Response.json({ challenge: issued.challenge }, { headers: NO_STORE })
          : refused(429, issued.kind);
      }
      case HUB_OWNER_ROUTES.alerts: {
        const status = options.spoke.status();
        return status.membership === "none"
          ? refused(403, "not-a-spoke")
          : Response.json({ alerts: status.alerts }, { headers: NO_STORE });
      }
      case HUB_OWNER_ROUTES.heldMembers:
        return options.spoke.status().membership === "none"
          ? refused(403, "not-a-spoke")
          : Response.json({ members: options.spoke.heldMembers() }, { headers: NO_STORE });
      case HUB_OWNER_ROUTES.alertDismiss:
        return outcome(
          options.spoke.dismissAlert(String(decodeOwnerAlertRequest(json()).alertId), principal),
        );
      case HUB_OWNER_ROUTES.alertRemove:
        return outcome(
          options.spoke.removeFromAlert(String(decodeOwnerAlertRequest(json()).alertId), principal),
        );
      case HUB_OWNER_ROUTES.grant:
        return outcome(options.spoke.setGrant(decodeHubGrant(json()), principal));
      case HUB_OWNER_ROUTES.leave: {
        empty();
        return outcome(await options.spoke.leave(principal));
      }
      case HUB_OWNER_ROUTES.confirmNewMembers:
        return outcome(
          options.spoke.setConfirmNewMembers(
            decodeConfirmNewMembersRequest(json()).enabled,
            principal,
          ),
        );
      case HUB_OWNER_ROUTES.confirmMember: {
        const confirmation = decodeNewMemberConfirmation(json());
        // The signing owner is the owner whose unlock opened this request.
        if (String(confirmation.confirmedBy) !== String(input.senderMemberId)) {
          return refused(403, "confirmed-by-mismatch");
        }
        return outcome(options.spoke.confirmMemberByOwner(confirmation, principal));
      }
      case HUB_OWNER_ROUTES.ownersAdd: {
        const added = decodeOwnerAdditionRequest(json());
        return outcome(
          scope.host === "hub"
            ? options.hub.addOwners(added.owners, principal)
            : options.spoke.addOwners(added.owners, principal),
        );
      }
      case HUB_OWNER_ROUTES.ownersRemove: {
        const memberId = String(decodeOwnerRemovalRequest(json()).memberId);
        return outcome(
          scope.host === "hub"
            ? options.hub.removeOwner(memberId, principal)
            : options.spoke.removeOwner(memberId, principal),
        );
      }
      case HUB_OWNER_ROUTES.hubRole:
        return outcome(
          decodeHubRoleRequest(json()).enabled
            ? options.hub.enable(principal)
            : options.hub.disable(principal),
        );
      case HUB_OWNER_ROUTES.joinCode:
        return outcome(options.hub.mintJoinCode(decodeOwnerJoinCodeRequest(json()), principal));
      case HUB_OWNER_ROUTES.removeMember:
        return outcome(
          await options.hub.removeMember(
            { memberId: String(decodeOwnerMemberRequest(json()).memberId) },
            principal,
          ),
        );
    }
  }
}

function readUnlockProof(request: Request): OwnerUnlockProof | undefined {
  const header = request.headers.get(OWNER_UNLOCK_HEADER);
  if (header === null) return undefined;
  try {
    return decodeOwnerUnlockProof(JSON.parse(Buffer.from(header, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

/** A refusal is a state the owner device can act on, so it answers 409 with its kind. */
function outcome(value: { readonly status: string; readonly kind?: string }): Response {
  return Response.json(value, {
    status: value.status === "refused" ? 409 : 200,
    headers: NO_STORE,
  });
}

async function readBody(request: Request): Promise<string | undefined> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return undefined;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return undefined;
  }
  return Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES ? undefined : text;
}

function refused(status: number, kind: string): Response {
  return Response.json({ status: "refused", kind }, { status, headers: NO_STORE });
}
