import { createProviderToolingClient } from "@octant/client-runtime/provider-tooling-client";
import { useMemo, type ComponentProps } from "react";
import { ProviderToolingPanel } from "../extensions/ProviderToolingPanel";
import type { RemoteProductPort } from "./remoteProductClients";

/**
 * The Claude and Codex tab over the session. The host takes it only from a
 * device its own person paired, so the shell mounts this for no other session.
 */
export function RemoteProviderTooling(
  props: Pick<ComponentProps<typeof ProviderToolingPanel>, "accounts" | "onOpenRunAsItself"> & {
    readonly port: RemoteProductPort;
  },
) {
  const { port, ...panel } = props;
  const client = useMemo(() => createProviderToolingClient(port), [port]);
  return <ProviderToolingPanel {...panel} client={client} localHost />;
}
