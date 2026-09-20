import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const SAFE_REFERENCE = /^android-[a-z0-9-]{1,500}$/;

export class AndroidRuntimeStore {
  readonly #artifactRoot: string;

  constructor(root: string) {
    this.#artifactRoot = join(root, "artifacts");
  }

  get artifactRoot(): string {
    return this.#artifactRoot;
  }

  async writeArtifact(reference: string, bytes: Uint8Array): Promise<void> {
    if (!SAFE_REFERENCE.test(reference) || bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new Error("Android artifact is invalid.");
    }
    await mkdir(this.#artifactRoot, { recursive: true, mode: 0o700 });
    const target = join(this.#artifactRoot, reference);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, target);
  }

  async readArtifact(reference: string): Promise<Uint8Array | undefined> {
    if (!SAFE_REFERENCE.test(reference)) return undefined;
    try {
      const bytes = await readFile(join(this.#artifactRoot, reference));
      if (bytes.byteLength > MAX_ARTIFACT_BYTES) return undefined;
      return new Uint8Array(bytes);
    } catch {
      return undefined;
    }
  }
}
