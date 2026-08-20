import { useState } from "react";
import {
  MAX_ZEN_SPACES_PER_WINDOW,
  type ZenFocusZone,
  type ZenSpaceId,
} from "@octant/contracts/zen";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export interface ZenSpaceSwitcherProps {
  readonly zone: ZenFocusZone;
  readonly busy?: boolean;
  readonly onAddSpace?: (name: string) => void;
  readonly onRemoveSpace?: (spaceId: ZenSpaceId) => void;
  readonly onRenameSpace?: (spaceId: ZenSpaceId, name: string) => void;
  readonly onShowSpace?: (spaceId: ZenSpaceId) => void;
}

/**
 * The strip of spaces this window holds, with the one in front marked.
 *
 * It lives outside the panning surface: the switcher is how you leave the
 * space you are looking at, so it must not move or scale with it.
 */
export function ZenSpaceSwitcher(props: ZenSpaceSwitcherProps) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const ordered = [...props.zone.spaces].sort((left, right) => left.position - right.position);
  const full = ordered.length >= MAX_ZEN_SPACES_PER_WINDOW;

  return (
    <div
      aria-label="Focus spaces"
      className="zen-pill zen-spaces window-no-drag"
      role="tablist"
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const at = ordered.findIndex(
          (space) => String(space.spaceId) === String(props.zone.activeSpaceId),
        );
        const step = event.key === "ArrowRight" ? 1 : -1;
        const next = ordered[(Math.max(at, 0) + step + ordered.length) % ordered.length];
        if (next === undefined) return;
        event.preventDefault();
        props.onShowSpace?.(next.spaceId);
      }}
    >
      {ordered.map((space) => {
        const showing = String(space.spaceId) === String(props.zone.activeSpaceId);
        if (renaming === String(space.spaceId)) {
          return (
            <OctantInput
              aria-label={`Rename ${space.name}`}
              autoFocus
              className="zen-spaces__rename"
              defaultValue={space.name}
              key={String(space.spaceId)}
              onBlur={() => setRenaming(null)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setRenaming(null);
                  return;
                }
                if (event.key !== "Enter") return;
                const value = event.currentTarget.value.trim();
                setRenaming(null);
                if (value.length === 0 || value === space.name) return;
                props.onRenameSpace?.(space.spaceId, value);
              }}
              type="text"
            />
          );
        }
        return (
          <div className="zen-spaces__space" key={String(space.spaceId)}>
            <OctantButton
              aria-selected={showing}
              className={`zen-spaces__tab${showing ? " zen-spaces__tab--showing" : ""}`}
              onClick={() => props.onShowSpace?.(space.spaceId)}
              onDoubleClick={() => setRenaming(String(space.spaceId))}
              role="tab"
              size="sm"
              tabIndex={showing ? 0 : -1}
              type="button"
              variant="ghost"
            >
              {space.name}
            </OctantButton>
            {ordered.length > 1 && props.onRemoveSpace !== undefined ? (
              <OctantButton
                aria-label={`Remove ${space.name}`}
                className="zen-spaces__remove"
                disabled={props.busy === true}
                onClick={() => props.onRemoveSpace?.(space.spaceId)}
                size="sm"
                type="button"
                variant="ghost"
              >
                ×
              </OctantButton>
            ) : null}
          </div>
        );
      })}
      <OctantButton
        aria-label="Add a space"
        className="zen-spaces__add"
        disabled={props.busy === true || full || props.onAddSpace === undefined}
        onClick={() => props.onAddSpace?.(`Space ${String(ordered.length + 1)}`)}
        size="sm"
        title={
          full
            ? `A window holds at most ${String(MAX_ZEN_SPACES_PER_WINDOW)} spaces.`
            : "Add a space"
        }
        type="button"
        variant="ghost"
      >
        +
      </OctantButton>
    </div>
  );
}
