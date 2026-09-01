import type { OctantMode } from "@octant/contracts/modes";
import { enabledModes } from "@octant/domain/mode-policy";
import { Check, CircleDashed } from "lucide-react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import type { FirstRunHandoff, FirstRunHandoffSetupTarget } from "./firstRunHandoffModel";
import type { WorkspaceChoices } from "./firstRunStepModel";

export interface FirstRunReadinessStepProps {
  readonly workspace: WorkspaceChoices;
  readonly selectedMode: OctantMode;
  readonly onSelectMode: (mode: OctantMode) => void;
  readonly handoff: FirstRunHandoff;
  readonly onSetup: (target: FirstRunHandoffSetupTarget) => void;
}

const MODE_COPY: Record<OctantMode, string> = {
  chat: "Chat",
  work: "Work",
  code: "Code",
};

/**
 * The end of first run: three facts, one next action.
 *
 * Provider, Project, and a mode-valid default model are reported separately so
 * a clean host cannot look ready, and so a missing prerequisite opens exactly
 * the surface that still has to be answered. The primary action lives in the
 * dialog footer; this step only states the facts and which mode they are for.
 */
export function FirstRunReadinessStep(props: FirstRunReadinessStepProps) {
  const modes = enabledModes({
    chatEnabled: props.workspace.chatEnabled,
    workEnabled: props.workspace.workEnabled,
  });

  return (
    <div className="first-run__step">
      <p className="first-run__intro">
        A thread starts in a Project, with a provider and a model that mode can actually use.
        Nothing here is assumed ready.
      </p>

      {modes.length > 1 ? (
        <div className="setgroup">
          <div className="setgroup-head">Mode</div>
          <div className="first-run__choices">
            <OctantToggleGroup<OctantMode>
              aria-label="First thread mode"
              onValueChange={(value) => {
                const selected = value[0];
                if (selected !== undefined) props.onSelectMode(selected);
              }}
              role="radiogroup"
              value={[props.selectedMode]}
            >
              {modes.map((mode) => (
                <OctantToggleGroupItem
                  aria-checked={props.selectedMode === mode}
                  key={mode}
                  role="radio"
                  value={mode}
                >
                  {MODE_COPY[mode]}
                </OctantToggleGroupItem>
              ))}
            </OctantToggleGroup>
          </div>
        </div>
      ) : null}

      <section aria-labelledby="first-run-handoff-title" className="setgroup">
        <h3 className="setgroup-head" id="first-run-handoff-title">
          Ready to start
        </h3>
        <ul className="first-run__providers" role="list">
          {props.handoff.facts.map((fact) => {
            const Icon = fact.ready ? Check : CircleDashed;
            const target = setupTarget(fact.id, props.selectedMode);
            return (
              <li
                className="first-run__provider"
                data-state={fact.ready ? "ready" : "missing"}
                key={fact.id}
              >
                <Icon size={16} />
                {fact.ready || target === undefined ? (
                  <span className="first-run__provider-name">{fact.label}</span>
                ) : (
                  <OctantButton
                    className="first-run__provider-name first-run__fact-action"
                    onClick={() => props.onSetup(target)}
                    type="button"
                    variant="ghost"
                  >
                    {fact.label}
                  </OctantButton>
                )}
                <span className="first-run__provider-label">{fact.ready ? "Ready" : "Needed"}</span>
                <span className="first-run__provider-detail">{fact.detail}</span>
              </li>
            );
          })}
        </ul>
      </section>

      {props.handoff.ready ? null : (
        <p className="first-run__caveat" role="note">
          Skip for now leaves these answers as they are. It does not mark the host ready or start a
          thread.
        </p>
      )}
    </div>
  );
}

function setupTarget(
  fact: FirstRunHandoff["facts"][number]["id"],
  mode: OctantMode,
): FirstRunHandoffSetupTarget | undefined {
  if (fact === "provider") return "providers";
  if (fact === "project") return "project";
  if (fact === "model") return mode === "chat" ? "default-model" : "providers";
  return undefined;
}
