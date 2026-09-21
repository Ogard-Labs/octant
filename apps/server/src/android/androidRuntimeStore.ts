import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeCodeThreadId,
  decodeCodeCheckoutId,
  type CodeThreadId,
  type CodeCheckoutId,
} from "@octant/contracts";

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const SAFE_REFERENCE = /^android-[a-z0-9-]{1,200}$/;

export interface AndroidArtifactScope {
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
}

export class AndroidRuntimeStore {
  readonly #artifactRoot: string;

  constructor(root: string) {
    this.#artifactRoot = join(root, "artifacts");
  }

  get artifactRoot(): string {
    return this.#artifactRoot;
  }

  async writeArtifact(
    reference: string,
    bytes: Uint8Array,
    scope: AndroidArtifactScope,
  ): Promise<void> {
    if (!SAFE_REFERENCE.test(reference) || bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new Error("Android artifact is invalid.");
    }
    const directory = await this.#scopeDirectory(scope, true);
    const target = join(directory, reference);
    const temporary = join(directory, `${randomUUID()}.tmp`);
    await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
    try {
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async readArtifact(
    reference: string,
    scope: AndroidArtifactScope,
  ): Promise<Uint8Array | undefined> {
    if (!SAFE_REFERENCE.test(reference)) return undefined;
    try {
      const directory = await this.#scopeDirectory(scope, false);
      const file = await open(
        join(directory, reference),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const status = await file.stat();
        if (!status.isFile() || status.nlink !== 1 || status.size > MAX_ARTIFACT_BYTES)
          return undefined;
        const buffer = new Uint8Array(status.size + 1);
        let length = 0;
        while (length < buffer.byteLength) {
          const { bytesRead } = await file.read(buffer, length, buffer.byteLength - length, length);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        return length === status.size ? buffer.slice(0, length) : undefined;
      } finally {
        await file.close();
      }
    } catch {
      return undefined;
    }
  }

  async #scopeDirectory(scope: AndroidArtifactScope, create: boolean): Promise<string> {
    const thread = String(decodeCodeThreadId(scope.threadId));
    const checkout = String(decodeCodeCheckoutId(scope.checkoutId));
    const directory = join(this.#artifactRoot, thread, checkout);
    for (const path of [this.#artifactRoot, join(this.#artifactRoot, thread), directory]) {
      if (create) await mkdir(path, { recursive: true, mode: 0o700 });
      const status = await lstat(path);
      if (!status.isDirectory() || status.isSymbolicLink())
        throw new Error("Android artifact directory is invalid.");
    }
    return directory;
  }
}
