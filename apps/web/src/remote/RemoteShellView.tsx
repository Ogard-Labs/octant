import "../styles/remote-shell.css";
import { OctantEmpty } from "../ui/base/OctantEmpty";
import { ContinuityScreenContext } from "../continuity/ContinueElsewhere";
import { readContinuationLink } from "../continuity/continuationLink";
import type { OctantMode } from "@octant/contracts/modes";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";

// Loaded with the notices it shows, so the shell's first load carries none of it.
const LazyRemoteChangeNotices = lazy(async () => ({
  default: (await import("./RemoteChangeNotices")).RemoteChangeNotices,
}));
const LazyRemoteActiveWork = lazy(async () => ({
  default: (await import("./RemoteActiveWork")).RemoteActiveWork,
}));
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
import { RemoteDeviceSelfPanel } from "./RemoteDeviceSelfPanel";
import {
  createRemoteAgentGrantClient,
  createRemoteDiagnosticsExportClient,
  createRemoteExtensionClient,
  createRemoteNewDeviceAlertsClient,
  createRemotePairedDeviceAdministrationClient,
  createRemoteProductClients,
  createRemoteProviderCredentialClient,
  createRemoteProviderOAuth,
  remoteProductPort,
} from "./remoteProductClients";
import { NewDeviceAlerts } from "../host/NewDeviceAlerts";
import { RemoteHostSettings } from "./RemoteHostSettings";
import { RemoteWorkspace } from "./RemoteWorkspace";
import { usePairedComposerStashScope } from "./usePairedComposerStashScope";
import { useRemoteSession } from "./useRemoteSession";
import { useVisibleRefresh } from "../polling/useVisibleRefresh";

