import type { ArtifactLibraryEntry } from "@octant/contracts/artifact-library";
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
      />
      <ArtifactMirrorSettings
        busy={mirror.busy}
        {...(mirror.message === undefined ? {} : { message: mirror.message })}
        onChangeAutoCommit={(autoCommit) => void mirror.changeAutoCommit(autoCommit)}
        onChangeDestination={(destination) => void mirror.changeDestination(destination)}
        settings={mirror.settings}
      />
    </Surface>
  );
}
