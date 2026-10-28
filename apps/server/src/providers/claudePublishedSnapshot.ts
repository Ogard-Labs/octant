import { constants } from "node:fs";
import { open } from "node:fs/promises";

import {
  MAX_THREAD_PUBLISHED_SNAPSHOT_BYTES,
  type ThreadPublishedSnapshot,
} from "@octant/contracts";

/**
 * The host's snapshot of a Project file a person approved publishing as a
 * Claude artifact: its text, read once, when they approved it, so the thread
 * can show what the page held without Octant ever fetching claude.ai. Only an
 * `.html` or `.md` file (the two the Artifact tool publishes) of at most
 * {@link MAX_THREAD_PUBLISHED_SNAPSHOT_BYTES} valid UTF-8 is kept; anything
 * else keeps only its link. The caller has already confined the path to the
 * Project; the final component is still opened without following a link, so a
 * file swapped for a link after that check is not read.
 */
export async function readClaudePublishedSnapshot(
  filePath: string,
): Promise<ThreadPublishedSnapshot | undefined> {
  const format = snapshotFormat(filePath);
  if (format === undefined) return undefined;
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_THREAD_PUBLISHED_SNAPSHOT_BYTES) {
      return undefined;
    }
    // One byte past the bound tells a file that grew since `stat` apart.
    const buffer = Buffer.alloc(MAX_THREAD_PUBLISHED_SNAPSHOT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length === 0 || length > MAX_THREAD_PUBLISHED_SNAPSHOT_BYTES) return undefined;
    const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    return { format, content };
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function snapshotFormat(filePath: string): ThreadPublishedSnapshot["format"] | undefined {
  if (/\.html?$/i.test(filePath)) return "html";
  if (/\.(md|markdown)$/i.test(filePath)) return "markdown";
  return undefined;
}
