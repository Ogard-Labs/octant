import type { ThreadGoalCriterion, ThreadGoalEvidenceRef } from "@octant/contracts";
import { Check, Circle } from "lucide-react";

export interface GoalCriteriaProps {
  readonly criteria: ReadonlyArray<ThreadGoalCriterion>;
}

const EVIDENCE_KIND_LABEL: Record<ThreadGoalEvidenceRef["kind"], string> = {
  event: "Event",
  artifact: "Artifact",
  test: "Check result",
  review: "Review",
  "user-confirmation": "Confirmed by a person",
};

/** "1 of 3 met", the count a collapsed row can state without opening. */
export function goalCriteriaSummary(criteria: ReadonlyArray<ThreadGoalCriterion>): string {
  const met = criteria.filter((criterion) => criterion.status === "met").length;
  return `${String(met)} of ${String(criteria.length)} met`;
}

/**
 * The goal's ledger: each acceptance criterion with how it is checked, what
 * the last check observed, and whether it holds. A criterion is met only by a
 * check the host ran or a person's confirmation, so the evidence is shown
 * beside the state it supports. The state is a word as well as a mark, so it
 * never depends on colour or shape alone.
 */
export function GoalCriteria(props: GoalCriteriaProps) {
  if (props.criteria.length === 0) return null;
  return (
    <section aria-label="Acceptance criteria" className="goal-criteria">
      <p className="goal-criteria__summary" data-testid="goal-criteria-summary">
        {goalCriteriaSummary(props.criteria)}
      </p>
      <ol className="goal-criteria__list">
        {props.criteria.map((criterion) => {
          const met = criterion.status === "met";
          const Mark = met ? Check : Circle;
          return (
            <li
              className="goal-criteria__item"
              data-criterion={criterion.id}
              data-status={criterion.status}
              key={criterion.id}
            >
              <span className="goal-criteria__state">
                <Mark aria-hidden="true" size={12} strokeWidth={1.8} />
                <span>{met ? "Met" : "Not met"}</span>
              </span>
              <span className="goal-criteria__text">{criterion.text}</span>
              <span className="goal-criteria__check">
                {criterion.check === undefined ? (
                  "Confirmed by a person"
                ) : (
                  <>
                    Command <code>{criterion.check}</code>
                  </>
                )}
              </span>
              <span className="goal-criteria__evidence">
                {criterion.evidence === undefined ? (
                  "No evidence yet"
                ) : (
                  <>
                    {EVIDENCE_KIND_LABEL[criterion.evidence.kind]}: {criterion.evidence.summary}
                    {" · "}
                    <time dateTime={criterion.evidence.observedAt}>
                      {formatObserved(criterion.evidence.observedAt)}
                    </time>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function formatObserved(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : value;
}
