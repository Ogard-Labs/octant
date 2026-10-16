import type { ApprovalOutsideContent } from "@octant/contracts";
import { approvalOutsideContentLines } from "@octant/domain";
import { absoluteTimeFormatter } from "../lib/relativeTime";
import "./outside-content-notice.css";

function time(at: string | undefined): string | undefined {
  if (at === undefined) return undefined;
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? undefined : absoluteTimeFormatter.format(parsed);
}

/**
 * Why an approval on a marked thread asks for this one call, and what marked
 * it. Without it the prompt only said "approve once", and a person could not
 * tell that a page or tool result the model read was the reason, nor which.
 */
export function ApprovalOutsideContentNote(props: {
  readonly outsideContent: ApprovalOutsideContent;
}) {
  const { reason, rows, more } = approvalOutsideContentLines(props.outsideContent, time);
  return (
    <div className="approval-outside-content">
      <p className="approval-outside-content__reason">{reason}</p>
      {rows.length === 0 ? null : (
        <ul
          aria-label="Outside content that marked this thread"
          className="outside-content-sources"
        >
          {rows.map((row) => (
            <li className="outside-content-sources__row" key={row.sourceLabel}>
              <span className="outside-content-sources__name">{row.name}</span>
              <span className="outside-content-sources__meta">{row.reads}</span>
            </li>
          ))}
        </ul>
      )}
      {more === undefined ? null : <p className="outside-content-sources__meta">{more}</p>}
    </div>
  );
}
