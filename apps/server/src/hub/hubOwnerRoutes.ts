// What an owner device asks of a host with a window's powers: the
// administration the loopback channel gives a window (hub grant, leave, Confirm
// new members, owner changes, and on the hub the hub role, join codes and
// Remove). It travels the same signed member request the hub link uses, on the
// private listener: the owner's host identity key signs the request, and a
// fresh unlock from the owner's unlock key signs a host challenge bound to this
// exact method, path, and body. The host checks its own owner list, the hub
// grant's Owners item, and the unlock before any side effect. An unlock is a
// fresh challenge for one action, or an open administration session (five
// minutes, decision H17) for the actions that class allows; Full access, a
// credential copy, an owner change, and opening a session each need their own
// challenge. The hub, a
// standby, a peer, and anything that is not on the owner list are refused; an
// agent or a routine holds no member key and reaches only the product routes.

import { createHash } from "node:crypto";
import {
  OWNER_IDENTITY_KEY_HEADER,
  OWNER_SESSION_HEADER,
  OWNER_UNLOCK_HEADER,
  decodeConfirmNewMembersRequest,
  decodeHubGrant,
  decodeHubProposalDecisionRequest,
  decodeHubRoleRequest,
  decodeNewMemberConfirmation,
  decodeOwnerAdditionRequest,
  decodeOwnerAlertRequest,
  decodeOwnerChallengeRequest,
  decodeOwnerCredentialCopyRequest,
  decodeOwnerCredentialReceiveRequest,
  decodeOwnerJoinCodeRequest,
  decodeOwnerMemberRequest,
  decodeOwnerPostureChangeRequest,
  decodeOwnerPostureReadRequest,
  decodeOwnerRemovalRequest,
  decodeOwnerUnlockProof,
  decodeHubSignInAsk,
  decodeHubSignInDecisionRequest,
  type AuditActingPrincipal,
  type HubGrant,
  type HubMemberId,
  type HubMembershipChangedPayload,
  type OwnerUnlockProof,
} from "@octant/contracts";
import {
  authorizeOwnerRequest,
  ownerPostureUnlockClass,
  type OwnerRequestAuthorization,
  type OwnerUnlockClass,
} from "@octant/domain";
import { publicKeyFingerprint } from "./hubCrypto";
import { HUB_LINK_HEADER, HubLinkVerifier } from "./hubLink";
import type { HubService } from "./hubService";
import type { HostOwnerRecord } from "./hubStateStore";
import type { OwnerCredentialCopyService } from "./ownerCredentialCopy";
import type { OwnerPostureHost } from "./ownerPostureHost";
import { ownerEntries } from "./ownerRecords";
import type { OwnerSessionCheck, OwnerUnlockService, OwnerUnlockVerification } from "./ownerUnlock";
import type { SignInService } from "./signInService";
import type { SpokeLinkService } from "./spokeLinkService";
import type { SpokeProvisionService } from "./spokeProvisionService";
import type { SpokeSignInService } from "./spokeSignInService";

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
  session: `${HUB_OWNER_ROUTE_PREFIX}/session`,
  postureRead: `${HUB_OWNER_ROUTE_PREFIX}/posture/read`,
  postureChange: `${HUB_OWNER_ROUTE_PREFIX}/posture/change`,
  credentialReceive: `${HUB_OWNER_ROUTE_PREFIX}/credentials/receive`,
  credentialCopy: `${HUB_OWNER_ROUTE_PREFIX}/credentials/copy`,
  provisionApply: `${HUB_OWNER_ROUTE_PREFIX}/provision/apply`,
  provisionDismiss: `${HUB_OWNER_ROUTE_PREFIX}/provision/dismiss`,
  signInRequests: `${HUB_OWNER_ROUTE_PREFIX}/sign-in/requests`,
  signInAsk: `${HUB_OWNER_ROUTE_PREFIX}/sign-in/ask`,
  signInAccept: `${HUB_OWNER_ROUTE_PREFIX}/sign-in/accept`,
  signInDecline: `${HUB_OWNER_ROUTE_PREFIX}/sign-in/decline`,
  signInCheck: `${HUB_OWNER_ROUTE_PREFIX}/sign-in/check`,
} as const;

type OwnerRoute = (typeof HUB_OWNER_ROUTES)[keyof typeof HUB_OWNER_ROUTES];
const OWNER_ROUTES: ReadonlySet<string> = new Set(Object.values(HUB_OWNER_ROUTES));

/** Reads: they change nothing, so they ask for no unlock. */
const READ_ROUTES: ReadonlySet<string> = new Set([
  HUB_OWNER_ROUTES.alerts,
  HUB_OWNER_ROUTES.heldMembers,
  HUB_OWNER_ROUTES.signInRequests,
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
  HUB_OWNER_ROUTES.signInAsk,
]);
const EITHER: ReadonlySet<string> = new Set([
  HUB_OWNER_ROUTES.challenge,
  HUB_OWNER_ROUTES.session,
  HUB_OWNER_ROUTES.ownersAdd,
  HUB_OWNER_ROUTES.ownersRemove,
]);

