import type { ArtifactLibraryEntry } from "@octant/contracts/artifact-library";
import { X } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import { ArtifactLibraryView } from "./ArtifactLibraryView";
import { useArtifactLibrary } from "./useArtifactLibrary";

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
  const library = useArtifactLibrary({
    ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
    ...(props.windowCapability === undefined ? {} : { windowCapability: props.windowCapability }),
  });

  return (
    <div className="artifact-library-surface">
      <div className="artifact-library-surface__chrome">
        <OctantButton onClick={props.onClose} size="sm" type="button" variant="ghost">
          <X aria-hidden="true" size={12} strokeWidth={1.8} />
          Close
        </OctantButton>
      </div>
      <ArtifactLibraryView
        busy={library.busy}
        filters={library.filters}
        listing={library.listing}
        {...(library.message === undefined ? {} : { message: library.message })}
        observedAt={String(library.listing?.generatedAt ?? "")}
        onFiltersChange={library.setFilters}
        onOpen={props.onOpen}
        {...(props.onCreate === undefined ? {} : { onCreate: props.onCreate })}
      />
    </div>
  );
}
