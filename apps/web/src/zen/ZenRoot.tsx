import { useEffect, useRef, type ReactNode } from "react";

export interface ZenRootProps {
  readonly active: boolean;
  readonly children: ReactNode;
  readonly onExit: () => void;
  readonly onToggle: () => void;
  readonly zen: ReactNode;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable ||
    target.closest('[role="textbox"]') !== null
  );
}

export function ZenRoot(props: ZenRootProps) {
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      const chord =
        (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "z";
      if (!chord) return;
      if (isEditableTarget(event.target) && props.active) return;
      event.preventDefault();
      props.onToggle();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [props]);

  return (
    <div className={`zen-root${props.active ? " zen-root--active" : ""}`}>
      <div
        aria-hidden={props.active ? true : undefined}
        className={`zen-root__shell${props.active ? " zen-root__shell--hidden" : ""}`}
        ref={shellRef}
      >
        {props.children}
      </div>
      {props.active ? (
        <div className="zen-root__surface" data-testid="zen-root-surface">
          {props.zen}
        </div>
      ) : null}
    </div>
  );
}
