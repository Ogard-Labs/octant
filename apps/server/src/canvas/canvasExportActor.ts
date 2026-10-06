import { ActorId, EventActor, EventActorDeviceId } from "@octant/contracts";
import { Schema } from "effect";
import type { ClientPrincipal } from "../clientPrincipal";

/**
 * Journal attribution for a Canvas export, resolved from the transport
 * principal the host authenticated — never from a client-supplied field.
 * A paired remote device is journaled as that device so a remote approval
 * stays distinguishable from a local one; a local window (and anything
 * reaching the handler on the loopback listener under a proven window
 * capability) is attributed to the host's local user.
 */
const decodeActorId = Schema.decodeUnknownSync(ActorId);
const decodeEventActorDeviceId = Schema.decodeUnknownSync(EventActorDeviceId);

export function canvasExportEventActor(
  principal: ClientPrincipal,
  localUserActorId: string,
): typeof EventActor.Type {
  if (principal.kind === "remote-device") {
    const deviceId = decodeEventActorDeviceId(String(principal.deviceId));
    return { kind: "remote-device", actorId: decodeActorId(String(deviceId)), deviceId };
  }
  return { kind: "local-user", actorId: decodeActorId(localUserActorId) };
}
