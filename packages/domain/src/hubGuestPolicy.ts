import type { HubMemberId, HubRoster, PeerGrant, RosterMember } from "@octant/contracts";
import { admitNewMember } from "./hubAndSpokesPolicy";

const sameId = (a: HubMemberId, b: HubMemberId): boolean => String(a) === String(b);

/**
 * The roster members a spoke introduces: the phones and browsers, and the
 * other spokes (a standby is a spoke too). The hub is not one of them: it holds
 * the hub grant, which the spoke's person chose, and sends no delegated work.
 */
export function introducibleMembers(
  roster: HubRoster,
  spokeId: HubMemberId,
): ReadonlyArray<RosterMember> {
  return roster.members.filter(
    (member) =>
      (member.role === "guest" || member.role === "spoke" || member.role === "standby-hub") &&
      !sameId(member.memberId, spokeId),
  );
}

export type GuestIntroduction = {
  readonly grants: ReadonlyArray<PeerGrant>;
  readonly admitted: ReadonlyArray<RosterMember>;
  readonly dropped: ReadonlyArray<HubMemberId>;
};

/**
 * The grants a spoke holds for other members after it saw a verified roster. A
 * spoke that ticked Introduce admits every listed guest and spoke it holds no
 * grant for as a new member (a full member unless Confirm new members is on); a
 * spoke that did not admits none. A member the roster no longer lists loses its
 * grant, whether or not Introduce is ticked.
 */
export function introduceGuests(input: {
  readonly spokeId: HubMemberId;
  readonly roster: HubRoster;
  readonly grants: ReadonlyArray<PeerGrant>;
  readonly introduce: boolean;
  readonly confirmNewMembers: boolean;
}): GuestIntroduction {
  const listed = (grant: PeerGrant) =>
    input.roster.members.some((member) => sameId(member.memberId, grant.memberId));
  const kept = input.grants.filter(listed);
  const dropped = input.grants.filter((grant) => !listed(grant)).map((grant) => grant.memberId);
  if (!input.introduce) return { grants: kept, admitted: [], dropped };
  const fresh = introducibleMembers(input.roster, input.spokeId).filter(
    (guest) => !kept.some((grant) => sameId(grant.memberId, guest.memberId)),
  );
  const added = fresh.map(
    (guest) =>
      admitNewMember({
        spokeId: input.spokeId,
        member: guest,
        confirmNewMembers: input.confirmNewMembers,
        owners: [],
      }).grant,
  );
  return { grants: [...kept, ...added], admitted: fresh, dropped };
}

/** How long before a Tailscale certificate expires the host asks for a new one. */
export const TAILSCALE_CERTIFICATE_RENEW_BEFORE_MS = 14 * 24 * 60 * 60 * 1_000;

export type CertificateRenewal =
  | { readonly status: "current"; readonly renewAt: number }
  | { readonly status: "due"; readonly renewAt: number }
  | { readonly status: "expired" };

/**
 * Whether a certificate is still good, due for renewal, or past its end.
 * Renewal is due once less than `renewBeforeMs` of its life remains; a host
 * that was asleep through the whole window finds it expired and asks anew.
 */
export function tailscaleCertificateRenewal(input: {
  readonly notAfter: number;
  readonly now: number;
  readonly renewBeforeMs?: number;
}): CertificateRenewal {
  if (input.now >= input.notAfter) return { status: "expired" };
  const renewAt = input.notAfter - (input.renewBeforeMs ?? TAILSCALE_CERTIFICATE_RENEW_BEFORE_MS);
  return input.now >= renewAt ? { status: "due", renewAt } : { status: "current", renewAt };
}
