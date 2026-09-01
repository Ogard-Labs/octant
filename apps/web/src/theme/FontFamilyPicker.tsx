import { Check, ChevronsUpDown } from "lucide-react";
import {
  OctantCombobox,
  OctantComboboxEmpty,
  OctantComboboxInput,
  OctantComboboxInputGroup,
  OctantComboboxItem,
  OctantComboboxItemIndicator,
  OctantComboboxList,
  OctantComboboxPopup,
  OctantComboboxPortal,
  OctantComboboxPositioner,
  OctantComboboxTrigger,
} from "../ui/base/OctantCombobox";

export interface FontFamilyPickerProps {
  readonly label: string;
  readonly onChange: (family: string) => void;
  readonly surface: "ui" | "editor" | "terminal";
  readonly value: string;
}

interface FontOption {
  readonly family: string;
  readonly label: string;
}

const UI_FONTS: ReadonlyArray<FontOption> = [
  {
    label: "Octant interface",
    family:
      "'Inter Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  },
  {
    label: "System interface",
    family: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  },
  { label: "SF Pro", family: "'SF Pro Text', -apple-system, system-ui, sans-serif" },
  { label: "Inter", family: "Inter, system-ui, sans-serif" },
  { label: "Geist", family: "Geist, system-ui, sans-serif" },
  { label: "Helvetica Neue", family: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { label: "Segoe UI", family: "'Segoe UI', system-ui, sans-serif" },
  { label: "Roboto", family: "Roboto, system-ui, sans-serif" },
  { label: "Open Sans", family: "'Open Sans', system-ui, sans-serif" },
];

const MONO_FONTS: ReadonlyArray<FontOption> = [
  {
    label: "Octant monospace",
    family: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
  },
  { label: "JetBrains Mono", family: "'JetBrains Mono', ui-monospace, monospace" },
  { label: "SF Mono", family: "'SF Mono', ui-monospace, monospace" },
  { label: "Menlo", family: "Menlo, ui-monospace, monospace" },
  { label: "Monaco", family: "Monaco, ui-monospace, monospace" },
  { label: "Geist Mono", family: "'Geist Mono', ui-monospace, monospace" },
  { label: "Fira Code", family: "'Fira Code', ui-monospace, monospace" },
  { label: "Source Code Pro", family: "'Source Code Pro', ui-monospace, monospace" },
  { label: "Cascadia Code", family: "'Cascadia Code', ui-monospace, monospace" },
  { label: "IBM Plex Mono", family: "'IBM Plex Mono', ui-monospace, monospace" },
  { label: "Hack Nerd Font", family: "'Hack Nerd Font Mono', ui-monospace, monospace" },
  { label: "MesloLGS NF", family: "'MesloLGS NF', ui-monospace, monospace" },
];

export function FontFamilyPicker(props: FontFamilyPickerProps) {
  const baseOptions = props.surface === "ui" ? UI_FONTS : MONO_FONTS;
  const known = baseOptions.some((option) => option.family === props.value);
  const options = known
    ? baseOptions
    : [{ label: "Current custom stack", family: props.value }, ...baseOptions];
  const families = options.map((option) => option.family);
  const labelFor = (family: string) =>
    options.find((option) => option.family === family)?.label ?? "Custom font stack";

  return (
    <OctantCombobox
      itemToStringLabel={labelFor}
      itemToStringValue={(family) => family}
      items={families}
      onValueChange={(family) => {
        if (family !== null) props.onChange(family);
      }}
      value={props.value}
    >
      <OctantComboboxInputGroup className="settings-font-picker">
        <OctantComboboxInput aria-label={props.label} placeholder="Search fonts…" />
        <OctantComboboxTrigger aria-label={`Open ${props.label} options`}>
          <ChevronsUpDown aria-hidden="true" />
        </OctantComboboxTrigger>
      </OctantComboboxInputGroup>
      <OctantComboboxPortal>
        <OctantComboboxPositioner align="end" sideOffset={4}>
          <OctantComboboxPopup>
            <OctantComboboxEmpty>No matching fonts</OctantComboboxEmpty>
            <OctantComboboxList>
              {(family: string) => (
                <OctantComboboxItem key={family} value={family}>
                  <span className="settings-font-picker__preview" style={{ fontFamily: family }}>
                    {labelFor(family)}
                  </span>
                  <span className="settings-font-picker__sample" style={{ fontFamily: family }}>
                    Aa 01
                  </span>
                  <OctantComboboxItemIndicator>
                    <Check aria-hidden="true" />
                  </OctantComboboxItemIndicator>
                </OctantComboboxItem>
              )}
            </OctantComboboxList>
          </OctantComboboxPopup>
        </OctantComboboxPositioner>
      </OctantComboboxPortal>
    </OctantCombobox>
  );
}
