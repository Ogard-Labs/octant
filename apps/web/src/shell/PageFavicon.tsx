import { useEffect, useState, type ReactNode } from "react";
import { DockToolIcon } from "./dockToolIcons";

/** A page's icon and whether it is the dimmed icon a sleeping tab kept. */
export interface PageIconState {
  readonly src?: string | undefined;
  readonly muted?: boolean;
}

/**
 * A page's own icon at 16px, as the host fetched it (a `data:` URL held in
 * memory), or the globe when the page has none or the image fails to load. The
 * image never sends a referrer, is not draggable, and carries no text of its
 * own: the tab's label names the page.
 */
export function PageFavicon(props: {
  readonly src?: string | undefined;
  readonly fallback?: ReactNode;
  /** The page is asleep: this is the icon it went to sleep with, shown dimmed. */
  readonly muted?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [props.src]);
  if (props.src === undefined || failed)
    return props.fallback ?? <DockToolIcon surface="browser" />;
  return (
    <img
      alt=""
      className={
        props.muted === true ? "dock-page-favicon dock-page-favicon--muted" : "dock-page-favicon"
      }
      draggable={false}
      height={16}
      onError={() => setFailed(true)}
      referrerPolicy="no-referrer"
      src={props.src}
      title={props.muted === true ? "Page is asleep — showing its last icon" : undefined}
      width={16}
    />
  );
}
