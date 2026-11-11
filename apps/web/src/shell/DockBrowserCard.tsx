import type { BrowserAutomationClient } from "@octant/client-runtime/browser-automation-client";
import type { BrowserThreadId } from "@octant/contracts/browser-automation";
import type { BrowserAutomationSnapshot } from "@octant/contracts/browser-automation-rpc";
import { useBrowserThreadSnapshot } from "../threadActivity/useBrowserThreadSnapshot";
import { DockMiniCard } from "./DockShelf";

/**
 * The Browser as a card: the page a thread's session has open, as a picture
 * the host already takes for the Browser tool. The card reads the same picture
 * the tool would show this window, and asks for it only while it is mounted,
 * which is only while the shelf is drawn. It never opens, drives or closes a
 * page by being there.
 */
export function DockBrowserCard(props: {
  readonly client: BrowserAutomationClient | undefined;
  readonly onClose: () => void;
  readonly onExpand: () => void;
  readonly pollIntervalMs?: number;
  readonly threadId: BrowserThreadId;
}) {
  const snapshot = useBrowserThreadSnapshot({
    client: props.client,
    enabled: props.client !== undefined,
    liveOnly: false,
    picture: true,
    ...(props.pollIntervalMs === undefined ? {} : { pollIntervalMs: props.pollIntervalMs }),
    threadId: props.threadId,
  });
  const observation = snapshot?.observation;
  // A stale picture is no picture: the neutral skeleton stands in until a
  // current one arrives, with no status words.
  const picture = observation?.stale === false ? observation.screenshotDataUrl : undefined;
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
      onClose={props.onClose}
      onExpand={props.onExpand}
      previewLabel={`Show Browser, live preview${
        title === "Browser" ? "" : `: ${title}`
      }${profile === undefined ? "" : `, ${profile} profile`}`}
      surface="browser"
      title={title}
      toolLabel="Browser"
    >
      {picture === undefined ? (
        <span className="skeleton dock-mini-card__skeleton" />
      ) : (
        <img alt="" className="dock-mini-card__picture" draggable={false} src={picture} />
      )}
    </DockMiniCard>
  );
}

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).host;
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
