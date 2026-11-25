import { File, Paths } from "expo-file-system";
import type { SealedFile } from "./sealedText";

export function outboxFile(): SealedFile {
  const file = () => new File(Paths.document, "outbox.v1.sealed");
  const next = () => new File(Paths.document, "outbox.v1.sealed.next");
  return {
    read: () => {
      // Moving over a file removes it first, so after a crash in between only
      // the new one is there, whole.
      const kept = [file(), next()].find((entry) => entry.exists);
      return kept === undefined ? null : kept.textSync();
    },
    // Beside the last one and then over it: a crash in between leaves one whole.
    write: (sealed) => {
      const written = next();
      if (!written.exists) written.create();
      written.writeSync(sealed);
      written.moveSync(file(), { overwrite: true });
    },
    remove: () => {
      for (const kept of [file(), next()]) if (kept.exists) kept.delete();
    },
  };
}
