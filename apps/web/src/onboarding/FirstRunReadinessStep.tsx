import { Check, CircleDashed } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import type { FirstRunHandoff, FirstRunHandoffSetupTarget } from "./firstRunHandoffModel";

export interface FirstRunReadinessStepProps {
  readonly handoff: FirstRunHandoff;
  readonly onSetup: (target: FirstRunHandoffSetupTarget) => void;
}

const MODE_COPY: Record<FirstRunHandoff["mode"], string> = {
  work: "Work",
  code: "Code",
};

const FACT_TARGET: Record<FirstRunHandoff["facts"][number]["id"], FirstRunHandoffSetupTarget> = {
  provider: "providers",
  project: "project",
  model: "model",
};

/**
 * The end of first run: three facts, one next action.
 *
 * Provider, Project, and a mode-valid model are reported separately so a clean
 * host cannot look ready, and so a missing prerequisite opens exactly the
 * surface that still has to be answered. The primary action lives in the
 * dialog footer; this step only states the facts and which mode they are for.
 */
export function FirstRunReadinessStep(props: FirstRunReadinessStepProps) {
  return (
    <div className="first-run__step">
      <p className="first-run__intro">
        Your first task starts in {MODE_COPY[props.handoff.mode]}, in a Project, with a provider and
        a model that mode can actually use. Nothing here is assumed ready.
      </p>

      <section
        aria-label="Ready to start"
        className="settings-card-section settings-card-section--open"
      >
        <h2>Ready to start</h2>
        <ul className="setgroup first-run__providers" role="list">
          {props.handoff.facts.map((fact) => {
            const Icon = fact.ready ? Check : CircleDashed;
            return (
              <li
                className="setrow first-run__provider"
                data-state={fact.ready ? "ready" : "missing"}
                key={fact.id}
              >
                <span className="setrow-label">
                  <Icon size={16} />
                  {fact.ready ? (
                    fact.label
                  ) : (
                    <OctantButton
                      className="first-run__fact-action"
                      onClick={() => props.onSetup(FACT_TARGET[fact.id])}
                      type="button"
                      variant="ghost"
                    >
                      {fact.label}
                    </OctantButton>
                  )}
                </span>
                <p className="setrow-hint">{fact.detail}</p>
                <div className="setrow-control">
                  <span className="first-run__provider-state">
                    {fact.ready ? "Ready" : "Needed"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {props.handoff.ready ? null : (
        <p className="first-run__caveat" role="note">
          Skip setup leaves these answers as they are. It does not mark the host ready or start a
          task.
        </p>
      )}
    </div>
  );
}