/**
 * The actions that always need their own fresh challenge, whatever session is
 * open (decision H17): opening a session, owner changes, copying a sign-in, and
 * the actions that change who may be an owner or leave the hub. Full access is
 * decided by the posture asked for; an owner join code by its body.
 */
const OWN_UNLOCK_ROUTES: ReadonlySet<string> = new Set([
  HUB_OWNER_ROUTES.session,
  HUB_OWNER_ROUTES.ownersAdd,
  HUB_OWNER_ROUTES.ownersRemove,
  HUB_OWNER_ROUTES.confirmMember,
  HUB_OWNER_ROUTES.leave,
  HUB_OWNER_ROUTES.credentialReceive,
  HUB_OWNER_ROUTES.credentialCopy,
]);

/** Which unlock this action asks for. A body that does not decode asks for the strictest. */
function unlockClassFor(route: string, body: string): OwnerUnlockClass {
  if (OWN_UNLOCK_ROUTES.has(route)) return "own";
  try {
    if (route === HUB_OWNER_ROUTES.joinCode) {
      return decodeOwnerJoinCodeRequest(JSON.parse(body)).owner ? "own" : "administration";
    }
    if (route === HUB_OWNER_ROUTES.postureChange) {
      return ownerPostureUnlockClass(decodeOwnerPostureChangeRequest(JSON.parse(body)).posture);
    }
  } catch {
    return "own";
  }
  return "administration";
}

/** Identifies the owner list and each owner's unlock key, so a session ends when either changes. */
function ownerListStamp(scope: OwnerScope): string {
  const entries = scope.owners
    .map((entry) => `${String(entry.memberId)}:${entry.unlockPublicKey}`)
    .sort();
  return createHash("sha256")
    .update(`${scope.host}\n${scope.ownerListRevision}\n${entries.join("\n")}`, "utf8")
    .digest("hex");
}

const MAX_BODY_BYTES = 16 * 1_024;
const NO_STORE = { "cache-control": "no-store" } as const;

export interface HubOwnerRouteOptions {
  readonly hub: HubService;
  readonly spoke: SpokeLinkService;
  readonly unlock: OwnerUnlockService;
  readonly postures: OwnerPostureHost;
  readonly credentials: OwnerCredentialCopyService;
  readonly provision: SpokeProvisionService;
  readonly signIn: SignInService;
  readonly spokeSignIn: SpokeSignInService;
  readonly record: (change: HubMembershipChangedPayload) => void;
  readonly now?: () => number;
}

interface OwnerScope {
  readonly host: "hub" | "spoke";
  readonly roster: Parameters<typeof authorizeOwnerRequest>[0]["roster"];
  readonly owners: ReadonlyArray<HostOwnerRecord>;
  readonly grant: HubGrant | undefined;
  readonly inactiveDeviceMemberIds: ReadonlyArray<string>;
  readonly ownerListRevision: number;
}

type Refusal = { readonly status: number; readonly kind: string };

