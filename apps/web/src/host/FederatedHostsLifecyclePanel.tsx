import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type {
  FederatedHostLifecycleSnapshot,
  HostFederationLifecycle,
} from "@octant/client-runtime/host-federation-lifecycle";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { OctantButton } from "../ui/base/OctantButton";

/**
 * Post-preview B6: Settings surface for per-host compatibility / auth /
 * expiry / reconnect / revocation. One host failing never blocks the list or
 * actions on healthy hosts.
 */

export interface FederatedHostsLifecyclePanelProps {
  readonly lifecycle: HostFederationLifecycle;
}

const STATE_LABELS: Readonly<Record<FederatedHostLifecycleSnapshot["state"], string>> = {
  connecting: "Connecting",
  ready: "Ready",
  stale: "Stale",
  incompatible: "Incompatible",
  unauthorized: "Unauthorized",
  unavailable: "Unavailable",
};

function guidanceCopy(snapshot: FederatedHostLifecycleSnapshot): string | undefined {
  if (snapshot.reasonCode === "expired" || snapshot.expiry?.expired === true) {
    return "This browser's device credential expired. Re-pair to restore access.";
  }
  if (snapshot.reasonCode === "revoked") {
    return "Access was revoked on the host. Re-pair or remove this entry.";
  }
  if (snapshot.reasonCode === "lost-key") {
    return "This browser lost its device key. Re-pair to continue.";
  }
  if (snapshot.reasonCode === "host-changed") {
    return "The host identity changed. Re-pair before reconnecting.";
  }
  if (snapshot.state === "unauthorized" && snapshot.actions.canReconnect) {
    return "Session ended. Reconnect renews from this browser's device key without pairing again.";
  }
  return undefined;
}

function identityFacts(snapshot: FederatedHostLifecycleSnapshot): string {
  const parts: string[] = [snapshot.hostId];
  if (snapshot.origin !== undefined) {
    parts.push(snapshot.origin);
  }
  return parts.join(" · ");
}

function useLifecycleSnapshots(
  lifecycle: HostFederationLifecycle,
): ReadonlyArray<FederatedHostLifecycleSnapshot> {
  return useSyncExternalStore(
    (listener) => lifecycle.subscribe(listener),
    () => lifecycle.list(),
    () => lifecycle.list(),
  );
}

export function FederatedHostsLifecyclePanel(props: FederatedHostsLifecyclePanelProps) {
  const snapshots = useLifecycleSnapshots(props.lifecycle);
  const [busyHostId, setBusyHostId] = useState<string>();
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    void props.lifecycle.sync().catch((error: unknown) => {
      setMessage(
        error instanceof Error
          ? error.message
          : "Could not refresh federated host lifecycle state.",
      );
    });
  }, [props.lifecycle]);

  const runAction = useCallback(
    async (hostId: string, action: "reconnect" | "revoke" | "remove") => {
      setBusyHostId(hostId);
      setMessage(undefined);
      try {
        if (action === "reconnect") {
          const result = await props.lifecycle.reconnect(hostId);
          setMessage(
            result.ok
              ? result.replayCursor !== undefined
                ? `Reconnected ${hostId}; resuming from ${result.replayCursor}.`
                : `Reconnected ${hostId}.`
              : (result.reason ?? `Could not reconnect ${hostId}.`),
          );
          return;
        }
        if (action === "revoke") {
          const result = await props.lifecycle.revoke(hostId);
          setMessage(
            result.warning ??
              (result.localCredentialRemoved
                ? `Revoked and cleared credentials for ${hostId}.`
                : `Revoked ${hostId}; local credential cleanup incomplete.`),
          );
          return;
        }
        const result = await props.lifecycle.removeLocal(hostId);
        setMessage(
          result.localCredentialRemoved
            ? `Removed ${hostId} from this browser.`
            : `Removed ${hostId}; local credential cleanup incomplete.`,
        );
      } catch (error) {
        setMessage(
          error instanceof Error ? error.message : `The ${action} request could not be completed.`,
        );
      } finally {
        setBusyHostId(undefined);
      }
    },
    [props.lifecycle],
  );

  return (
    <section
      aria-label="Federated hosts"
      className="settings-card-section settings-card-section--open federated-hosts-lifecycle"
      id="settings-federated-hosts"
    >
      <h2>Federated hosts</h2>
      <p className="settings-section-note">
        Each host keeps its own connection state. Device credential expiry, revoke, or failure on
        one host never blocks the local host or other healthy hosts. A spent session reconnects from
        the paired device key; only a lost, revoked, or expired credential needs a new pair.
      </p>
      <ul className="federated-hosts-lifecycle__list">
        {snapshots.map((snapshot) => {
          const guidance = guidanceCopy(snapshot);
          const busy = busyHostId === snapshot.hostId;
          const isLocal = snapshot.hostId === LOCAL_HOST_ID;
          return (
            <li
              className="setrow federated-hosts-lifecycle__item"
              data-host-id={snapshot.hostId}
              data-host-state={snapshot.state}
              key={snapshot.hostId}
            >
              <span className="setrow-label">{snapshot.displayName}</span>
              <p className="setrow-hint">
                <span className="federated-hosts-lifecycle__facts">{identityFacts(snapshot)}</span>
                {" · "}
                <span className="federated-hosts-lifecycle__state">
                  {STATE_LABELS[snapshot.state]}
                  {snapshot.reasonCode !== undefined ? ` · ${snapshot.reasonCode}` : ""}
                </span>
                {guidance !== undefined ? (
                  <span className="federated-hosts-lifecycle__guidance">{guidance}</span>
                ) : snapshot.reason !== undefined ? (
                  <span className="federated-hosts-lifecycle__guidance">{snapshot.reason}</span>
                ) : null}
              </p>
              <div className="setrow-control federated-hosts-lifecycle__actions">
                {snapshot.actions.canReconnect ? (
                  <OctantButton
                    disabled={busy}
                    onClick={() => void runAction(snapshot.hostId, "reconnect")}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Reconnect
                  </OctantButton>
                ) : null}
                {snapshot.actions.canRevoke ? (
                  <OctantButton
                    disabled={busy}
                    onClick={() => void runAction(snapshot.hostId, "revoke")}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Revoke
                  </OctantButton>
                ) : null}
                {snapshot.actions.canRemove && !isLocal ? (
                  <OctantButton
                    disabled={busy}
                    onClick={() => void runAction(snapshot.hostId, "remove")}
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Remove
                  </OctantButton>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {message !== undefined ? (
        <p className="settings-section-line" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}

/** Compact shell strip summarizing non-ready federated hosts. */
export function FederatedHostsLifecycleStrip(props: FederatedHostsLifecyclePanelProps) {
  const snapshots = useLifecycleSnapshots(props.lifecycle);
  const attention = snapshots.filter(
    (entry) => entry.hostId !== LOCAL_HOST_ID && entry.state !== "ready",
  );
  if (attention.length === 0) return null;
  return (
    <div
      aria-label="Federated host attention"
      className="federated-hosts-lifecycle-strip"
      role="status"
    >
      {attention.map((entry) => (
        <span data-host-id={entry.hostId} key={entry.hostId}>
          {entry.displayName}: {STATE_LABELS[entry.state]}
          {entry.reasonCode !== undefined ? ` (${entry.reasonCode})` : ""}
        </span>
      ))}
    </div>
  );
}
