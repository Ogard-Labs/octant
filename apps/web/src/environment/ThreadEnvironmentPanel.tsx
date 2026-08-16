import {
  type EnvironmentCompactIdentity,
  type EnvironmentPresentation,
  type EnvironmentPresentationState,
  type OctantMode,
  type WorkspaceTabId,
} from "@octant/contracts";
import { PanelRightClose, PanelRightOpen, Pin } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import {
  clearTabPresentation,
  replaceTabPresentation,
  resolveTabPresentation,
} from "./EnvironmentPresentationModel";

export interface ThreadEnvironmentPanelProps {
  readonly identity: EnvironmentCompactIdentity;
  readonly mode: OctantMode;
  readonly presentation: EnvironmentPresentationState;
  readonly tabId: WorkspaceTabId;
  readonly onChangePresentation: (next: EnvironmentPresentationState) => void;
  readonly children?: ReactNode;
}

export function ThreadEnvironmentPanel(props: ThreadEnvironmentPanelProps) {
  const resolved = resolveTabPresentation(props.presentation, props.mode, props.tabId);

  const setPresentation = useCallback(
    (next: EnvironmentPresentation) => {
      if (next === resolved.presentation) return;
      if (next === props.presentation.byMode[props.mode]) {
        props.onChangePresentation(clearTabPresentation(props.presentation, props.tabId));
      } else {
        props.onChangePresentation(replaceTabPresentation(props.presentation, props.tabId, next));
      }
    },
    [props, resolved.presentation],
  );

  if (resolved.presentation === "hidden") {
    return (
      <ThreadEnvironmentReveal
        identity={props.identity}
        onReveal={() => setPresentation("floating")}
      />
    );
  }

  if (resolved.presentation === "floating") {
    return (
      <ThreadEnvironmentFloating
        identity={props.identity}
        onPin={() => setPresentation("pinned")}
        onHide={() => setPresentation("hidden")}
      >
        {props.children}
      </ThreadEnvironmentFloating>
    );
  }

  return (
    <ThreadEnvironmentPinned
      identity={props.identity}
      pinnedWidth={resolved.pinnedWidth}
      onFloat={() => setPresentation("floating")}
      onHide={() => setPresentation("hidden")}
      onResize={(width) =>
        props.onChangePresentation(
          replaceTabPresentation(props.presentation, props.tabId, "pinned", width),
        )
      }
    >
      {props.children}
    </ThreadEnvironmentPinned>
  );
}

function ThreadEnvironmentReveal(props: {
  readonly identity: EnvironmentCompactIdentity;
  readonly onReveal: () => void;
}) {
  return (
    <OctantButton
      type="button"
      className="thread-environment-reveal"
      onClick={props.onReveal}
      aria-label={`Show environment for ${props.identity.label} ${props.identity.detail}`}
      variant="ghost"
    >
      <PanelRightOpen aria-hidden="true" size={16} strokeWidth={1.8} />
      <span className="thread-environment-reveal__label">{props.identity.label}</span>
      <span className="thread-environment-reveal__detail">{props.identity.detail}</span>
      <span
        className={`thread-environment-reveal__status thread-environment-reveal__status--${props.identity.status}`}
      >
        {props.identity.status}
      </span>
    </OctantButton>
  );
}

