export interface MiddleEllipsisProps {
  readonly text: string;
  /** Characters of the end kept readable when the text is cut. */
  readonly tail?: number;
  /** Words that always stay whole after the text, such as " · on main". */
  readonly suffix?: string;
  readonly className?: string;
}

/**
 * One line of a path or a name that gives up its middle when it does not fit,
 * so the folder it ends in stays readable. The whole text is the tooltip.
 */
export function MiddleEllipsis(props: MiddleEllipsisProps) {
  const tail = props.tail ?? 14;
  const split = props.text.length > tail * 2 ? props.text.length - tail : 0;
  const head = props.text.slice(0, split === 0 ? props.text.length : split);
  const end = split === 0 ? "" : props.text.slice(split);
  const suffix = props.suffix ?? "";
  return (
    <span
      className={
        props.className === undefined ? "middle-ellipsis" : `middle-ellipsis ${props.className}`
      }
      title={`${props.text}${suffix}`}
    >
      <span className="middle-ellipsis__head">{head}</span>
      {end === "" ? null : <span className="middle-ellipsis__tail">{end}</span>}
      {suffix === "" ? null : <span className="middle-ellipsis__tail">{suffix}</span>}
    </span>
  );
}
