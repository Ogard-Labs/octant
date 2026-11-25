import type { ThreadMentionCandidate } from "@octant/contracts";
import { lazy, Suspense, type ComponentType } from "react";
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

async function importThreadMentionOption(): Promise<{
  readonly default: ComponentType<OptionProps>;
}> {
  try {
    const module = await import("./ThreadMentionOption");
    return { default: module.ThreadMentionOption };
  } catch {
    return { default: PlainOption };
  }
}

const ThreadMentionOption = lazy(importThreadMentionOption);

/** One hit of the `#` list. Its marks and their styles load when the list first opens. */
export function LazyThreadMentionOption(props: OptionProps) {
  return (
    <Suspense fallback={<PlainOption {...props} />}>
      <ThreadMentionOption {...props} />
    </Suspense>
  );
}
