import { trackerMentionLabel } from "@octant/domain";
import type { TrackerMentionCandidate } from "@octant/contracts/tracker-mention-search";
import { OctantListboxOption } from "../ui/base/OctantListbox";
import {
  TRACKER_MENTION_KIND_LABEL,
  TrackerMentionIcon,
  trackerMentionStateText,
} from "./trackerMentionPresentation";
import "../chat/thread-mention-option.css";

export interface TrackerMentionRowsProps {
  readonly listId: string;
  readonly candidates: ReadonlyArray<TrackerMentionCandidate>;
  /** The highlighted row among these, negative while a thread is highlighted. */
  readonly activeIndex: number;
  readonly onHover: (index: number) => void;
  readonly onChoose: (candidate: TrackerMentionCandidate) => void;
}

/** The pull requests and issues of the `#` list, each shaped as a thread's row is. */
export function TrackerMentionRows(props: TrackerMentionRowsProps) {
  return props.candidates.map((candidate, index) => (
    <li className="thread-mention__option" key={candidate.url} role="presentation">
      <OctantListboxOption
        id={`${props.listId}-${candidate.source}-${candidate.id}`}
        onClick={() => props.onChoose(candidate)}
        onMouseEnter={() => props.onHover(index)}
        selected={index === props.activeIndex}
        size="sm"
        variant={index === props.activeIndex ? "secondary" : "ghost"}
      >
        <span className="thread-mention__mark">
          <TrackerMentionIcon kind={candidate.kind} />
        </span>
        <span className="thread-mention__title">
          {`${trackerMentionLabel(candidate)} ${candidate.title}`}
        </span>
        <span className="thread-mention__meta">
          <span>{trackerMentionStateText(candidate.state)}</span>
          <span className="thread-mention__origin">
            {`${TRACKER_MENTION_KIND_LABEL[candidate.kind]} · ${candidate.container}`}
          </span>
        </span>
      </OctantListboxOption>
    </li>
  ));
}
