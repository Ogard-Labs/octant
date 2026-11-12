import { useEffect, useState, type RefObject } from "react";

/**
 * The element's rendered width, kept current while it resizes. It is undefined
 * until a width has been measured, and stays undefined where the platform has
 * no resize observer, so a caller treats "unknown" as "room enough".
 */
export function useElementWidth(target: RefObject<HTMLElement | null>): number | undefined {
  const [width, setWidth] = useState<number>();
  useEffect(() => {
    const element = target.current;
    if (element === null || typeof ResizeObserver === "undefined") return undefined;
    const read = () => {
      const next = element.getBoundingClientRect().width;
      setWidth(next > 0 ? Math.round(next) : undefined);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, [target]);
  return width;
}
