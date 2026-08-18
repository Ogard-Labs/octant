import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import type { ModelPickerSelection, PickerGroup } from "@octant/domain";
import { ModelPicker } from "../providers/ModelPicker";
import { OctantButton } from "../ui/base/OctantButton";

export interface FirstRunModelStepProps {
  readonly ariaLabel: string;
  readonly intro: string;
  /** What is true when nothing is chosen. Said plainly, never as an error. */
  readonly unsetNote: string;
  readonly groups: ReadonlyArray<PickerGroup>;
  readonly selectedProviderInstanceId?: ProviderInstanceId | undefined;
  readonly selectedModelId?: ProviderModelId | undefined;
  readonly onSelect: (selection: ModelPickerSelection) => void;
  readonly onClear?: () => void;
  readonly clearLabel?: string;
  readonly onOpenProviderSettings: () => void;
}

/**
 * One model choice in first run, made from what the host actually found.
 *
 * When the provider step found nothing, this step says so and points back at
 * it instead of showing an empty picker: an empty list looks like a broken
 * control, while "no provider is ready" is the real answer. Nothing here is
 * required — leaving a model unchosen is a supported outcome, and the note
 * says exactly what stays unavailable as a result.
 */
export function FirstRunModelStep(props: FirstRunModelStepProps) {
  // A provider that is enabled and reachable still gets a group even when it
  // offered no usable models, so counting groups would draw an empty picker
  // for the state the provider step already reports as "no models". What
  // decides this is whether there is a model to choose, not a provider to
  // list.
  const empty = !props.groups.some((group) =>
    group.sections.some((section) => section.models.length > 0),
  );
  // A provider that answered with no models is not an unready one, and telling
  // the user to go check readiness would send them after a problem that is not
  // there. What is missing differs, so the two states say so differently.
  const listed = props.groups.length > 0;
  const chosen =
    props.selectedProviderInstanceId !== undefined && props.selectedModelId !== undefined;

  return (
    <div className="first-run__step">
      <p className="first-run__intro">{props.intro}</p>

      {empty ? (
        <div className="first-run__notice" data-tone="attention" role="status">
          <p className="first-run__intro">
            {listed
              ? "No provider on this Mac offered a model, so there is nothing to choose from yet."
              : "No provider on this Mac is ready, so there is nothing to choose from yet."}
          </p>
          <OctantButton onClick={props.onOpenProviderSettings} type="button" variant="ghost">
            Open provider settings
          </OctantButton>
        </div>
      ) : (
        <ModelPicker
          ariaLabel={props.ariaLabel}
          groups={props.groups}
          onSelect={props.onSelect}
          {...(props.selectedModelId === undefined
            ? {}
            : { selectedModelId: props.selectedModelId })}
          {...(props.selectedProviderInstanceId === undefined
            ? {}
            : { selectedProviderInstanceId: props.selectedProviderInstanceId })}
        />
      )}

      {chosen ? null : (
        <p className="first-run__caveat" role="note">
          {props.unsetNote}
        </p>
      )}

      {chosen && props.onClear !== undefined ? (
        <div className="first-run__setup">
          <OctantButton onClick={props.onClear} type="button" variant="ghost">
            {props.clearLabel ?? "Clear selection"}
          </OctantButton>
        </div>
      ) : null}
    </div>
  );
}
