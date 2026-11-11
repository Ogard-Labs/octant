import { Maximize2, X } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { DockToolIcon } from "./dockToolIcons";
import { IconButton } from "./IconButton";
import { OctantButton } from "../ui/base/OctantButton";
import type { RightUtilityDockSurfaceId } from "./rightUtilityDockModel";
import type { ThreadUtilityDockState } from "./rightUtilityDockSelection";

/** One minimised tool, as the shelf draws it: a card for the tool, never for one of its pages. */
export interface DockShelfEntry {
  /** The tab that stands for the tool: the one expanding or closing it addresses. */
  readonly tabId: string;
  readonly surface: Extract<RightUtilityDockSurfaceId, "browser" | "terminal">;
}

/**
 * The cards a dock state asks for: one for each minimised tool, Browser first,
 * and one for the Browser while the agent has a live session and the Browser is
 * out of sight, whether or not the person minimised it, as long as it has a tab.
 */
export function dockShelfEntries(
  state: ThreadUtilityDockState,
  agentBrowserLive: boolean,
): ReadonlyArray<DockShelfEntry> {
  const minimised = new Set(state.minimised);
  const entries: DockShelfEntry[] = [];
  const browser = state.tabs.find((tab) => tab.surface === "browser");
  if (browser !== undefined && (minimised.has(browser.id) || agentBrowserLive)) {
    entries.push({ tabId: browser.id, surface: "browser" });
  }
  const terminal = state.tabs.find((tab) => tab.surface === "terminal" && minimised.has(tab.id));
  if (terminal !== undefined) entries.push({ tabId: terminal.id, surface: "terminal" });
  return entries;
}

/**
 * The foot of the dock: the tools that were minimised, each a small live card.
 * It takes its natural height and never more than a share of the dock; the
 * area above keeps its floors and measures the space that is left.
 */
export function DockShelf(props: {
  readonly entries: ReadonlyArray<DockShelfEntry>;
  readonly renderCard: (entry: DockShelfEntry) => ReactNode;
}) {
  if (props.entries.length === 0) return null;
  return (
    <div aria-label="Minimised tools" className="dock-shelf" role="group">
      {props.entries.map((entry) => (
        <div className="dock-shelf__slot" key={entry.surface}>
          {props.renderCard(entry)}
        </div>
      ))}
    </div>
  );
}

/**
 * One card's anatomy, for any tool: its icon, a title, expand and close, and
 * a live preview that is itself the expand control. The preview is drawn
 * inert under a transparent button, so nothing inside it can take focus or
 * act: a card shows a page or a shell and never reaches into one.
 */
export function DockMiniCard(props: {
  readonly children: ReactNode;
  /** A quiet word beside the title, such as the profile a page lives in or that a shell exited. */
  readonly detail?: string | undefined;
  /** Output arrived while nobody was looking; a quiet dot says so to every reader. */
  readonly newOutput?: boolean;
  readonly onClose: () => void;
  /**
   * Whether the pointer or the keyboard is on the card, so what it shows is
   * being seen. Told when either arrives and when both have left.
   */
  readonly onEngagementChange?: (engaged: boolean) => void;
  readonly onExpand: () => void;
  readonly previewLabel: string;
  readonly surface: DockShelfEntry["surface"];
  readonly title: string;
  readonly toolLabel: string;
}) {
  const pointer = useRef(false);
  const focus = useRef(false);
  const report = () => props.onEngagementChange?.(pointer.current || focus.current);
  return (
    <section
      aria-label={`Minimised ${props.toolLabel}`}
      className="dock-card dock-mini-card"
      data-dock-card={props.surface}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        focus.current = false;
        report();
      }}
      onFocus={() => {
        focus.current = true;
        report();
      }}
      onPointerEnter={() => {
        pointer.current = true;
        report();
      }}
      onPointerLeave={() => {
        pointer.current = false;
        report();
      }}
    >
      <div className="dock-mini-card__head">
        <span className="dock-card__icon">
          <DockToolIcon surface={props.surface} />
        </span>
        <span className="dock-card__title dock-mini-card__title" title={props.title}>
          {props.title}
        </span>
        {props.detail === undefined ? null : (
          <span className="dock-mini-card__detail">{props.detail}</span>
        )}
        {props.newOutput === true ? (
          <span aria-label="New output" className="dock-mini-card__dot" role="img" />
        ) : null}
        <IconButton
          className="dock-mini-card__action text-muted-foreground"
          icon={Maximize2}
          label={`Show ${props.toolLabel}`}
          onClick={props.onExpand}
        />
        <IconButton
          className="dock-mini-card__action text-muted-foreground"
          icon={X}
          label={`Close ${props.toolLabel}`}
          onClick={props.onClose}
        />
      </div>
      <div className="dock-mini-card__preview">
        <div aria-hidden="true" className="dock-mini-card__live" inert>
          {props.children}
        </div>
        <OctantButton
          aria-label={props.previewLabel}
          className="dock-mini-card__expand"
          onClick={props.onExpand}
          type="button"
          variant="bare"
        />
      </div>
    </section>
  );
}
