import { decodeEventActor, type EventActor } from "@octant/contracts";
import { OCTANT_LOCAL_ACTOR_ID } from "./shellService";

/** The actor a change made at one of this host's own windows is journaled with. */
const LOCAL_PERSON_ACTOR: EventActor = decodeEventActor({
  kind: "local-user",
  actorId: OCTANT_LOCAL_ACTOR_ID,
});

/**
 * What of an authenticated principal names the actor. A route's
 * `ClientPrincipal` and the principal an Automation command carries both
 * have this shape.
 */
export type ActingPrincipal =
  | { readonly kind: "local-window" }
  | { readonly kind: "remote-device"; readonly deviceId: string };

/**
 * The actor a request's change is journaled with. A paired device does what a
 * local window does (maintainer decision, 2026-11-12), and the journal is
 * what still tells the two apart: a device's change names the device, never
 * the local person. A request with no bound principal reached its handler on
 * the loopback listener under a window capability, so it is the local person's.
 *
 * Routes resolve this once from the authenticated principal and hand it to the
 * service as an argument; no service reads it from ambient state or from
 * anything the request carried. A service called with no actor journals the
 * local person, as the host's own callers (a routine, a benchmark) rely on.
 */
export function eventActorForPrincipal(principal: ActingPrincipal | undefined): EventActor {
  if (principal?.kind !== "remote-device") return LOCAL_PERSON_ACTOR;
  const deviceId = String(principal.deviceId);
  return decodeEventActor({ kind: "remote-device", actorId: deviceId, deviceId });
}
