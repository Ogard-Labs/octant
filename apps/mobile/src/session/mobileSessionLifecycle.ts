import type { RemoteSessionBridge } from "@octant/client-runtime";
import type { MobileHostSessionHub } from "./MobileHostSessionHub";

export function disconnectLiveMobileSession(input: {
  readonly bridge: Pick<RemoteSessionBridge, "disconnect">;
  readonly hub: Pick<MobileHostSessionHub, "disconnectAll">;
}): void {
  input.hub.disconnectAll();
  input.bridge.disconnect();
}
