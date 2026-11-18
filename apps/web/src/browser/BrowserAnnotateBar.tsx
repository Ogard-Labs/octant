import { Fragment, type ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";

/** One tool in the page's annotation toolbar. */
export interface AnnotateTool {
  readonly id: string;
  /** The accessible name, and the first line of the tooltip. */
  readonly label: string;
  /** What the tool does, or why it cannot be used now. */
  readonly hint?: string | undefined;
  readonly icon: ReactNode;
  /** The tool is armed: the next click on the page is its. */
  readonly pressed?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly onPress: () => void;
  /** Tools of one kind stand together; a hairline parts the kinds. */
  readonly group: "point" | "draw" | "notes" | "end";
}

export interface BrowserAnnotateBarProps {
  readonly tools: ReadonlyArray<AnnotateTool>;
  /** What the armed tool waits for, or what the host last said about a note. */
  readonly status?: string | undefined;
  /** The notes left on this page, and whether their list is open above the band. */
  readonly notes?:
    | {
        readonly count: number;
        readonly included: number;
        readonly open: boolean;
        readonly onToggle: () => void;
      }
    | undefined;
}

/**
 * The page's annotation tools as one toolbar, centred in a band of its own
 * under the page. The band has one height whatever is armed and whatever the
 * host says, so the page above it never resizes for a tool: a live page is a
 * window-level view placed by its rectangle, and it must not move between
 * arming a tool and the click that tool waits for. Nothing can be drawn over
 * that view either, which is why the toolbar stands under the page and its
 * tooltips are the platform's own.
 */
export function BrowserAnnotateBar(props: BrowserAnnotateBarProps) {
  const notes = props.notes;
  return (
    <div className="browser-annotate">
      <p className="browser-annotate__status" role="status" title={props.status}>
        {props.status}
      </p>
      <div aria-label="Page tools" className="browser-annotate__pill" role="toolbar">
        {props.tools.map((tool, index) => (
          <Fragment key={tool.id}>
            {index > 0 && props.tools[index - 1]?.group !== tool.group ? (
              <span aria-hidden="true" className="browser-annotate__rule" />
            ) : null}
            <OctantButton
              aria-label={tool.label}
              aria-pressed={tool.pressed === undefined ? undefined : tool.pressed}
              className="browser-annotate__tool"
              disabled={tool.disabled === true}
              onClick={tool.onPress}
              size="icon"
              title={tool.hint === undefined ? tool.label : `${tool.label}. ${tool.hint}`}
              type="button"
              variant="bare"
            >
              {tool.icon}
            </OctantButton>
          </Fragment>
        ))}
      </div>
      <div className="browser-annotate__notes">
        {notes === undefined || notes.count === 0 ? null : (
          <OctantButton
            aria-expanded={notes.open}
            onClick={notes.onToggle}
            size="sm"
            title={
              notes.included === 1 && notes.count === 1
                ? "1 note goes with your next message"
                : `${notes.included} of ${notes.count} notes included with your next message`
            }
            type="button"
            variant="ghost"
          >
            {notes.count === 1 ? "1 note" : `${notes.count} notes`}
          </OctantButton>
        )}
      </div>
    </div>
  );
}
