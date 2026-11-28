import {
  createLocalServerClient,
  createRemoteProductFetch,
  canExecuteRemoteProductMutation,
  readRemoteSessionStanding,
  RESTRICTED_REMOTE_SESSION,
  type RemotePairingClient,
  type RemoteSessionBridge,
  type RemoteSessionStanding,
} from "@octant/client-runtime";
import type { CodeCheckoutIdentity, CodeThread, CodeThreadId } from "@octant/contracts/code";
import type { HostId, HostIdentity } from "@octant/contracts/host";
import { buildModelPickerGroups, type CreateHostViewScope } from "@octant/domain";
import { useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { AddRepositoryToComputerContext } from "../projects/addRepositoryToComputerContext";
import { useProviderController } from "../providers/useProviderController";
import { createRemoteExtensionClient, remoteProductPort } from "../remote/remoteProductClients";
import { RemoteCodeSurface } from "../remote/RemoteWorkspace";
import { HostSelector } from "../shell/HostSelector";
import type { PairedComputersBridge } from "../shell/hostBridge";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import { VideoClientContext } from "../video/ThreadVideoClips";
import { createPairedComputerCodeClients } from "./pairedComputerCodeClients";
import { PairedComputerConnectDialog } from "./PairedComputerConnectDialog";
import { PairedComputerThreadServers } from "./PairedComputerThreadServers";
import { useHostFederationStack } from "./useHostFederationLifecycle";
import type { RemoteServerGrantSource } from "@octant/contracts";
import type { RemoteOpenMode, RemoteOpenOutcome } from "../home/runningServices";
import { ComposerStashScopeContext } from "../composer/ComposerStashControls";
import { usePairedComposerStashScope } from "../remote/usePairedComposerStashScope";

export interface PairedComputerCodeSurfaceProps {
  /** The paired computer's session, already ready. */
  readonly bridge: RemoteSessionBridge;
  readonly hosts: ReadonlyArray<HostIdentity>;
  readonly selectedHostId: HostId;
  readonly onSelectHost: (hostId: HostId) => void;
  readonly viewScope?: CreateHostViewScope;
  /** A thread on that computer to open, chosen from this window's list of its threads. */
  readonly initialThreadId?: CodeThreadId;
  /** Counts each request to open `initialThreadId`, so the same thread can be reopened. */
  readonly initialThreadRequest?: number;
  /** Desktop pairing bridge, used by "Connect to reply" on a Watching thread. */
  readonly pairedComputers?: PairedComputersBridge;
  /** Registered origin of the computer currently shown. */
  readonly origin?: string;
  /** Expected listener pin of the computer currently shown. */
  readonly expectedPin?: string;
  /** Replaces the transport-backed pairing client; only tests do. */
  readonly pairingClient?: RemotePairingClient;
  /**
   * Opens one of a thread's servers on that computer, in Octant's own window or
   * the default browser. Absent where this window cannot show such a page.
   */
  readonly openServer?: (
    source: RemoteServerGrantSource,
    mode: RemoteOpenMode,
  ) => Promise<RemoteOpenOutcome>;
  readonly selectProjectRequest?: Readonly<{
    readonly projectId: string;
    readonly sequence: number;
  }>;
}

/**
 * The Code start screen when the computer picker names a paired computer: that
 * computer's Projects, models and threads, a thread started there, and the open
 * thread followed from this window. Everything goes to that computer over its
 * session, under its own rules; nothing is created on this one. The picker
 * stays on top, so choosing this computer again brings back the local composer.
 */
export function PairedComputerCodeSurface(props: PairedComputerCodeSurfaceProps) {
  const { bridge } = props;
  const clients = useMemo(() => createPairedComputerCodeClients(bridge), [bridge]);
  const localServers = useMemo(
    () =>
      createLocalServerClient({
        // The session owns the destination; the base URL only shapes the path.
        baseUrl: "http://127.0.0.1",
        fetch: createRemoteProductFetch({ bridge }),
        windowCapability: "",
      }),
    [bridge],
  );
  const hostName =
    props.hosts.find((host) => String(host.hostId) === String(props.selectedHostId))?.displayName ??
    "that computer";
  const { openServer } = props;
  const openBootstrap = useContext(AddRepositoryToComputerContext);
  const federation = useHostFederationStack();
  const [connectOpen, setConnectOpen] = useState(false);
  const [registeredTarget, setRegisteredTarget] = useState<{
    readonly origin?: string | undefined;
    readonly pin?: string | undefined;
  }>({});
  useEffect(() => {
    if (federation === undefined) return;
    let cancelled = false;
    void federation.registry
      .get(props.selectedHostId)
      .then((entry) => {
        if (cancelled) return;
        const trust = entry?.credential?.listenerTrust?.current;
        setRegisteredTarget({
          origin: entry?.origin,
          pin: trust?.kind === "pinned" ? trust.pin : undefined,
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [federation, props.selectedHostId]);
  const connectOrigin = props.origin ?? registeredTarget.origin;
  const connectPin = props.expectedPin ?? registeredTarget.pin;
  const canOpenConnect =
    props.pairedComputers !== undefined && federation !== undefined && connectOrigin !== undefined;
  const state = useSyncExternalStore(
    (onChange) => bridge.subscribe(onChange),
    () => bridge.getState(),
  );
  const connected = canExecuteRemoteProductMutation(state);
  // What the computer says this window's device is, read each time its session
  // becomes ready. A device it does not treat as its own person sees the
  // threads but no start form, as a restricted paired browser does.
  const [standing, setStanding] = useState<RemoteSessionStanding>(RESTRICTED_REMOTE_SESSION);
  const ready = state.kind === "ready";
  useEffect(() => {
    if (!ready) return;
    const connection = bridge.connection();
    if (connection === undefined) return;
    let current = true;
    void readRemoteSessionStanding(connection).then((answer) => {
      if (current) setStanding(answer);
    });
    return () => {
      current = false;
    };
  }, [bridge, ready]);
  const stashScope = usePairedComposerStashScope(
    bridge,
    props.selectedHostId,
    connected && standing.actsAsHostPerson,
  );

  // A thread's MCP tool approvals, listed and answered on that computer, so one
  // Needs you opens here can be answered here.
  const extensionClient = useMemo(
    () => createRemoteExtensionClient(bridge, standing),
    [bridge, standing],
  );

  // The thread's Restore worktree, which the computer takes only from a device
  // its own person paired: gated as the paired browser's shell gates it.
  const worktreePort = useMemo(
    () => (standing.actsAsHostPerson ? remoteProductPort(bridge) : undefined),
    [bridge, standing.actsAsHostPerson],
  );

  const providerController = useProviderController({ client: clients.provider });
  const providerGroups = useMemo(
    () =>
      buildModelPickerGroups({
        instances: providerController.instances,
        observedByInstance: providerController.observedByInstance,
        providerOrder: providerController.defaults.providerOrder,
        hiddenModels: providerController.defaults.hiddenModels,
        mode: "code",
      }),
    [
      providerController.instances,
      providerController.observedByInstance,
      providerController.defaults.providerOrder,
      providerController.defaults.hiddenModels,
    ],
  );

  return (
    <div className="draft-thread paired-computer-code" data-testid="paired-computer-code">
      <div className="draft-thread__context-strip" aria-label="Thread context">
        <HostSelector
          presentation="environment"
          hosts={props.hosts}
          selectedHostId={props.selectedHostId}
          onSelectHost={props.onSelectHost}
          requiredCapability="code"
          {...(props.viewScope === undefined ? {} : { viewScope: props.viewScope })}
        />
      </div>
      <VideoClientContext.Provider
        value={
          standing !== RESTRICTED_REMOTE_SESSION &&
          (standing.actsAsHostPerson || standing.accessLevel !== undefined)
            ? clients.videoResults
            : undefined
        }
      >
        <ComposerStashScopeContext.Provider value={stashScope}>
          <RemoteCodeSurface
            clients={clients}
            actsAsHostPerson={standing.actsAsHostPerson}
            extensionClient={extensionClient}
            hostName={hostName}
            {...(canOpenConnect ? { onConnectToReply: () => setConnectOpen(true) } : {})}
            {...(worktreePort === undefined ? {} : { worktreePort })}
            connected={connected}
            providerGroups={providerGroups}
            followsContinuationLink={false}
            {...(props.initialThreadId === undefined
              ? {}
              : { initialThreadId: props.initialThreadId })}
            {...(props.initialThreadRequest === undefined
              ? {}
              : { initialThreadRequest: props.initialThreadRequest })}
            {...(standing.actsAsHostPerson && openBootstrap !== undefined
              ? {
                  onCloneFromThisComputer: () =>
                    openBootstrap({ destinationHostId: props.selectedHostId }),
                }
              : {})}
            {...(props.selectProjectRequest === undefined
              ? {}
              : { selectProjectRequest: props.selectProjectRequest })}
            {...(openServer === undefined
              ? {}
              : {
                  renderThreadExtras: (
                    thread: CodeThread,
                    checkout: CodeCheckoutIdentity | undefined,
                  ) => (
                    <PairedComputerThreadServers
                      key={String(thread.id)}
                      client={localServers}
                      inOwnWorktree={checkout?.kind === "managed-worktree"}
                      hostName={hostName}
                      open={openServer}
                      projectId={thread.projectId}
                      threadId={thread.id}
                    />
                  ),
                })}
            onNavigate={() => undefined}
            onOpenCanvas={() => undefined}
          />
          <OctantDialogPresence>
            {connectOpen &&
            props.pairedComputers !== undefined &&
            federation !== undefined &&
            connectOrigin !== undefined ? (
              <PairedComputerConnectDialog
                bridge={props.pairedComputers}
                expectedPin={connectPin}
                federation={federation}
                hostName={hostName}
                onClose={() => setConnectOpen(false)}
                onConnected={() => setConnectOpen(false)}
                open={connectOpen}
                origin={connectOrigin}
                pairingClient={props.pairingClient}
              />
            ) : null}
          </OctantDialogPresence>
        </ComposerStashScopeContext.Provider>
      </VideoClientContext.Provider>
    </div>
  );
}
