import type { ArtifactLibraryEntry } from "@octant/contracts/artifact-library";
import type { CanvasExportOfferList } from "@octant/contracts/canvas-export";
import type { CanvasTagCommand } from "@octant/contracts/canvas-tags";
import { decodeUtcTimestamp } from "@octant/contracts";
import { createCanvasClient, type CanvasClient } from "@octant/client-runtime/canvas-client";
import { useEffect, useMemo, useRef, useState } from "react";
import { CanvasExportPanel } from "../canvas/CanvasExportPanel";
import { withWorkspaceFrameTheme } from "../canvas/blocks/designDocument";
import { useCanvasExportFolder } from "../canvas/useCanvasExportFolder";
import { OctantDialog } from "../ui/base/OctantDialog";
import { Surface } from "../surface/SurfaceHeader";
import {
  ARTIFACT_LIBRARY_VIEW_GALLERY,
  readArtifactLibraryView,
  writeArtifactLibraryView,
  type ArtifactLibraryView as LibraryViewMode,
} from "./artifactLibraryViewPreference";
import { ArtifactLibraryView } from "./ArtifactLibraryView";
import { ArtifactMirrorSettings } from "./ArtifactMirrorSettings";
import { useArtifactLibrary } from "./useArtifactLibrary";
import { useArtifactTags } from "./useArtifactTags";
import { useArtifactMirror } from "./useArtifactMirror";
import { SyncedArtifactDialog } from "./SyncedArtifactDialog";
import { useSyncedArtifacts } from "./useSyncedArtifacts";
import type { executeSyncedArtifactCommand } from "@octant/client-runtime/artifact-library-client";

export interface ArtifactLibrarySurfaceProps {
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly onOpen: (entry: ArtifactLibraryEntry) => void;
  readonly onClose: () => void;
  /** Absent on a host that cannot start one, which hides the create action. */
  readonly onCreate?: () => void;
  /** Injected in tests; the host's synced-artifact commands otherwise. */
  readonly execute?: typeof executeSyncedArtifactCommand;
  /** Injected in tests; the renderer's local storage otherwise. */
  readonly storage?: Pick<Storage, "getItem" | "setItem">;
}

/**
 * The library as a full surface in the shell.
 *
 * "Edited ago" is measured against the host's own `generatedAt` rather than the
 * renderer's clock: the listing already carries the instant the host read it,
 * and using it keeps a card from disagreeing with the host by a machine's clock
 * skew.
 */
