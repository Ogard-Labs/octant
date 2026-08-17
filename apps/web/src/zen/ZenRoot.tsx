import { matchKeybinding } from "@octant/domain";
import { useEffect, useRef, type ReactNode } from "react";
import { useKeybindings } from "../keybindings/useKeybindings";
import { isApplePlatform } from "../platform";

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
  const { keybindings } = useKeybindings();

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (matchKeybinding(keybindings, event, isApplePlatform()) !== "zen-mode") return;
      if (isEditableTarget(event.target) && props.active) return;
      event.preventDefault();
      props.onToggle();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, props]);

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
