import "../styles/artifacts.css";
import {
  ArtifactLibraryClientFailure,
  copyClaudePageToCanvas,
  loadArtifactLibrary,
  loadClaudePageSnapshot,
} from "@octant/client-runtime/artifact-library-client";
import type {
  ArtifactLibraryEntry,
  ArtifactLibraryListing,
} from "@octant/contracts/artifact-library";
import { decodeWorkspaceTab, decodeWorkspaceTabId } from "@octant/contracts";
import { lazy, Suspense, useEffect, useState } from "react";
import { ArtifactTableHead, ArtifactTableRow } from "../artifacts/ArtifactTableRow";
import { ClaudePageCard } from "../artifacts/ClaudePageCard";
import { createThreadMessageQueueClient } from "../messageQueue/threadMessageQueueClient";
import type { ThreadUtilityDockContentProps } from "../shell/dockModuleContext";
import { Compass } from "../ui/icons";
import { OctantEmpty } from "../ui/base/OctantEmpty";
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
 * The library's table in a column that is 280px when tiled and 480px at least
 * when flexible: its container tiers drop the tags, the share mark and the
 * edited time so the name keeps the width.
 */
export function ArtifactDockList(props: {
  readonly entries: ReadonlyArray<ArtifactLibraryEntry>;
  readonly observedAt: string;
  readonly onOpen: (entry: ArtifactLibraryEntry) => void;
}) {
  return (
    <div className="artifact-table artifact-table--dock">
      <ArtifactTableHead />
      <ul className="artifact-table__rows">
        {props.entries.map((entry) => (
          <ArtifactTableRow
            key={String(entry.canvasId)}
            entry={entry}
            observedAt={props.observedAt}
            onOpen={props.onOpen}
          />
        ))}
      </ul>
    </div>
  );
}

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

  if (state.status === "loading") return <OctantEmpty state="loading" title="Loading artifacts" />;
  if (state.status === "unavailable") {
    return (
      <OctantEmpty
        detail={state.message}
        icon={<Compass size={16} />}
        layout="line"
        title="Artifacts are unavailable"
      />
    );
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
          <Suspense fallback={<OctantEmpty state="loading" title="Loading canvas" />}>
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
          <OctantEmpty
            detail="This artifact could not be opened in the dock."
            icon={<Compass size={16} />}
            layout="line"
            title="Artifact is unavailable"
          />
        )}
      </div>
    );
  }

  const { entries, truncated } = state.listing;
  const claudePages = state.listing.claude ?? [];
  return (
    <section aria-label="Project artifacts" className="dock-artifacts">
      <div className="dock-artifacts__bar">
        <OctantButton
          onClick={() => setReloads((count) => count + 1)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Refresh
        </OctantButton>
      </div>
      <div className="dock-artifacts__body">
        {entries.length === 0 && claudePages.length === 0 ? (
          <OctantEmpty
            detail="Canvas documents and pages published to claude.ai from this Project show here."
            icon={<Compass size={16} />}
            layout="line"
            title="No artifacts yet"
          />
        ) : (
          <ArtifactDockList entries={entries} observedAt={observedAt} onOpen={setOpen} />
        )}
        {claudePages.length === 0 ||
        serverUrl === undefined ||
        windowCapability === undefined ? null : (
          <ul aria-label="Published to claude.ai" className="artifact-library__claude">
            {claudePages.map((page) => (
              <ClaudePageCard
                entry={page}
                key={page.url}
                onLoadSnapshot={(entry) =>
                  loadClaudePageSnapshot(
                    { baseUrl: serverUrl, fetch, windowCapability },
                    { mode: entry.mode, threadId: entry.threadId, toolCallId: entry.toolCallId },
                  )
                }
                onCopyToCanvas={(entry, title) =>
                  copyClaudePageToCanvas(
                    { baseUrl: serverUrl, fetch, windowCapability },
                    {
                      mode: entry.mode,
                      threadId: entry.threadId,
                      toolCallId: entry.toolCallId,
                      title,
                    },
                  )
                }
              />
            ))}
          </ul>
        )}
        {truncated ? (
          <p className="dock-artifacts__note">Showing the most recent artifacts.</p>
        ) : null}
      </div>
    </section>
  );
}
