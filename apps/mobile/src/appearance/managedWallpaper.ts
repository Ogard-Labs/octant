const MANAGED_NAME = /^background-\d+\.jpg$/;

export function managedWallpaperName(now: number): string {
  return `background-${now}.jpg`;
}

/**
 * Only a copy the app made in its own documents folder is the app's to delete.
 * A user's original photo, a picker cache file, or a data URI never matches.
 */
export function isManagedWallpaperUri(uri: string, documentDirectoryUri: string): boolean {
  const directory = documentDirectoryUri.endsWith("/")
    ? documentDirectoryUri
    : `${documentDirectoryUri}/`;
  if (!uri.startsWith(directory)) return false;
  return MANAGED_NAME.test(uri.slice(directory.length));
}
