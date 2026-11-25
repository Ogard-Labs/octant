import { createHash } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ImageGenerationScopeId } from "@octant/contracts";
import { MAX_VIDEO_CLIP_BYTES, type VideoClipId } from "@octant/contracts/video-generation";

const CLIP_EXTENSION = ".mp4";

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
  | {
      readonly status: "refused";
      readonly reason: "too-large" | "not-mp4" | "empty" | "purged";
    }
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
  /**
   * Scopes a thread delete closed: a write admitted after that is refused
   * rather than recreating a directory the delete already removed.
   */
  readonly #purgedScopes = new Set<string>();
  readonly #openWrites = new Map<string, number>();
  readonly #writeWaiters = new Map<string, Array<() => void>>();

  constructor(dataDirectory: string) {
    this.#root = join(dataDirectory, "generated-video");
  }

  #scopeDirectory(scopeId: ImageGenerationScopeId): string {
    return join(this.#root, String(scopeId));
  }

  #clipPath(scopeId: ImageGenerationScopeId, clipId: VideoClipId): string {
    return join(this.#scopeDirectory(scopeId), `${String(clipId)}${CLIP_EXTENSION}`);
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
    const scopeKey = String(scopeId);
    if (this.#purgedScopes.has(scopeKey)) return { status: "refused", reason: "purged" };
    this.#openWrites.set(scopeKey, (this.#openWrites.get(scopeKey) ?? 0) + 1);
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
    } finally {
      const left = (this.#openWrites.get(scopeKey) ?? 1) - 1;
      if (left <= 0) {
        this.#openWrites.delete(scopeKey);
        for (const waiter of this.#writeWaiters.get(scopeKey) ?? []) waiter();
        this.#writeWaiters.delete(scopeKey);
      } else {
        this.#openWrites.set(scopeKey, left);
      }
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

  /**
   * Streams a whole clip for a download or save, bounded by the read rather
   * than held in memory.
   */
  async stream(
    scopeId: ImageGenerationScopeId,
    clipId: VideoClipId,
  ): Promise<{ readonly body: ReadableStream<Uint8Array>; readonly size: number } | undefined> {
    let handle;
    try {
      handle = await open(this.#clipPath(scopeId, clipId), "r");
    } catch {
      return undefined;
    }
    const size = (await handle.stat()).size;
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const chunk = new Uint8Array(1024 * 1024);
          const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength);
          if (bytesRead === 0) {
            await handle.close().catch(() => undefined);
            controller.close();
            return;
          }
          controller.enqueue(chunk.subarray(0, bytesRead));
        } catch (error) {
          await handle.close().catch(() => undefined);
          controller.error(error);
        }
      },
      cancel: async () => {
        await handle.close().catch(() => undefined);
      },
    });
    return { body, size };
  }

  /** Removes every clip of a thread, for a thread delete. */
  async purgeScope(scopeId: ImageGenerationScopeId): Promise<void> {
    // Admission closes before the delete so a write that began while the
    // provider answered can finish but no later write recreates the folder.
    const scopeKey = String(scopeId);
    this.#purgedScopes.add(scopeKey);
    while ((this.#openWrites.get(scopeKey) ?? 0) > 0) {
      await new Promise<void>((resolve) => {
        const waiters = this.#writeWaiters.get(scopeKey) ?? [];
        waiters.push(resolve);
        this.#writeWaiters.set(scopeKey, waiters);
      });
    }
    await rm(this.#scopeDirectory(scopeId), { recursive: true, force: true });
  }

  /**
   * Removes temporary files a crash left behind and, in the threads `recorded`
   * names, finished clips the journal does not record. Other threads keep
   * every clip. Called before any job can write one.
   */
  async recover(recorded: ReadonlyMap<string, ReadonlySet<string>>): Promise<void> {
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
      const known = recorded.get(scope);
      for (const name of names) {
        const unrecorded =
          known !== undefined &&
          name.endsWith(CLIP_EXTENSION) &&
          !known.has(name.slice(0, -CLIP_EXTENSION.length));
        if (unrecorded || name.endsWith(".partial")) {
          await rm(join(directory, name), { force: true }).catch(() => undefined);
        }
      }
    }
  }
}
