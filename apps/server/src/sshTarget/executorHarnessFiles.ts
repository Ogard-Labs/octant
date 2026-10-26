import { Schema } from "effect";
import {
  SshHarnessFileResult,
  type SshExecutorHarnessFileReply,
  type SshExecutorHarnessFileRequest,
  type SshExecutorRefusedReply,
} from "@octant/contracts/ssh-executor-protocol";
import { NativeHarnessFileSystem } from "../harness/nativeHarnessFileSystem";
import { resolveBoundRoot, type ExecutorReadEnvironment } from "./executorReads";

/**
 * The native harness's file tools on a bound root, run on the target by the
 * same file system class a local harness session uses. Canonical:
 * docs/design/remote-ssh-environments.md § Native harness on a target.
 *
 * Every path is resolved and contained on the target, where the files are,
 * so a link planted in the root cannot carry a read or a write out of it. A
 * reader is one host tool set: it sees only its own reads, so an edit needs a
 * read by the same thread, as locally. Readers are not kept past the session,
 * so a reconnected thread reads a file again before it edits it.
 */

/** Readers one session keeps; the oldest is forgotten past this. */
const MAX_READERS = 32;
const isHarnessFileResult = Schema.is(SshHarnessFileResult);

export class ExecutorHarnessFiles {
  readonly #environment: Pick<ExecutorReadEnvironment, "homeDirectory" | "sessionParent">;
  readonly #readers = new Map<string, NativeHarnessFileSystem>();

  constructor(environment: Pick<ExecutorReadEnvironment, "homeDirectory" | "sessionParent">) {
    this.#environment = environment;
  }

  async answer(
    request: SshExecutorHarnessFileRequest,
  ): Promise<SshExecutorHarnessFileReply | SshExecutorRefusedReply> {
    const root = await resolveBoundRoot(this.#environment, request.root);
    if (root.status === "refused") return { kind: "refused", reason: root.reason };
    const files = this.#reader(root.canonical, request.reader);
    const { operation } = request;
    let result: unknown;
    try {
      switch (operation.tool) {
        case "read":
          result = await files.read(operation.arguments);
          break;
        case "write":
          result = await files.write(operation.arguments);
          break;
        case "edit":
          result = await files.edit(operation.arguments);
          break;
        case "glob":
          result = await files.glob(operation.arguments);
          break;
        case "grep":
          result = await files.grep(operation.arguments);
          break;
      }
    } catch {
      return { kind: "refused", reason: "read-failed" };
    }
    // A result the host's schema would refuse ends the whole session there,
    // so one this side cannot send as it is fails here instead.
    return isHarnessFileResult(result)
      ? { kind: "harness-file", result }
      : { kind: "refused", reason: "read-failed" };
  }

  #reader(root: string, reader: string): NativeHarnessFileSystem {
    const key = `${reader}\u0000${root}`;
    const known = this.#readers.get(key);
    if (known !== undefined) {
      this.#readers.delete(key);
      this.#readers.set(key, known);
      return known;
    }
    if (this.#readers.size >= MAX_READERS) {
      const oldest = this.#readers.keys().next();
      if (oldest.done !== true) this.#readers.delete(oldest.value);
    }
    const created = new NativeHarnessFileSystem({ root });
    this.#readers.set(key, created);
    return created;
  }
}
