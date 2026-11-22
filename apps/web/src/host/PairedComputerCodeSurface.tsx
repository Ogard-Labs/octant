import {
  canExecuteRemoteProductMutation,
  readRemoteSessionStanding,
  RESTRICTED_REMOTE_SESSION,
  type RemoteSessionBridge,
  type RemoteSessionStanding,
} from "@octant/client-runtime";
import type { HostId, HostIdentity } from "@octant/contracts/host";
import { buildModelPickerGroups, type CreateHostViewScope } from "@octant/domain";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useProviderController } from "../providers/useProviderController";
import { RemoteCodeSurface } from "../remote/RemoteWorkspace";
import { HostSelector } from "../shell/HostSelector";
import { createPairedComputerCodeClients } from "./pairedComputerCodeClients";

export interface PairedComputerCodeSurfaceProps {
  /** The paired computer's session, already ready. */
  readonly bridge: RemoteSessionBridge;
  readonly hosts: ReadonlyArray<HostIdentity>;
  readonly selectedHostId: HostId;
  readonly onSelectHost: (hostId: HostId) => void;
  readonly viewScope?: CreateHostViewScope;
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
        extensionClient={undefined}
        connected={connected}
        providerGroups={providerGroups}
        followsContinuationLink={false}
        onNavigate={() => undefined}
        onOpenCanvas={() => undefined}
      />
    </div>
  );
}
