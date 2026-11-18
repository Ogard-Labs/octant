import { OctantSelectField } from "../ui/base/OctantSelect";

export type StrictPreferenceValue = boolean | "inherit" | "legacy";

export function strictPreferenceValue(
  input: {
    readonly defaultStrict?: boolean | undefined;
    readonly defaultFullAccessSandbox?: boolean | undefined;
  },
  inherit = false,
): StrictPreferenceValue {
  return (
    input.defaultStrict ??
    (input.defaultFullAccessSandbox === true ? "legacy" : inherit ? "inherit" : false)
  );
}

/** One control retains a previous Full-access-only choice until it is changed. */
export function StrictPreferenceControl(props: {
  readonly value: StrictPreferenceValue;
  readonly onChange: (value: boolean | "inherit") => void;
  readonly disabled?: boolean | undefined;
  readonly inherit?: boolean | undefined;
  readonly label?: string;
}) {
  return (
    <OctantSelectField
      aria-label={props.label ?? "Strict"}
      disabled={props.disabled === true}
      value={typeof props.value === "boolean" ? (props.value ? "on" : "off") : props.value}
      options={[
        ...(props.inherit === true ? [{ id: "inherit", label: "Same as Settings" }] : []),
        ...(props.value === "legacy"
          ? [{ id: "legacy", label: "Full access only (previous choice)" }]
          : []),
        { id: "on", label: "On" },
        { id: "off", label: "Off" },
      ]}
      onValueChange={(value) => {
        if (value === "on" || value === "off") props.onChange(value === "on");
        else if (value === "inherit" && props.inherit === true) props.onChange("inherit");
      }}
    />
  );
}
