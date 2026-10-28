import type { ThreadPublishedPage } from "@octant/contracts";
import { ExternalLink } from "lucide-react";
import { useContext } from "react";
import { MarkdownLinkActionsContext } from "../markdown/Markdown";

/**
 * A page a tool call published outside this host, such as a Claude artifact on
 * the person's claude.ai account. Octant never fetches or frames the page: the
 * card names it and opens it in the person's own browser, where their account
 * is signed in. The title came from the service, so it is shown as text only.
 */
export function PublishedPageCard(props: { readonly page: ThreadPublishedPage }) {
  const actions = useContext(MarkdownLinkActionsContext);
  const host = hostOf(props.page.url);
  const title = props.page.title ?? "Published page";
  return (
    <a
      className="published-page-card window-no-drag"
      href={props.page.url}
      onClick={(event) => {
        event.preventDefault();
        if (actions?.openExternal !== undefined) {
          actions.openExternal(props.page.url);
          return;
        }
        globalThis.open?.(props.page.url, "_blank", "noopener,noreferrer");
      }}
      rel="noreferrer"
      target="_blank"
    >
      <span className="published-page-card__text">
        <span className="published-page-card__title">{title}</span>
        <span className="published-page-card__detail">
          Published to {host} · opens in your browser
        </span>
      </span>
      <ExternalLink
        aria-hidden="true"
        className="published-page-card__icon"
        size={14}
        strokeWidth={1.8}
      />
    </a>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "the web";
  }
}
