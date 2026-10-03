interface RailRow {
  readonly top: number;
  readonly bottom: number;
}

/**
 * Where the Settings rail should rest so no heading or page row is cut in
 * half at its top edge. Scrolling the selected page into view moves the rail
 * by whatever distance the page needs, which left "Personal" half hidden when
 * Host was chosen. A row that straddles the top edge is scrolled away whole;
 * when the rail cannot scroll that far, it is shown whole instead, unless that
 * would push the selected page below the rail.
 */
export function wholeRowScrollTop(rail: {
  readonly scrollTop: number;
  readonly maxScrollTop: number;
  readonly top: number;
  readonly bottom: number;
  readonly rows: ReadonlyArray<RailRow>;
  readonly selected: RailRow | undefined;
}): number {
  const straddling = rail.rows.find(
    (row) => row.top < rail.top - 0.5 && row.bottom > rail.top + 0.5,
  );
  if (straddling === undefined) return rail.scrollTop;
  const hidden = rail.scrollTop + (straddling.bottom - rail.top);
  if (hidden <= rail.maxScrollTop) return hidden;
  const shown = rail.scrollTop - (rail.top - straddling.top);
  if (shown < 0) return rail.scrollTop;
  const shift = rail.scrollTop - shown;
  return rail.selected !== undefined && rail.selected.bottom + shift > rail.bottom
    ? rail.scrollTop
    : shown;
}

/** Brings the selected page into view, then settles the rail on whole rows. */
export function settleSettingsRail(rail: HTMLElement): void {
  const selected = rail.querySelector<HTMLElement>('.setnav-item[aria-current="page"]');
  selected?.scrollIntoView?.({ block: "nearest" });
  const railBox = rail.getBoundingClientRect();
  const rows = Array.from(rail.querySelectorAll<HTMLElement>(".setnav-section, .setnav-item")).map(
    (row) => row.getBoundingClientRect(),
  );
  const next = wholeRowScrollTop({
    scrollTop: rail.scrollTop,
    maxScrollTop: rail.scrollHeight - rail.clientHeight,
    top: railBox.top,
    bottom: railBox.bottom,
    rows,
    selected: selected?.getBoundingClientRect(),
  });
  if (next !== rail.scrollTop) rail.scrollTop = next;
}
