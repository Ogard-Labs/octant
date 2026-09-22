import type { ThreadBoardPullRequestIdentity } from "@octant/contracts";
import { SurfaceEmpty } from "../surface/SurfaceHeader";
import { ShellState } from "../shell/ShellState";
import { OctantButton } from "../ui/base/OctantButton";
import type { ReactNode } from "react";
import { lastUsefulView, type ThreadBoardState } from "./threadBoardState";

export interface ThreadBoardCardPresentation {
  readonly layout: "list" | "card";
  readonly statusPresentation: "visible" | "screen-reader";
}

export function cardViewExtras<
  TCard extends {
    readonly projectId: unknown;
    readonly providerInstanceId: unknown;
  },
  TOpenTarget,
>(
  card: TCard,
  props: {
    readonly projectNames: ReadonlyMap<string, string>;
    readonly providerLabels?: ReadonlyMap<string, string>;
    readonly onOpenThread?: (target: TOpenTarget) => void;
    readonly onSelectPullRequest?: (identity: ThreadBoardPullRequestIdentity) => void;
  },
): {
  readonly projectName?: string;
  readonly providerLabel?: string;
  readonly onOpen?: (target: TOpenTarget) => void;
  readonly onSelectPullRequest?: (identity: ThreadBoardPullRequestIdentity) => void;
} {
  const projectName = props.projectNames.get(String(card.projectId));
  const providerLabel = props.providerLabels?.get(String(card.providerInstanceId));
  return {
    ...(projectName === undefined ? {} : { projectName }),
    ...(providerLabel === undefined ? {} : { providerLabel }),
    ...(props.onOpenThread === undefined ? {} : { onOpen: props.onOpenThread }),
    ...(props.onSelectPullRequest === undefined
      ? {}
      : { onSelectPullRequest: props.onSelectPullRequest }),
  };
}

export interface ThreadBoardListViewProps<
  TCard extends { readonly threadId: unknown },
  TColumn extends {
    readonly key: string;
    readonly label: string;
    readonly status?: string | undefined;
    readonly cards: ReadonlyArray<TCard>;
  },
> {
  readonly columns: ReadonlyArray<TColumn>;
  readonly renderCard: (card: TCard, presentation: ThreadBoardCardPresentation) => ReactNode;
}

export function ThreadBoardListView<
  TCard extends { readonly threadId: unknown },
  TColumn extends {
    readonly key: string;
    readonly label: string;
    readonly status?: string | undefined;
    readonly cards: ReadonlyArray<TCard>;
  },
