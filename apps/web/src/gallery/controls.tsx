import { Bell, Check, Plus, Settings, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { IconButton } from "../shell/IconButton";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import {
  OctantCombobox,
  OctantComboboxInput,
  OctantComboboxInputGroup,
  OctantComboboxTrigger,
} from "../ui/base/OctantCombobox";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantNumberStepper } from "../ui/base/OctantNumberStepper";
import { OctantSelectField, type OctantSelectOption } from "../ui/base/OctantSelect";
import { OctantSeparator, OctantSeparatorWithLabel } from "../ui/base/OctantSeparator";
import { OctantSlider } from "../ui/base/OctantSlider";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { OctantTabs, OctantTabsList, OctantTabsPanel, OctantTabsTab } from "../ui/base/OctantTabs";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { HOVER_PRESSED_NOTE, Section, Specimen, StateRow } from "./Specimen";

const BUTTON_VARIANTS = [
  "default",
  "solid",
  "destructive",
  "outline",
  "secondary",
  "ghost",
  "link",
  "chip",
] as const;
const BUTTON_SIZES = ["xs", "sm", "default", "lg"] as const;
const ICON_SIZES = ["icon-xs", "icon-sm", "icon"] as const;

function Buttons() {
  return (
    <>
      {BUTTON_VARIANTS.map((variant) => (
        <Specimen
          adapters={["OctantButton"]}
          key={variant}
          props={`variant="${variant}" size="${variant === "chip" ? "default (a chip sizes itself)" : "xs | sm | default | lg"}"`}
          wide
        >
          <div className="gallery-row">
            {BUTTON_SIZES.map((size) => (
              <OctantButton key={size} size={size} type="button" variant={variant}>
                {size}
              </OctantButton>
            ))}
            <OctantButton size="default" type="button" variant={variant}>
              <Plus aria-hidden="true" data-icon="inline-start" size={16} strokeWidth={1.5} />
              With icon
            </OctantButton>
          </div>
        </Specimen>
      ))}
      <Specimen
        adapters={["OctantButton"]}
        props={`variant="outline" size="icon-xs | icon-sm | icon"`}
        note="the recipe's own icon sizes; the shell icon button follows"
      >
        <div className="gallery-row">
          {ICON_SIZES.map((size) => (
            <OctantButton aria-label={size} key={size} size={size} type="button" variant="outline">
              <Bell aria-hidden="true" size={16} strokeWidth={1.5} />
            </OctantButton>
          ))}
        </div>
      </Specimen>
      <Specimen
        adapters={["OctantButton"]}
        props={`variant="bare"`}
        note="paints nothing; a feature stylesheet owns it"
      >
        <OctantButton type="button" variant="bare">
          Bare button
        </OctantButton>
      </Specimen>
      {(["default", "outline", "secondary", "ghost", "destructive"] as const).map((variant) => (
        <StateRow
          cells={[
            {
              state: "rest",
              children: (
                <OctantButton type="button" variant={variant}>
                  Label
                </OctantButton>
              ),
            },
            {
              state: "hover",
              note: HOVER_PRESSED_NOTE,
              children: (
                <OctantButton type="button" variant={variant}>
                  Label
                </OctantButton>
              ),
            },
            {
              state: "pressed",
              note: HOVER_PRESSED_NOTE,
              children: (
                <OctantButton type="button" variant={variant}>
                  Label
                </OctantButton>
              ),
            },
            {
              state: "focus-visible",
              children: (
                <OctantButton type="button" variant={variant}>
                  Label
                </OctantButton>
              ),
            },
            {
              state: "disabled",
              note: "disabled",
              children: (
                <OctantButton disabled type="button" variant={variant}>
                  Label
                </OctantButton>
              ),
            },
            {
              state: "invalid",
              note: 'aria-invalid="true"',
              children: (
                <OctantButton aria-invalid="true" type="button" variant={variant}>
                  Label
                </OctantButton>
              ),
            },
          ]}
          key={variant}
          title={`variant="${variant}"`}
          adapters={["OctantButton"]}
        />
      ))}
    </>
  );
}

