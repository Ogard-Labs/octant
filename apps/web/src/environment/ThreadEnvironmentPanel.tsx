import {
  type EnvironmentCompactIdentity,
  type EnvironmentPresentation,
  type EnvironmentPresentationState,
  type OctantMode,
  type WorkspaceTabId,
} from "@octant/contracts";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useCallback, useEffect, useRef, type ReactNode } from "react";
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

/**
 * The thread's environment panel: it floats over the thread, or it hides
 * behind a reveal control. There is no docked presentation — a panel in the
 * row took width from the surface being read, and glanceable live status is
 * what the panel is for.
 */
export function ThreadEnvironmentPanel(props: ThreadEnvironmentPanelProps) {
  const presentation = resolveTabPresentation(props.presentation, props.mode, props.tabId);

  const setPresentation = useCallback(
    (next: EnvironmentPresentation) => {
      if (next === presentation) return;
      if (next === props.presentation.byMode[props.mode]) {
        props.onChangePresentation(clearTabPresentation(props.presentation, props.tabId));
      } else {
        props.onChangePresentation(replaceTabPresentation(props.presentation, props.tabId, next));
      }
    },
    [presentation, props],
  );

  if (presentation === "hidden") {
    return (
      <ThreadEnvironmentReveal
        identity={props.identity}
        onReveal={() => setPresentation("floating")}
      />
    );
  }

  return (
    <ThreadEnvironmentFloating identity={props.identity} onHide={() => setPresentation("hidden")}>
      {props.children}
    </ThreadEnvironmentFloating>
  );
}

/**
 * The show half of the toggle. It collapses to an icon square in the thread's
 * top-right corner, so its accessible name has to carry what it opens and
 * which environment that is — the visible label is not always rendered.
 */
function ThreadEnvironmentReveal(props: {
  readonly identity: EnvironmentCompactIdentity;
  readonly onReveal: () => void;
}) {
  const name = `Show environment panel for ${props.identity.label} ${props.identity.detail}`;
  return (
    <OctantButton
      type="button"
      className="thread-environment-reveal"
      onClick={props.onReveal}
      aria-label={name}
      title={name}
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
      {/* A plain row, not a <header>: the panel is a dialog rather than
          sectioning content, so a <header> here would publish a second banner
          landmark alongside the window chrome. */}
      <div className="thread-environment-panel__header">
        <CompactIdentity identity={props.identity} />
        <OctantButton
          type="button"
          className="thread-environment-panel__icon-button"
          onClick={props.onHide}
          aria-label="Hide environment panel"
          title="Hide environment panel"
          size="icon"
          variant="ghost"
        >
          <PanelRightClose aria-hidden="true" size={14} strokeWidth={1.8} />
        </OctantButton>
      </div>
      <div className="thread-environment-panel__body">{props.children}</div>
    </div>
  );
}

function CompactIdentity(props: { readonly identity: EnvironmentCompactIdentity }) {
  return (
    <div className="thread-environment-identity">
      <span className="thread-environment-identity__label">{props.identity.label}</span>
      <span
        className={`thread-environment-identity__status thread-environment-identity__status--${props.identity.status}`}
      >
        {props.identity.status}
      </span>
      <span className="thread-environment-identity__detail">{props.identity.detail}</span>
    </div>
  );
}
