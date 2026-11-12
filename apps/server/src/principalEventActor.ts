import { decodeEventActor, type EventActor } from "@octant/contracts";
import type { ClientPrincipal } from "./clientPrincipal";
import { OCTANT_LOCAL_ACTOR_ID } from "./shellService";

/**
 * The actor a change made at one of this host's own windows is journaled
 * with. Host callers that act for the person with no request (a routine, a
 * benchmark) pass it too.
 */
export const LOCAL_PERSON_ACTOR: EventActor = decodeEventActor({
  kind: "local-user",
  actorId: OCTANT_LOCAL_ACTOR_ID,
});

/**
 * The actor a request's change is journaled with. A paired device does what a
 * local window does (maintainer decision, 2026-11-12), and the journal is
 * what still tells the two apart: a device's change names the device, never
 * the local person. A request with no bound principal reached its handler on
 * the loopback listener under a window capability, so it is the local person's.
 *
 * Routes resolve this once from the authenticated principal and hand it to the
 * service as an argument; no service reads it from ambient state or from
 * anything the request carried.
 */
export function eventActorForPrincipal(principal: ClientPrincipal | undefined): EventActor {
  if (principal?.kind !== "remote-device") return LOCAL_PERSON_ACTOR;
  const deviceId = String(principal.deviceId);
  return decodeEventActor({ kind: "remote-device", actorId: deviceId, deviceId });
}
