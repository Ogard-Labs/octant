import type { ApprovalOutsideContent } from "@octant/contracts";
import { describeReads } from "./OutsideContentNotice";
import { describeSource } from "./outsideContentSources";
import "./outside-content-notice.css";

/**
 * Why an approval on a marked thread asks for this one call, and what marked
 * it. Without it the prompt only said "approve once", and a person could not
 * tell that a page or tool result the model read was the reason, nor which.
 */
export function ApprovalOutsideContentNote(props: {
  readonly outsideContent: ApprovalOutsideContent;
}) {
  const { sources, sourceCount } = props.outsideContent;
  const unnamed = sourceCount - sources.length;
  return (
    <div className="approval-outside-content">
      <p className="approval-outside-content__reason">
        This thread took in outside content, so this call is approved once. Check that it is
        something you asked for.
      </p>
      {sources.length === 0 ? null : (
        <ul
          aria-label="Outside content that marked this thread"
          className="outside-content-sources"
        >
          {sources.map((source) => (
            <li className="outside-content-sources__row" key={source.sourceLabel}>
              <span className="outside-content-sources__name">
                {describeSource(source.sourceLabel)}
              </span>
              <span className="outside-content-sources__meta">{describeReads(source)}</span>
            </li>
          ))}
        </ul>
      )}
      {unnamed > 0 ? (
        <p className="outside-content-sources__meta">
          {unnamed === 1 ? "and 1 more source" : `and ${unnamed} more sources`}
        </p>
      ) : null}
    </div>
  );
}
