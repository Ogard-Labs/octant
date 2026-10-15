import { useEffect, useState } from "react";
import type { RunningService } from "@octant/contracts";
import { LocalServerClientFailure, type LocalServerClient } from "@octant/client-runtime";
import type { RemoteSessionFacts } from "@octant/client-runtime";
import type { ListenerOriginTrust } from "@octant/client-runtime/remote-listener-trust";
import {
  createRemoteServerProxyClient,
  type RemoteServerProxyClient,
} from "@octant/client-runtime/remote-server-proxy-client";
import type { RemoteOpenMode, RemoteOpenOutcome } from "./runningServices";

/** The desktop's half: it shows a granted page, and asks this window to sign its requests. */
export interface RemoteServerLiveBridge {
  readonly openRemoteServerPage: (
    request: unknown,
  ) => Promise<
    | { readonly kind: "opened"; readonly notice?: string }
    | { readonly kind: "refused"; readonly message: string }
  >;
  readonly subscribeRemoteServerPageSigning: (
    signer: (request: unknown) => Promise<unknown>,
  ) => () => void;
}

/** A paired computer this window reads, with what it takes to prove this device to it. */
export interface RemoteServerLiveHost {
  readonly hostId: string;
  readonly hostName: string;
  readonly origin: string;
  readonly listenerTrust: ListenerOriginTrust;
  /** Mints a proxy session with this device's key. */
  readonly issueSession: () => Promise<RemoteSessionFacts>;
  /** Signs with this device's non-extractable key for that host. */
  readonly sign: (payload: string) => Promise<string>;
}

export interface RemoteServerLiveOpener {
  readonly openLive: (
    host: RemoteServerLiveHost,
    service: RunningService,
    mode: RemoteOpenMode,
  ) => Promise<RemoteOpenOutcome>;
  /** Stops signing for the pages this window opened. */
  readonly dispose: () => void;
}

/**
 * Opens a Running services row of another computer live on this one: the
 * host grants it, the desktop serves it on its own name, and this window
 * signs the page's requests for as long as it is open. This window signs only
 * for the grants it was given, through the proxy client of the host that gave
 * them.
 */
export function createRemoteServerLiveOpener(
  bridge: RemoteServerLiveBridge,
  fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): RemoteServerLiveOpener {
  const clients = new Map<string, RemoteServerProxyClient>();
  const unsubscribe = bridge.subscribeRemoteServerPageSigning(async (value) => {
    const request = decodeSignRequest(value);
    const client = request === undefined ? undefined : clients.get(request.hostId);
    if (request === undefined || client === undefined) return { status: "refused" };
    return client.signRelayRequest(request);
  });
  return {
    openLive: async (host, service, mode) => {
      let client = clients.get(host.hostId);
      if (client === undefined) {
        client = createRemoteServerProxyClient({
          origin: host.origin,
          hostName: host.hostName,
          fetch,
          issueSession: host.issueSession,
          sign: host.sign,
        });
        clients.set(host.hostId, client);
      }
      const opening = await client.openGrant({
        surface: "running-services",
        listenerId: service.listenerId,
      });
      if (opening.status === "refused") return { kind: "refused", message: opening.message };
      const shown = await bridge.openRemoteServerPage({
        hostId: host.hostId,
        hostName: host.hostName,
        listenerOrigin: host.origin,
        listenerTrust: host.listenerTrust,
        grant: opening.grant,
        mode,
      });
      if (shown.kind === "refused") return shown;
      return shown.notice === undefined
        ? { kind: "opened" }
        : { kind: "opened", notice: shown.notice };
    },
    dispose: () => {
      unsubscribe();
      for (const client of clients.values()) client.forget();
      clients.clear();
    },
  };
}

function decodeSignRequest(value: unknown):
  | {
      readonly hostId: string;
      readonly grantId: string;
      readonly method: string;
      readonly pathQuery: string;
      readonly bodyDigest: string;
    }
  | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { hostId, grantId, method, pathQuery, bodyDigest } = value as Record<string, unknown>;
  if (
    typeof hostId !== "string" ||
    typeof grantId !== "string" ||
    typeof method !== "string" ||
    typeof pathQuery !== "string" ||
    typeof bodyDigest !== "string"
  ) {
    return undefined;
  }
  return { hostId, grantId, method, pathQuery, bodyDigest };
}

/**
 * The window's live opener while the desktop offers one; outside the desktop
 * app there is none and rows keep their picture of the page.
 */
export function useRemoteServerLiveOpener(
  bridge: Partial<RemoteServerLiveBridge> | undefined,
): RemoteServerLiveOpener | undefined {
  const [opener, setOpener] = useState<RemoteServerLiveOpener>();
  const openPage = bridge?.openRemoteServerPage;
  const subscribe = bridge?.subscribeRemoteServerPageSigning;
  useEffect(() => {
    if (openPage === undefined || subscribe === undefined) return undefined;
    const created = createRemoteServerLiveOpener({
      openRemoteServerPage: openPage,
      subscribeRemoteServerPageSigning: subscribe,
    });
    setOpener(created);
    return () => {
      created.dispose();
      setOpener(undefined);
    };
  }, [openPage, subscribe]);
  return opener;
}

/**
 * The Running services reader for a paired computer the window is narrowed to
 * but cannot reach yet. Every read fails with that computer's name, so the
 * card says it could not check rather than listing this computer's servers
 * under the other's name, where Stop would act on the wrong computer.
 */
export function disconnectedRunningServicesClient(hostName: string): LocalServerClient {
  const refuse = async (): Promise<never> => {
    throw new LocalServerClientFailure(`${hostName} isn't connected, so Octant can't check.`, 0);
  };
  return { execute: refuse, executeRunningServices: refuse };
}
