import { type ProviderInstance } from "@octant/contracts";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantInput } from "../../ui/base/OctantInput";
import type { ProviderSettingsViewProps } from "../ProviderSettingsView";

export function PiConfigurationForm(props: {
  readonly disabled: boolean;
  readonly instance: Extract<ProviderInstance, { driverKind: "pi" }>;
  readonly onChange: ProviderSettingsViewProps["onChangePiConfiguration"];
}) {
  return (
    <form
      className="provider-card__edit"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void props.onChange(props.instance.id, {
          kind: "pi-rpc",
          binaryPath: String(data.get("binaryPath") ?? ""),
        });
      }}
    >
      <label>
        <span>Binary path</span>
        <OctantInput
          aria-label={`Binary path for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.binaryPath}
          name="binaryPath"
          required
        />
      </label>
      <OctantButton
        disabled={props.disabled}
        type="submit"
        variant="outline"
        size="sm"
        aria-label={`Save Pi settings for ${props.instance.displayName}`}
      >
        Save
      </OctantButton>
    </form>
  );
}

export function OhMyPiConfigurationForm(props: {
  readonly disabled: boolean;
  readonly instance: Extract<ProviderInstance, { driverKind: "oh-my-pi" }>;
  readonly onChange: ProviderSettingsViewProps["onChangeOhMyPiConfiguration"];
}) {
  return (
    <form
      className="provider-card__edit"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void props.onChange(props.instance.id, {
          kind: "oh-my-pi-rpc",
          binaryPath: String(data.get("binaryPath") ?? ""),
          supportedVersion: props.instance.configuration.supportedVersion,
        });
      }}
    >
      <label>
        <span>Binary path</span>
        <OctantInput
          aria-label={`Binary path for ${props.instance.displayName}`}
          className="settings-view__text-input"
          defaultValue={props.instance.configuration.binaryPath}
          name="binaryPath"
          required
        />
      </label>
      <OctantButton
        disabled={props.disabled}
        type="submit"
        variant="outline"
        size="sm"
        aria-label={`Save Oh My Pi settings for ${props.instance.displayName}`}
      >
        Save
      </OctantButton>
    </form>
  );
}
