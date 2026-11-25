import type { ThreadMentionCandidate } from "@octant/contracts";
import { lazyOr } from "../lib/lazyOr";
import { threadModeLabel } from "../threadReferences/threadModeLabel";
import { Hash } from "../ui/icons";
import { threadPlacementLabel } from "./threadPlacementLabel";

interface OptionProps {
  readonly candidate: ThreadMentionCandidate;
}

/** The hit in the host's own words, until the window's facts about it are drawn, and if they cannot be. */
function PlainOption({ candidate }: OptionProps) {
  return (
    <>
      <Hash aria-hidden="true" size={12} />
      <span>{candidate.title}</span>
      <span className="thread-mention__meta">
        {`${threadModeLabel(candidate.mode)} · ${threadPlacementLabel(candidate.placement)}`}
      </span>
    </>
  );
}

/** One hit of the `#` list. Its marks and their styles load when the list first opens. */
export const LazyThreadMentionOption = lazyOr<OptionProps>(
  async () => (await import("./ThreadMentionOption")).ThreadMentionOption,
  PlainOption,
);
