import { GitPullRequest, Plus } from "lucide-react";
import { useEffect, useId, useRef, useState, type Ref } from "react";
import { DockToolIcon } from "./dockToolIcons";
import { OctantButton } from "../ui/base/OctantButton";
import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";

export interface DockUtilityLauncherSurface {
  readonly id: RightUtilityDockSurfaceId;
  readonly label: string;
}

/**
 * Something this thread is already about that can be opened as a tab.
 *
 * The tool list answers "what kind of tab"; this answers "which one", so the
 * reader does not have to leave the dock, find the pull request on another
 * surface, and come back.
 */
export interface DockUtilityLauncherReference {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly onOpen: () => void;
}

export interface DockUtilityLauncherProps {
  readonly onOpen: (surface: RightUtilityDockSurfaceId) => void;
  readonly surfaces: ReadonlyArray<DockUtilityLauncherSurface>;
  readonly references?: ReadonlyArray<DockUtilityLauncherReference>;
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

  // A subject whose remaining tools are all gated away has nothing to offer,
  // and a permanently greyed-out plus reads as a broken control rather than as
  // an honest "nothing to add here". Absence is the honest state.
  const references = props.references ?? [];
  if (props.surfaces.length === 0 && references.length === 0) return null;

  return (
    <span className="dock-utility-launcher">
      <OctantButton
        aria-label="Add tool"
        aria-controls={disclosureId}
        aria-expanded={open}
        className="dock-utility-launcher__trigger"
        onClick={() => setOpen((current) => !current)}
        ref={trigger}
        size="icon"
        title="Add tool"
        type="button"
        variant="ghost"
      >
        <Plus aria-hidden="true" size={14} strokeWidth={1.8} />
      </OctantButton>
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
          {references.length === 0 ? null : (
            <>
              <span className="workspace-disclosure__caption">Relevant to this task</span>
              {references.map((reference) => (
                <OctantButton
                  className="workspace-disclosure__action window-no-drag"
                  key={reference.id}
                  onClick={() => {
                    reference.onOpen();
                    close();
                  }}
                  type="button"
                  variant="ghost"
                >
                  <GitPullRequest aria-hidden="true" size={14} strokeWidth={1.7} />
                  <span className="dock-utility-launcher__reference">
                    <span>{reference.label}</span>
                    {reference.detail === undefined ? null : (
                      <span className="dock-utility-launcher__reference-detail">
                        {reference.detail}
                      </span>
                    )}
                  </span>
                </OctantButton>
              ))}
            </>
          )}
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
        <OctantButton
          className="workspace-disclosure__action window-no-drag"
          key={surface.id}
          onClick={() => props.onOpen(surface.id)}
          ref={index === 0 ? props.firstAction : undefined}
          type="button"
          variant="ghost"
        >
          <DockToolIcon surface={surface.id} />
          <span>{surface.label}</span>
        </OctantButton>
      ))}
    </>
  );
}
