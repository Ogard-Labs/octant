import type { HostFederationTransports } from "@octant/client-runtime/host-federation-transports";
import type { RepositoryBootstrapClientOptions } from "@octant/client-runtime/repository-bootstrap-client";
import { LOCAL_HOST_ID, type HostId } from "@octant/contracts/host";
import type { ProjectId, ProjectSummary } from "@octant/contracts/projects";
import { useEffect, useMemo, useState } from "react";
import { useBootstrapDestinations } from "../host/useBootstrapDestinations";
import { localHostDisplayName } from "@octant/client-runtime";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import {
  AddRepositoryToComputerDialog,
  type AddRepositoryToComputerCompleted,
} from "./AddRepositoryToComputerDialog";

export interface RepositoryBootstrapRequest {
  readonly projectId?: ProjectId;
  readonly destinationHostId?: HostId;
}

export interface RepositoryBootstrapHostProps {
  readonly transports: HostFederationTransports;
  readonly allProjects: ReadonlyArray<ProjectSummary>;
  readonly hosts: ReadonlyArray<{ readonly hostId: HostId; readonly displayName: string }>;
  readonly request: RepositoryBootstrapRequest | undefined;
  readonly sourceBootstrapPort: RepositoryBootstrapClientOptions;
  readonly onHasDestinationChange: (hasDestination: boolean) => void;
  readonly onClose: () => void;
  readonly onCompleted: (result: AddRepositoryToComputerCompleted) => void;
}

export function RepositoryBootstrapHost(props: RepositoryBootstrapHostProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const destinations = useBootstrapDestinations(props.transports, refreshKey);

  useEffect(() => {
    props.onHasDestinationChange(destinations.length > 0);
  }, [destinations.length, props.onHasDestinationChange]);

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
      props.request?.projectId === undefined
        ? undefined
        : localActiveCodeProjects.find(
            (candidate) => String(candidate.id) === String(props.request?.projectId),
          ),
    [props.request?.projectId, localActiveCodeProjects],
  );

  return (
    <OctantDialogPresence>
      {props.request === undefined ? null : (
        <AddRepositoryToComputerDialog
          destinations={destinations}
          {...(props.request.destinationHostId === undefined
            ? {}
            : { initialDestinationHostId: props.request.destinationHostId })}
          localProjects={localActiveCodeProjects}
          onClose={props.onClose}
          onCompleted={(result) => {
            setRefreshKey((count) => count + 1);
            props.onCompleted(result);
          }}
          open
          {...(targetProject === undefined ? {} : { project: targetProject })}
          sourceBootstrapPort={props.sourceBootstrapPort}
          sourceHostName={sourceHostName}
        />
      )}
    </OctantDialogPresence>
  );
}
