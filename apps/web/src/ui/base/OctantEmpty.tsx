import {
  Compass,
  LoaderCircle,
  RefreshCcw,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import { useId, type ReactNode } from "react";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyDescription,
  EmptyEyebrow,
  EmptyMedia,
  EmptyTitle,
} from "../shadcn/empty";
import { OctantButton } from "./OctantButton";

export {
  Empty as OctantEmptyRoot,
  EmptyContent as OctantEmptyContent,
  EmptyHeader as OctantEmptyHeader,
  EmptyDescription as OctantEmptyDescription,
  EmptyEyebrow as OctantEmptyEyebrow,
  EmptyMedia as OctantEmptyMedia,
  EmptyTitle as OctantEmptyTitle,
};

export type OctantEmptyState = "disconnected" | "loading" | "neutral" | "warning";

const stateIcons: Record<OctantEmptyState, LucideIcon> = {
  disconnected: WifiOff,
  loading: LoaderCircle,
  neutral: Compass,
  warning: TriangleAlert,
};

/** The card layout with caller-drawn mark and action. */
export interface OctantEmptyCardProps {
  readonly layout?: "card";
  readonly state?: undefined;
  readonly action?: ReactNode;
  readonly className?: string;
  readonly eyebrow?: string;
  readonly icon?: ReactNode;
  readonly message: ReactNode;
  readonly role?: "alert" | "status";
  readonly title: string;
}

/**
 * A named state: the glyph comes from `state` and the action is one button.
 * **card** sits inside a pane or panel; **page** is a state that is the whole
 * window (a refused launch, a lost connection): a large dotted mark, a centred
 * title, one line, and the way back as a text link. A loading state is always
 * the card, whatever the layout.
 */
export interface OctantEmptyStateProps {
  readonly layout?: "card" | "page";
  readonly state: OctantEmptyState;
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
  readonly title: string;
}

/** The quiet line: a line of text, not a card. An optional icon and a real button frame it. */
export interface OctantEmptyLineProps {
  readonly layout: "line";
  readonly state?: undefined;
  readonly title: string;
  readonly detail?: string;
  readonly action?: ReactNode;
  /** A quiet mark above the line, for a page with nothing on it. Decorative. */
  readonly icon?: ReactNode;
  /**
   * "page" is a surface with nothing on it, where the sentence is the only
   * thing to read. "lane" is one empty column beside full ones, where the same
   * sentence in the same ink shouts louder than the real cards next to it.
   */
  readonly tone?: "page" | "lane";
}

export type OctantEmptyProps = OctantEmptyCardProps | OctantEmptyStateProps | OctantEmptyLineProps;

/** Empty, connection, error, and whole-window states. */
export function OctantEmpty(props: OctantEmptyProps) {
  if (props.layout === "line") return <LineEmpty {...props} />;
  if (props.state !== undefined) {
    if (props.layout === "page" && props.state !== "loading") return <PageEmpty {...props} />;
    return <StateEmpty {...props} />;
  }
  return <CardEmpty {...props} />;
}

function CardEmpty({
  action,
  className,
  eyebrow,
  icon,
  message,
  role,
  title,
}: OctantEmptyCardProps) {
  const hasIcon = icon !== undefined;
  return (
    <Empty className={className} role={role}>
      {hasIcon ? <EmptyMedia>{icon}</EmptyMedia> : null}
      <EmptyHeader className={hasIcon ? undefined : "col-span-2"}>
        {eyebrow === undefined ? null : <EmptyEyebrow>{eyebrow}</EmptyEyebrow>}
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      {action === undefined ? null : (
        <EmptyContent className={hasIcon ? undefined : "col-span-2 col-start-1"}>
          {action}
        </EmptyContent>
      )}
    </Empty>
  );
}

function StateEmpty(props: OctantEmptyStateProps) {
  const StateIcon = stateIcons[props.state];
  return (
    <Empty
      className="shell-state"
      data-state={props.state}
      role={props.role ?? (props.state === "loading" ? "status" : undefined)}
    >
      {/* Every state's mark is neutral ink in every style. A warning-coloured
          triangle on a screen whose glyph and title already say what is wrong
          reads as an alarm it is not. */}
      <EmptyMedia>
        <StateIcon
          aria-hidden="true"
          className={props.state === "loading" ? "shell-state__spinner" : undefined}
          size={16}
        />
      </EmptyMedia>
      <EmptyHeader>
        {props.eyebrow === undefined ? null : <EmptyEyebrow>{props.eyebrow}</EmptyEyebrow>}
        <EmptyTitle>{props.title}</EmptyTitle>
        {props.message === undefined ? null : <EmptyDescription>{props.message}</EmptyDescription>}
      </EmptyHeader>
      {props.action === undefined ? null : (
        <EmptyContent>
          <OctantButton onClick={props.action.onClick} type="button" variant="secondary">
            {props.action.glyph === undefined ? (
              <RefreshCcw aria-hidden="true" size={14} />
            ) : (
              <props.action.glyph aria-hidden="true" size={14} />
            )}
            <span>{props.action.label}</span>
          </OctantButton>
        </EmptyContent>
      )}
    </Empty>
  );
}

/**
 * A whole-window state. The mark is the state's glyph drawn as a field of dots,
 * the same grain as the pulsing character ground, in the primary ink; the
 * eyebrow is left out, since the title already says what happened.
 */
function PageEmpty(props: OctantEmptyStateProps) {
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
function DottedMark(props: { readonly state: OctantEmptyState }) {
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

function LineEmpty(props: OctantEmptyLineProps) {
  return (
    <div className="surface-empty" data-tone={props.tone ?? "page"} role="status">
      {props.icon === undefined ? null : (
        <span aria-hidden="true" className="surface-empty__icon">
          {props.icon}
        </span>
      )}
      <span className={props.tone === "lane" ? "oct-meta" : "oct-row-label"}>{props.title}</span>
      {props.detail === undefined ? null : <span className="oct-row-detail">{props.detail}</span>}
      {props.action === undefined ? null : (
        <span className="surface-empty__action">{props.action}</span>
      )}
    </div>
  );
}
