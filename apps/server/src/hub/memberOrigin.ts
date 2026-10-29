import { NO_LISTENER_PIN, type RosterMember } from "@octant/contracts";

/** A member's listener origin from the roster entry that lists it; a guest has none. */
export function memberOrigin(member: RosterMember): string | undefined {
  if (member.listenerPin === NO_LISTENER_PIN) return undefined;
  const host = member.addresses[0] ?? member.privateNames[0];
  if (host === undefined) return undefined;
  const bracketed = host.includes(":") ? `[${host}]` : host;
  return `https://${bracketed}${member.listenerPort === undefined ? "" : `:${member.listenerPort}`}`;
}
