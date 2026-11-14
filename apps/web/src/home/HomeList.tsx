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
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  HOME_LIST_SECTIONS,
} from "./homeListModel";
import {
  homeListCacheStorage,
  readHomeListCache,
  writeHomeListCache,
  type CachedHomeListRow,
} from "./homeListCache";
import "./home-list.css";

/** How long the list waits for a slow source before it shows what it has. */
export const HOME_LIST_PATIENCE_MS = 5000;

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
  /**
   * Names the host and Project the list is read for. With it the list keeps its
   * last answer and paints it on the next start's first frame; without it
   * nothing is stored.
   */
  readonly cacheScope?: string | undefined;
  /** Injectable for tests; defaults to the browser's local storage. */
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | undefined;
}

/**
 * The one list under a start screen's composer: Needs you, In progress, Your
 * pull requests and Continue, in that order. Its sections are laid out from the
 * first frame: the last answer for this host and Project when there is one,
 * otherwise skeleton rows in the places the sections will take. It draws the
 * fresh rows only once every source has answered (or the patience runs out) and
 * replaces the placeholder in place, so a section that loads late never moves
 * what is above it.
 */
export function HomeList(props: HomeListProps) {
  return (
    <ReadChain contributors={props.contributors} reads={[]}>
      {(reads) => (
        <HomeListBody
          cacheScope={props.cacheScope}
          contributors={props.contributors}
          menu={props.menu}
          reads={reads}
          storage={props.storage}
        />
      )}
    </ReadChain>
  );
}

/** What a start list expects to draw before it knows: the sections nearly every start has. */
const COLD_SECTIONS: ReadonlySet<HomeListSectionId> = new Set([
  "needs-you",
  "your-pull-requests",
  "continue",
]);
const SECTIONS_OF_CONTRIBUTOR: Readonly<Record<string, ReadonlyArray<HomeListSectionId>>> = {
  "needs-you": ["needs-you"],
  "pull-requests": ["needs-you", "your-pull-requests"],
  "assigned-work": ["needs-you", "your-pull-requests"],
  "working-now": ["in-progress"],
  "running-services": ["in-progress"],
  "open-issues": ["open-issues"],
  continue: ["continue"],
};

/** Rows a section holds in its skeleton when no earlier answer says how many. */
export const HOME_LIST_COLD_ROWS = 4;
const COLD_ROWS: Readonly<Partial<Record<HomeListSectionId, number>>> = {
  "your-pull-requests": 5,
};

type SectionView =
  | {
      readonly kind: "loading";
      readonly id: HomeListSectionId;
      readonly rows: number;
      /** A full section ends in a See all line, so its place is kept too. */
      readonly seeAll: boolean;
    }
  | {
      readonly kind: "stored";
      readonly id: HomeListSectionId;
      readonly total: number;
      readonly rows: ReadonlyArray<CachedHomeListRow>;
      readonly seeAll: string | undefined;
    }
  | { readonly kind: "live"; readonly section: HomeListSection }
  | { readonly kind: "empty"; readonly id: HomeListSectionId };

function titleOf(id: HomeListSectionId): string {
  return HOME_LIST_SECTIONS.find((section) => section.id === id)?.title ?? id;
}

