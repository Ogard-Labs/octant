import { useEffect, useState, type ReactNode } from "react";
import { DockToolIcon } from "./dockToolIcons";

/**
 * A page's own icon at 16px, as the host fetched it (a `data:` URL held in
 * memory), or the globe when the page has none or the image fails to load. The
 * image never sends a referrer, is not draggable, and carries no text of its
 * own: the tab's label names the page.
 */
export function PageFavicon(props: {
  readonly src: string | undefined;
  readonly fallback?: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [props.src]);
  if (props.src === undefined || failed)
    return props.fallback ?? <DockToolIcon surface="browser" />;
  return (
    <img
      alt=""
      className="dock-page-favicon"
      draggable={false}
      height={16}
      onError={() => setFailed(true)}
      referrerPolicy="no-referrer"
      src={props.src}
      width={16}
    />
  );
}
