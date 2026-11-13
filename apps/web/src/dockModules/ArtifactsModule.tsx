import {
  ArtifactLibraryClientFailure,
  loadArtifactLibrary,
} from "@octant/client-runtime/artifact-library-client";
import type {
  ArtifactLibraryEntry,
  ArtifactLibraryListing,
} from "@octant/contracts/artifact-library";
import { decodeWorkspaceTab, decodeWorkspaceTabId } from "@octant/contracts";
import { lazy, Suspense, useEffect, useState } from "react";
import { ArtifactListRow } from "../artifacts/ArtifactListRow";
import { createThreadMessageQueueClient } from "../messageQueue/threadMessageQueueClient";
import type { ThreadUtilityDockContentProps } from "../shell/dockModuleContext";
import { ShellState } from "../shell/ShellState";
import { OctantButton } from "../ui/base/OctantButton";

const CanvasWorkspaceTab = lazy(() =>
  import("../canvas/CanvasWorkspaceTab").then((module) => ({
    default: module.CanvasWorkspaceTab,
  })),
);

const dockArtifactTabId = decodeWorkspaceTabId("90000000-0000-4000-8000-000000000008");

type Props = Pick<
  ThreadUtilityDockContentProps,
  "canvasClient" | "canvasRevision" | "serverUrl" | "subject" | "windowCapability"
>;

type Listing =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly listing: ArtifactLibraryListing }
  | { readonly status: "unavailable"; readonly message: string };

/**
 * The thread's Project's artifacts, beside the thread.
 *
 * It reads the same host library the Artifacts page reads, asked for this one
 * Project; the host applies the filter and its scope, so the dock never sees
 * an artifact the page would not show this window. Opening an entry shows the
 * same document by `canvasId` in the dock, so the person keeps their thread.
 */
export default function ArtifactsModule(props: Props) {
  const { serverUrl, windowCapability } = props;
  const projectId = props.subject.projectId;
  const [state, setState] = useState<Listing>({ status: "loading" });
  const [open, setOpen] = useState<ArtifactLibraryEntry>();
  const [observedAt, setObservedAt] = useState(() => new Date().toISOString());
  // The listing is read once per load. A Canvas this thread writes reloads it
  // through `canvasRevision`; one written in another thread of the Project
  // needs Refresh, because the window holds no signal for other threads.
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    if (serverUrl === undefined || windowCapability === undefined || projectId === undefined) {
      setState({ status: "unavailable", message: "This thread has no Project artifacts to list." });
      return;
    }
    const controller = new AbortController();
    setState({ status: "loading" });
    loadArtifactLibrary(
      { baseUrl: serverUrl, fetch, windowCapability },
      { tab: "all", projectId },
      controller.signal,
    ).then(
      (listing) => {
        if (controller.signal.aborted) return;
        setObservedAt(new Date().toISOString());
        setState({ status: "ready", listing });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "unavailable",
          message:
            error instanceof ArtifactLibraryClientFailure
              ? error.message
              : "The artifact library is unavailable.",
        });
      },
    );
    return () => controller.abort();
  }, [projectId, props.canvasRevision, reloads, serverUrl, windowCapability]);

  if (state.status === "loading") return <ShellState state="loading" title="Loading artifacts" />;
  if (state.status === "unavailable") {
    return <ShellState message={state.message} state="neutral" title="Artifacts are unavailable" />;
  }

  if (open !== undefined && open.projectId !== undefined) {
    const tab = decodeWorkspaceTab({
      kind: "canvas",
      id: dockArtifactTabId,
      mode: open.mode,
      title: open.title,
      canvasId: open.canvasId,
      projectId: open.projectId,
    });
    return (
      <div className="dock-canvas-tool">
        <OctantButton onClick={() => setOpen(undefined)} type="button" variant="ghost">
          All artifacts
        </OctantButton>
        {tab.kind === "canvas" && props.canvasClient !== undefined ? (
          <Suspense fallback={<ShellState state="loading" title="Loading canvas" />}>
            <CanvasWorkspaceTab
              key={String(open.currentVersionId)}
              client={props.canvasClient}
              tab={tab}
              {...(serverUrl === undefined || windowCapability === undefined
                ? {}
                : { queueClient: createThreadMessageQueueClient({ serverUrl, windowCapability }) })}
            />
          </Suspense>
        ) : (
          <ShellState
            message="This artifact could not be opened in the dock."
            state="neutral"
            title="Artifact is unavailable"
          />
        )}
      </div>
    );
  }

  const { entries, truncated } = state.listing;
  if (entries.length === 0) {
    return (
      <section aria-label="Project artifacts" className="dock-canvas-tool">
        <OctantButton
          onClick={() => setReloads((count) => count + 1)}
          type="button"
          variant="ghost"
        >
          Refresh
        </OctantButton>
        <ShellState
          message="Canvas documents made in this Project appear here."
          state="neutral"
          title="No artifacts yet"
        />
      </section>
    );
  }
  return (
    <section aria-label="Project artifacts" className="dock-canvas-tool">
      <OctantButton onClick={() => setReloads((count) => count + 1)} type="button" variant="ghost">
        Refresh
      </OctantButton>
      <ul className="artifact-library__list">
        {entries.map((entry) => (
          <ArtifactListRow
            key={String(entry.canvasId)}
            entry={entry}
            observedAt={observedAt}
            onOpen={setOpen}
          />
        ))}
      </ul>
      {truncated ? (
        <p className="dock-canvas-tool__note">Showing the most recent artifacts.</p>
      ) : null}
    </section>
  );
}
