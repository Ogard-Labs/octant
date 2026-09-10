import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MAX_AGENT_MESSAGE_BODY_BYTES } from "@octant/contracts";

/**
 * Host-side storage for one agent message's body.
 *
 * Bodies stay out of the journal: events carry an opaque token reference and a
 * byte length only. The store keeps the body on disk under the host data
 * directory, keyed by a random token that names nothing about the sender or
 * the recipient, and a purged thread's bodies are deleted with it — replay
 * after a purge rebuilds the message record but never the body.
 */
export class AgentMessageBodyStore {
  readonly #root: string;
  /** Hard ceiling on bodies held at once, so one host cannot fill its disk. */
  readonly #maxTotalBytes: number;
  #totalBytes = 0;

  constructor(root: string, options: { readonly maxTotalBytes?: number } = {}) {
    this.#root = root;
    this.#maxTotalBytes = options.maxTotalBytes ?? 32 * MAX_AGENT_MESSAGE_BODY_BYTES;
  }

  async write(
    body: string,
  ): Promise<
    | { readonly status: "stored"; readonly contentReference: string; readonly byteLength: number }
    | { readonly status: "refused"; readonly reason: "oversize" }
  > {
    const bytes = new TextEncoder().encode(body).length;
    if (bytes < 1 || bytes > MAX_AGENT_MESSAGE_BODY_BYTES) {
      return { status: "refused", reason: "oversize" };
    }
    if (this.#totalBytes + bytes > this.#maxTotalBytes) {
      return { status: "refused", reason: "oversize" };
    }
    const contentReference = `am-${randomUUID()}`;
    await mkdir(this.#root, { recursive: true });
    await writeFile(this.path(contentReference), body, "utf8");
    this.#totalBytes += bytes;
    return { status: "stored", contentReference, byteLength: bytes };
  }

  async read(contentReference: string): Promise<string | undefined> {
    if (!isOpaqueReference(contentReference)) return undefined;
    try {
      return await readFile(this.path(contentReference), "utf8");
    } catch {
      return undefined;
    }
  }

  async forget(contentReference: string): Promise<void> {
    if (!isOpaqueReference(contentReference)) return;
    const body = await this.read(contentReference);
    if (body !== undefined) this.#totalBytes -= new TextEncoder().encode(body).length;
    await rm(this.path(contentReference), { force: true });
  }

  path(contentReference: string): string {
    // The token is the whole file name: it never names a host path, and a
    // crafted reference cannot escape the store's directory.
    return join(this.#root, `${contentReference}.txt`);
  }
}

export function isOpaqueReference(value: string): boolean {
  return /^am-[0-9a-f-]{36}$/.test(value);
}