export function createHubOwnerRouteHandler(
  options: HubOwnerRouteOptions,
): (request: Request) => Promise<Response | undefined> {
  const verifier = new HubLinkVerifier({ now: options.now ?? Date.now });

  // A challenge belongs to the scope of the action it is for, so it is
  // authenticated against the same owners that action will be.
  const challengedRoute = (body: string): string | undefined => {
    try {
      return decodeOwnerChallengeRequest(JSON.parse(body)).path;
    } catch {
      return undefined;
    }
  };

  const scopeFor = (requested: OwnerRoute, body: string): OwnerScope | Refusal => {
    const route =
      requested === HUB_OWNER_ROUTES.challenge ? (challengedRoute(body) ?? requested) : requested;
    // A hub whose role is off keeps its roster and owners, but they hold no
    // owner powers: a former hub that joined another hub answers only as a spoke.
    const hub = options.hub.status().enabled ? options.hub.ownerContext() : undefined;
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
            ownerListRevision: hub.ownerListRevision,
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
            ownerListRevision: spoke.ownerListRevision,
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

    const scope = scopeFor(route, body);
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
    if (scope.inactiveDeviceMemberIds.includes(senderId)) {
      options.unlock.revokeOwner(senderId);
      return refused(403, "device-revoked");
    }
    // A device that is no longer on the owner list holds no session either.
    if (owner === undefined) options.unlock.revokeOwner(senderId);

    // The unlock is checked here, before anything else is decided, because it
    // consumes the challenge whatever happens next. A request that carries a
    // challenge answer is judged by it alone; one that carries only a session
    // id is covered only if its action is an administration one.
    const needsUnlock = UNLOCKED_ROUTES.has(route);
    const unlockClass = needsUnlock ? unlockClassFor(route, body) : "own";
    const proof = readUnlockProof(request);
    const sessionId = request.headers.get(OWNER_SESSION_HEADER);
    let unlockResult: OwnerUnlockVerification | undefined;
    let sessionResult: OwnerSessionCheck | undefined;
    if (needsUnlock && owner !== undefined) {
      if (proof !== undefined) {
        unlockResult = options.unlock.verify({
          ownerMemberId: senderId,
          unlockPublicKey: owner.unlockPublicKey,
          proof,
          request: { method: request.method, path: route, body },
        });
      } else if (sessionId !== null) {
        sessionResult = options.unlock.checkSession({
          sessionId,
          ownerMemberId: senderId,
          ownerListStamp: ownerListStamp(scope),
        });
      }
    }

    const decision: OwnerRequestAuthorization = authorizeOwnerRequest({
      host: scope.host,
      grant: scope.grant,
      owners: ownerEntries(scope.owners),
      roster: scope.roster,
      memberId: senderMember.memberId,
      identityKeyFingerprint: publicKeyFingerprint(presentedKey),
      unlock: !needsUnlock
        ? "not-needed"
        : unlockResult?.status === "fresh"
          ? "fresh"
          : sessionResult?.status === "open"
            ? "session"
            : "absent",
      unlockClass,
    });
    if (decision.status === "refused") {
      // An unlock that failed is more useful to report than the missing one it left behind.
      if (decision.kind === "unlock-required" && unlockResult?.status === "refused") {
        return refused(403, `unlock-${unlockResult.kind}`);
      }
      if (decision.kind === "unlock-required" && sessionResult?.status === "refused") {
        return refused(403, sessionResult.kind);
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
      case HUB_OWNER_ROUTES.session: {
        empty();
        const session = options.unlock.openSession({
          ownerMemberId: String(input.senderMemberId),
          ownerListStamp: ownerListStamp(scope),
        });
        if (session === undefined) return refused(429, "too-many-sessions");
        options.record({
          change: "owner-session-opened",
          actingPrincipal: principal,
          memberId: input.senderMemberId,
        });
        return Response.json({ status: "opened", session }, { headers: NO_STORE });
      }
      case HUB_OWNER_ROUTES.postureRead:
        return outcome(await options.postures.read(decodeOwnerPostureReadRequest(json()).subject));
      case HUB_OWNER_ROUTES.postureChange: {
        const change = decodeOwnerPostureChangeRequest(json());
        const result = await options.postures.change(change);
        if (result.status === "changed") {
          options.record({
            change: "owner-posture-changed",
            actingPrincipal: principal,
            memberId: input.senderMemberId,
            posture: change.posture,
          });
        }
        return outcome(result);
      }
      case HUB_OWNER_ROUTES.credentialReceive: {
        const asked = decodeOwnerCredentialReceiveRequest(json());
        return outcome(
          options.credentials.issueTicket({
            ownerMemberId: String(input.senderMemberId),
            sourceMemberId: String(asked.sourceMemberId),
            targetCredentialName: asked.targetCredentialName,
            principal,
          }),
        );
      }
      case HUB_OWNER_ROUTES.credentialCopy: {
        const asked = decodeOwnerCredentialCopyRequest(json());
        const result = await options.credentials.send({
          targetMemberId: String(asked.targetMemberId),
          sourceCredentialName: asked.sourceCredentialName,
          ticketId: asked.ticketId,
          principal,
        });
        return outcome(result.status === "ok" ? { status: "copied" } : result);
      }
      case HUB_OWNER_ROUTES.provisionApply: {
        const decided = decodeHubProposalDecisionRequest(json());
        return outcome(
          await options.provision.apply(decided.offerId, principal, decided.projectId),
        );
      }
      case HUB_OWNER_ROUTES.provisionDismiss:
        return outcome(
          options.provision.dismiss(decodeHubProposalDecisionRequest(json()).offerId, principal),
        );
      case HUB_OWNER_ROUTES.signInRequests:
        return options.spoke.status().membership === "none"
          ? refused(403, "not-a-spoke")
          : Response.json({ requests: options.spokeSignIn.view() }, { headers: NO_STORE });
      case HUB_OWNER_ROUTES.signInAsk:
        return outcome(await options.signIn.ask(decodeHubSignInAsk(json()), principal));
      case HUB_OWNER_ROUTES.signInAccept:
        return outcome(
          options.spokeSignIn.accept(decodeHubSignInDecisionRequest(json()).requestId, principal),
        );
      case HUB_OWNER_ROUTES.signInDecline:
        return outcome(
          await options.spokeSignIn.decline(
            decodeHubSignInDecisionRequest(json()).requestId,
            principal,
          ),
        );
      case HUB_OWNER_ROUTES.signInCheck:
        return outcome(
          await options.spokeSignIn.check(
            decodeHubSignInDecisionRequest(json()).requestId,
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