function HomeListBody(props: {
  readonly reads: ReadonlyArray<HomeListRead>;
  readonly contributors: ReadonlyArray<HomeListContributor>;
  readonly menu: ReactNode;
  readonly cacheScope: string | undefined;
  readonly storage: Pick<Storage, "getItem" | "setItem"> | undefined;
}) {
  const { cacheScope } = props;
  const storage = props.storage ?? homeListCacheStorage();
  // Read once, on the first render: the stored answer is what the first frame paints.
  const [stored] = useState(() =>
    cacheScope === undefined ? undefined : readHomeListCache(storage, cacheScope),
  );
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

  // A settled list is the new stored answer; a partial one never is.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!settled || cacheScope === undefined) return;
    const heights = new Map<string, number>();
    for (const item of root.current?.querySelectorAll<HTMLElement>("li[data-row-id]") ?? []) {
      const id = item.dataset["rowId"];
      if (id !== undefined)
        heights.set(id, Math.round(item.getBoundingClientRect().height * 10) / 10);
    }
    writeHomeListCache(storage, cacheScope, model.sections, { heights });
  }, [settled, cacheScope, storage, model.sections]);

  // The sections the first frame laid out, kept for this mount: one that comes
  // back empty keeps its place (below it something may be under the pointer).
  const [placed] = useState<ReadonlyArray<HomeListSectionId>>(() => {
    if (stored !== undefined) return stored.map((section) => section.id);
    const wanted = new Set(
      props.contributors.flatMap((contributor) => SECTIONS_OF_CONTRIBUTOR[contributor.id] ?? []),
    );
    return HOME_LIST_SECTIONS.map((section) => section.id).filter(
      (id) => COLD_SECTIONS.has(id) && wanted.has(id),
    );
  });

  // A section is still on its way while a source that feeds it has not answered;
  // until then it keeps its stored rows or its skeleton, and every other section
  // is drawn as soon as its sources have answered.
  const loadingSections = new Set<HomeListSectionId>();
  if (!impatient) {
    props.contributors.forEach((contributor, index) => {
      if (props.reads[index]?.status === "ready") return;
      const feeds = SECTIONS_OF_CONTRIBUTOR[contributor.id];
      // A source that names no section may add to any: wait for it as a whole.
      for (const { id } of feeds === undefined
        ? HOME_LIST_SECTIONS
        : HOME_LIST_SECTIONS.filter((definition) => feeds.includes(definition.id))) {
        loadingSections.add(id);
      }
    });
  }
  const { sections, caveat } = model;
  const shown = HOME_LIST_SECTIONS.map((definition, order) => {
    const live = sections.find((section) => section.id === definition.id);
    const storedSection = stored?.find((section) => section.id === definition.id);
    const isPlaced = placed.includes(definition.id);
    let view: SectionView | undefined;
    if (loadingSections.has(definition.id) && isPlaced) {
      view =
        storedSection === undefined
          ? {
              kind: "loading",
              id: definition.id,
              rows: COLD_ROWS[definition.id] ?? HOME_LIST_COLD_ROWS,
              seeAll: definition.id === "your-pull-requests",
            }
          : {
              kind: "stored",
              id: definition.id,
              total: storedSection.total,
              rows: storedSection.rows,
              seeAll: storedSection.seeAll,
            };
    } else if (live !== undefined && !loadingSections.has(definition.id)) {
      view = { kind: "live", section: live };
    }
    return { order, id: definition.id, view, isPlaced };
  });
  const lastShown = Math.max(-1, ...shown.flatMap((entry) => (entry.view ? [entry.order] : [])));
  const views: ReadonlyArray<SectionView> = shown.flatMap((entry) => {
    if (entry.view !== undefined) return [entry.view];
    // An emptied section collapses only when nothing is drawn after it.
    return entry.isPlaced && entry.order < lastShown
      ? [{ kind: "empty" as const, id: entry.id }]
      : [];
  });
  if (views.length === 0 && loadingSections.size > 0) {
    // Nothing is known to come: the place is kept, so nothing below it moves,
    // and Customize stays where the first header will put it.
    return (
      <div aria-busy="true" className="home-list home-list--reserved">
        <span className="home-list__menu">{props.menu}</span>
      </div>
    );
  }
  if (views.length === 0) {
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
  // One return for every state of the list, so the stored or skeleton sections
  // are the same elements as the live ones and are replaced in place.
  return (
    <div
      aria-busy={loadingSections.size > 0 ? "true" : undefined}
      ref={root}
      className="home-list"
      data-state={loadingSections.size > 0 ? "loading" : "ready"}
    >
      {views.map((view, index) => (
        <HomeListSectionView
          key={view.kind === "live" ? view.section.id : view.id}
          menu={index === 0 ? props.menu : undefined}
          view={view}
        />
      ))}
      {loadingSections.size === 0 && caveat !== undefined ? (
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
      ) : null}
    </div>
  );
}