function IconButtons() {
  return (
    <>
      <Specimen
        adapters={["OctantIconButton"]}
        props={`<IconButton icon={Settings} label="Settings" /> (shell/IconButton.tsx, 16px icon, stroke 1.5)`}
      >
        <div className="gallery-row">
          <IconButton icon={Settings} label="Settings" />
          <IconButton icon={Bell} label="Notifications" />
          <IconButton icon={Trash2} label="Delete" />
        </div>
      </Specimen>
      <StateRow
        cells={[
          { state: "rest", children: <IconButton icon={Settings} label="Settings" /> },
          {
            state: "hover",
            note: HOVER_PRESSED_NOTE,
            children: <IconButton icon={Settings} label="Settings" />,
          },
          {
            state: "pressed",
            note: 'aria-pressed="true"',
            children: <IconButton aria-pressed="true" icon={Settings} label="Settings" />,
          },
          { state: "focus-visible", children: <IconButton icon={Settings} label="Settings" /> },
          {
            state: "disabled",
            note: "disabled",
            children: <IconButton disabled icon={Settings} label="Settings" />,
          },
        ]}
        title="via IconButton (shell/IconButton.tsx)"
        adapters={["OctantIconButton"]}
      />
    </>
  );
}

const FIELD_STATES = (
  render: (props: { disabled?: true; "aria-invalid"?: "true"; readOnly?: true }) => ReactNode,
) =>
  [
    { state: "rest", children: render({}) },
    { state: "hover", note: HOVER_PRESSED_NOTE, children: render({}) },
    { state: "focus-visible", children: render({}) },
    { state: "disabled", note: "disabled", children: render({ disabled: true }) },
    { state: "invalid", note: 'aria-invalid="true"', children: render({ "aria-invalid": "true" }) },
    { state: "read only", note: "readOnly", children: render({ readOnly: true }) },
  ] as const;

const SELECT_OPTIONS: ReadonlyArray<OctantSelectOption> = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