const STANDING_REFRESH_INTERVAL_MS = 10_000;

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
  const [activeWorkOpen, setActiveWorkOpen] = useState(false);
  // A thread opened from active work; its count keys the workspace, so opening
  // the same thread again after moving away opens it again.
  const [openedThread, setOpenedThread] = useState<{
    readonly thread: { readonly mode: OctantMode; readonly threadId: string };
    readonly count: number;
  }>();
  const connected = canExecuteRemoteProductMutation(state);
  // When the session was last ready, so active work can say how long ago the
  // host last answered once it stops.
  const [lastReadyAt, setLastReadyAt] = useState<string>();
  useEffect(() => {
    if (state.kind === "ready") setLastReadyAt(new Date().toISOString());
  }, [state.kind]);
  // The host can change device access without replacing the session.
  const connection = props.bridge.connection();
  const sessionId = state.kind === "ready" ? connection?.session()?.sessionId : undefined;
  const [standingRead, setStandingRead] = useState<{
    readonly connection: NonNullable<typeof connection>;
    readonly sessionId: string;
    readonly standing: RemoteSessionStanding;
  }>();
  const refreshStanding = useCallback(
    async (signal: AbortSignal) => {
      if (connection === undefined || sessionId === undefined) return;
      const standing = await readRemoteSessionStanding(connection);
      if (signal.aborted) return;
      setStandingRead((previous) =>
        previous?.connection === connection &&
        previous.sessionId === sessionId &&
        (previous.standing === RESTRICTED_REMOTE_SESSION) ===
          (standing === RESTRICTED_REMOTE_SESSION) &&
        previous.standing.actsAsHostPerson === standing.actsAsHostPerson &&
        previous.standing.accessLevel === standing.accessLevel
          ? previous
          : { connection, sessionId, standing },
      );
    },
    [connection, sessionId],
  );
  useVisibleRefresh(refreshStanding, undefined, STANDING_REFRESH_INTERVAL_MS);
  const standing =
    standingRead !== undefined &&
    standingRead.connection === connection &&
    (standingRead.sessionId === sessionId || state.kind === "stale")
      ? standingRead.standing
      : RESTRICTED_REMOTE_SESSION;
  const stashScope = usePairedComposerStashScope(
    props.bridge,
    hosts[0]?.hostId ?? "paired-browser",
    connected && standing.actsAsHostPerson,
  );
  const extensionClient = useMemo(
    () => createRemoteExtensionClient(props.bridge, standing),
    [props.bridge, standing],
  );
  const pairedDevices = useMemo(
    () => createRemotePairedDeviceAdministrationClient(props.bridge),
    [props.bridge],
  );
  const newDeviceAlerts = useMemo(
    () => createRemoteNewDeviceAlertsClient(props.bridge),
    [props.bridge],
  );
  const providerKeys = useMemo(
    () => createRemoteProviderCredentialClient(props.bridge),
    [props.bridge],
  );
  const personPort = useMemo(
    () => (standing.actsAsHostPerson ? remoteProductPort(props.bridge) : undefined),
    [props.bridge, standing.actsAsHostPerson],
  );
  const providerOAuth = useMemo(() => createRemoteProviderOAuth(props.bridge), [props.bridge]);
  const agentGrants = useMemo(() => createRemoteAgentGrantClient(props.bridge), [props.bridge]);
  const diagnosticsClient = useMemo(
    () => createRemoteDiagnosticsExportClient(props.bridge),
    [props.bridge],
  );
  // The matrix names what the host forwards for this session; a restricted
  // session reaches neither settings surface, so it is shown none.
  const reachableSettings = useMemo(
    () =>
      new Set(
        listRemoteShellSurfacesByAvailability("remote", standing).map((surface) => surface.id),
      ),
    [standing],
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
      <OctantEmpty
        message="Establishing the authenticated remote session."
        state="loading"
        title="Connecting to Octant"
      />
    );
  }

  if (state.kind === "reconnecting") {
    return (
      <OctantEmpty
        message="Your draft is preserved locally. Reconnecting does not queue authority offline."
        state="loading"
        title="Reconnecting"
      />
    );
  }

  if (state.kind === "incompatible") {
    return (
      <OctantEmpty
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
      <OctantEmpty
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
      <OctantEmpty
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
        <OctantButton
          aria-expanded={activeWorkOpen}
          onClick={() => setActiveWorkOpen((open) => !open)}
          type="button"
          variant="ghost"
        >
          Active work
        </OctantButton>
      </header>

      {activeWorkOpen ? (
        <section aria-label="Active work">
          <Suspense fallback={null}>
            <LazyRemoteActiveWork
              bridge={props.bridge}
              connected={connected}
              {...(lastReadyAt === undefined ? {} : { lastReadyAt })}
              reach={activeWorkReach(state.kind)}
              hostId={hosts[0]?.hostId ?? "paired-browser"}
              hostName={hosts[0]?.displayName ?? "Paired host"}
              onOpen={(thread) => {
                setActiveWorkOpen(false);
                setActiveMode(thread.mode);
                setOpenedThread((previous) => ({ thread, count: (previous?.count ?? 0) + 1 }));
              }}
            />
          </Suspense>
        </section>
      ) : null}

      {state.kind === "stale" ? (
        <OctantEmpty
          action={{ label: "Reconnect", onClick: () => props.bridge.reconnect() }}
          message="The host connection is stale. What you see may be behind; reconnect to send a turn."
          role="status"
          state="warning"
          title="Connection stale"
        />
      ) : null}

      <NewDeviceAlerts client={newDeviceAlerts} />
      {/* The host answers only a device paired at Full; any other shows none. */}
      {standing.actsAsHostPerson ? (
        <Suspense fallback={null}>
          <LazyRemoteChangeNotices bridge={props.bridge} />
        </Suspense>
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
          canWatchVideoClips={
            standing !== RESTRICTED_REMOTE_SESSION &&
            (standing.actsAsHostPerson || standing.accessLevel !== undefined)
          }
          clients={clients}
          connected={connected}
          extensionClient={extensionClient}
          key={openedThread?.count ?? 0}
          {...(openedThread === undefined ? {} : { initialThread: openedThread.thread })}
          mode={activeMode}
          {...(personPort === undefined ? {} : { worktreePort: personPort })}
          readOnly={standing.accessLevel === "read-only"}
          stashScope={stashScope}
        />
      </ContinuityScreenContext.Provider>

      <RemoteHostSettings
        agentGrants={agentGrants}
        diagnosticsClient={diagnosticsClient}
        extensionClient={extensionClient}
        origin={origin}
        pairedDevices={pairedDevices}
        projectClient={clients.project}
        providerClient={clients.provider}
        {...(clients.code.providerCloudSessions === undefined
          ? {}
          : { providerCloudSessionClient: clients.code.providerCloudSessions })}
        providerKeys={providerKeys}
        {...(personPort === undefined ? {} : { personPort })}
        providerOAuth={providerOAuth}
        reachable={reachableSettings}
      />

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

/** The browser's session, in the words active work uses for a computer. */
function activeWorkReach(kind: string): "ready" | "connecting" | "refused" | "unreachable" {
  switch (kind) {
    case "ready":
      return "ready";
    case "unauthorized":
      return "refused";
    case "stale":
    case "incompatible":
    case "unavailable":
      return "unreachable";
    default:
      return "connecting";
  }
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