function storedRow(row: CachedHomeListRow): HomeListRow {
  return { ...row, meta: row.meta };
}

function HomeListSectionView(props: { readonly view: SectionView; readonly menu: ReactNode }) {
  const { view } = props;
  const id = view.kind === "live" ? view.section.id : view.id;
  const title = titleOf(id);
  // The heading, its busy slot and the menu's slot are drawn in every state, so
  // the header never changes width or height when the rows arrive.
  const busy = view.kind === "loading" || view.kind === "stored";
  const count =
    view.kind === "live" ? view.section.total : view.kind === "stored" ? view.total : "";
  return (
    <section
      aria-label={title}
      className="home-list__section"
      data-section={id}
      data-state={view.kind}
    >
      <header className="home-list__head">
        <h2 className="home-list__title">{title}</h2>
        <span aria-hidden="true" className="home-list__busy">
          {busy ? <span className="spinner spinner-sm" /> : null}
        </span>
        <span className="home-list__count">{count}</span>
        <span className="home-list__menu">{props.menu}</span>
      </header>
      {view.kind === "loading" ? (
        <div className="home-list__rows" role="status">
          <span className="sr-only">{`Loading ${title}`}</span>
          {Array.from({ length: view.rows }, (_unused, row) => (
            <HomeListSkeletonRow key={row} />
          ))}
        </div>
      ) : view.kind === "empty" ? (
        <p className="home-list__quiet">Nothing right now.</p>
      ) : (
        <ul className="home-list__rows">
          {view.kind === "live"
            ? view.section.rows.map((row) => (
                <li data-row-id={row.id} key={row.id}>
                  {row.custom ?? <HomeListRowView row={row} />}
                </li>
              ))
            : view.rows.map((row) => (
                <li data-row-id={row.id} key={row.id}>
                  <HomeListRowView height={row.height} row={storedRow(row)} />
                </li>
              ))}
        </ul>
      )}
      <SeeAllLine view={view} />
    </section>
  );
}

/** "See all" holds its line: a stored answer that had it draws it inert until the live link arrives. */
function SeeAllLine(props: { readonly view: SectionView }) {
  const { view } = props;
  if (view.kind === "live") {
    const { section } = view;
    if (section.seeAll === undefined) return null;
    return (
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
    );
  }
  if (view.kind === "loading") {
    return view.seeAll ? <span aria-hidden="true" className="home-list__see-all-slot" /> : null;
  }
  if (view.kind !== "stored" || view.seeAll === undefined) return null;
  return (
    <OctantButton
      aria-label={`See all in ${titleOf(view.id)}`}
      className="home-list__see-all window-no-drag"
      disabled
      size="sm"
      type="button"
      variant="link"
    >
      {view.seeAll}
    </OctantButton>
  );
}

/** A row's shape, in the real row's height, while its section's data is on the way. */
function HomeListSkeletonRow() {
  return (
    <div aria-hidden="true" className="home-list__row home-list__row--skeleton">
      <span className="skeleton home-list__skeleton-glyph" />
      <span className="skeleton home-list__skeleton-title" />
      <span className="skeleton home-list__skeleton-meta" />
    </div>
  );
}

function HomeListRowView(props: {
  readonly row: HomeListRow;
  readonly height?: number | undefined;
}) {
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
  if (row.onOpen === undefined) {
    return (
      <div
        className="home-list__row"
        {...(props.height === undefined
          ? {}
          : { style: { height: props.height, minHeight: props.height } })}
      >
        {face}
      </div>
    );
  }
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
