import { useEffect, useRef, useState } from "react";
import { revealSettingsAncestors, type SettingsOutlineEntry } from "../settings/primitives";

/**
 * The pages that carry an "On this page" row. The row's slot is a fixed height
 * on exactly these pages, so the chips arriving as sections mount (some load
 * late) move nothing; every other page has no row and no slot. A page with
 * sub-tabs of its own (Skills & Extensions) is not on the list: its sections
 * change with the tab, so a row would change with it.
 */
export const SETTINGS_OUTLINE_PAGES: ReadonlySet<string> = new Set([
  "general",
  "appearance",
  "providers",
  "harness",
  "code",
  "computer-use",
  "github",
  "permissions",
  "data",
  "sync",
]);

/** A section's top edge counts as reached once it is this far below the page's top. */
const READ_LINE_PX = 96;

/**
 * One line of quiet chips, one per section, in page order. It never wraps: it
 * scrolls sideways with a fade at the edge that has more, and the section the
 * reader is in is marked as the page scrolls.
 */
export function SettingsOutlineRow(props: {
  readonly entries: ReadonlyArray<SettingsOutlineEntry>;
  readonly scrollRoot: React.RefObject<HTMLElement | null>;
}) {
  const strip = useRef<HTMLUListElement>(null);
  const [current, setCurrent] = useState<string>();
  const [more, setMore] = useState(false);
  const { entries, scrollRoot } = props;

  useEffect(() => {
    const root = scrollRoot.current;
    if (root === null) return;
    const update = () => {
      const top = root.getBoundingClientRect().top + READ_LINE_PX;
      let found: string | undefined = entries[0]?.id;
      for (const entry of entries) {
        if (entry.element.getBoundingClientRect().top <= top) found = entry.id;
      }
      setCurrent(found);
    };
    update();
    root.addEventListener("scroll", update, { passive: true });
    return () => root.removeEventListener("scroll", update);
  }, [entries, scrollRoot]);

  useEffect(() => {
    const list = strip.current;
    if (list === null) return;
    const measure = () => setMore(list.scrollLeft + list.clientWidth < list.scrollWidth - 1);
    measure();
    list.addEventListener("scroll", measure, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(list);
    return () => {
      list.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [entries]);

  // Keep the marked chip in view when the page scrolls to a section the strip hides.
  useEffect(() => {
    const list = strip.current;
    const chip = list?.querySelector<HTMLElement>('[aria-current="location"]');
    if (list === null || chip === null || chip === undefined) return;
    if (
      chip.offsetLeft < list.scrollLeft ||
      chip.offsetLeft + chip.offsetWidth > list.scrollLeft + list.clientWidth
    ) {
      list.scrollTo?.({ left: chip.offsetLeft - 8 });
    }
  }, [current]);

  return (
    <nav aria-label="On this page" className="settings-view__outline" data-more={more}>
      <ul ref={strip}>
        {entries.length < 2
          ? null
          : entries.map((entry) => (
              <li key={entry.id}>
                <a
                  aria-current={entry.id === current ? "location" : undefined}
                  className="settings-view__outline-link window-no-drag"
                  href={`#${entry.id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    // A section inside a closed disclosure opens first, or the
                    // link would scroll to nothing.
                    const scroll = () => entry.element.scrollIntoView?.({ block: "start" });
                    if (revealSettingsAncestors(entry.element)) requestAnimationFrame(scroll);
                    else scroll();
                  }}
                >
                  {entry.title}
                </a>
              </li>
            ))}
      </ul>
    </nav>
  );
}
