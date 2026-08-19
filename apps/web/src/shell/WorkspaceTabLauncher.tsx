import type { WorkspaceSurfaceCatalog, WorkspaceSurfaceDescriptor } from "@octant/contracts";
import { Plus } from "lucide-react";
import { useEffect, useId, useRef, useState, type Ref } from "react";
import type { CodeOverviewSurfaceKind } from "../code/CodeOverview";
import { IconButton } from "./IconButton";

export interface WorkspaceTabLauncherProps {
  readonly catalog: WorkspaceSurfaceCatalog;
  readonly mode: "chat" | "work" | "code";
  readonly onOpenSurface: (surface: WorkspaceSurfaceDescriptor["kind"]) => void;
  /**
   * Opens a surface against the Code thread this group is showing. Present only
   * while that thread is the active tab, because each of these surfaces reads
   * one thread and means nothing without it.
   */
  readonly onOpenThreadSurface?: (kind: CodeOverviewSurfaceKind) => void;
  readonly owningThreadAvailable?: boolean;
  readonly threadSurfaces?: ReadonlyArray<{
    readonly kind: CodeOverviewSurfaceKind;
    readonly label: string;
  }>;
}

export function WorkspaceTabLauncher(props: WorkspaceTabLauncherProps) {
  const [open, setOpen] = useState(false);
  const disclosureId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) firstAction.current?.focus();
  }, [open]);

  const surfaces = props.catalog[props.mode];
  const available = surfaces.filter(
    (surface) =>
      surface.available && (surface.kind !== "browser" || props.owningThreadAvailable !== false),
  );

  function close(): void {
    setOpen(false);
    queueMicrotask(() => trigger.current?.focus());
  }

  function select(surface: WorkspaceSurfaceDescriptor["kind"]): void {
    props.onOpenSurface(surface);
    close();
  }

  const openThreadSurface = props.onOpenThreadSurface;
  const entries = [
    ...available.map((surface) => ({
      key: String(surface.kind),
      label: surface.label,
      open: () => select(surface.kind),
    })),
    ...(openThreadSurface === undefined
      ? []
      : (props.threadSurfaces ?? []).map((surface) => ({
          key: String(surface.kind),
          label: surface.label,
          open: () => {
            openThreadSurface(surface.kind);
            close();
          },
        }))),
  ];

  return (
    <span className="workspace-tab-launcher">
      <IconButton
        aria-controls={disclosureId}
        aria-expanded={open}
        className="workspace-tab-launcher__trigger"
        disabled={entries.length === 0}
        icon={Plus}
        label="New tab"
        onClick={() => setOpen((current) => !current)}
        ref={trigger}
      />
      {open ? (
        <span
          className="workspace-disclosure workspace-tab-launcher__disclosure"
          id={disclosureId}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
        >
          {entries.length === 0 ? (
            <span className="workspace-tab-launcher__empty">
              No surfaces available. Open a Project to enable more.
            </span>
          ) : (
            entries.map((entry, index) => (
              <LauncherAction
                {...(index === 0 ? { buttonRef: firstAction } : {})}
                key={entry.key}
                label={entry.label}
                onClick={entry.open}
              />
            ))
          )}
        </span>
      ) : null}
    </span>
  );
}

function LauncherAction(props: {
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      className="workspace-disclosure__action window-no-drag"
      onClick={props.onClick}
      ref={props.buttonRef}
      type="button"
    >
      <span>{props.label}</span>
    </button>
  );
}
