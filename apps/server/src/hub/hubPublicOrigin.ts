// Where the public reaches this host while it serves as the hub. The device
// relay's address and a visitor link's whole URL are both built from it, and
// both reach a spoke only in an answer over the signed hub link.

import type { HubState } from "./hubStateStore";

/**
 * The public address the person typed for their own front, or else the Funnel
 * front on this host's tailnet name, as the local Tailscale daemon reports it
 * (`funnelName`). The roster's private names stand in until that is read; a
 * listener bound to an IP address has none. Undefined while the hub role or
 * the entrance is off, or the address is not known.
 */
export function hubPublicOrigin(
  state: HubState,
  hubMemberId: string,
  funnelName?: string,
): string | undefined {
  const entrance = state.publicEntrance;
  if (state.hub?.enabled !== true || entrance?.enabled !== true) return undefined;
  if (entrance.ownFrontOrigin !== undefined) return entrance.ownFrontOrigin;
  if (entrance.funnel === undefined) return undefined;
  const self = state.hub.roster?.roster.members.find(
    (member) => String(member.memberId) === hubMemberId,
  );
  const name = [funnelName, ...(self?.privateNames ?? [])].find((candidate) =>
    candidate?.endsWith(".ts.net"),
  );
  if (name === undefined) return undefined;
  return entrance.funnel.port === 443
    ? `https://${name}`
    : `https://${name}:${entrance.funnel.port}`;
}
