export interface PopupSkeletonRowsProps {
  /** Spoken in place of the shapes, which a screen reader cannot see. */
  readonly label: string;
  readonly rows?: number;
}

/**
 * The shape of a popup's list while its data is on its way: rows of the same
 * height the real ones have, so the popup keeps its size when they arrive.
 */
export function PopupSkeletonRows(props: PopupSkeletonRowsProps) {
  const rows = Array.from({ length: props.rows ?? 5 }, (_unused, index) => index);
  return (
    <div className="popup-skeleton" role="status">
      <span className="sr-only">{props.label}</span>
      <div aria-hidden="true" className="popup-skeleton__rows">
        {rows.map((row) => (
          <span className="skeleton popup-skeleton__row" key={row} />
        ))}
      </div>
    </div>
  );
}
