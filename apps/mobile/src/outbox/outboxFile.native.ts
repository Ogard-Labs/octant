import { File, Paths } from "expo-file-system";
import type { SealedFile } from "./sealedText";

export function outboxFile(): SealedFile {
  const file = () => new File(Paths.document, "outbox.v1.sealed");
  return {
    read: () => {
      const kept = file();
      return kept.exists ? kept.textSync() : null;
    },
    write: (sealed) => file().write(sealed),
    remove: () => {
      const kept = file();
      if (kept.exists) kept.delete();
    },
  };
}
