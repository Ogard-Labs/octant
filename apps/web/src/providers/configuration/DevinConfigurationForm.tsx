import { type ProviderInstance } from "@octant/contracts";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantInput } from "../../ui/base/OctantInput";
import type { ProviderSettingsViewProps } from "../ProviderSettingsView";

export function DevinConfigurationForm(props: {
  readonly disabled: boolean;
  readonly instance: Extract<ProviderInstance, { driverKind: "devin" }>;
  readonly onChange: ProviderSettingsViewProps["onChangeDevinConfiguration"];
}) {
  return (
    <form
      className="provider-card__edit"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void props.onChange(props.instance.id, {
          kind: "devin-acp",
          binaryPath: String(data.get("binaryPath") ?? ""),
          authentication: "subscription",
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
        aria-label={`Save Devin settings for ${props.instance.displayName}`}
      >
        Save
      </OctantButton>
    </form>
  );
}
