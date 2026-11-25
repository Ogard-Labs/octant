import type { SealedFile } from "./sealedText";

/** A browser stand-in keeps the messages while it is open, and no longer. */
export function outboxFile(): SealedFile {
  let held: string | null = null;
  return {
    read: () => held,
    write: (sealed) => {
      held = sealed;
    },
    remove: () => {
      held = null;
    },
  };
}
