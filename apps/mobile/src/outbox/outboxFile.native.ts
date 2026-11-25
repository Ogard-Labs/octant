import { File, Paths } from "expo-file-system";
import type { SealedFile } from "./sealedText";

export function outboxFile(): SealedFile {
  const file = () => new File(Paths.document, "outbox.v1.sealed");
  const next = () => new File(Paths.document, "outbox.v1.sealed.next");
  return {
    read: () => {
      const kept = file();
      return kept.exists ? kept.textSync() : null;
    },
    // Beside the last one and then over it: a crash in between leaves one whole.
    write: (sealed) => {
      const written = next();
      if (!written.exists) written.create();
      written.writeSync(sealed);
      written.moveSync(file(), { overwrite: true });
    },
    remove: () => {
      const kept = file();
      if (kept.exists) kept.delete();
    },
  };
}
