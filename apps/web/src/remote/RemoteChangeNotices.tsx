import { createAccessActivityClient } from "@octant/client-runtime/access-activity-client";
import {
  createMachineChangeClient,
  createRemoteProductFetch,
  type RemoteSessionBridge,
} from "@octant/client-runtime";
import { useMemo } from "react";
import { useMachineChangeFeed } from "../polling/useMachineChangeFeed";
import { ChangeNotices } from "../host/ChangeNotices";

/**
 * Change notices for a browser paired at Full, over its own session. The host
 * answers no other device; it acts through the notice routes, which take a Full
 * device's session as the person's.
 */
export function RemoteChangeNotices(props: { readonly bridge: RemoteSessionBridge }) {
  const fetch = useMemo(() => createRemoteProductFetch({ bridge: props.bridge }), [props.bridge]);
  const client = useMemo(
    () =>
      createAccessActivityClient({
        // The session's fetch ignores the origin, as every remote product client's does.
        baseUrl: "http://127.0.0.1",
        fetch,
      }),
    [fetch],
  );
  const changesClient = useMemo(
    () =>
      createMachineChangeClient({
        baseUrl: "http://127.0.0.1",
        fetch,
        windowCapability: "",
      }),
    [fetch],
  );
  const changes = useMachineChangeFeed(changesClient);
  return <ChangeNotices changeRevision={changes.changeNotices} client={client} />;
}
