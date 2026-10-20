import { File, Paths } from "expo-file-system";

/**
 * The image picker hands back a cache file the system may purge. Copy it next
 * to the app's documents, which the system keeps, and store that path.
 */
export function persistWallpaperFile(pickedUri: string): string {
  const source = new File(pickedUri);
  const target = new File(Paths.document, `background-${Date.now()}.jpg`);
  source.copy(target);
  return target.uri;
}

export async function wallpaperFileExists(uri: string): Promise<boolean> {
  return new File(uri).exists;
}