export function ArtifactLibrarySurface(props: ArtifactLibrarySurfaceProps) {
  const storage = props.storage ?? globalThis.localStorage;
  const mirror = useArtifactMirror({
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  const library = useArtifactLibrary({
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  const [view, setView] = useState<LibraryViewMode>(
    () => readArtifactLibraryView(storage) ?? ARTIFACT_LIBRARY_VIEW_GALLERY,
  );
  useEffect(() => {
    // The storage prop is a test seam; a window keeps one storage for its
    // life, so this only re-reads when a test hands the surface another one.
    setView(readArtifactLibraryView(storage) ?? ARTIFACT_LIBRARY_VIEW_GALLERY);
  }, [storage]);
  const tags = useArtifactTags({
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
    onChanged: library.refresh,
  });
  const exportClient = useMemo(
    () => exportClientFor(props),
    [props.serverUrl, props.windowCapability],
  );
  const prepareExport = exportClient?.prepareExport;
  const [exportOffers, setExportOffers] = useState<CanvasExportOfferList | undefined>(undefined);
  const [exportMessage, setExportMessage] = useState<string | undefined>(undefined);
  const [exportEntry, setExportEntry] = useState<ArtifactLibraryEntry | undefined>(undefined);
  const exportFolder = useCanvasExportFolder({
    client: exportClient,
    canvasId: exportEntry?.canvasId,
  });

  // The newest request, or a closed dialog, supersedes an offers response that
  // resolves later, so an answer for one artifact never opens the dialog on
  // another. Same idiom as the Canvas tab's load token.
  const exportToken = useRef(0);

  async function openExport(entry: ArtifactLibraryEntry) {
    if (exportClient?.exportOffers === undefined) return;
    const current = (exportToken.current += 1);
    setExportEntry(entry);
    setExportMessage(undefined);
    setExportOffers(undefined);
    try {
      const offers = await exportClient.exportOffers(entry.canvasId);
      if (exportToken.current !== current) return;
      setExportOffers(offers);
    } catch {
      if (exportToken.current !== current) return;
      setExportMessage("Export is unavailable.");
      setExportOffers(undefined);
    }
  }

  const synced = useSyncedArtifacts({
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
    ...(props.execute === undefined ? {} : { execute: props.execute }),
    onChanged: library.refresh,
    onOpened: props.onOpen,
  });
  const observedAt = String(library.listing?.generatedAt ?? "");
  const viewMessage = tags.message ?? synced.notice ?? library.message;

  // The command's timestamp is this window's clock; the host stamps the
  // journaled fact with its own, so a wrong window clock files nothing wrong.
  const tagCommand =
    (kind: "canvas-tag-add" | "canvas-tag-remove") =>
    (canvasId: ArtifactLibraryEntry["canvasId"], tag: string): CanvasTagCommand => ({
      kind,
      canvasId,
      tag,
      issuedAt: decodeUtcTimestamp(new Date().toISOString()),
    });

  return (
    <Surface ariaLabel="Artifact library" measure="wide">
      <ArtifactLibraryView
        busy={library.busy}
        filters={library.filters}
        listing={library.listing}
        {...(viewMessage === undefined ? {} : { message: viewMessage })}
        {...(synced.available
          ? {
              onSync: (canvasId) => void synced.select(canvasId),
              onRestore: (canvasId) => void synced.run({ kind: "restore", canvasId }),
            }
          : {})}
        observedAt={observedAt}
        view={view}
        onViewChange={(next) => {
          setView(next);
          writeArtifactLibraryView(next, storage);
        }}
        onClose={props.onClose}
        onFiltersChange={library.setFilters}
        onOpen={props.onOpen}
        {...(props.onCreate === undefined ? {} : { onCreate: props.onCreate })}
        {...(exportClient?.exportOffers === undefined
          ? {}
          : { onExport: (entry) => void openExport(entry) })}
        {...(props.serverUrl === undefined || props.windowCapability === undefined
          ? {}
          : {
              onTagAdd: (canvasId, tag) =>
                void tags.change(tagCommand("canvas-tag-add")(canvasId, tag)),
              onTagRemove: (canvasId, tag) =>
                void tags.change(tagCommand("canvas-tag-remove")(canvasId, tag)),
            })}
      />
      <ArtifactMirrorSettings
        busy={mirror.busy}
        {...(mirror.message === undefined ? {} : { message: mirror.message })}
        onChangeAutoCommit={(autoCommit) => void mirror.changeAutoCommit(autoCommit)}
        onChangeDestination={(destination) => void mirror.changeDestination(destination)}
        onChooseFolderAgain={(status, folder) => void mirror.chooseFolderAgain(status, folder)}
        projects={mirror.projects}
        settings={mirror.settings}
      />
      <SyncedArtifactDialog
        busy={synced.busy}
        detail={synced.detail}
        {...(synced.message === undefined ? {} : { message: synced.message })}
        observedAt={observedAt}
        onClose={synced.close}
        {...(props.onCreate === undefined ? {} : { onCreate: props.onCreate })}
        onKeep={(versionId) =>
          void synced.runOnSelected((canvasId) => ({ kind: "keep", canvasId, versionId }))
        }
        onMerge={(threadId) =>
          void synced.runOnSelected((canvasId) => ({
            kind: "merge",
            canvasId,
            ...(threadId === undefined ? {} : { threadId }),
          }))
        }
        onOpenIn={(threadId) =>
          void synced.runOnSelected((canvasId) => ({ kind: "open", canvasId, threadId }))
        }
        onRestore={() => void synced.runOnSelected((canvasId) => ({ kind: "restore", canvasId }))}
        open={synced.selected !== undefined}
      />
      <OctantDialog
        className="canvas-workspace-tab__share-dialog"
        describedBy="canvas-export-description"
        label="Export artifact"
        labelledBy="canvas-export-title"
        onClose={() => {
          exportToken.current += 1;
          setExportOffers(undefined);
          setExportMessage(undefined);
          setExportEntry(undefined);
        }}
        open={exportOffers !== undefined || exportMessage !== undefined}
      >
        {exportOffers !== undefined &&
        prepareExport !== undefined &&
        exportClient?.decideExport !== undefined ? (
          <CanvasExportPanel
            key={String(exportOffers.canvasId)}
            folder={exportFolder}
            offers={exportOffers}
            onDecide={exportClient.decideExport}
            onExportFolderChosen={() => {
              if (exportEntry !== undefined) void openExport(exportEntry);
            }}
            onPrepare={(request) => prepareExport(withWorkspaceFrameTheme(request))}
          />
        ) : exportMessage === undefined ? null : (
          <p className="canvas-export__note">{exportMessage}</p>
        )}
      </OctantDialog>
    </Surface>
  );
}

function exportClientFor(props: ArtifactLibrarySurfaceProps): CanvasClient | undefined {
  if (props.serverUrl === undefined || props.windowCapability === undefined) return undefined;
  return createCanvasClient({
    baseUrl: props.serverUrl,
    fetch: globalThis.fetch,
    windowCapability: props.windowCapability,
  });
}
