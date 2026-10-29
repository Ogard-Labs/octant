// The one place the wake service touches a UDP socket. A magic packet goes to
// the LAN broadcast address and nowhere else, so it cannot leave the local
// network, and tests replace the port with one that records what it was given.

import { createSocket } from "node:dgram";
import { WAKE_ON_LAN_PORT } from "@octant/domain";

const LAN_BROADCAST_ADDRESS = "255.255.255.255";

export interface WakeOnLanPort {
  /** Sends one magic packet on the LAN broadcast; true when the socket accepted it. */
  readonly broadcast: (packet: Uint8Array) => Promise<boolean>;
}

export function createUdpWakeOnLanPort(): WakeOnLanPort {
  return {
    broadcast: (packet) =>
      new Promise<boolean>((resolve) => {
        const socket = createSocket("udp4");
        const finish = (sent: boolean) => {
          try {
            socket.close();
          } catch {
            // A socket that failed to open has nothing to close.
          }
          resolve(sent);
        };
        socket.once("error", () => finish(false));
        socket.bind(() => {
          try {
            socket.setBroadcast(true);
          } catch {
            finish(false);
            return;
          }
          socket.send(packet, WAKE_ON_LAN_PORT, LAN_BROADCAST_ADDRESS, (error) =>
            finish(error === null),
          );
        });
      }),
  };
}
