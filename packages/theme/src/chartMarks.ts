/**
 * The mark specifications every chart draws to, stated once.
 *
 * A Canvas chart on screen and a Canvas thumbnail drawn on the host are the
 * same picture at different sizes, so they read the bar corner, the gap, the
 * line width, and the dot size from here rather than each naming their own.
 */
export const CHART_BAR_RADIUS = 2;
export const CHART_BAR_GAP = 2;
export const CHART_LINE_WIDTH = 2;
export const CHART_DOT_RADIUS = 3;
/** Horizontal gridlines behind a cartesian chart, not counting the axis. */
export const CHART_GRID_LINE_COUNT = 4;
