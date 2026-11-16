import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { BrowserThreadId } from "@octant/contracts/browser-automation";
import type { BrowserAutomationSnapshot } from "@octant/contracts/browser-automation-rpc";
import { useEffect, useState } from "react";
import { useBrowserThreadRead } from "../threadActivity/useBrowserThreadSnapshot";
import { DockMiniCard, type DockCardPages } from "./DockShelf";
import type { OctantHostBridge } from "./hostBridge";
import { PageFavicon } from "./PageFavicon";

/** How often the desktop app's own picture of the page is refreshed while the card shows. */
const DESKTOP_PREVIEW_INTERVAL_MS = 3_000;
/** Refusals in a row after which a card stops asking its window for a picture. */
const PREVIEW_REFUSALS_BEFORE_STOP = 3;

/**
 * The Browser as a card: the page a thread's session has open, as a picture.
 * In the desktop app the picture comes straight from the window's own page
 * view; the server's picture withholds itself on most real pages (any field
 * that looks like a credential, any frame it cannot read), which left the card
 * an empty box. Elsewhere the card reads the server's picture. It asks only
 * while it is mounted, which is only while the shelf is drawn. It never opens or drives a page by
 * being there; its X is the one thing that closes the page, as its tab's close does.
 */
export function DockBrowserCard(props: {
  readonly client: BrowserAutomationClient | undefined;
  /**
   * The Browser context of the page the card stands for, when that page lives
   * in one of its own; the thread's own page is read through the thread.
   */
  readonly contextId?: string;
  /** Closes the page the card stands for. */
  readonly onClose: () => void;
  readonly onExpand: () => void;
  /** The Browser's pages; choosing one makes it the page the card shows. */
  readonly pages?: DockCardPages;
  readonly pollIntervalMs?: number;
  readonly threadId: BrowserThreadId;
  /** The desktop app's bridge, whose own picture of the page the card prefers. */
  readonly hostBridge?: Pick<OctantHostBridge, "captureBrowserSurfacePreview">;
  readonly previewIntervalMs?: number;
}) {
  const capture = props.hostBridge?.captureBrowserSurfacePreview;
  const [desktopPicture, setDesktopPicture] = useState<{
    readonly picture: string | undefined;
    readonly answered: boolean;
  }>({ picture: undefined, answered: false });
  const { snapshot, unavailable } = useBrowserThreadRead({
    client: props.client,
    ...(props.contextId === undefined ? {} : { contextId: props.contextId }),
    enabled: props.client !== undefined,
    liveOnly: false,
    // Once the desktop app gives its own picture, the server stops taking one:
    // its picture costs the page a credential-field check on every read.
    picture: desktopPicture.picture === undefined,
    ...(props.pollIntervalMs === undefined ? {} : { pollIntervalMs: props.pollIntervalMs }),
    threadId: props.threadId,
  });
  const surfaceContextId = props.contextId ?? snapshot?.context?.contextId;
  const previewIntervalMs = props.previewIntervalMs ?? DESKTOP_PREVIEW_INTERVAL_MS;
  useEffect(() => {
    setDesktopPicture({ picture: undefined, answered: false });
    if (capture === undefined || surfaceContextId === undefined) return;
    const request = { contextId: String(surfaceContextId), threadId: String(props.threadId) };
    let stopped = false;
    let inFlight = false;
    let refusals = 0;
    const stop = () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
    const take = () => {
      if (stopped || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      capture(request).then(
        (picture) => {
          inFlight = false;
          refusals = 0;
          if (stopped) return;
          // An empty answer (taken moments ago, or no page yet) keeps the last
          // good picture, so the card never flashes empty between refreshes.
          setDesktopPicture((last) => ({ picture: picture ?? last.picture, answered: true }));
        },
        () => {
          inFlight = false;
          if (stopped) return;
          // Refused (another window owns the page, or no native page here):
          // the server's picture stands in. One refusal is not final, because
          // a card can mount a beat before the window knows its page; after
          // three in a row the card stops asking.
          refusals += 1;
          if (refusals >= PREVIEW_REFUSALS_BEFORE_STOP) stop();
          setDesktopPicture((last) => ({ picture: last.picture, answered: true }));
        },
      );
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") take();
    };
    const timer = window.setInterval(take, previewIntervalMs);
    document.addEventListener("visibilitychange", onVisibility);
    take();
    return stop;
  }, [capture, previewIntervalMs, props.threadId, surfaceContextId]);

  const observation = snapshot?.observation;
  // A stale picture is no picture: the server's is used only while current.
  const serverPicture = observation?.stale === false ? observation.screenshotDataUrl : undefined;
  const picture = desktopPicture.picture ?? serverPicture;
  const waitingForDesktop =
    capture !== undefined && surfaceContextId !== undefined && !desktopPicture.answered;
  const waitingForServer = props.client !== undefined && snapshot === undefined;
  const title = observation?.title ?? hostOf(observation?.url) ?? "Browser";
  // A signed-in page acts as the person's account, so the card names the
  // profile it lives in beside the page.
  const profile = profileNameOf(snapshot?.context?.policy.profile);
  const pages = snapshot?.contexts?.length ?? 1;
  const detail = [profile, pages > 1 ? `${pages} pages` : undefined]
    .filter((part) => part !== undefined)
    .join(" · ");
  return (
    <DockMiniCard
      {...(detail === "" ? {} : { detail })}
      {...(observation?.faviconDataUrl === undefined
        ? {}
        : { icon: <PageFavicon src={observation.faviconDataUrl} /> })}
      onClose={props.onClose}
      onHide={props.onClose}
      onExpand={props.onExpand}
      pages={props.pages}
      previewLabel={`Show Browser, live preview${
        title === "Browser" ? "" : `: ${title}`
      }${profile === undefined ? "" : `, ${profile} profile`}`}
      surface="browser"
      title={title}
      toolLabel="Browser"
    >
      {unavailable ? (
        <p className="dock-mini-card__note">Page not available</p>
      ) : picture !== undefined ? (
        <img alt="" className="dock-mini-card__picture" draggable={false} src={picture} />
      ) : waitingForDesktop || waitingForServer ? (
        <span className="skeleton dock-mini-card__skeleton" />
      ) : (
        // No picture to show: the page's icon and name, muted, rather than an
        // empty box. The head and the preview's label already name the page.
        <p aria-hidden="true" className="dock-mini-card__note">
          <span className="dock-mini-card__note-page">
            <PageFavicon src={observation?.faviconDataUrl} />
            <span className="dock-mini-card__note-name">{title}</span>
          </span>
        </p>
      )}
    </DockMiniCard>
  );
}

/** A page's host, for a tab or a card that has no title to show yet. */
export function browserPageHost(url: string | undefined): string | undefined {
  return hostOf(url);
}

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    // A blank page has an address and no host: it has no name to show.
    const host = new URL(url).host;
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}

/** The name of the stored profile a page lives in; a Private page has none worth naming. */
function profileNameOf(
  profile: NonNullable<BrowserAutomationSnapshot["context"]>["policy"]["profile"],
): string | undefined {
  if (profile === undefined || profile.kind === "private") return undefined;
  return profile.kind === "personal" ? "Personal" : "Project";
}