function Fields() {
  const [stepper, setStepper] = useState(13);
  const [stepperAtMin, setStepperAtMin] = useState(10);
  const [slider, setSlider] = useState(40);
  return (
    <>
      <StateRow
        cells={FIELD_STATES((state) => (
          <OctantInput aria-label="Name" defaultValue="Octant" placeholder="Name" {...state} />
        ))}
        title="states"
        adapters={["OctantInput"]}
      />
      <Specimen
        adapters={["OctantInput"]}
        props={`placeholder="Search" (empty)`}
        note="empty with placeholder"
      >
        <OctantInput aria-label="Search" placeholder="Search" />
      </Specimen>
      <StateRow
        cells={FIELD_STATES((state) => (
          <OctantTextarea
            aria-label="Notes"
            defaultValue={"Two lines of text\nin a textarea"}
            {...state}
          />
        ))}
        title="states"
        adapters={["OctantTextarea"]}
      />
      <StateRow
        cells={[
          {
            state: "rest",
            children: (
              <OctantSelectField
                aria-label="Theme"
                defaultValue="system"
                options={SELECT_OPTIONS}
              />
            ),
          },
          {
            state: "hover",
            note: HOVER_PRESSED_NOTE,
            children: (
              <OctantSelectField
                aria-label="Theme"
                defaultValue="system"
                options={SELECT_OPTIONS}
              />
            ),
          },
          {
            state: "focus-visible",
            children: (
              <OctantSelectField
                aria-label="Theme"
                defaultValue="system"
                options={SELECT_OPTIONS}
              />
            ),
          },
          {
            state: "disabled",
            note: "disabled",
            children: (
              <OctantSelectField
                aria-label="Theme"
                defaultValue="system"
                disabled
                options={SELECT_OPTIONS}
              />
            ),
          },
          {
            state: "placeholder",
            note: "value matches no option",
            children: (
              <OctantSelectField
                aria-label="Theme"
                placeholder="Choose a theme"
                value="none"
                options={SELECT_OPTIONS}
              />
            ),
          },
        ]}
        title={`OctantSelectField (the open popup is under Menu and popups)`}
      />
      <StateRow
        cells={[
          {
            state: "rest",
            children: (
              <OctantCombobox items={["Geist", "Menlo", "Monaco"]} defaultValue="Geist">
                <OctantComboboxInputGroup className="gallery-field-width">
                  <OctantComboboxInput aria-label="Font" placeholder="Search fonts" />
                  <OctantComboboxTrigger aria-label="Open fonts">
                    <Check aria-hidden="true" />
                  </OctantComboboxTrigger>
                </OctantComboboxInputGroup>
              </OctantCombobox>
            ),
          },
          {
            state: "disabled",
            note: "disabled",
            children: (
              <OctantCombobox disabled items={["Geist", "Menlo"]} defaultValue="Geist">
                <OctantComboboxInputGroup className="gallery-field-width">
                  <OctantComboboxInput aria-label="Font, disabled" placeholder="Search fonts" />
                  <OctantComboboxTrigger aria-label="Open fonts, disabled">
                    <Check aria-hidden="true" />
                  </OctantComboboxTrigger>
                </OctantComboboxInputGroup>
              </OctantCombobox>
            ),
          },
        ]}
        title="OctantCombobox with its input group, input and trigger"
      />
      <Specimen adapters={["OctantNumberStepper"]} props={`min={8} max={24} step={1} suffix="px"`}>
        <OctantNumberStepper
          label="Interface size"
          max={24}
          min={8}
          onChange={setStepper}
          suffix="px"
          value={stepper}
        />
      </Specimen>
      <Specimen
        adapters={["OctantNumberStepper"]}
        props={`value === min`}
        note="the decrease button is disabled"
      >
        <OctantNumberStepper
          label="Floor"
          max={24}
          min={10}
          onChange={setStepperAtMin}
          value={stepperAtMin}
        />
      </Specimen>
      <StateRow
        cells={[
          { state: "unchecked", children: <OctantCheckbox aria-label="Unchecked" /> },
          {
            state: "checked",
            note: "defaultChecked",
            children: <OctantCheckbox aria-label="Checked" defaultChecked />,
          },
          {
            state: "hover",
            note: HOVER_PRESSED_NOTE,
            children: <OctantCheckbox aria-label="Hover" />,
          },
          { state: "focus-visible", children: <OctantCheckbox aria-label="Focus" /> },
          {
            state: "disabled",
            note: "disabled",
            children: <OctantCheckbox aria-label="Disabled" disabled />,
          },
          {
            state: "invalid",
            note: 'aria-invalid="true"',
            children: <OctantCheckbox aria-invalid="true" aria-label="Invalid" />,
          },
        ]}
        title="states"
        adapters={["OctantCheckbox"]}
      />
      <StateRow
        cells={[
          {
            state: "off",
            children: (
              <OctantSwitch checked={false} label="Off" onCheckedChange={() => undefined} />
            ),
          },
          {
            state: "on",
            children: <OctantSwitch checked label="On" onCheckedChange={() => undefined} />,
          },
          {
            state: "hover",
            note: HOVER_PRESSED_NOTE,
            children: (
              <OctantSwitch checked={false} label="Hover" onCheckedChange={() => undefined} />
            ),
          },
          {
            state: "focus-visible",
            children: <OctantSwitch checked label="Focus" onCheckedChange={() => undefined} />,
          },
          {
            state: "disabled",
            note: "disabled",
            children: (
              <OctantSwitch
                checked={false}
                disabled
                label="Disabled"
                onCheckedChange={() => undefined}
              />
            ),
          },
          {
            state: "disabled on",
            note: "disabled, with disabledReason",
            children: (
              <OctantSwitch
                checked
                disabled
                disabledReason="Managed by policy"
                label="Disabled on"
                onCheckedChange={() => undefined}
              />
            ),
          },
        ]}
        title="states"
        adapters={["OctantSwitch"]}
      />
      <StateRow
        cells={[
          {
            state: "rest",
            children: (
              <OctantSlider
                aria-label="Opacity"
                className="gallery-field-width"
                max={100}
                min={0}
                onChange={(event) => setSlider(Number(event.currentTarget.value))}
                value={slider}
              />
            ),
          },
          {
            state: "focus-visible",
            children: (
              <OctantSlider
                aria-label="Opacity focus"
                className="gallery-field-width"
                defaultValue={60}
                max={100}
                min={0}
              />
            ),
          },
          {
            state: "disabled",
            note: "disabled",
            children: (
              <OctantSlider
                aria-label="Opacity disabled"
                className="gallery-field-width"
                defaultValue={30}
                disabled
                max={100}
                min={0}
              />
            ),
          },
        ]}
        title="states"
        adapters={["OctantSlider"]}
      />
    </>
  );
}

