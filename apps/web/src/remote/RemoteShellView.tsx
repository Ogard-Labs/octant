import { ContinuityScreenContext } from "../continuity/ContinueElsewhere";
import { readContinuationLink } from "../continuity/continuationLink";
import type { OctantMode } from "@octant/contracts/modes";
import { useEffect, useMemo, useState } from "react";
import type { RemoteSessionBridge } from "@octant/client-runtime";
import { createConnectionSupervisor, type ConnectionStatus } from "@octant/client-runtime";
import { useConnectionStatus } from "@octant/client-runtime/use-connection-status";
import {
  buildRemoteHostObservation,
  canExecuteRemoteProductMutation,
  listRemoteShellSurfacesByAvailability,
  readRemoteSessionStanding,
  RESTRICTED_REMOTE_SESSION,
  type RemoteSessionStanding,
} from "@octant/client-runtime";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCard } from "../ui/base/OctantCard";
import { HostStatus } from "../shell/HostSelector";
import { ModeSwitcher } from "../shell/ModeSwitcher";
import { SyncStatusReadOnly } from "../settings/SyncMembershipSections";
import { ShellState } from "../shell/ShellState";
import { RemoteDeviceSelfPanel } from "./RemoteDeviceSelfPanel";
import { createRemoteExtensionClient, createRemoteProductClients } from "./remoteProductClients";
import { RemoteWorkspace } from "./RemoteWorkspace";
import { useRemoteSession } from "./useRemoteSession";

export interface RemoteShellViewProps {
  readonly bridge: RemoteSessionBridge;
  readonly onReset: (warning?: string) => void;
  readonly onSignedOut?: () => void;
  readonly origin?: string;
}

