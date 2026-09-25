import type { LucideIcon } from "lucide-react";
import {
  ChevronDown,
  ChevronUp,
  LogOut,
  MessagesSquare,
  Palette,
  Plus,
  Sparkles,
} from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTooltip } from "../ui/base/OctantTooltip";

export interface ZenBarProps {
  readonly collapsed: boolean;
  readonly onExit: () => void;
  readonly onExpand?: () => void;
  readonly onHide?: () => void;
  readonly onOpenAdd?: () => void;
  readonly onOpenAppearance?: () => void;
  readonly onOpenNavigator?: () => void;
  readonly onOpenThreads?: () => void;
}

/**
 * The one bar a focus surface carries.
 *
 * It held nine text controls, a model label, and a prompt field, which is more
 * chrome than the surface it sits on. Four destinations are left, each one a
 * place to go rather than a thing to read: what to put on the wall, what is
 * already on it, how it looks, and the Navigator. They are drawn as icons in
 * one glass dock; a row of words was the loudest thing on a calm surface. Each
 * keeps its name for assistive technology and in a tooltip.
 */
export function ZenBar(props: ZenBarProps) {
  if (props.collapsed) {
    return (
      <div className="zen-pill window-no-drag" role="group" aria-label="Zen pill">
        <BarControl icon={ChevronUp} label="Show Navigator bar" onClick={props.onExpand} />
        <BarControl icon={LogOut} label="Exit Zen" onClick={props.onExit} />
      </div>
    );
  }

  return (
    <div className="zen-bar window-no-drag" role="toolbar" aria-label="Navigator Bar">
      <BarControl deferrable icon={MessagesSquare} label="Threads" onClick={props.onOpenThreads} />
      <BarControl deferrable icon={Plus} label="Add" onClick={props.onOpenAdd} />
      <BarControl deferrable icon={Sparkles} label="Navigator" onClick={props.onOpenNavigator} />
      <BarControl deferrable icon={Palette} label="Appearance" onClick={props.onOpenAppearance} />
      <span className="zen-bar-sep" aria-hidden="true" />
      <BarControl icon={ChevronDown} label="Hide Navigator bar" onClick={props.onHide} />
      <BarControl icon={LogOut} label="Exit Zen" onClick={props.onExit} />
    </div>
  );
}

/**
 * A destination with no handler here is shown but refuses, rather than
 * disappearing: the bar keeps its shape whichever surface hosts it.
 */
function BarControl(props: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly onClick?: (() => void) | undefined;
  readonly deferrable?: boolean;
}) {
  const Icon = props.icon;
  const deferred = props.deferrable === true && props.onClick === undefined;
  return (
    <OctantTooltip label={props.label} side="top">
      <OctantButton
        {...(deferred ? { "aria-disabled": true } : {})}
        aria-label={props.label}
        className={deferred ? "zen-bar__button zen-bar__button--deferred" : "zen-bar__button"}
        onClick={(event) => {
          event.preventDefault();
          props.onClick?.();
        }}
        size="icon"
        type="button"
        variant="ghost"
      >
        <Icon aria-hidden="true" size={16} />
      </OctantButton>
    </OctantTooltip>
  );
}
