import { Plus } from "lucide-react";
import { useEffect, useId, useRef, useState, type Ref } from "react";
import { DockToolIcon } from "./dockToolIcons";
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

  if (props.surfaces.length === 0) return null;

  return (
    <span className="dock-utility-launcher">
      <IconButton
        aria-controls={disclosureId}
        aria-expanded={open}
        icon={Plus}
        label="Add tool"
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
          <DockToolLaunchList
            firstAction={firstAction}
            onOpen={(surface) => {
              props.onOpen(surface);
              close();
            }}
            surfaces={props.surfaces}
          />
        </span>
      ) : null}
    </span>
  );
}

export function DockToolLaunchList(props: {
  readonly firstAction?: Ref<HTMLButtonElement>;
  readonly onOpen: (surface: RightUtilityDockSurfaceId) => void;
  readonly surfaces: ReadonlyArray<DockUtilityLauncherSurface>;
}) {
  return (
    <>
      {props.surfaces.map((surface, index) => (
        <button
          className="workspace-disclosure__action window-no-drag"
          key={surface.id}
          onClick={() => props.onOpen(surface.id)}
          ref={index === 0 ? props.firstAction : undefined}
          type="button"
        >
          <DockToolIcon surface={surface.id} />
          <span>{surface.label}</span>
        </button>
      ))}
    </>
  );
}
