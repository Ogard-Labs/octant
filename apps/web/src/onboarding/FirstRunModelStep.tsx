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
  const empty = props.groups.length === 0;
  const chosen =
    props.selectedProviderInstanceId !== undefined && props.selectedModelId !== undefined;

  return (
    <div className="first-run__step">
      <p className="first-run__intro">{props.intro}</p>

      {empty ? (
        <div className="first-run__notice" data-tone="attention" role="status">
          <p className="first-run__intro">
            No provider on this Mac is ready, so there is nothing to choose from yet.
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
