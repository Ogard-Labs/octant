import {
  Activity,
  BellRing,
  CircleDot,
  GitPullRequest,
  GitPullRequestDraft,
  MessageSquare,
  Server,
  type IconComponent,
} from "../ui/icons";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { absoluteTimeFormatter } from "../lib/relativeTime";
import { OctantButton } from "../ui/base/OctantButton";
import type { HomeListContributor, HomeListRead } from "./homeCards";
import {
  buildHomeList,
  homeListMetaLine,
  type HomeListGlyph,
  type HomeListRow,
  type HomeListSection,
  type HomeListSectionId,
  type HomeListSeeAll,
} from "./homeListModel";
import "./home-list.css";

/** How long the list waits for a slow source before it shows what it has. */
export const HOME_LIST_PATIENCE_MS = 1500;

const GLYPHS: Readonly<Record<HomeListGlyph, IconComponent>> = {
  "pull-request": GitPullRequest,
  "pull-request-draft": GitPullRequestDraft,
  issue: CircleDot,
  thread: MessageSquare,
  running: Activity,
  service: Server,
  ask: BellRing,
};

/**
 * Reads every contributor, one hook per component level. Which contributors
 * there are can change (a card turned off, a connection made), so a loop of
 * hook calls would break the rules of hooks; a chain of one-hook components
 * keeps each contributor's hook in a place that does not depend on the others.
 */
function ReadChain(props: {
  readonly contributors: ReadonlyArray<HomeListContributor>;
  readonly reads: ReadonlyArray<HomeListRead>;
  readonly children: (reads: ReadonlyArray<HomeListRead>) => ReactNode;
}) {
  const [head, ...rest] = props.contributors;
  if (head === undefined) return <>{props.children(props.reads)}</>;
  return (
    <ReadStep contributor={head} key={head.id} reads={props.reads} rest={rest}>
      {props.children}
    </ReadStep>
  );
}

function ReadStep(props: {
  readonly contributor: HomeListContributor;
  readonly rest: ReadonlyArray<HomeListContributor>;
  readonly reads: ReadonlyArray<HomeListRead>;
  readonly children: (reads: ReadonlyArray<HomeListRead>) => ReactNode;
}) {
  const read = props.contributor.useRows();
  return (
    <ReadChain contributors={props.rest} reads={[...props.reads, read]}>
      {props.children}
    </ReadChain>
  );
}

export interface HomeListProps {
  readonly contributors: ReadonlyArray<HomeListContributor>;
  /** The "…" menu, drawn at the right end of the first header or of the empty line. */
  readonly menu: ReactNode;
}

/**
 * The one list under a start screen's composer: Needs you, In progress, Your
 * pull requests and Continue, in that order, each only while it has rows. It
 * waits for every source to answer (or for {@link HOME_LIST_PATIENCE_MS}) before
 * it draws, so a section that loads late never pushes the rows already read
 * out from under the pointer.
 */
export function HomeList(props: HomeListProps) {
  return (
    <ReadChain contributors={props.contributors} reads={[]}>
      {(reads) => <HomeListBody menu={props.menu} reads={reads} />}
    </ReadChain>
  );
}

