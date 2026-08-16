import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectSummary } from "@octant/contracts/projects";
import type { RemoteSessionBridge, RemoteSessionBridgeState } from "@octant/client-runtime";
import {
  createRemoteProjectSnapshotRegistry,
  fetchRemoteProjectBootstrap,
  isRemoteProjectOverviewFailure,
} from "@octant/client-runtime";
import { useEffect, useMemo, useRef, useState } from "react";
import { ProjectOverview } from "../projects/ProjectOverview";
import { ShellState } from "../shell/ShellState";
import { useRemoteSession } from "./useRemoteSession";

export interface RemoteProjectOverviewSectionProps {
  readonly bridge: RemoteSessionBridge;
  readonly mode: OctantMode;
}

function isConnectionStale(state: RemoteSessionBridgeState): boolean {
  return (
    state.kind === "stale" ||
    state.kind === "unavailable" ||
    state.kind === "unauthorized" ||
    state.kind === "reconnecting"
  );
}

function pickProject(
  bootstrap: { readonly active: ReadonlyArray<ProjectSummary> },
  mode: OctantMode,
): ProjectSummary | undefined {
  return bootstrap.active.find(
    (project) => project.lifecycle === "active" && project.type === mode,
  );
}

export function RemoteProjectOverviewSection(props: RemoteProjectOverviewSectionProps) {
  const state = useRemoteSession(props.bridge);
  const snapshotRegistry = useMemo(() => createRemoteProjectSnapshotRegistry(), []);
  const alive = useRef(true);
  const [snapshot, setSnapshot] = useState(() => snapshotRegistry.read());
  const [loadError, setLoadError] = useState("");
  const connectionStale = isConnectionStale(state);
  const ready = state.kind === "ready";

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    setLoadError("");
    void fetchRemoteProjectBootstrap({ bridge: props.bridge })
      .then((bootstrap) => {
        if (!alive.current) return;
        snapshotRegistry.write(bootstrap);
        setSnapshot(bootstrap);
      })
      .catch((error) => {
        if (!alive.current) return;
        if (isRemoteProjectOverviewFailure(error)) {
          setLoadError(error.message);
        } else {
          setLoadError("Project Overview could not be refreshed.");
        }
      });
  }, [props.bridge, ready, snapshotRegistry, state.kind]);

  const project = snapshot === undefined ? undefined : pickProject(snapshot, props.mode);

  if (snapshot === undefined && !connectionStale && state.kind !== "ready") {
    return (
      <ShellState
        message="Project Overview loads after the remote session is ready."
        state="loading"
        title="Loading Project Overview"
      />
    );
  }

  if (snapshot === undefined && loadError !== "") {
    return (
      <ShellState
        message={loadError}
        role="alert"
        state="warning"
        title="Project Overview unavailable"
      />
    );
  }

  if (snapshot === undefined || project === undefined) {
    return (
      <ShellState
        message="Create a Project on the host or switch modes to view another Overview snapshot."
        state="neutral"
        title="No Project snapshot"
      />
    );
  }

  return (
    <section aria-label="Project Overview" className="remote-shell__overview" role="region">
      {connectionStale ? (
        <div className="remote-shell__stale-banner" role="status">
          <strong>Project snapshot stale</strong>
          <p>
            Showing the last in-memory Project Overview from this browser. Host identity stays
            visible above; reconnect to refresh or send changes.
          </p>
        </div>
      ) : null}
      <ProjectOverview
        allowRootRelink={false}
        connectionStale={connectionStale}
        onArchive={() => undefined}
        onRelink={async () => false}
        onRename={async () => false}
        project={project}
      />
    </section>
  );
}
