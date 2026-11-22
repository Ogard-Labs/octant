import { createHash } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_VIDEO_CLIP_BYTES,
  type ImageGenerationScopeId,
  type VideoClipId,
} from "@octant/contracts";

/** `"video/mp4"` when the bytes start with an MP4 `ftyp` box, else `undefined`. */
export function sniffVideoClipMediaType(bytes: Uint8Array): "video/mp4" | undefined {
  return bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
    ? "video/mp4"
    : undefined;
}

export type VideoClipWrite =
  | { readonly status: "stored"; readonly hash: string; readonly size: number }
  | { readonly status: "refused"; readonly reason: "too-large" | "not-mp4" | "empty" }
  | { readonly status: "failed"; readonly reason: "disk" };

export interface VideoClipRange {
  readonly bytes: Uint8Array;
  readonly start: number;
  readonly end: number;
  readonly size: number;
}

/**
 * Generated clips under the host's data directory, one file per clip, named
 * by the clip id inside a folder per thread so a thread delete removes them
 * together. A clip is written once to a temporary name and renamed into
 * place, so a crash never leaves a half-written clip under its real name.
 */
export class VideoClipStore {
  readonly #root: string;

  constructor(dataDirectory: string) {
    this.#root = join(dataDirectory, "generated-video");
  }

  #scopeDirectory(scopeId: ImageGenerationScopeId): string {
    return join(this.#root, String(scopeId));
  }

  #clipPath(scopeId: ImageGenerationScopeId, clipId: VideoClipId): string {
    return join(this.#scopeDirectory(scopeId), `${String(clipId)}.mp4`);
  }

  async write(
    scopeId: ImageGenerationScopeId,
    clipId: VideoClipId,
    bytes: Uint8Array,
  ): Promise<VideoClipWrite> {
    if (bytes.byteLength === 0) return { status: "refused", reason: "empty" };
    if (bytes.byteLength > MAX_VIDEO_CLIP_BYTES) return { status: "refused", reason: "too-large" };
    if (sniffVideoClipMediaType(bytes) === undefined) {
      return { status: "refused", reason: "not-mp4" };
    }
    const directory = this.#scopeDirectory(scopeId);
    const target = this.#clipPath(scopeId, clipId);
    const temporary = `${target}.partial`;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      return { status: "failed", reason: "disk" };
    }
    return {
      status: "stored",
      hash: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    };
  }

  async size(scopeId: ImageGenerationScopeId, clipId: VideoClipId): Promise<number | undefined> {
    try {
      const info = await stat(this.#clipPath(scopeId, clipId));
      return info.isFile() ? info.size : undefined;
    } catch {
      return undefined;
    }
  }

  /** Reads `[start, end]` inclusive, clamped to the clip, for a byte-range response. */
  async readRange(
    scopeId: ImageGenerationScopeId,
    clipId: VideoClipId,
    range: { readonly start: number; readonly end: number },
  ): Promise<VideoClipRange | undefined> {
    let handle;
    try {
      handle = await open(this.#clipPath(scopeId, clipId), "r");
    } catch {
      return undefined;
    }
    try {
      const size = (await handle.stat()).size;
      if (range.start >= size || range.start > range.end) return undefined;
      const end = Math.min(range.end, size - 1);
      const bytes = new Uint8Array(end - range.start + 1);
      await handle.read(bytes, 0, bytes.byteLength, range.start);
      return { bytes, start: range.start, end, size };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async readAll(
    scopeId: ImageGenerationScopeId,
    clipId: VideoClipId,
  ): Promise<Uint8Array | undefined> {
    const size = await this.size(scopeId, clipId);
    if (size === undefined || size === 0) return undefined;
    return (await this.readRange(scopeId, clipId, { start: 0, end: size - 1 }))?.bytes;
  }

  async remove(scopeId: ImageGenerationScopeId, clipId: VideoClipId): Promise<void> {
    await rm(this.#clipPath(scopeId, clipId), { force: true });
  }

  /** Removes every clip of a thread, for a thread delete. */
  async purgeScope(scopeId: ImageGenerationScopeId): Promise<void> {
    await rm(this.#scopeDirectory(scopeId), { recursive: true, force: true });
  }

  /** Removes temporary files a crash left behind. */
  async recover(): Promise<void> {
    let scopes: ReadonlyArray<string>;
    try {
      scopes = await readdir(this.#root);
    } catch {
      return;
    }
    for (const scope of scopes) {
      const directory = join(this.#root, scope);
      let names: ReadonlyArray<string>;
      try {
        names = await readdir(directory);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.endsWith(".partial")) {
          await rm(join(directory, name), { force: true }).catch(() => undefined);
        }
      }
    }
  }
}
