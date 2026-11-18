import { Fragment } from "react";
import "./welcome-heading.css";

/** The start screen's question, shared by every mode's welcome. */
export const WELCOME_QUESTION = "What are we building today?";

/** The start screen's question when a Project is chosen; the name follows. */
const WELCOME_PROJECT_LEAD = "What should we work on in ";

/**
 * The start screen's hero: one question and one quiet line under it. It names
 * no time of day and counts nothing: what is running and what waits for
 * review live in the sidebar, so the start screen asks one thing and hands
 * the rest of the page to the composer. No mark stands over it: a logo above
 * a large centred headline is how a web page opens, and the app's own mark is
 * already in the Dock and the window. Renders into the caller's heading grid.
 */
export function WelcomeHeading(props: {
  readonly projectChosen?: boolean;
  /** False leaves the quiet line out; Chat says it in the composer's placeholder. */
  readonly hint?: boolean;
  /** The chosen Project's display name; the question then names it. */
  readonly projectName?: string;
}) {
  const projectName = props.projectName?.trim();
  return (
    <Fragment>
      {projectName === undefined || projectName === "" ? (
        <h1 className="oct-title oct-title--hero welcome__question">{WELCOME_QUESTION}</h1>
      ) : (
        // One line always, so choosing another Project changes the words in
        // place and nothing below the heading moves. A long name gives way
        // to an ellipsis; the full name stays in the title.
        <h1
          aria-label={`${WELCOME_PROJECT_LEAD}${projectName}?`}
          className="oct-title oct-title--hero welcome__question welcome__question--project"
        >
          <span className="welcome__question-lead">{WELCOME_PROJECT_LEAD}</span>
          <span className="welcome__project" title={projectName}>
            {projectName}
          </span>
          <span className="welcome__question-tail">?</span>
        </h1>
      )}
      {/* With a Project already chosen, asking for one reads as if the choice
          did not take. */}
      {props.hint === false ? null : (
        <p className="oct-row-detail welcome__status">
          {props.projectChosen === true
            ? "Just start typing"
            : "Pick a Project, or just start typing"}
        </p>
      )}
    </Fragment>
  );
}
