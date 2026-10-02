import { Eye, FolderPlus, GitBranch, Terminal, type LucideIcon } from "lucide-react";
import { relativeTimeLabel } from "../lib/relativeTime";
import { ProviderGlyph } from "../providers/ProviderGlyph";
import { OctantButton } from "../ui/base/OctantButton";
import type { RunningNowCard } from "./runningNow";

export type HomeActionId = "add-folder" | "open-terminal" | "review";

export interface HomeAction {
  readonly id: HomeActionId;
  readonly title: string;
  readonly detail: string;
  readonly onSelect: () => void;
}

const ACTION_ICONS: Readonly<Record<HomeActionId, LucideIcon>> = {
  "add-folder": FolderPlus,
  "open-terminal": Terminal,
  review: Eye,
};

export interface HomeStartProps {
  readonly actions: ReadonlyArray<HomeAction>;
  readonly running: ReadonlyArray<RunningNowCard>;
  readonly onOpenRunning?: (card: RunningNowCard) => void;
  readonly onOpenBoard?: () => void;
}

/**
 * What a start screen offers under its composer before the person types:
 * the few things worth doing next, then the threads already working. Each
 * part leaves when it has nothing to say, so a fresh install shows neither
 * an empty strip nor tiles that go nowhere.
 */
export function HomeStart(props: HomeStartProps) {
  if (props.actions.length === 0 && props.running.length === 0) return null;
  return (
    <div className="home-start">
      {props.actions.length === 0 ? null : (
        <div aria-label="Quick actions" className="home-tiles" role="group">
          {props.actions.map((action) => {
            const Icon = ACTION_ICONS[action.id];
            return (
              <OctantButton
                // The link variant draws nothing of its own; the face inside
                // carries the tile's paint, so the shared button recipe is
                // never repainted from a feature stylesheet.
                className="home-tile window-no-drag hover:no-underline"
                data-action={action.id}
                key={action.id}
                onClick={action.onSelect}
                type="button"
                variant="link"
              >
                <span className="home-tile__face">
                  <span aria-hidden="true" className="home-tile__icon">
                    <Icon size={16} strokeWidth={1.8} />
                  </span>
                  <span className="home-tile__text">
                    <span className="oct-row-label home-tile__title">{action.title}</span>
                    <span className="oct-row-detail home-tile__detail">{action.detail}</span>
                  </span>
                </span>
              </OctantButton>
            );
          })}
        </div>
      )}
      {props.running.length === 0 ? null : (
        <section aria-labelledby="home-running-now" className="running-now">
          <div className="running-now__head">
            <h2 className="oct-section-label" id="home-running-now">
              Running now
            </h2>
            {props.onOpenBoard === undefined ? null : (
              <OctantButton onClick={props.onOpenBoard} size="sm" type="button" variant="link">
                Open board
              </OctantButton>
            )}
          </div>
          <ul className="running-now__list">
            {props.running.map((card) => (
              <li key={card.threadId}>
                <OctantButton
                  className="running-card window-no-drag hover:no-underline"
                  disabled={props.onOpenRunning === undefined}
                  onClick={() => props.onOpenRunning?.(card)}
                  type="button"
                  variant="link"
                >
                  <span className="running-card__face">
                    <span className="running-card__head">
                      {card.provider === undefined ? null : (
                        <ProviderGlyph
                          className="running-card__provider"
                          displayName={card.provider.displayName}
                          driverKind={card.provider.driverKind}
                          size={16}
                        />
                      )}
                      <span className="oct-row-label running-card__title">{card.title}</span>
                      <span aria-hidden="true" className="spinner spinner-sm" />
                      {card.activeAt === undefined ? null : (
                        <span className="oct-meta running-card__age">
                          Active {relativeTimeLabel(card.activeAt)}
                        </span>
                      )}
                    </span>
                    {card.projectName === undefined && card.branch === undefined ? null : (
                      <span className="running-card__chips">
                        {card.projectName === undefined ? null : (
                          <span className="oct-meta running-chip">{card.projectName}</span>
                        )}
                        {card.branch === undefined ? null : (
                          <span className="oct-meta oct-meta--mono running-chip">
                            <GitBranch aria-hidden="true" size={12} strokeWidth={1.8} />
                            {card.branch}
                          </span>
                        )}
                      </span>
                    )}
                    {card.latestActivity === undefined ? null : (
                      <span className="oct-meta oct-meta--mono running-card__well">
                        {card.latestActivity}
                      </span>
                    )}
                  </span>
                </OctantButton>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
