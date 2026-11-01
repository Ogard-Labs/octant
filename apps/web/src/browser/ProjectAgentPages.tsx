import type { ProjectBrowserClient } from "@octant/client-runtime/project-browser-client";
import type { BrowserAutomationSnapshot } from "@octant/contracts/browser-automation-rpc";
import type { ProjectAgentPage, ProjectBrowserMode } from "@octant/contracts/project-browser";
import type { ProjectId } from "@octant/contracts/projects";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTabs, OctantTabsList, OctantTabsTab } from "../ui/base/OctantTabs";

/** How often the list of live agent pages is read while the dock is open. */
const LIST_INTERVAL_MS = 3_000;
/** How often the selected page's picture is read, as the floating preview does. */
const PICTURE_INTERVAL_MS = 1_500;

/** The tab that stands for the person's own Project page. */
export const OWN_PAGE_TAB = "own";

/**
 * The live agent pages of a Project's threads, read from the host. An older
 * host, a refusal, or a Project the window no longer holds leaves the list
 * empty, so the strip simply does not appear.
 */
export function useProjectAgentPages(input: {
  readonly client: Pick<ProjectBrowserClient, "agentPages">;
  readonly projectId: ProjectId;
  readonly mode: ProjectBrowserMode;
  readonly enabled: boolean;
}): ReadonlyArray<ProjectAgentPage> {
  const { client, projectId, mode, enabled } = input;
  const [pages, setPages] = useState<ReadonlyArray<ProjectAgentPage>>([]);
  useEffect(() => {
    const read = client.agentPages?.bind(client);
    if (!enabled || read === undefined) {
      setPages([]);
      return undefined;
    }
    const controller = new AbortController();
    const load = () =>
      read({ projectId, mode }, controller.signal)
        .then((answer) => {
          if (!controller.signal.aborted) setPages(answer.pages);
        })
        .catch(() => {
          if (!controller.signal.aborted) setPages([]);
        });
    void load();
    const timer = globalThis.setInterval(() => void load(), LIST_INTERVAL_MS);
    return () => {
      controller.abort();
      globalThis.clearInterval(timer);
    };
  }, [client, enabled, mode, projectId]);
  return pages;
}

export const SIGNED_IN_PAGE_COPY = "Signed-in page — open it on this Mac.";

function pageLabel(page: ProjectAgentPage): string {
  if (page.signedIn === true) return SIGNED_IN_PAGE_COPY;
  const title = page.title?.trim();
  return title !== undefined && title !== "" ? title : (page.host ?? "New page");
}

export interface ProjectAgentPageStripProps {
  readonly pages: ReadonlyArray<ProjectAgentPage>;
  /** The selected page's thread, or `OWN_PAGE_TAB` for the person's own page. */
  readonly selected: string;
  readonly onSelect: (value: string) => void;
}

/**
 * One tab for the person's own Project page, then one per live agent page: the
 * page's title or host, the thread that owns it, and an "Agent active" mark
 * while that thread's agent drives it. Choosing a tab only changes what the
 * dock shows; nothing here moves a page from one thread to another.
 */
export function ProjectAgentPageStrip(props: ProjectAgentPageStripProps) {
  if (props.pages.length === 0) return null;
  return (
    <OctantTabs
      className="project-agent-pages"
      onValueChange={(value) => props.onSelect(String(value))}
      value={props.selected}
    >
      <OctantTabsList
        aria-label="Agent pages in this Project"
        className="project-agent-pages__rail"
      >
        <OctantTabsTab className="project-agent-pages__tab" value={OWN_PAGE_TAB}>
          <span className="project-agent-pages__page">Your page</span>
          <span className="project-agent-pages__owner">This Project</span>
        </OctantTabsTab>
        {props.pages.map((page) => (
          <OctantTabsTab
            className="project-agent-pages__tab"
            key={String(page.threadId)}
            title={page.host}
            value={String(page.threadId)}
          >
            <span className="project-agent-pages__page">{pageLabel(page)}</span>
            <span className="project-agent-pages__owner">
              <span className="project-agent-pages__thread">{page.threadTitle}</span>
              {page.agentActive ? (
                <OctantBadge className="project-agent-pages__active" variant="success">
                  Agent active
                </OctantBadge>
              ) : null}
            </span>
          </OctantTabsTab>
        ))}
      </OctantTabsList>
    </OctantTabs>
  );
}

export interface ProjectAgentPageViewProps {
  readonly client: Pick<ProjectBrowserClient, "agentPageSnapshot">;
  readonly page: ProjectAgentPage;
  /** Opens the owning thread; absent, the control is not drawn. */
  readonly onOpenThread?: (threadId: string, title: string) => void;
}

/**
 * An agent's page as the person sees it today: the thread's own picture, the
 * one the floating preview shows, with no address bar and nothing to click.
 * The agent in the owning thread drives it; the person can open that thread.
 */
export function ProjectAgentPageView(props: ProjectAgentPageViewProps) {
  const { client, page } = props;
  const [snapshot, setSnapshot] = useState<BrowserAutomationSnapshot>();
  useEffect(() => {
    const read = client.agentPageSnapshot?.bind(client);
    setSnapshot(undefined);
    if (read === undefined || page.signedIn === true) return undefined;
    const controller = new AbortController();
    const load = () =>
      read({ threadId: page.threadId }, controller.signal)
        .then((next) => {
          if (!controller.signal.aborted) setSnapshot(next);
        })
        .catch(() => undefined);
    void load();
    const timer = globalThis.setInterval(() => void load(), PICTURE_INTERVAL_MS);
    return () => {
      controller.abort();
      globalThis.clearInterval(timer);
    };
  }, [client, page.signedIn, page.threadId]);

  const observation = snapshot?.observation;
  const picture = observation?.stale === false ? observation.screenshotDataUrl : undefined;
  const label = pageLabel(page);
  return (
    <div aria-label={`Page of ${page.threadTitle}`} className="project-agent-page" role="region">
      <header className="project-agent-page__head">
        <span className="project-agent-page__owner" title={page.threadTitle}>
          {page.threadTitle}
        </span>
        {page.agentActive ? (
          <OctantBadge className="project-agent-pages__active" variant="success">
            Agent active
          </OctantBadge>
        ) : null}
        {props.onOpenThread === undefined ? null : (
          <OctantButton
            onClick={() => props.onOpenThread?.(String(page.threadId), page.threadTitle)}
            size="sm"
            type="button"
            variant="secondary"
          >
            <ExternalLink aria-hidden="true" size={14} />
            Open thread
          </OctantButton>
        )}
      </header>
      {page.signedIn === true ? (
        <p className="project-agent-page__note">{SIGNED_IN_PAGE_COPY}</p>
      ) : picture === undefined ? (
        <p className="project-agent-page__note" title={page.host}>
          {label}
        </p>
      ) : (
        <img alt={`Picture of ${label}`} className="project-agent-page__picture" src={picture} />
      )}
      <p className="project-agent-page__note">
        You are looking at this thread&apos;s page. Its agent drives it; you cannot click in it from
        here.
      </p>
    </div>
  );
}
