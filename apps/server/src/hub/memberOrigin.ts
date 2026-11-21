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
  return `https://${bracketed}${member.listenerPort === undefined ? "" : `:${member.listenerPort}`}`;
}

/**
 * The members a desktop window on this host may add as computers: the spokes
 * and standbys of the roster this host holds, other than this host, each at a
 * private origin and the pin the roster names. The hub is not one: it has no
 * Act item of its own to bound a device it introduced to itself, and a guest
 * runs no listener.
 */
export function windowComputersFrom(input: {
  readonly roster: SignedHubRoster;
  readonly selfMemberId: string;
}): ReadonlyArray<HubWindowComputer> {
  return input.roster.roster.members.flatMap((member): ReadonlyArray<HubWindowComputer> => {
    if (member.role !== "spoke" && member.role !== "standby-hub") return [];
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
      },
    ];
  });
}
