/**
 * The code editor and the terminal draw their scrollbars as elements of their
 * own, so the stylesheet's one scrollbar rule (`scrollbar-width: thin` and the
 * thumb colour, in styles.css) cannot reach them. Their runtimes ask each
 * library for the same picture instead, from the measurements here.
 *
 * The measurements are what that rule draws in a plain pane in the engine the
 * app ships, read from rendered pixels on macOS: a thumb 6px wide with round
 * ends, standing 2px in from the pane's edge, on no painted track. They were
 * the same whether the system floats scrollbars or keeps a strip for them.
 */

/** How wide the thumb is, in CSS pixels. */
export const SCROLLBAR_THUMB_WIDTH = 6;

/**
 * The lane the editor's thumb travels in: the thumb with 2px clear on each
 * side, so it stands as far in from the edge as a pane's does. The terminal's
 * lane is its engine's own; styles/code.css cuts its thumb to this picture.
 */
export const SCROLLBAR_LANE_WIDTH = 10;

/**
 * Whether the system floats scrollbars over the content and hides them at
 * rest, or keeps a strip beside the content with the thumb always in it.
 *
 * A plain pane follows the system without being told. A library that draws
 * its own scrollbar has to be told which of the two to imitate, and a
 * scroller that takes no room for its scrollbar is how a page can tell.
 */
export function systemFloatsScrollbars(): boolean {
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.width = "50px";
  probe.style.height = "50px";
  probe.style.overflow = "scroll";
  document.body.append(probe);
  const floats = probe.offsetWidth === probe.clientWidth;
  probe.remove();
  return floats;
}
