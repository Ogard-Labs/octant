import { NewThreadDraft } from "@octant/contracts/thread-draft";

/** What the draft-thread workspace says about its mode: the name in the surface's label and the composer's hint. */
export interface DraftThreadModePresentation {
  readonly eyebrow: string;
  readonly composerPlaceholder: string;
}

/** Build mode-specific presentation for the draft-thread workspace. */
export function draftThreadModePresentation(
  mode: NewThreadDraft["mode"],
): DraftThreadModePresentation {
  switch (mode) {
    case "chat":
      return { eyebrow: "Octant Chat", composerPlaceholder: "Ask anything…" };
    case "work":
      return { eyebrow: "Octant Work", composerPlaceholder: "Ask anything…" };
    case "code":
      return { eyebrow: "Octant Code", composerPlaceholder: "Ask anything…" };
  }
}
