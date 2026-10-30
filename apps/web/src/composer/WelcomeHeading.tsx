import { Fragment } from "react";
import "./welcome-heading.css";

/** The start screen's question, shared by every mode's welcome. */
export const WELCOME_QUESTION = "What are we building today?";

/**
 * The mark above the question: the Octant aperture from the icon sprite. It is
 * drawn in the text ink, so it follows the theme without a colour of its own.
 */
function OctantMark() {
  return (
    <svg
      aria-hidden="true"
      className="welcome__mark"
      focusable="false"
      height={22}
      viewBox="0 0 100 100"
      width={22}
    >
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
export function WelcomeHeading(props: { readonly projectChosen?: boolean }) {
  return (
    <Fragment>
      <OctantMark />
      <h1 className="oct-title oct-title--hero welcome__question">{WELCOME_QUESTION}</h1>
      {/* With a Project already chosen, asking for one reads as if the choice
          did not take. */}
      <p className="oct-row-detail welcome__status">
        {props.projectChosen === true
          ? "Just start typing"
          : "Pick a Project, or just start typing"}
      </p>
    </Fragment>
  );
}
