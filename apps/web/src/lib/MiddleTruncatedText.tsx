export function MiddleTruncatedText(props: {
  readonly value: string;
  readonly className?: string;
  readonly ariaHidden?: boolean;
}) {
  const separator = props.value.lastIndexOf("/");
  const scheme = props.value.indexOf("://");
  const split = separator >= 0 && (scheme < 0 || separator > scheme + 2) ? separator + 1 : -1;

  return (
    <span
      className={
        props.className === undefined
          ? "middle-truncated-text"
          : `middle-truncated-text ${props.className}`
      }
      aria-hidden={props.ariaHidden}
      title={props.value}
    >
      {split < 0 || split === props.value.length ? (
        <span className="middle-truncated-text__head">{props.value}</span>
      ) : (
        <>
          <span className="middle-truncated-text__head">{props.value.slice(0, split)}</span>
          <span className="middle-truncated-text__tail">{props.value.slice(split)}</span>
        </>
      )}
    </span>
  );
}
