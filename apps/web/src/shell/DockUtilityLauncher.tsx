import {
  Files,
  FlaskConical,
  GitCompareArrows,
  Globe2,
  MessageCircle,
  PanelsTopLeft,
  Plus,
  Smartphone,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { IconButton } from "./IconButton";
import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";

export interface DockUtilityLauncherSurface {
  readonly id: RightUtilityDockSurfaceId;
  readonly label: string;
}

export interface DockUtilityLauncherProps {
  readonly onOpen: (surface: RightUtilityDockSurfaceId) => void;
  readonly surfaces: ReadonlyArray<DockUtilityLauncherSurface>;
}

export function DockUtilityLauncher(props: DockUtilityLauncherProps) {
  const [open, setOpen] = useState(false);
  const disclosureId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) firstAction.current?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <span className="dock-utility-launcher">
      <IconButton
        aria-controls={disclosureId}
        aria-expanded={open}
        disabled={props.surfaces.length === 0}
        icon={Plus}
        label="Add utility tab"
        onClick={() => setOpen((current) => !current)}
        ref={trigger}
      />
      {open ? (
        <span
          className="workspace-disclosure dock-utility-launcher__disclosure"
          id={disclosureId}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            close();
          }}
        >
          {props.surfaces.map((surface, index) => (
            <button
              className="workspace-disclosure__action window-no-drag"
              key={surface.id}
              onClick={() => {
                props.onOpen(surface.id);
                close();
              }}
              ref={index === 0 ? firstAction : undefined}
              type="button"
            >
              <DockUtilityIcon surface={surface.id} />
              <span>{surface.label}</span>
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

function DockUtilityIcon(props: { readonly surface: RightUtilityDockSurfaceId }) {
  const icons: Partial<Record<RightUtilityDockSurfaceId, LucideIcon>> = {
    browser: Globe2,
    changes: GitCompareArrows,
    files: Files,
    "ios-simulator": Smartphone,
    "side-chat": MessageCircle,
    terminal: SquareTerminal,
    tests: FlaskConical,
    thread: PanelsTopLeft,
  };
  const Icon = icons[props.surface];
  return Icon === undefined ? null : <Icon aria-hidden="true" size={14} strokeWidth={1.8} />;
}
