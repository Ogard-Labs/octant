import type { HostFederationTransports } from "@octant/client-runtime/host-federation-transports";
import { localHostDisplayName } from "@octant/client-runtime";
import { LOCAL_HOST_ID, type HostId } from "@octant/contracts/host";
import type { ProjectId, ProjectSummary } from "@octant/contracts/projects";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useBootstrapDestinations } from "../host/useBootstrapDestinations";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import type { OpenRepositoryBootstrap } from "./addRepositoryToComputerContext";
import { AddRepositoryToComputerDialog } from "./AddRepositoryToComputerDialog";

interface RepositoryBootstrapRequest {
  readonly projectId?: ProjectId;
  readonly destinationHostId?: HostId;
}

export interface RepositoryBootstrapSelection {
  readonly hostId: HostId;
  readonly projectId: string;
  readonly sequence: number;
}

export interface RepositoryBootstrapHostProps {
  readonly transports: HostFederationTransports;
  readonly allProjects: ReadonlyArray<ProjectSummary>;
  readonly hosts: ReadonlyArray<{ readonly hostId: HostId; readonly displayName: string }>;
  readonly serverUrl: string;
  readonly windowCapability: string;
  readonly onReady: Dispatch<SetStateAction<OpenRepositoryBootstrap | undefined>>;
  readonly onCompleted: (selection: RepositoryBootstrapSelection) => void;
}

export default function RepositoryBootstrapHost(props: RepositoryBootstrapHostProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [request, setRequest] = useState<RepositoryBootstrapRequest | undefined>(undefined);
  const destinations = useBootstrapDestinations(props.transports, refreshKey);

  const openBootstrap = useCallback<OpenRepositoryBootstrap>((target) => {
    setRequest(typeof target === "object" ? target : { projectId: target });
  }, []);

  const hasDestinations = destinations.length > 0;
  const { onReady } = props;
  useEffect(() => {
    onReady(() => (hasDestinations ? openBootstrap : undefined));
    return () => onReady(undefined);
  }, [hasDestinations, onReady, openBootstrap]);

  const sourceBootstrapPort = useMemo(
    () => ({
      baseUrl: props.serverUrl,
      fetch: globalThis.fetch,
      windowCapability: props.windowCapability,
    }),
    [props.serverUrl, props.windowCapability],
  );

  const sourceHostName =
    props.hosts.find((host) => String(host.hostId) === String(LOCAL_HOST_ID))?.displayName ??
    localHostDisplayName();

  const localActiveCodeProjects = useMemo(
    () =>
      props.allProjects.filter(
        (project): project is Extract<ProjectSummary, { readonly type: "code" }> =>
          project.type === "code" && project.lifecycle === "active",
      ),
    [props.allProjects],
  );
  const targetProject = useMemo(
    () =>
      request?.projectId === undefined
        ? undefined
        : localActiveCodeProjects.find(
            (candidate) => String(candidate.id) === String(request.projectId),
          ),
    [request?.projectId, localActiveCodeProjects],
  );

  return (
    <OctantDialogPresence>
      {request === undefined ? null : (
        <AddRepositoryToComputerDialog
          destinations={destinations}
          {...(request.destinationHostId === undefined
            ? {}
            : { initialDestinationHostId: request.destinationHostId })}
          localProjects={localActiveCodeProjects}
          onClose={() => setRequest(undefined)}
          onCompleted={(result) => {
            const nextSequence = refreshKey + 1;
            setRefreshKey(nextSequence);
            props.onCompleted({
              hostId: result.destinationHostId,
              projectId: String(result.projectId),
              sequence: nextSequence,
            });
          }}
          open
          {...(targetProject === undefined ? {} : { project: targetProject })}
          sourceBootstrapPort={sourceBootstrapPort}
          sourceHostName={sourceHostName}
        />
      )}
    </OctantDialogPresence>
  );
}
