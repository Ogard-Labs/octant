import { CHART_GRID_LINE_COUNT } from "@octant/theme";
import type { YDomain } from "./chartGeometry";

/**
 * The values a cartesian chart draws gridlines at: even steps inside the
 * domain, never on the edges, so a gridline is a backdrop and not a frame.
 */
export function gridValues(domain: YDomain, count = CHART_GRID_LINE_COUNT): ReadonlyArray<number> {
  if (count <= 0 || domain.max <= domain.min) return [];
  const span = domain.max - domain.min;
  return Array.from(
    { length: count },
    (_value, index) => domain.min + (span * (index + 1)) / (count + 1),
  );
}