function ThreadEnvironmentFloating(props: {
  readonly identity: EnvironmentCompactIdentity;
  readonly onPin: () => void;
  readonly onHide: () => void;
  readonly children?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onHideRef = useRef(props.onHide);
  onHideRef.current = props.onHide;

  // Focus once on mount so Escape-to-hide works; do not refocus on parent
  // re-renders (identity/sections/handlers change identity each render).
  useEffect(() => {
    const node = panelRef.current;
    if (node === null) return;
    node.focus();
  }, []);

  // Escape-to-hide handler reads the latest onHide via a ref so the listener
  // is bound once and never needs to re-attach on props changes.
  useEffect(() => {
    const node = panelRef.current;
    if (node === null) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onHideRef.current();
      }
    };
    node.addEventListener("keydown", handleKey);
    return () => node.removeEventListener("keydown", handleKey);
  }, []);

  return (
    <div
      ref={panelRef}
      className="thread-environment-panel thread-environment-panel--floating"
      tabIndex={-1}
      role="dialog"
      aria-label={`Environment for ${props.identity.label}`}
    >
      <div className="thread-environment-panel__header">
        <CompactIdentity identity={props.identity} />
        <div className="thread-environment-panel__actions">
          <IconButton label="Pin environment" onClick={props.onPin}>
            <Pin aria-hidden="true" size={14} strokeWidth={1.8} />
          </IconButton>
          <IconButton label="Hide environment" onClick={props.onHide}>
            <PanelRightClose aria-hidden="true" size={14} strokeWidth={1.8} />
          </IconButton>
        </div>
      </div>
      <div className="thread-environment-panel__body">{props.children}</div>
    </div>
  );
}

function ThreadEnvironmentPinned(props: {
  readonly identity: EnvironmentCompactIdentity;
  readonly pinnedWidth: number;
  readonly onFloat: () => void;
  readonly onHide: () => void;
  readonly onResize: (width: number) => void;
  readonly children?: ReactNode;
}) {
  const [dragging, setDragging] = useState(false);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const dragStartRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const previewWidthRef = useRef<number | null>(null);
  const onResizeRef = useRef(props.onResize);
  onResizeRef.current = props.onResize;

  // Keep the ref in sync with state so the mouseup handler reads the latest
  // preview width without re-binding the listeners on every mousemove.
  previewWidthRef.current = previewWidth;

  useEffect(() => {
    if (!dragging) return;
    const handleMove = (event: MouseEvent) => {
      const start = dragStartRef.current;
      if (start === null) return;
      const delta = event.clientX - start.startX;
      setPreviewWidth(Math.round(start.startWidth - delta));
    };
    const handleUp = () => {
      const width = previewWidthRef.current;
      if (width !== null) {
        onResizeRef.current(width);
      }
      dragStartRef.current = null;
      setPreviewWidth(null);
      setDragging(false);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      document.body.style.cursor = "";
    };
  }, [dragging]);

  const effectiveWidth = previewWidth ?? props.pinnedWidth;

  return (
    <div
      className="thread-environment-panel thread-environment-panel--pinned"
      style={{ width: effectiveWidth }}
      role="region"
      aria-label={`Environment for ${props.identity.label}`}
    >
      <div className="thread-environment-panel__header">
        <CompactIdentity identity={props.identity} />
        <div className="thread-environment-panel__actions">
          <IconButton label="Float environment" onClick={props.onFloat}>
            <PanelRightOpen aria-hidden="true" size={14} strokeWidth={1.8} />
          </IconButton>
          <IconButton label="Hide environment" onClick={props.onHide}>
            <PanelRightClose aria-hidden="true" size={14} strokeWidth={1.8} />
          </IconButton>
        </div>
      </div>
      <div className="thread-environment-panel__body">{props.children}</div>
      <div
        className="thread-environment-panel__resizer"
        role="separator"
        aria-orientation="vertical"
        onMouseDown={(event) => {
          dragStartRef.current = { startX: event.clientX, startWidth: props.pinnedWidth };
          setPreviewWidth(null);
          setDragging(true);
        }}
      />
    </div>
  );
}

function CompactIdentity(props: { readonly identity: EnvironmentCompactIdentity }) {
  return (
    <div className="thread-environment-identity">
      <span className="thread-environment-identity__label">{props.identity.label}</span>
      <span className="thread-environment-identity__detail">{props.identity.detail}</span>
      <span
        className={`thread-environment-identity__status thread-environment-identity__status--${props.identity.status}`}
      >
        {props.identity.status}
      </span>
    </div>
  );
}

function IconButton(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <OctantButton
      type="button"
      className="thread-environment-panel__icon-button"
      onClick={props.onClick}
      aria-label={props.label}
      size="icon"
      variant="ghost"
    >
      {props.children}
    </OctantButton>
  );
}
