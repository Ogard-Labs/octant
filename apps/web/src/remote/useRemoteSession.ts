import { useEffect, useState } from "react";
import type { RemoteSessionBridge, RemoteSessionBridgeState } from "@octant/client-runtime";

export function useRemoteSession(client: RemoteSessionBridge): RemoteSessionBridgeState {
  const [state, setState] = useState<RemoteSessionBridgeState>(() => client.getState());

  useEffect(() => {
    setState(client.getState());
    return client.subscribe((next) => {
      setState(next);
    });
  }, [client]);

  return state;
}
