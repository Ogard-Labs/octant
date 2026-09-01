import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";

export interface SurfaceProps {
  /** Names the landmark; every surface is a `<section>` with a label. */
  readonly ariaLabel: string;
  readonly className?: string;
  /** Boards and canvases use the full width; lists keep the reading measure. */
  readonly measure?: "reading" | "wide";
  readonly children: ReactNode;
}

/**
 * The one page shell for lists, boards, readers, and preference pages. It
 * owns the reading measure and the ground; the header, toolbar, and sections
 * inside it come from `SurfaceHeader` and the `surface-*` recipes.
 */
export function Surface(props: SurfaceProps) {
  const classes = ["surface"];
  if (props.measure === "wide") classes.push("surface--wide");
  if (props.className !== undefined) classes.push(props.className);
  return (
    <section aria-label={props.ariaLabel} className={classes.join(" ")}>
      <div className="surface__inner">{props.children}</div>
    </section>
  );
}

export interface SurfaceHeaderProps {
  readonly title: string;
  /** One sentence. Longer explanations belong in a section note. */
  readonly subtitle?: string;
  readonly titleId?: string;
  /** Primary actions for the whole surface, at the trailing edge. */
  readonly actions?: ReactNode;
  /**
   * The one way to leave a reader route. Every surface that replaces the
   * workspace offers the same ghost back control; Close, ×, and raised
   * variants are not part of the language.
   */
  readonly onBack?: () => void;
}

export function SurfaceHeader(props: SurfaceHeaderProps) {
  return (
    <header className="surface-header">
      <div className="surface-header__copy">
        <h1 className="oct-title" {...(props.titleId === undefined ? {} : { id: props.titleId })}>
          {props.title}
        </h1>
        {props.subtitle === undefined ? null : <p className="oct-subtitle">{props.subtitle}</p>}
      </div>
      {props.actions === undefined && props.onBack === undefined ? null : (
        <div className="surface-header__actions">
          {props.actions}
          {props.onBack === undefined ? null : (
            <OctantButton onClick={props.onBack} size="sm" type="button" variant="ghost">
              <ArrowLeft aria-hidden="true" size={14} strokeWidth={1.8} />
              Back to workspace
            </OctantButton>
          )}
        </div>
      )}
    </header>
  );
}

export interface SurfaceSectionProps {
  readonly label: string;
  readonly note?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

/** A labelled group with the shared hairline rule under its label. */
export function SurfaceSection(props: SurfaceSectionProps) {
  return (
    <section
      aria-label={props.label}
      className={
        props.className === undefined ? "surface-section" : `surface-section ${props.className}`
      }
    >
      <h2 className="oct-section-label">{props.label}</h2>
      {props.note === undefined ? null : <p className="surface-section__note">{props.note}</p>}
      {props.children}
    </section>
  );
}

export interface SurfaceEmptyProps {
  readonly title: string;
  readonly detail?: string;
  readonly action?: ReactNode;
}

/** Quiet empty state: a line of text, not a card. */
export function SurfaceEmpty(props: SurfaceEmptyProps) {
  return (
    <div className="surface-empty" role="status">
      <span className="oct-row-label">{props.title}</span>
      {props.detail === undefined ? null : <span className="oct-row-detail">{props.detail}</span>}
      {props.action}
    </div>
  );
}
