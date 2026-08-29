import { useCallback, useEffect, useRef, useState } from "react";
import {
  createClientHostRegistry,
  createDefaultDeviceKeyStore,
  createRemotePairingClient,
  createRemoteSessionBridge,
  isRemotePairingFailure,
  parseTypedPairingCode,
  readPairingFragment,
  registerPairedRemoteHost,
  type ClientHostRegistry,
  type RemotePairingApproval,
  type RemotePairingClaim,
  type RemotePairingClient,
  type RemotePairingTicket,
  type RemoteSessionBridgeState,
  type RemoteSessionBridge,
} from "@octant/client-runtime";
import type { HostHelloV1 } from "@octant/contracts/remote-access";
import { createBrowserHostRegistryStorage } from "../host/browserHostRegistryStorage";

const REMOTE_WEB_BUILD_VERSION = "0.1.0";
const POLL_INTERVAL_MS = 1_000;

type FailedCategory =
  | "denied"
  | "expired"
  | "revoked"
  | "lost-key"
  | "host-changed"
  | "incompatible"
  | "invalid"
  | "rate-limited"
  | "recovery-required"
  | "unavailable";

export type RemotePairingScreen =
  | { readonly kind: "entry"; readonly inputError?: string }
  | { readonly kind: "requesting-hello" }
  | {
      readonly kind: "confirm";
      readonly hostHello: HostHelloV1;
      readonly ticket: RemotePairingTicket;
    }
  | { readonly kind: "claiming" }
  | { readonly kind: "waiting"; readonly claim: RemotePairingClaim }
  | { readonly kind: "approved"; readonly approval: RemotePairingApproval }
  | { readonly kind: "resuming" }
  | { readonly kind: "resumed" }
  | { readonly kind: "failed"; readonly category: FailedCategory; readonly message: string };

export interface UseRemotePairingOptions {
  readonly baseUrl: string;
  readonly ticket?: RemotePairingTicket | undefined;
  readonly client?: RemotePairingClient;
  readonly sessionClient?: RemoteSessionBridge;
  readonly deviceKeyStore?: ReturnType<typeof createDefaultDeviceKeyStore>;
  /** Defaults to the shared browser federation registry storage. */
  readonly hostRegistry?: ClientHostRegistry;
  readonly replaceFragment?: ((href: string) => void) | undefined;
}

export interface UseRemotePairingResult {
  readonly screen: RemotePairingScreen;
  readonly typedCode: string;
  readonly setTypedCode: (value: string) => void;
  readonly submitTypedCode: () => void;
  readonly confirmPairing: (deviceLabel: string) => void;
  readonly retry: () => void;
  readonly reset: () => void;
}