export function RemoteShellView(props: RemoteShellViewProps) {
  const state = useRemoteSession(props.bridge);
  const origin = props.origin ?? globalThis.location?.origin ?? "";
  const supervisor = useMemo(
    () => createConnectionSupervisor({ bridge: props.bridge, origin }),
    [props.bridge, origin],
  );
  useEffect(() => {
    supervisor.start();
    return () => supervisor.stop();
  }, [supervisor]);
  const connectionStatus = useConnectionStatus(supervisor);
  const clients = useMemo(() => createRemoteProductClients(props.bridge), [props.bridge]);
  const hosts = buildRemoteHostObservation({ state });
  const [activeMode, setActiveMode] = useState<OctantMode>(
    () => readContinuationLink(globalThis.location?.href ?? "")?.mode ?? "chat",
  );
  const connected = canExecuteRemoteProductMutation(state);
  // What the host says this session is, asked again each time the session
  // becomes ready. Until the host answers, and whenever it does not, the
  // session is shown as restricted.
  const [standing, setStanding] = useState<RemoteSessionStanding>(RESTRICTED_REMOTE_SESSION);
  const ready = state.kind === "ready";
  useEffect(() => {
    if (!ready) return;
    const connection = props.bridge.connection();
    if (connection === undefined) return;
    let current = true;
    void readRemoteSessionStanding(connection).then((answer) => {
      if (current) setStanding(answer);
    });
    return () => {
      current = false;
    };
  }, [props.bridge, ready]);
  const extensionClient = useMemo(
    () => createRemoteExtensionClient(props.bridge, standing),
    [props.bridge, standing],
  );
  const localHostSurfaces = useMemo(
    () => listRemoteShellSurfacesByAvailability("local-host-only", standing),
    [standing],
  );

  if (
    state.kind === "connecting" ||
    state.kind === "negotiating" ||
    state.kind === "authenticating"
  ) {
    return (
      <ShellState
        message="Establishing the authenticated remote session."
        state="loading"
        title="Connecting to Octant"
      />
    );
  }

  if (state.kind === "reconnecting") {
    return (
      <ShellState
        message="Your draft is preserved locally. Reconnecting does not queue authority offline."
        state="loading"
        title="Reconnecting"
      />
    );
  }

  if (state.kind === "incompatible") {
    return (
      <ShellState
        action={{ label: "Start over", onClick: () => props.onReset() }}
        message={state.reason}
        role="alert"
        state="warning"
        title="Host incompatible"
      />
    );
  }

  if (state.kind === "unauthorized") {
    return (
      <ShellState
        action={{ label: "Start over", onClick: () => props.onReset() }}
        message={state.reason}
        role="alert"
        state="disconnected"
        title="Remote access unauthorized"
      />
    );
  }

  if (state.kind === "unavailable") {
    return (
      <ShellState
        action={{ label: "Try reconnect", onClick: supervisor.retryNow }}
        message={state.reason}
        role="alert"
        state="disconnected"
        title="Host unavailable"
      />
    );
  }

  return (
    <section aria-label="Remote Octant shell" className="remote-shell remote-shell--workspace">
      <ConnectionStatusLine status={connectionStatus} />
      <header className="remote-shell__header">
        <h1 className="remote-shell__title">Octant</h1>
        <HostStatus hosts={hosts} />
        <ModeSwitcher
          separateChat
          activeMode={activeMode}
          modes={["chat", "work", "code"]}
          onSelectMode={setActiveMode}
          presentation="buttons"
        />
      </header>

      {state.kind === "stale" ? (
        <ShellState
          action={{ label: "Reconnect", onClick: () => props.bridge.reconnect() }}
          message="The host connection is stale. What you see may be behind; reconnect to send a turn."
          role="status"
          state="warning"
          title="Connection stale"
        />
      ) : null}

      <ContinuityScreenContext.Provider
        value={{
          hostLabel: hosts[0]?.displayName ?? "Paired host",
          screenLabel: "This paired browser",
          origin,
        }}
      >
        <RemoteWorkspace
          actsAsHostPerson={standing.actsAsHostPerson}
          clients={clients}
          connected={connected}
          extensionClient={extensionClient}
          mode={activeMode}
        />
      </ContinuityScreenContext.Provider>

      <RemoteDeviceSelfPanel
        bridge={props.bridge}
        onRevoked={props.onReset}
        onSignedOut={() => {
          if (props.onSignedOut !== undefined) {
            props.onSignedOut();
            return;
          }
          props.onReset();
        }}
      />

      <div className="settings-section-stack">
        <SyncStatusReadOnly client={clients.syncStatus} />
      </div>

      <section
        aria-label="Local host only surfaces"
        className="remote-shell__surface-grid"
        role="note"
      >
        <h2 className="remote-shell__section-title">Local host only</h2>
        <p className="remote-shell__local-only">
          {standing.actsAsHostPerson
            ? "Only a window on the host's own computer does these. You paired this browser yourself, so the host takes its other requests as it takes a window's."
            : "These stay with the person at the host. A paired browser reads threads and sends turns; it cannot bind folders, approve tool use, or manage credentials."}
        </p>
        {localHostSurfaces.map((surface) => (
          <OctantCard
            aria-disabled="true"
            className="remote-shell__surface-card remote-shell__surface-card--local-only p-2"
            key={surface.id}
            role="article"
          >
            <OctantBadge className="remote-shell__surface-badge" variant="secondary">
              Unavailable remotely
            </OctantBadge>
            <h3 className="remote-shell__surface-title">{surface.label}</h3>
            <p className="remote-shell__surface-description">{surface.description}</p>
          </OctantCard>
        ))}
      </section>

      <OctantButton onClick={() => props.onReset()} type="button" variant="secondary">
        End remote session
      </OctantButton>
    </section>
  );
}

function ConnectionStatusLine(props: { readonly status: ConnectionStatus }) {
  if (props.status.kind === "connected") return null;
  const message =
    props.status.kind === "blocked"
      ? (props.status.reason ?? "Remote access is blocked.")
      : props.status.kind === "offline"
        ? "Waiting for the network."
        : "Reconnecting to the host…";
  return (
    <p aria-live="polite" className="remote-shell__status" role="status">
      {message}
    </p>
  );
}