function Labels() {
  const [view, setView] = useState<ReadonlyArray<string>>(["list"]);
  return (
    <>
      <Specimen
        adapters={["OctantBadge"]}
        props={`variant="default | secondary | destructive | outline | dashed | success | warning"`}
        wide
      >
        <div className="gallery-row">
          {(
            [
              "default",
              "secondary",
              "destructive",
              "outline",
              "dashed",
              "success",
              "warning",
            ] as const
          ).map((variant) => (
            <OctantBadge key={variant} variant={variant}>
              {variant}
            </OctantBadge>
          ))}
        </div>
      </Specimen>
      <Specimen
        adapters={["OctantBadge"]}
        props={`aria-invalid="true"`}
        note="the invalid state the recipe reads"
      >
        <OctantBadge aria-invalid="true">Invalid</OctantBadge>
      </Specimen>
      <Specimen
        adapters={["OctantButton"]}
        props={`variant="chip"`}
        note="the suggestion chip is a button; the badge is a label"
        wide
      >
        <div className="gallery-row">
          <OctantButton type="button" variant="chip">
            Suggest a fix
          </OctantButton>
          <OctantButton type="button" variant="chip">
            Explain this file
          </OctantButton>
          <OctantButton disabled type="button" variant="chip">
            Disabled chip
          </OctantButton>
        </div>
      </Specimen>
      <Specimen adapters={["OctantSeparator"]} props={`orientation="horizontal" | "vertical"`} wide>
        <div className="gallery-row">
          <span className="oct-row-label">Left</span>
          <OctantSeparator orientation="vertical" />
          <span className="oct-row-label">Right</span>
        </div>
        <OctantSeparator orientation="horizontal" />
      </Specimen>
      <Specimen
        adapters={["OctantSeparatorWithLabel"]}
        props={`<OctantSeparatorWithLabel>Today</OctantSeparatorWithLabel>`}
        wide
      >
        <OctantSeparatorWithLabel>Today</OctantSeparatorWithLabel>
      </Specimen>
      <Specimen
        adapters={["OctantTabs", "OctantTabsList", "OctantTabsTab", "OctantTabsPanel"]}
        props={`defaultValue="overview"; one tab disabled`}
        wide
      >
        <OctantTabs defaultValue="overview">
          <OctantTabsList aria-label="Sections">
            <OctantTabsTab value="overview">Overview</OctantTabsTab>
            <OctantTabsTab value="activity">Activity</OctantTabsTab>
            <OctantTabsTab disabled value="archive">
              Archive
            </OctantTabsTab>
          </OctantTabsList>
          <OctantTabsPanel value="overview">
            <span className="oct-row-detail">The selected tab's panel.</span>
          </OctantTabsPanel>
          <OctantTabsPanel value="activity">
            <span className="oct-row-detail">Activity panel.</span>
          </OctantTabsPanel>
        </OctantTabs>
      </Specimen>
      <Specimen
        adapters={["OctantToggleGroup", "OctantToggleGroupItem"]}
        props={`value={["list"]}; one item disabled`}
      >
        <OctantToggleGroup<string> aria-label="View" onValueChange={setView} value={view}>
          <OctantToggleGroupItem value="list">List</OctantToggleGroupItem>
          <OctantToggleGroupItem value="board">Board</OctantToggleGroupItem>
          <OctantToggleGroupItem disabled value="graph">
            Graph
          </OctantToggleGroupItem>
        </OctantToggleGroup>
      </Specimen>
    </>
  );
}

export function ControlSections() {
  return (
    <>
      <Section
        caption="OctantButton in every variant and size, then across its states."
        id="buttons"
        title="Buttons"
      >
        <Buttons />
      </Section>
      <Section
        caption="The shell's icon button, which every window and tile bar uses."
        id="icon-buttons"
        title="Icon button"
      >
        <IconButtons />
      </Section>
      <Section
        caption="Fields and toggles across rest, focus, disabled and invalid; hover and pressed have no prop, so they are shown at rest."
        id="fields"
        title="Fields and toggles"
      >
        <Fields />
      </Section>
      <Section
        caption="Badges, chips, separators, tabs and the segmented control."
        id="labels"
        title="Labels, tabs and segments"
      >
        <Labels />
      </Section>
    </>
  );
}