export function useRemotePairing(options: UseRemotePairingOptions): UseRemotePairingResult {
  const deviceKeyStore = options.deviceKeyStore ?? createDefaultDeviceKeyStore();
  const hostRegistry =
    options.hostRegistry ?? createClientHostRegistry(createBrowserHostRegistryStorage());
  const client =
    options.client ??
    createRemotePairingClient({
      baseUrl: options.baseUrl,
      fetch: globalThis.fetch,
      webBuildVersion: REMOTE_WEB_BUILD_VERSION,
      deviceKeyStore,
    });
  const sessionClient =
    options.sessionClient ??
    createRemoteSessionBridge({
      fetch: globalThis.fetch,
      deviceKeyStore,
    });
  const replaceFragment =
    options.replaceFragment ??
    ((href) => {
      if (typeof window !== "undefined" && window.history?.replaceState) {
        const url = new URL(href);
        url.hash = "";
        window.history.replaceState(null, "", url.toString());
      }
    });

  const [screen, setScreen] = useState<RemotePairingScreen>({ kind: "entry" });
  const [typedCode, setTypedCode] = useState("");
  const ticketRef = useRef<RemotePairingTicket | undefined>(options.ticket);
  const pollingRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const lastClaimRef = useRef<RemotePairingClaim | undefined>(undefined);
  const isMountedRef = useRef(true);
  const fragmentHandledRef = useRef(false);
  const resumeStartedRef = useRef(false);
  const resumeFlowRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollingRef.current !== undefined) {
      clearInterval(pollingRef.current);
      pollingRef.current = undefined;
    }
  }, []);

  const setFailed = useCallback(
    (category: FailedCategory, message: string) => {
      stopPolling();
      setScreen({ kind: "failed", category, message });
    },
    [stopPolling],
  );

  const clearAndSetTicket = useCallback(
    (ticket: RemotePairingTicket, href: string) => {
      ticketRef.current = ticket;
      replaceFragment(href);
      setScreen({ kind: "requesting-hello" });
    },
    [replaceFragment],
  );

  const requestHello = useCallback(async () => {
    try {
      const hello = await client.requestHostHello();
      if (!isMountedRef.current) return;
      const ticket = ticketRef.current;
      if (ticket === undefined) {
        setScreen({ kind: "entry" });
        return;
      }
      setScreen({ kind: "confirm", hostHello: hello, ticket });
    } catch (error) {
      if (!isMountedRef.current) return;
      if (isRemotePairingFailure(error)) {
        setFailed(
          error.category === "rate-limited" ? "rate-limited" : "unavailable",
          error.message,
        );
      } else {
        setFailed("unavailable", "Octant host is unavailable.");
      }
    }
  }, [client, setFailed]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (fragmentHandledRef.current) return;
    fragmentHandledRef.current = true;
    const ticket = options.ticket ?? readPairingFragment(window.location.href);
    if (ticket !== undefined) {
      clearAndSetTicket(ticket, window.location.href);
    }
  }, [options.ticket, clearAndSetTicket]);

  useEffect(() => {
    if (options.ticket !== undefined || ticketRef.current !== undefined) return;
    resumeFlowRef.current = true;
    const unsubscribe = sessionClient.subscribe((state: RemoteSessionBridgeState) => {
      if (state.kind === "idle") {
        setScreen({ kind: "entry" });
      } else if (state.kind === "ready") {
        setScreen({ kind: "resumed" });
      } else if (state.kind === "unauthorized") {
        // The wire is deliberately generic for unauthenticated rejections
        // (remote redaction contract), so a rejected resume maps to an
        // explicit recovery state rather than the pairing-flow "denied" copy.
        const category = state.reasonCode ?? "recovery-required";
        setFailed(category, state.reason);
      } else if (state.kind === "incompatible") {
        setFailed("incompatible", state.reason);
      } else if (state.kind === "unavailable") {
        setFailed("unavailable", state.reason);
      }
    });
    // StrictMode runs effect setup, cleanup, and setup again. Subscribe on
    // every setup so an in-flight resume can deliver its terminal state after
    // the first subscription is cleaned up, but only start the async resume
    // once. A current non-idle state also needs replaying for the second setup.
    if (!resumeStartedRef.current) {
      resumeStartedRef.current = true;
      setScreen({ kind: "resuming" });
      sessionClient.resume(options.baseUrl);
    } else {
      const current = sessionClient.getState();
      if (current.kind !== "idle") {
        if (current.kind === "ready") {
          setScreen({ kind: "resumed" });
        } else if (current.kind === "unauthorized") {
          setFailed(current.reasonCode ?? "recovery-required", current.reason);
        } else if (current.kind === "incompatible") {
          setFailed("incompatible", current.reason);
        } else if (current.kind === "unavailable") {
          setFailed("unavailable", current.reason);
        }
      }
    }
    return unsubscribe;
  }, [options.baseUrl, options.ticket, sessionClient, setFailed]);

  useEffect(() => {
    if (screen.kind === "requesting-hello") {
      void requestHello();
    }
  }, [screen.kind, requestHello]);

  const recordApprovedHost = useCallback(
    async (approval: RemotePairingApproval, claim: RemotePairingClaim) => {
      try {
        await registerPairedRemoteHost({
          registry: hostRegistry,
          approval,
          displayName: claim.hostDisplayName,
          hostKeyFingerprint: claim.hostKeyFingerprint,
        });
      } catch {
        // Pairing still succeeded; Settings may miss this host until the next
        // successful pair. Do not fail the session for a registry write miss.
      }
    },
    [hostRegistry],
  );

  const pollStatus = useCallback(
    async (ticket: RemotePairingTicket, claim: RemotePairingClaim) => {
      try {
        const status = await client.pollPairingStatus({ ticket, claim });
        if (!isMountedRef.current) return;
        if (status.kind === "pending") return;
        if (status.kind === "approved") {
          stopPolling();
          lastClaimRef.current = undefined;
          await recordApprovedHost(status.approval, claim);
          if (!isMountedRef.current) return;
          setScreen({ kind: "approved", approval: status.approval });
          sessionClient.connect(status.approval);
          return;
        }
        stopPolling();
        if (!status.retryable) {
          lastClaimRef.current = undefined;
        }
        setFailed(status.category, status.message);
      } catch (error) {
        if (!isMountedRef.current) return;
        if (isRemotePairingFailure(error)) {
          setFailed(
            error.category === "rate-limited" ? "rate-limited" : "unavailable",
            error.message,
          );
        } else {
          setFailed("unavailable", "Octant host is unreachable.");
        }
      }
    },
    [client, recordApprovedHost, sessionClient, setFailed, stopPolling],
  );

  useEffect(() => {
    if (screen.kind === "waiting") {
      const ticket = ticketRef.current;
      if (ticket === undefined) {
        setScreen({ kind: "entry" });
        return;
      }
      void pollStatus(ticket, screen.claim);
      pollingRef.current = setInterval(() => {
        void pollStatus(ticket, screen.claim);
      }, POLL_INTERVAL_MS);
      return () => {
        stopPolling();
      };
    }
  }, [screen, pollStatus, stopPolling]);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      stopPolling();
      const claim = lastClaimRef.current;
      if (claim !== undefined) {
        void client.removeDeviceKey(claim.deviceKeyId);
      }
    };
  }, [client, stopPolling]);

  const submitTypedCode = useCallback(() => {
    const ticket = parseTypedPairingCode(typedCode);
    if (ticket === undefined) {
      setScreen({ kind: "entry", inputError: "Enter a valid pairing link or code." });
      return;
    }
    setScreen({ kind: "requesting-hello" });
    ticketRef.current = ticket;
  }, [typedCode]);

  const confirmPairing = useCallback(
    (deviceLabel: string) => {
      const current = screen;
      if (current.kind !== "confirm") return;
      setScreen({ kind: "claiming" });
      void (async () => {
        try {
          const claim = await client.claimPairing({
            ticket: current.ticket,
            deviceLabel,
            hostHello: current.hostHello,
          });
          if (!isMountedRef.current) return;
          lastClaimRef.current = claim;
          setScreen({ kind: "waiting", claim });
        } catch (error) {
          if (!isMountedRef.current) return;
          if (isRemotePairingFailure(error)) {
            setFailed(
              error.category === "rate-limited" ? "rate-limited" : "unavailable",
              error.message,
            );
          } else {
            setFailed("unavailable", "Octant host is unreachable.");
          }
        }
      })();
    },
    [client, screen, setFailed],
  );

  const retry = useCallback(() => {
    const claim = lastClaimRef.current;
    if (claim !== undefined) {
      setScreen({ kind: "waiting", claim });
      return;
    }
    const ticket = ticketRef.current;
    if (ticket === undefined) {
      if (resumeFlowRef.current) {
        setScreen({ kind: "resuming" });
        sessionClient.resume(options.baseUrl);
        return;
      }
      setScreen({ kind: "entry" });
      return;
    }
    setScreen({ kind: "requesting-hello" });
  }, [options.baseUrl, sessionClient]);

  const reset = useCallback(() => {
    stopPolling();
    const claim = lastClaimRef.current;
    if (claim !== undefined) {
      void client.removeDeviceKey(claim.deviceKeyId);
      lastClaimRef.current = undefined;
    }
    ticketRef.current = undefined;
    setTypedCode("");
    setScreen({ kind: "entry" });
  }, [client, stopPolling]);

  return {
    screen,
    typedCode,
    setTypedCode,
    submitTypedCode,
    confirmPairing,
    retry,
    reset,
  };
}
