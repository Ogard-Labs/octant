import type { SealedFile } from "./sealedText";

/** A browser stand-in keeps the text while it is open, and no longer. */
export function sealedFile(_name: string): SealedFile {
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
