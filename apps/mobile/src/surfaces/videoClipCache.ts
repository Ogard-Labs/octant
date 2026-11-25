import type { MobileThreadVideos } from "@octant/client-runtime/video-generation-client";
import { File, Paths } from "expo-file-system";

const CACHED_CLIP_NAME = /^octant-video-.+\.mp4$/;

/**
 * Deletes playback copies left behind when the system ended the app before a
 * clip was closed. Run once at launch, before any clip can be open.
 */
export function reclaimVideoClipCache(): void {
  try {
    for (const entry of Paths.cache.list()) {
      if (!(entry instanceof File) || !CACHED_CLIP_NAME.test(entry.name)) continue;
      try {
        entry.delete();
      } catch {
        // The next launch tries again; the other copies still go now.
      }
    }
  } catch {
    // An unreadable cache folder must not stop the app from opening.
  }
}

export async function cacheVideoClip(
  client: MobileThreadVideos,
  input: Omit<Parameters<MobileThreadVideos["readClip"]>[0], "write">,
): Promise<File> {
  const file = new File(Paths.cache, `octant-video-${globalThis.crypto.randomUUID()}.mp4`);
  let complete = false;
  try {
    file.create();
    const handle = file.open();
    try {
      await client.readClip({ ...input, write: (bytes) => handle.writeBytesSync(bytes) });
    } finally {
      handle.close();
    }
    if (input.signal.aborted) throw new Error("The clip was closed.");
    complete = true;
    return file;
  } finally {
    if (!complete && file.exists) file.delete();
  }
}
