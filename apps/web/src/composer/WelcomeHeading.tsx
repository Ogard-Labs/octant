import { Fragment } from "react";

/** The start screen's question, shared by every mode's welcome. */
export const WELCOME_QUESTION = "What are we building today?";

/**
 * The mark above the question: Octant's own aperture, the same eight-blade
 * symbol the harness wears as its provider mark, from the shared icon sprite.
 * It is drawn in the text ink, so it follows the theme without a colour of its
 * own.
 */
function OctantMark() {
  return (
    <svg aria-hidden="true" className="welcome__mark" height={24} viewBox="0 0 100 100" width={24}>
      <use href="./icons.svg#aperture" />
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
