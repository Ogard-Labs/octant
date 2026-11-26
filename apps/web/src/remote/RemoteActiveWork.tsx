import { createMachineChangeClient, createRemoteProductFetch } from "@octant/client-runtime";
import type { RemoteSessionBridge } from "@octant/client-runtime";
import type { OctantMode } from "@octant/contracts/modes";
import { useMemo } from "react";
import { ActiveWorkView } from "../activeWork/ActiveWorkView";
import type { ActiveWorkHost } from "../activeWork/useActiveWork";
import { pairedActiveWorkClient } from "../activeWork/useActiveWorkHosts";
import { useMachineChangeFeed } from "../polling/useMachineChangeFeed";

export interface RemoteActiveWorkProps {
  readonly bridge: RemoteSessionBridge;
  readonly hostId: string;
  readonly hostName: string;
  readonly connected: boolean;
  /** What the browser's own session says of the host. */
  readonly reach: ActiveWorkHost["reach"];
  /** When the session was last ready, for a host that stopped answering. */
  readonly lastReadyAt?: string;
  readonly onOpen: (thread: { readonly mode: OctantMode; readonly threadId: string }) => void;
}

/**
 * The host's active work in a paired browser, over the browser's own session.
 * The browser holds one session to one host, so it lists that host alone.
 */
export function RemoteActiveWork(props: RemoteActiveWorkProps) {
  const { bridge, connected, hostId, hostName, lastReadyAt, reach } = props;
  const changesClient = useMemo(
    () =>
      createMachineChangeClient({
        baseUrl: "http://127.0.0.1",
        fetch: createRemoteProductFetch({ bridge }),
        windowCapability: "",
      }),
    [bridge],
  );
  const changes = useMachineChangeFeed(changesClient);
  const revision = changes.chatNavigation + changes.workNavigation + changes.codeNavigation;
  const hosts = useMemo(
    () => [
      {
        hostId,
        name: hostName,
        reach,
        ...(lastReadyAt === undefined ? {} : { lastReadyAt }),
        client: pairedActiveWorkClient(bridge),
        revision,
      },
    ],
    [bridge, hostId, hostName, lastReadyAt, reach, revision],
  );
  return (
    <ActiveWorkView
      canOpen={() => connected}
      hosts={hosts}
      onOpen={(_host, row) => props.onOpen({ mode: row.mode, threadId: row.threadId })}
    />
  );
}
