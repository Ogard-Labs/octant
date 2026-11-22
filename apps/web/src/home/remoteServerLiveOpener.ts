import { useEffect, useState } from "react";
import type { RemoteServerGrantSource } from "@octant/contracts";
import { LocalServerClientFailure, type LocalServerClient } from "@octant/client-runtime";
import type { RemoteSessionFacts } from "@octant/client-runtime";
import {
  createRemoteServerProxyClient,
  type RemoteServerProxyClient,
} from "@octant/client-runtime/remote-server-proxy-client";
import type { RemoteForwardOutcome, RemoteOpenMode, RemoteOpenOutcome } from "./runningServices";

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
  /** Listens on this computer's loopback for a forward the host opened. */
  readonly openRemotePortForward?: (
    request: unknown,
  ) => Promise<
    | { readonly kind: "listening"; readonly port: number }
    | { readonly kind: "refused"; readonly message: string }
  >;
}

/** A paired computer this window reads, with what it takes to prove this device to it. */
export interface RemoteServerLiveHost {
  readonly hostId: string;
  readonly hostName: string;
  readonly origin: string;
  /**
   * Which of this device's credentials for that host signs. A hub re-admits a
   * member window under a replacement credential with the same host ID, so a
   * client built for the old key would sign every new request with a key the
   * host no longer knows.
   */
  readonly credentialKeyId?: string;
  /** Mints a proxy session with this device's key. */
  readonly issueSession: () => Promise<RemoteSessionFacts>;
  /** Signs with this device's non-extractable key for that host. */
  readonly sign: (payload: string) => Promise<string>;
  /**
   * How requests to this host travel, when the window's own fetch cannot reach
   * it: a computer paired through Other computers is reached through the
   * desktop, because the window's page policy allows loopback only.
   */
  readonly fetch?: typeof globalThis.fetch;
}

export interface RemoteServerProjectPreviewTarget {
  readonly projectId: string;
  readonly remotePort: number;
  readonly grantId: string;
}

export interface RemoteServerLiveOpener {
  /**
   * Asks the host for a grant to one server it lists, by the listing the row
   * came from (the start screen's Running services, or a thread's Local
   * servers), and shows it.
   */
  readonly openLive: (
    host: RemoteServerLiveHost,
    source: RemoteServerGrantSource,
    mode: RemoteOpenMode,
  ) => Promise<RemoteOpenOutcome>;
  /**
   * Forwards one port of another computer to this computer's loopback; absent
   * from the opener where the desktop offers no forward.
   */
  readonly openForward?: (
    host: RemoteServerLiveHost,
    target: number | RemoteServerGrantSource,
  ) => Promise<RemoteForwardOutcome>;
  /**
   * Opens a relayed server Project preview through the desktop's isolated
   * forwarder, minting a proxy session and signing every request for its grant.
   */
  readonly openServerProjectPreview: (
    host: RemoteServerLiveHost,
    preview: RemoteServerProjectPreviewTarget,
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
  const clients = new Map<
    string,
    { readonly client: RemoteServerProxyClient; readonly credentialKeyId: string | undefined }
  >();
  const unsubscribe = bridge.subscribeRemoteServerPageSigning(async (value) => {
    const request = decodeSignRequest(value);
    const client = request === undefined ? undefined : clients.get(request.hostId)?.client;
    if (request === undefined || client === undefined) return { status: "refused" };
    return client.signRelayRequest(request);
  });
  const clientFor = (host: RemoteServerLiveHost): RemoteServerProxyClient => {
    const held = clients.get(host.hostId);
    if (held !== undefined && held.credentialKeyId === host.credentialKeyId) return held.client;
    held?.client.forget();
    const client = createRemoteServerProxyClient({
      origin: host.origin,
      hostName: host.hostName,
      fetch: host.fetch ?? fetch,
      issueSession: host.issueSession,
      sign: host.sign,
    });
    clients.set(host.hostId, { client, credentialKeyId: host.credentialKeyId });
    return client;
  };
  const openRemotePortForward = bridge.openRemotePortForward;
  return {
    ...(openRemotePortForward === undefined
      ? {}
      : {
          openForward: async (
            host: RemoteServerLiveHost,
            target: number | RemoteServerGrantSource,
          ) => {
            const opening = await clientFor(host).openForward(target);
            if (opening.status === "refused") return { kind: "refused", message: opening.message };
            const listening = await openRemotePortForward({
              hostId: host.hostId,
              listenerOrigin: host.origin,
              forward: opening.forward,
            });
            return listening.kind === "refused"
              ? listening
              : { kind: "forwarded", localPort: listening.port };
          },
        }),
    openLive: async (host, source, mode) => {
      const opening = await clientFor(host).openGrant(source);
      if (opening.status === "refused") return { kind: "refused", message: opening.message };
      const shown = await bridge.openRemoteServerPage({
        hostId: host.hostId,
        hostName: host.hostName,
        listenerOrigin: host.origin,
        grant: opening.grant,
        mode,
      });
      if (shown.kind === "refused") return shown;
      return shown.notice === undefined
        ? { kind: "opened" }
        : { kind: "opened", notice: shown.notice };
    },
    openServerProjectPreview: async (host, preview, mode) => {
      const client = clientFor(host);
      const adopted = await client.adoptGrant(preview.grantId);
      if (adopted.status === "refused") return { kind: "refused", message: adopted.message };
      const shown = await bridge.openRemoteServerPage({
        hostId: host.hostId,
        hostName: host.hostName,
        listenerOrigin: host.origin,
        grant: {
          grantId: preview.grantId,
          threadId: preview.projectId,
          port: preview.remotePort,
          openedAt: new Date().toISOString(),
        },
        mode,
      });
      if (shown.kind === "refused") return shown;
      return shown.notice === undefined
        ? { kind: "opened" }
        : { kind: "opened", notice: shown.notice };
    },
    dispose: () => {
      unsubscribe();
      for (const held of clients.values()) held.client.forget();
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
  const openForward = bridge?.openRemotePortForward;
  useEffect(() => {
    if (openPage === undefined || subscribe === undefined) return undefined;
    const created = createRemoteServerLiveOpener({
      openRemoteServerPage: openPage,
      subscribeRemoteServerPageSigning: subscribe,
      ...(openForward === undefined ? {} : { openRemotePortForward: openForward }),
    });
    setOpener(created);
    return () => {
      created.dispose();
      setOpener(undefined);
    };
  }, [openPage, subscribe, openForward]);
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
