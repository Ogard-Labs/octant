/**
 * How the Artifacts page draws its entries: a gallery of preview cards, or a
 * list of compact rows. The choice is this window's own reading preference,
 * like the Browser's Recent pages: it is kept in the renderer's local storage
 * and never sent to the host, because it journals nothing and decides nothing
 * about what the host returns.
 */
export type ArtifactLibraryView = "gallery" | "list";

export const ARTIFACT_LIBRARY_VIEW_GALLERY: ArtifactLibraryView = "gallery";
export const ARTIFACT_LIBRARY_VIEW_LIST: ArtifactLibraryView = "list";

const VIEW_KEY = "octant.artifacts.view.v1";

export function readArtifactLibraryView(
  storage: Pick<Storage, "getItem"> | undefined,
): ArtifactLibraryView | undefined {
  try {
    const value = storage?.getItem(VIEW_KEY);
    return value === "gallery" || value === "list" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeArtifactLibraryView(
  view: ArtifactLibraryView,
  storage: Pick<Storage, "setItem"> | undefined,
): void {
  try {
    storage?.setItem(VIEW_KEY, view);
  } catch {
    // A window without storage simply opens the gallery next time.
  }
}