function HomeListBody(props: {
  readonly reads: ReadonlyArray<HomeListRead>;
  readonly menu: ReactNode;
}) {
  const [impatient, setImpatient] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setImpatient(true), HOME_LIST_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, []);
  const settled = props.reads.every((read) => read.status === "ready");
  const { reads } = props;
  const model = useMemo(() => {
    const ready = reads.flatMap((read) => (read.status === "ready" ? [read] : []));
    const seeAll: Partial<Record<HomeListSectionId, HomeListSeeAll>> = {};
    for (const read of ready) {
      for (const [id, link] of Object.entries(read.seeAll ?? {})) {
        const section = id as HomeListSectionId;
        if (seeAll[section] === undefined) seeAll[section] = link;
      }
    }
    return {
      sections: buildHomeList({ rows: ready.flatMap((read) => read.rows), seeAll }),
      caveat: ready.find((read) => read.caveat !== undefined)?.caveat,
    };
  }, [reads]);

  if (!settled && !impatient) {
    // The place is kept, so nothing below it moves when the rows arrive, and
    // Customize stays where the first header will put it.
    return (
      <div aria-busy="true" className="home-list home-list--reserved">
        <span className="home-list__menu">{props.menu}</span>
      </div>
    );
  }
  const { sections, caveat } = model;
  if (sections.length === 0) {
    return (
      <div className="home-list" data-state="empty">
        <p className="home-list__empty">
          <span>
            {caveat === undefined ? "Nothing waiting on you. Start a thread above." : caveat.text}
          </span>
          {caveat?.action === undefined ? null : (
            <OctantButton
              className="window-no-drag"
              onClick={caveat.action.onSelect}
              size="sm"
              type="button"
              variant="link"
            >
              {caveat.action.label}
            </OctantButton>
          )}
          <span className="home-list__menu">{props.menu}</span>
        </p>
      </div>
    );
  }
  return (
    <div className="home-list">
      {sections.map((section, index) => (
        <HomeListSectionView
          key={section.id}
          menu={index === 0 ? props.menu : undefined}
          section={section}
        />
      ))}
      {caveat === undefined ? null : (
        <p className="home-list__note">
          <span>{caveat.text}</span>
          {caveat.action === undefined ? null : (
            <OctantButton
              className="window-no-drag"
              onClick={caveat.action.onSelect}
              size="sm"
              type="button"
              variant="link"
            >
              {caveat.action.label}
            </OctantButton>
          )}
        </p>
      )}
    </div>
  );
}

function HomeListSectionView(props: {
  readonly section: HomeListSection;
  readonly menu: ReactNode;
}) {
  const { section } = props;
  return (
    <section aria-label={section.title} className="home-list__section" data-section={section.id}>
      <header className="home-list__head">
        <h2 className="home-list__title">{section.title}</h2>
        <span className="home-list__count">{section.total}</span>
        {/* Every header keeps the menu's slot, so the counts stand in one column. */}
        <span className="home-list__menu">{props.menu}</span>
      </header>
      <ul className="home-list__rows">
        {section.rows.map((row) => (
          <li key={row.id}>{row.custom ?? <HomeListRowView row={row} />}</li>
        ))}
      </ul>
      {section.seeAll === undefined ? null : (
        <OctantButton
          aria-label={`See all in ${section.title}`}
          className="home-list__see-all window-no-drag"
          onClick={section.seeAll.onSelect}
          size="sm"
          type="button"
          variant="link"
        >
          {section.seeAll.label}
        </OctantButton>
      )}
    </section>
  );
}

function HomeListRowView(props: { readonly row: HomeListRow }) {
  const { row } = props;
  const Glyph = GLYPHS[row.glyph];
  const meta = homeListMetaLine(row.meta);
  const face = (
    <>
      <span aria-label={row.label} className="home-list__glyph" data-tone={row.tone} role="img">
        <Glyph aria-hidden="true" size={16} />
      </span>
      <span className="home-list__row-title" title={row.title}>
        {row.title}
      </span>
      {row.trailing === undefined ? null : (
        <span className="home-list__trailing" data-tone={row.tone}>
          {row.trailing}
        </span>
      )}
      {meta === "" ? null : (
        <span
          className="home-list__meta"
          {...(row.at === undefined
            ? {}
            : { title: absoluteTimeFormatter.format(new Date(row.at)) })}
        >
          {meta}
        </span>
      )}
    </>
  );
  if (row.onOpen === undefined) return <div className="home-list__row">{face}</div>;
  return (
    <OctantButton
      className="home-list__row window-no-drag"
      onClick={row.onOpen}
      type="button"
      variant="bare"
    >
      {face}
    </OctantButton>
  );
}
