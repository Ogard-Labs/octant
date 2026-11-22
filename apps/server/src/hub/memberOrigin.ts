import {
  NO_LISTENER_PIN,
  type HubWindowComputer,
  type RosterMember,
  type SignedHubRoster,
} from "@octant/contracts";
import { listenerPinFromDigest } from "./hubCrypto";
import { originIsPrivate } from "./privateListenerReading";

/** A member's listener origin from the roster entry that lists it; a guest has none. */
export function memberOrigin(member: RosterMember): string | undefined {
  if (member.listenerPin === NO_LISTENER_PIN) return undefined;
  const host = member.addresses[0] ?? member.privateNames[0];
  if (host === undefined) return undefined;
  const bracketed = host.includes(":") ? `[${host}]` : host;
  // HTTPS's default port is left out, as the canonical origin does: a roster
  // entry carrying 443 built `https://host:443`, which no listener origin
  // equals, so that member was never listed.
  const port =
    member.listenerPort === undefined || member.listenerPort === 443
      ? ""
      : `:${member.listenerPort}`;
  return `https://${bracketed}${port}`;
}

/**
 * The members a desktop window on this host may add as computers: the hub,
 * the spokes, and the standbys of the roster this host holds, other than this
 * host, each at a private origin and the pin the roster names. The hub is
 * marked, because it holds such a window to its own Act list where a member
 * holds it to its Act item (maintainer decision, 2026-11-21). A guest runs no
 * listener.
 */
export function windowComputersFrom(input: {
  readonly roster: SignedHubRoster;
  readonly selfMemberId: string;
}): ReadonlyArray<HubWindowComputer> {
  return input.roster.roster.members.flatMap((member): ReadonlyArray<HubWindowComputer> => {
    if (member.role === "guest") return [];
    if (String(member.memberId) === input.selfMemberId) return [];
    const origin = memberOrigin(member);
    if (origin === undefined || !originIsPrivate(origin)) return [];
    return [
      {
        memberId: member.memberId,
        name: member.name,
        origin,
        pin: listenerPinFromDigest(member.listenerPin),
        identityKeyFingerprint: member.identityKeyFingerprint,
        ...(member.role === "hub" ? { role: "hub" as const } : {}),
      },
    ];
  });
}
