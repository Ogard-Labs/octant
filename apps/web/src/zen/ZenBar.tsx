import { OctantButton } from "../ui/base/OctantButton";

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
 * already on it, how it looks, and the Navigator. The prompt field went with
 * Navigator, whose own panel has the same field and shows the answer; keeping
 * both meant asking in one place and reading in another.
 */
export function ZenBar(props: ZenBarProps) {
  if (props.collapsed) {
    return (
      <div className="zen-pill window-no-drag" role="group" aria-label="Zen pill">
        <OctantButton onClick={props.onExpand} size="sm" type="button" variant="ghost">
          Show Navigator bar
        </OctantButton>
        <OctantButton onClick={props.onExit} size="sm" type="button" variant="secondary">
          Exit Zen
        </OctantButton>
      </div>
    );
  }

  return (
    <div className="zen-bar window-no-drag" role="toolbar" aria-label="Navigator Bar">
      <OctantButton onClick={props.onHide} size="sm" type="button" variant="ghost">
        Hide Navigator bar
      </OctantButton>
      <span className="zen-bar-sep" aria-hidden="true" />
      <DeferredControl
        label="Threads"
        {...(props.onOpenThreads === undefined ? {} : { onClick: props.onOpenThreads })}
      />
      <DeferredControl
        label="Add"
        {...(props.onOpenAdd === undefined ? {} : { onClick: props.onOpenAdd })}
      />
      <DeferredControl
        label="Navigator"
        {...(props.onOpenNavigator === undefined ? {} : { onClick: props.onOpenNavigator })}
      />
      <DeferredControl
        label="Appearance"
        {...(props.onOpenAppearance === undefined ? {} : { onClick: props.onOpenAppearance })}
      />
      <span className="zen-bar-sep" aria-hidden="true" />
      <OctantButton onClick={props.onExit} size="sm" type="button" variant="secondary">
        Exit Zen
      </OctantButton>
    </div>
  );
}

function DeferredControl(props: { readonly label: string; readonly onClick?: () => void }) {
  return (
    <OctantButton
      {...(props.onClick === undefined ? { "aria-disabled": true } : {})}
      className={props.onClick === undefined ? "zen-bar__button--deferred" : undefined}
      onClick={(event) => {
        event.preventDefault();
        props.onClick?.();
      }}
      size="sm"
      title={props.label}
      type="button"
      variant="ghost"
    >
      {props.label}
    </OctantButton>
  );
}
