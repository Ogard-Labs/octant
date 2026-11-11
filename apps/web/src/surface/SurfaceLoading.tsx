export interface SurfaceLoadingProps {
  /** What is opening, as assistive technology hears it: "Opening Inbox". */
  readonly label: string;
  /** The measure of the page that is on its way; most destinations are wide. */
  readonly measure?: "reading" | "wide";
}

const ROWS = ["first", "second", "third", "fourth", "fifth"] as const;

/**
 * The shape of a destination page while it loads: its title bar and a few
 * rows, in the frame the page itself draws in. A line of text in the middle of
 * the pane was replaced by a title in the corner when the page arrived, and
 * the whole pane jumped. The words stay for assistive technology, which cannot
 * see the shape.
 */
export function SurfaceLoading(props: SurfaceLoadingProps) {
  return (
    <div
      aria-label={props.label}
      className={
        props.measure === "reading"
          ? "surface surface-loading"
          : "surface surface--wide surface-loading"
      }
      role="status"
    >
      <span className="sr-only">{props.label}…</span>
      <div aria-hidden="true" className="surface__inner">
        <div className="surface-header">
          <span className="skeleton surface-loading__title" />
        </div>
        <div className="surface-loading__rows">
          {ROWS.map((row) => (
            <span className="skeleton surface-loading__row" key={row} />
          ))}
        </div>
      </div>
    </div>
  );
}
