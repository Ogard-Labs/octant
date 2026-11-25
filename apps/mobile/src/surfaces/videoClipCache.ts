import type { MobileThreadVideos } from "@octant/client-runtime/video-generation-client";
import { File, Paths } from "expo-file-system";

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
