import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

export interface ZenBarProps {
  readonly collapsed: boolean;
  readonly onAskNavigatorAssistant?: (prompt: string) => void;
  readonly onExit: () => void;
  readonly onExpand?: () => void;
  readonly onHide?: () => void;
  readonly onOpenActivity?: () => void;
  readonly onOpenAdd?: () => void;
  readonly onOpenAppearance?: () => void;
  readonly onOpenThreads?: () => void;
  readonly onOpenWidgets?: () => void;
  readonly providerLabel?: string;
}

export function ZenBar(props: ZenBarProps) {
  if (props.collapsed) {
    return (
      <div className="zen-pill window-no-drag" role="group" aria-label="Zen pill">
        <OctantButton
          className="zen-pill__show"
          onClick={props.onExpand}
          type="button"
          variant="ghost"
        >
          Show Navigator Bar
        </OctantButton>
        <OctantButton
          className="zen-pill__exit"
          onClick={props.onExit}
          type="button"
          variant="ghost"
        >
          Exit Zen
        </OctantButton>
      </div>
    );
  }

  return (
    <div className="zen-bar window-no-drag" role="toolbar" aria-label="Navigator Bar">
      <OctantButton
        className="zen-bar__button"
        onClick={props.onHide}
        type="button"
        variant="ghost"
      >
        Hide Navigator Bar
      </OctantButton>
      <span className="zen-bar__provider" aria-label="Navigator model">
        {props.providerLabel ?? "Navigator"}
      </span>
      <label className="zen-bar__ask">
        <span className="visually-hidden">Ask Navigator</span>
        <OctantInput
          aria-label="Ask Navigator"
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            const value = event.currentTarget.value.trim();
            if (value.length === 0) return;
            props.onAskNavigatorAssistant?.(value);
            event.currentTarget.value = "";
          }}
          placeholder="Ask Navigator…"
          type="text"
        />
      </label>
      <DeferredControl
        label="Threads"
        {...(props.onOpenThreads === undefined ? {} : { onClick: props.onOpenThreads })}
      />
      <DeferredControl
        label="Widgets"
        {...(props.onOpenWidgets === undefined ? {} : { onClick: props.onOpenWidgets })}
      />
      <DeferredControl
        label="Add"
        {...(props.onOpenAdd === undefined ? {} : { onClick: props.onOpenAdd })}
      />
      <DeferredControl
        label="Activity"
        {...(props.onOpenActivity === undefined ? {} : { onClick: props.onOpenActivity })}
      />
      <DeferredControl
        label="Appearance"
        {...(props.onOpenAppearance === undefined ? {} : { onClick: props.onOpenAppearance })}
      />
      <OctantButton
        className="zen-bar__button zen-bar__exit"
        onClick={props.onExit}
        type="button"
        variant="ghost"
      >
        Exit Zen
      </OctantButton>
    </div>
  );
}

function DeferredControl(props: { readonly label: string; readonly onClick?: () => void }) {
  return (
    <OctantButton
      {...(props.onClick === undefined ? { "aria-disabled": true } : {})}
      className={`zen-bar__button${props.onClick === undefined ? " zen-bar__button--deferred" : ""}`}
      onClick={(event) => {
        event.preventDefault();
        props.onClick?.();
      }}
      title={props.onClick === undefined ? `${props.label} is unavailable` : props.label}
      type="button"
      variant="ghost"
    >
      {props.label}
    </OctantButton>
  );
}
