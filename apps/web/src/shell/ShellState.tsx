import {
  Compass,
  LoaderCircle,
  RefreshCcw,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { useId } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import {
  OctantEmptyContent,
  OctantEmptyHeader,
  OctantEmptyDescription,
  OctantEmptyEyebrow,
  OctantEmptyMedia,
  OctantEmptyRoot,
  OctantEmptyTitle,
} from "../ui/base/OctantEmpty";

type ShellStateKind = "disconnected" | "loading" | "neutral" | "warning";

const stateIcons: Record<ShellStateKind, LucideIcon> = {
  disconnected: WifiOff,
  loading: LoaderCircle,
  neutral: Compass,
  warning: TriangleAlert,
};

export interface ShellStateProps {
  readonly action?: {
    readonly label: string;
    readonly onClick: () => void;
    /** The action's own glyph; a retry is the default, not the only meaning. */
    readonly glyph?: LucideIcon;
  };
  readonly eyebrow?: string;
  /** One sentence under the title; a loading line is the title alone. */
  readonly message?: string;
  readonly role?: "alert" | "status";
  readonly state: ShellStateKind;
  readonly title: string;
  /**
   * **page** is a state that is the whole window (a refused launch, a lost
   * connection): a large dotted mark, a centred title, one line, and the way
   * back as a text link. Without it the state sits inside a pane or panel.
   */
  readonly presentation?: "page";
}

export function ShellState(props: ShellStateProps) {
  if (props.presentation === "page" && props.state !== "loading") {
    return <PageShellState {...props} />;
  }
  const StateIcon = stateIcons[props.state];
  return (
    <OctantEmptyRoot
      className="shell-state"
      data-state={props.state}
      role={props.role ?? (props.state === "loading" ? "status" : undefined)}
    >
      {/* Every state's mark is neutral ink. The default look is monochrome, and
          a warning-coloured triangle was the only hue on a screen whose glyph
          and title already say what is wrong. */}
      <OctantEmptyMedia>
        <StateIcon
          aria-hidden="true"
          className={props.state === "loading" ? "shell-state__spinner" : undefined}
          size={16}
          strokeWidth={1.7}
        />
      </OctantEmptyMedia>
      <OctantEmptyHeader>
        {props.eyebrow === undefined ? null : (
          <OctantEmptyEyebrow>{props.eyebrow}</OctantEmptyEyebrow>
        )}
        <OctantEmptyTitle>{props.title}</OctantEmptyTitle>
        {props.message === undefined ? null : (
          <OctantEmptyDescription>{props.message}</OctantEmptyDescription>
        )}
      </OctantEmptyHeader>
      {props.action === undefined ? null : (
        <OctantEmptyContent>
          <OctantButton onClick={props.action.onClick} type="button" variant="secondary">
            {props.action.glyph === undefined ? (
              <RefreshCcw aria-hidden="true" size={14} strokeWidth={1.9} />
            ) : (
              <props.action.glyph aria-hidden="true" size={14} strokeWidth={1.9} />
            )}
            <span>{props.action.label}</span>
          </OctantButton>
        </OctantEmptyContent>
      )}
    </OctantEmptyRoot>
  );
}

/**
 * A whole-window state. The mark is the state's glyph drawn as a field of dots,
 * the same grain as the pulsing character ground, in the primary ink; the
 * eyebrow is left out, since the title already says what happened.
 */
function PageShellState(props: ShellStateProps) {
  return (
    <section
      aria-label={props.title}
      className="shell-state shell-state--page"
      data-state={props.state}
      role={props.role}
    >
      <DottedMark state={props.state} />
      <h1 className="shell-state__page-title">{props.title}</h1>
      {props.message === undefined ? null : (
        <p className="shell-state__page-message">{props.message}</p>
      )}
      {props.action === undefined ? null : (
        <OctantButton
          className="shell-state__page-action"
          onClick={props.action.onClick}
          type="button"
          variant="link"
        >
          <span className="shell-state__page-action-label">{props.action.label}</span>
        </OctantButton>
      )}
    </section>
  );
}

/**
 * The state's glyph as dots: a dot grid shown only where the glyph is. A
 * warning is a filled triangle with its mark cut out of it; every other state
 * is its icon's own strokes, thickened so the dots can fill them.
 */
function DottedMark(props: { readonly state: ShellStateKind }) {
  // useId yields characters a url(#…) reference cannot carry.
  const id = `shell-state-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const pattern = `${id}-dots`;
  const mask = `${id}-shape`;
  const StateIcon = stateIcons[props.state];
  return (
    <svg aria-hidden="true" className="shell-state__mark" viewBox="0 0 24 24">
      <defs>
        {/* About a dot every 6px at the mark's 96px, each under 2px: the
            open grain of the reference, not a halftone. */}
        <pattern height="1.5" id={pattern} patternUnits="userSpaceOnUse" width="1.5">
          <circle cx="0.75" cy="0.75" fill="currentColor" r="0.22" />
        </pattern>
        <mask id={mask}>
          {props.state === "warning" ? (
            <>
              <path d="M12 2.5 L22.5 21 L1.5 21 Z" fill="white" />
              <rect fill="black" height="7" rx="0.6" width="2.2" x="10.9" y="8.5" />
              <rect fill="black" height="2.2" rx="0.6" width="2.2" x="10.9" y="17" />
            </>
          ) : (
            <StateIcon color="white" height={24} strokeWidth={3} width={24} />
          )}
        </mask>
      </defs>
      <rect fill={`url(#${pattern})`} height="24" mask={`url(#${mask})`} width="24" />
    </svg>
  );
}
