import { Fragment } from "react";

/** The start screen's question, shared by every mode's welcome. */
export const WELCOME_QUESTION = "What are we building today?";

/**
 * The mark above the question: a circle with one eighth of it filled, the
 * octant the product is named for. It is drawn in the text ink, so it follows
 * the theme without a colour of its own.
 */
function OctantMark() {
  return (
    <svg aria-hidden="true" className="welcome__mark" height={24} viewBox="0 0 24 24" width={24}>
      <circle cx="12" cy="12" fill="none" r="10.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 12 L12 1.75 A10.25 10.25 0 0 1 19.25 4.75 Z" fill="currentColor" />
    </svg>
  );
}

/**
 * The start screen's hero: the mark, one question, and one quiet line under
 * it. It names no time of day and counts nothing: what is running and what
 * waits for review live in the sidebar, so the start screen asks one thing
 * and hands the rest of the page to the composer. Renders into the caller's
 * heading grid.
 */
export function WelcomeHeading() {
  return (
    <Fragment>
      <OctantMark />
      <h1 className="oct-title oct-title--hero">{WELCOME_QUESTION}</h1>
      <p className="oct-row-detail welcome__status">Pick a project, or just start typing</p>
    </Fragment>
  );
}
