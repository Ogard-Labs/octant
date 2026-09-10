import type { OctantMode } from "@octant/contracts/modes";
import { enabledModes } from "@octant/domain/mode-policy";
import { Check, CircleDashed } from "lucide-react";
import { SettingRow } from "../settings/primitives";
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
        <section aria-label="Mode" className="settings-card-section settings-card-section--open">
          <h2>Mode</h2>
          <div className="setgroup">
            <SettingRow
              description="The mode this first thread starts in."
              label="First thread"
              scope="app"
              settingId="first-run-thread-mode"
            >
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
            </SettingRow>
          </div>
        </section>
      ) : null}

      <section
        aria-label="Ready to start"
        className="settings-card-section settings-card-section--open"
      >
        <h2>Ready to start</h2>
        <ul className="setgroup first-run__providers" role="list">
          {props.handoff.facts.map((fact) => {
            const Icon = fact.ready ? Check : CircleDashed;
            const target = setupTarget(fact.id, props.selectedMode);
            return (
              <li
                className="setrow first-run__provider"
                data-state={fact.ready ? "ready" : "missing"}
                key={fact.id}
              >
                <span className="setrow-label">
                  <Icon size={16} />
                  {fact.ready || target === undefined ? (
                    fact.label
                  ) : (
                    <OctantButton
                      className="first-run__fact-action"
                      onClick={() => props.onSetup(target)}
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
