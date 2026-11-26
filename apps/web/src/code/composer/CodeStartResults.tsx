import { OctantButton } from "../../ui/base/OctantButton";
import { useThreadReferences } from "../../threadReferences/useThreadReferences";
import type { CodeFanOutResult } from "./codeFanOut";
import "./code-start-results.css";

export interface CodeStartResultsProps {
  readonly results: ReadonlyArray<CodeFanOutResult>;
  readonly label: (result: CodeFanOutResult) => string;
}

/**
 * What each start reached, one row per model: a started thread can be opened
 * from here once the window lists it, and a refusal says why. Threads that
 * started stay started whatever happened to the others.
 */
export function CodeStartResults(props: CodeStartResultsProps) {
  const references = useThreadReferences();
  return (
    <ul className="code-start-results">
      {props.results.map((result, index) => {
        const { outcome } = result;
        const threadId = outcome.threadId;
        const reference = threadId === undefined ? undefined : references.find(threadId);
        const open = references.open;
        return (
          <li className="code-start-results__row" key={`${String(index)}:${props.label(result)}`}>
            <span>
              {outcome.status === "started"
                ? `${props.label(result)}: started.`
                : `${props.label(result)}: ${outcome.reason}`}
            </span>
            {reference === undefined || open === undefined ? null : (
              <OctantButton onClick={() => open(reference)} size="sm" type="button" variant="link">
                Open
              </OctantButton>
            )}
          </li>
        );
      })}
    </ul>
  );
}
