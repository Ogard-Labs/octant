import type { ArtifactLibraryEntry } from "@octant/contracts/artifact-library";
import type { CanvasExportOfferList } from "@octant/contracts/canvas-export";
import { createCanvasClient, type CanvasClient } from "@octant/client-runtime/canvas-client";
import { useMemo, useState } from "react";
import { CanvasExportPanel } from "../canvas/CanvasExportPanel";
import { OctantDialog } from "../ui/base/OctantDialog";
import { Surface } from "../surface/SurfaceHeader";
import { ArtifactLibraryView } from "./ArtifactLibraryView";
import { ArtifactMirrorSettings } from "./ArtifactMirrorSettings";
import { useArtifactLibrary } from "./useArtifactLibrary";
import { useArtifactMirror } from "./useArtifactMirror";

export interface ArtifactLibrarySurfaceProps {
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly onOpen: (entry: ArtifactLibraryEntry) => void;
  readonly onClose: () => void;
  /** Absent on a host that cannot start one, which hides the create action. */
  readonly onCreate?: () => void;
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
  const mirror = useArtifactMirror({
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  const library = useArtifactLibrary({
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });
  const exportClient = useMemo(
    () => exportClientFor(props),
    [props.serverUrl, props.windowCapability],
  );
  const [exportOffers, setExportOffers] = useState<CanvasExportOfferList | undefined>(undefined);
  const [exportMessage, setExportMessage] = useState<string | undefined>(undefined);

  async function openExport(entry: ArtifactLibraryEntry) {
    if (exportClient?.exportOffers === undefined) return;
    setExportMessage(undefined);
    setExportOffers(undefined);
    try {
      setExportOffers(await exportClient.exportOffers(entry.canvasId));
    } catch {
      setExportMessage("Export is unavailable.");
      setExportOffers(undefined);
    }
  }

  return (
    <Surface ariaLabel="Artifact library">
      <ArtifactLibraryView
        busy={library.busy}
        filters={library.filters}
        listing={library.listing}
        {...(library.message === undefined ? {} : { message: library.message })}
        observedAt={String(library.listing?.generatedAt ?? "")}
        onClose={props.onClose}
        onFiltersChange={library.setFilters}
        onOpen={props.onOpen}
        {...(props.onCreate === undefined ? {} : { onCreate: props.onCreate })}
        {...(exportClient?.exportOffers === undefined
          ? {}
          : { onExport: (entry) => void openExport(entry) })}
      />
      <ArtifactMirrorSettings
        busy={mirror.busy}
        {...(mirror.message === undefined ? {} : { message: mirror.message })}
        onChangeAutoCommit={(autoCommit) => void mirror.changeAutoCommit(autoCommit)}
        onChangeDestination={(destination) => void mirror.changeDestination(destination)}
        settings={mirror.settings}
      />
      <OctantDialog
        className="canvas-workspace-tab__share-dialog"
        describedBy="canvas-export-description"
        label="Export artifact"
        labelledBy="canvas-export-title"
        onClose={() => {
          setExportOffers(undefined);
          setExportMessage(undefined);
        }}
        open={exportOffers !== undefined || exportMessage !== undefined}
      >
        {exportOffers !== undefined &&
        exportClient?.prepareExport !== undefined &&
        exportClient.decideExport !== undefined ? (
          <CanvasExportPanel
            key={String(exportOffers.canvasId)}
            offers={exportOffers}
            onDecide={exportClient.decideExport}
            onPrepare={exportClient.prepareExport}
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