>(props: ThreadBoardListViewProps<TCard, TColumn>) {
  return (
    <div className="code-board__list">
      {props.columns.map((column) => (
        <section
          aria-label={`${column.label} (${column.cards.length})`}
          className="code-board__list-group"
          key={column.key}
        >
          <header className="code-board__list-head">
            {column.status === undefined ? null : (
              <span aria-hidden="true" className={`st st-${column.status}`} />
            )}
            <h2 className="oct-section-label">{column.label}</h2>
            <span aria-hidden="true" className="count oct-meta">
              {column.cards.length}
            </span>
          </header>
          {column.cards.length === 0 ? (
            <SurfaceEmpty title="No threads" tone="lane" />
          ) : (
            <ul className="issuelist">
              {column.cards.map((card) => (
                <li key={String(card.threadId)}>
                  {props.renderCard(card, {
                    layout: "list",
                    statusPresentation: "visible",
                  })}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

export interface ThreadBoardColumnViewProps<
  TCard extends { readonly threadId: unknown },
  TColumn extends {
    readonly key: string;
    readonly label: string;
    readonly status?: string | undefined;
    readonly cards: ReadonlyArray<TCard>;
  },
> {
  readonly column: TColumn;
  readonly renderCard: (card: TCard, presentation: ThreadBoardCardPresentation) => ReactNode;
}

export function ThreadBoardColumnView<
  TCard extends { readonly threadId: unknown },
  TColumn extends {
    readonly key: string;
    readonly label: string;
    readonly status?: string | undefined;
    readonly cards: ReadonlyArray<TCard>;
  },
>(props: ThreadBoardColumnViewProps<TCard, TColumn>) {
  const { column } = props;
  // A Status column header already states the status visibly, so its cards only
  // need the status for assistive technology. Project columns carry no status of
  // their own, so their cards must show it as visible text — the colored dot
  // alone is not a status.
  const statusPresentation =
    "kind" in column && column.kind === "status" ? "screen-reader" : "visible";
  return (
    <section
      aria-label={`${column.label} (${column.cards.length})`}
      className="board-col"
      data-column-kind={"kind" in column ? column.kind : undefined}
      data-empty={column.cards.length === 0 ? "true" : "false"}
    >
      <header className="board-col-head">
        {column.status === undefined ? null : (
          <span aria-hidden="true" className={`st st-${column.status}`} />
        )}
        <h2 className="oct-section-label">{column.label}</h2>
        <span aria-hidden="true" className="count oct-meta">
          {column.cards.length}
        </span>
      </header>
      {column.cards.length === 0 ? (
        <div className="board-col-body">
          <SurfaceEmpty title="No threads" tone="lane" />
        </div>
      ) : (
        <ul className="board-col-body">
          {column.cards.map((card) => (
            <li key={String(card.threadId)}>
              {props.renderCard(card, {
                layout: "card",
                statusPresentation,
              })}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export interface ThreadBoardBodyProps<
  TCard extends { readonly threadId: unknown },
  TColumn extends {
    readonly key: string;
    readonly label: string;
    readonly status?: string | undefined;
    readonly cards: ReadonlyArray<TCard>;
  },
  TView,
> {
  readonly board: ThreadBoardState<TView>;
  readonly cardsOf: (view: TView) => ReadonlyArray<TCard>;
  readonly groupCards: (cards: ReadonlyArray<TCard>) => ReadonlyArray<TColumn>;
  readonly copy: {
    readonly eyebrow: string;
    readonly emptyTitle: string;
    readonly emptyFilteredTitle: string;
    readonly emptyDetail: string;
  };
  readonly activeFilterSummary: string | undefined;
  readonly onClearFilters: () => void;
  readonly showEmptyGroups: boolean;
  readonly isNarrow: boolean;
  readonly layout: "list" | "columns";
  readonly grouping: string;
  readonly renderCard: (card: TCard, presentation: ThreadBoardCardPresentation) => ReactNode;
}

export function ThreadBoardBody<
  TCard extends { readonly threadId: unknown },
  TColumn extends {
    readonly key: string;
    readonly label: string;
    readonly status?: string | undefined;
    readonly cards: ReadonlyArray<TCard>;
  },
  TView,
>(props: ThreadBoardBodyProps<TCard, TColumn, TView>) {
  if (props.board.status === "loading") {
    return (
      <div className="code-board__body">
        <ShellState
          eyebrow={props.copy.eyebrow}
          message="Loading the board."
          state="loading"
          title="Loading"
        />
      </div>
    );
  }
  const view = lastUsefulView(props.board);
  if (view === undefined) {
    return (
      <div className="code-board__body">
        <ShellState
          eyebrow={props.copy.eyebrow}
          message={
            props.board.status === "error" ? props.board.message : "The board is unavailable"
          }
          role="alert"
          state="disconnected"
          title="The board is unavailable"
        />
      </div>
    );
  }
  const refreshNotice =
    props.board.status === "refreshing" ? (
      <p className="code-board__note" role="status">
        Refreshing local board state.
      </p>
    ) : props.board.status === "error" ? (
      <p className="code-board__note" role="alert">
        {props.board.message} Showing the last useful view.
      </p>
    ) : null;
  const cards = props.cardsOf(view);
  const empty = props.activeFilterSummary === undefined;
  const emptyProps = empty
    ? {
        title: props.copy.emptyTitle,
        detail: props.copy.emptyDetail,
      }
    : {
        title: props.copy.emptyFilteredTitle,
        action: (
          <OctantButton onClick={props.onClearFilters} size="sm" type="button" variant="ghost">
            Clear filters
          </OctantButton>
        ),
      };
  const columns = props.groupCards(cards);
  const visibleColumns =
    (props.showEmptyGroups && !props.isNarrow) || cards.length === 0
      ? columns
      : columns.filter((column) => column.cards.length > 0);
  return (
    <div className="code-board__body" data-grouping={props.grouping} data-layout={props.layout}>
      {refreshNotice}
      {cards.length === 0 ? (
        <SurfaceEmpty {...emptyProps} {...(empty ? {} : { detail: props.activeFilterSummary })} />
      ) : null}
      {props.isNarrow ? (
        <ThreadBoardListView columns={visibleColumns} renderCard={props.renderCard} />
      ) : (
        <div className="board" data-grouping={props.grouping}>
          {visibleColumns.map((column) => (
            <ThreadBoardColumnView column={column} key={column.key} renderCard={props.renderCard} />
          ))}
        </div>
      )}
    </div>
  );
}
