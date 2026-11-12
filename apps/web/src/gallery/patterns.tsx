import { Inbox, Play, Settings as SettingsIcon, SquareTerminal } from "lucide-react";
import { useState } from "react";
import { SettingGroup, SettingRow, SettingsPageScope } from "../settings/primitives";
import { SidebarCountTiles } from "../shell/SidebarCountTiles";
import { IconButton } from "../shell/IconButton";
import { SidebarThreadRowContent } from "../projects/SidebarThreadRowContent";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantEmpty } from "../ui/base/OctantEmpty";
import {
  OctantField,
  OctantFieldDescription,
  OctantFieldError,
  OctantFieldGroup,
  OctantFieldLabel,
} from "../ui/base/OctantField";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { Section, Specimen } from "./Specimen";

const THEME_OPTIONS = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;

function SidebarSlice() {
  const [active, setActive] = useState("two");
  return (
    <aside className="sidebar gallery-sidebar" aria-label="Sidebar slice">
      <SidebarCountTiles
        tiles={[
          { id: "inbox", count: 3, onSelect: () => undefined },
          { id: "running", count: 2, onSelect: () => undefined, active: true },
          { id: "review", count: 0 },
          { id: "done", count: 11, onSelect: () => undefined },
        ]}
      />
      <section aria-label="Threads" className="project-section">
        <div className="project-section__header sidebar-section">
          <h2>Threads</h2>
        </div>
        <div className="project-threads">
          {(
            [
              ["one", "Fix the merge queue flake", "3m"],
              ["two", "Add a component gallery", "12m"],
              ["three", "Plan the Settings reorganisation", "2h"],
            ] as const
          ).map(([id, title, age]) => (
            <div className="sidebar-navigation__thread-row" key={id}>
              <OctantButton
                aria-current={active === id ? "page" : undefined}
                className="sidebar-navigation__thread project-threads__thread justify-start"
                onClick={() => setActive(id)}
                type="button"
                variant="bare"
              >
                <SidebarThreadRowContent age={{ label: age }} projectName="octant" title={title} />
              </OctantButton>
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}

function SettingsGroup() {
  const [dark, setDark] = useState(true);
  return (
    <SettingsPageScope.Provider value="app">
      <div className="gallery-settings">
        <SettingGroup label="Appearance" description="How the window looks.">
          <SettingRow
            description="Follows the system unless you pick one."
            label="Theme"
            scope="app"
            settingId="gallery-theme"
          >
            <OctantSelectField aria-label="Theme" defaultValue="system" options={THEME_OPTIONS} />
          </SettingRow>
          <SettingRow
            description="Show the sidebar's icon rail when it is collapsed."
            label="Icon rail"
            scope="app"
            settingId="gallery-rail"
          >
            <OctantSwitch checked={dark} label="Icon rail" onCheckedChange={setDark} />
          </SettingRow>
        </SettingGroup>
      </div>
    </SettingsPageScope.Provider>
  );
}

export function PatternSections() {
  return (
    <Section
      caption="Patterns built only from the real pieces above and the classes the app's own screens use."
      id="patterns"
      title="Composed patterns"
    >
      <Specimen
        adapters={["OctantButton"]}
        props={`<SidebarCountTiles /> + .project-section header + .sidebar-navigation__thread rows (SidebarThreadRowContent), aria-current="page" on the selected row`}
        note="group label, count tiles, rows, a selected row and counts"
      >
        <SidebarSlice />
      </Specimen>
      <Specimen
        adapters={["OctantSelectField", "OctantSwitch"]}
        props={`<SettingGroup><SettingRow label description scope>{OctantSelectField | OctantSwitch}</SettingRow></SettingGroup>`}
        note="a Settings form-row group"
        wide
      >
        <SettingsGroup />
      </Specimen>
      <Specimen
        adapters={[
          "OctantField",
          "OctantFieldGroup",
          "OctantFieldLabel",
          "OctantFieldDescription",
          "OctantFieldError",
        ]}
        props={`OctantFieldGroup > OctantField > OctantFieldLabel + OctantInput + OctantFieldDescription | OctantFieldError (aria-invalid)`}
        note="a stacked form field with its description and its error"
      >
        <OctantFieldGroup>
          <OctantField>
            <OctantFieldLabel htmlFor="gallery-name">Project name</OctantFieldLabel>
            <OctantInput defaultValue="octant" id="gallery-name" />
            <OctantFieldDescription>Shown in the sidebar.</OctantFieldDescription>
          </OctantField>
          <OctantField>
            <OctantFieldLabel htmlFor="gallery-folder">Folder</OctantFieldLabel>
            <OctantInput aria-invalid="true" defaultValue="/missing" id="gallery-folder" />
            <OctantFieldError>That folder does not exist.</OctantFieldError>
          </OctantField>
        </OctantFieldGroup>
      </Specimen>
      <Specimen
        adapters={[
          "OctantEmpty",
          "OctantEmptyRoot",
          "OctantEmptyHeader",
          "OctantEmptyMedia",
          "OctantEmptyEyebrow",
          "OctantEmptyTitle",
          "OctantEmptyDescription",
          "OctantEmptyContent",
        ]}
        props={`<OctantEmpty icon eyebrow title message action />`}
        note="an empty state; its parts are what OctantEmpty composes"
        wide
      >
        <OctantEmpty
          action={<OctantButton type="button">Start a thread</OctantButton>}
          eyebrow="Nothing yet"
          icon={<Inbox aria-hidden="true" size={20} />}
          message="Threads that need you appear here."
          title="The inbox is empty"
        />
      </Specimen>
      <Specimen
        props={`.surface-empty > .surface-empty__icon + .oct-row-label + .oct-row-detail + .surface-empty__action`}
        note="the quiet text empty state surfaces use"
        wide
      >
        <div className="surface-empty">
          <span className="surface-empty__icon">
            <SquareTerminal aria-hidden="true" size={20} />
          </span>
          <p className="oct-row-label">No terminals open</p>
          <p className="oct-row-detail">Open one from the dock.</p>
          <span className="surface-empty__action">
            <OctantButton size="sm" type="button" variant="outline">
              Open terminal
            </OctantButton>
          </span>
        </div>
      </Specimen>
      <Specimen
        props={`.project-action-buttons: OctantButton size="sm" variant="ghost" + IconButton`}
        note="the title band's button shape: the rail button's height and the control radius"
      >
        <div className="project-action-buttons">
          <OctantButton size="sm" type="button" variant="ghost">
            <Play aria-hidden="true" size={12} />
            Run
          </OctantButton>
          <OctantButton size="sm" type="button" variant="ghost">
            Worktrees
          </OctantButton>
          <IconButton icon={SettingsIcon} label="Settings" />
        </div>
      </Specimen>
    </Section>
  );
}
