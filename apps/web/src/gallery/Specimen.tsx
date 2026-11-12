import type { ReactNode } from "react";

/**
 * One section of the gallery: a heading, a one-line caption, and its specimens.
 * The section's id is the anchor the contents list links to.
 */
export function Section(props: {
  readonly id: string;
  readonly title: string;
  readonly caption: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="gallery-section" id={props.id}>
      <header className="gallery-section__head">
        <h2 className="oct-page-title">{props.title}</h2>
        <p className="oct-row-detail">{props.caption}</p>
      </header>
      <div className="gallery-section__body">{props.children}</div>
    </section>
  );
}

/**
 * A labelled sample. `adapters` names the shared components it renders, as the
 * gallery test reads them to prove every adapter is shown; `props` is the
 * prop and attribute text the sample uses, written beside it so the label is
 * the code that drew it.
 */
export function Specimen(props: {
  readonly adapters?: ReadonlyArray<string>;
  readonly props?: string;
  readonly note?: string;
  readonly wide?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <figure className="gallery-specimen" data-wide={props.wide === true ? "true" : undefined}>
      <div className="gallery-specimen__stage">{props.children}</div>
      <figcaption className="gallery-specimen__label oct-meta">
        {(props.adapters ?? []).map((name) => (
          <code className="gallery-specimen__adapter" data-adapter={name} key={name}>
            {name}
          </code>
        ))}
        {props.props === undefined ? null : (
          <code className="gallery-specimen__props">{props.props}</code>
        )}
        {props.note === undefined ? null : (
          <span className="gallery-specimen__note">{props.note}</span>
        )}
      </figcaption>
    </figure>
  );
}

/** A row of one control across its states, with the state named under each. */
export function StateRow(props: {
  readonly title: string;
  /** The shared components the row draws, read by the gallery test like a specimen's. */
  readonly adapters?: ReadonlyArray<string>;
  readonly cells: ReadonlyArray<{
    readonly state: string;
    readonly note?: string;
    readonly children: ReactNode;
  }>;
}) {
  return (
    <div className="gallery-states" role="group" aria-label={props.title}>
      <p className="oct-row-label gallery-states__title">
        {(props.adapters ?? []).map((name) => (
          <code className="gallery-specimen__adapter" data-adapter={name} key={name}>
            {name}
          </code>
        ))}{" "}
        {props.title}
      </p>
      <div className="gallery-states__cells">
        {props.cells.map((cell) => (
          <div
            className="gallery-states__cell"
            data-focus-sample={cell.state === "focus-visible" ? "true" : undefined}
            data-state={cell.state}
            key={cell.state}
          >
            <div className="gallery-states__control">{cell.children}</div>
            <span className="oct-meta">
              {cell.state}
              {cell.note === undefined ? "" : ` (${cell.note})`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export const HOVER_PRESSED_NOTE = "no prop; shown at rest";
