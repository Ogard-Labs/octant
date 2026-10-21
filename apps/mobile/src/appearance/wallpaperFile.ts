import { File, Paths } from "expo-file-system";
import { isManagedWallpaperUri, managedWallpaperName } from "./managedWallpaper";

/**
 * The image picker hands back a cache file the system may purge. Copy it next
 * to the app's documents, which the system keeps, and store that path.
 */
export function persistWallpaperFile(pickedUri: string): string {
  const source = new File(pickedUri);
  const target = new File(Paths.document, managedWallpaperName(Date.now()));
  source.copy(target);
  return target.uri;
}

export async function wallpaperFileExists(uri: string): Promise<boolean> {
  return new File(uri).exists;
}

/** Deletes a wallpaper copy this app made; any other URI is left alone. */
export async function removeManagedWallpaperFile(uri: string): Promise<void> {
  if (!isManagedWallpaperUri(uri, Paths.document.uri)) return;
  const file = new File(uri);
  if (file.exists) file.delete();
}
