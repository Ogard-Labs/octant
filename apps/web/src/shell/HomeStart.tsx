import { Eye, FolderPlus, Terminal, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";

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
  /** The card area (`HomeDashboard`), which owns its own empty states. */
  readonly dashboard?: ReactNode;
}

/**
 * What a start screen offers under its composer before the person types:
 * the few things worth doing next, then the cards. Each part leaves when it
 * has nothing to say, so a fresh install shows neither an empty strip nor
 * tiles that go nowhere.
 */
export function HomeStart(props: HomeStartProps) {
  if (props.actions.length === 0 && props.dashboard === undefined) return null;
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
      {props.dashboard}
    </div>
  );
}
