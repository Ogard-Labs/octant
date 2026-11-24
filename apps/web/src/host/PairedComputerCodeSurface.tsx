import {
  createLocalServerClient,
  createRemoteProductFetch,
  canExecuteRemoteProductMutation,
  readRemoteSessionStanding,
  RESTRICTED_REMOTE_SESSION,
  type RemoteSessionBridge,
  type RemoteSessionStanding,
} from "@octant/client-runtime";
import type { CodeCheckoutIdentity, CodeThread, CodeThreadId } from "@octant/contracts/code";
import type { HostId, HostIdentity } from "@octant/contracts/host";
import { buildModelPickerGroups, type CreateHostViewScope } from "@octant/domain";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useProviderController } from "../providers/useProviderController";
import { createRemoteExtensionClient } from "../remote/remoteProductClients";
import { RemoteCodeSurface } from "../remote/RemoteWorkspace";
import { HostSelector } from "../shell/HostSelector";
import { createPairedComputerCodeClients } from "./pairedComputerCodeClients";
import { PairedComputerThreadServers } from "./PairedComputerThreadServers";
import type { RemoteServerGrantSource } from "@octant/contracts";
import type { RemoteOpenMode, RemoteOpenOutcome } from "../home/runningServices";

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
  /**
   * Opens one of a thread's servers on that computer, in Octant's own window or
   * the default browser. Absent where this window cannot show such a page.
   */
  readonly openServer?: (
    source: RemoteServerGrantSource,
    mode: RemoteOpenMode,
  ) => Promise<RemoteOpenOutcome>;
  readonly onCloneFromThisComputer?: () => void;
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

  // A thread's MCP tool approvals, listed and answered on that computer, so one
  // Needs you opens here can be answered here.
  const extensionClient = useMemo(
    () => createRemoteExtensionClient(bridge, standing),
    [bridge, standing],
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
      <RemoteCodeSurface
        clients={clients}
        actsAsHostPerson={standing.actsAsHostPerson}
        extensionClient={extensionClient}
        connected={connected}
        providerGroups={providerGroups}
        followsContinuationLink={false}
        {...(props.initialThreadId === undefined ? {} : { initialThreadId: props.initialThreadId })}
        {...(props.initialThreadRequest === undefined
          ? {}
          : { initialThreadRequest: props.initialThreadRequest })}
        {...(standing.actsAsHostPerson && props.onCloneFromThisComputer !== undefined
          ? { onCloneFromThisComputer: props.onCloneFromThisComputer }
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
    </div>
  );
}
