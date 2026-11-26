import type { SidebarThreadStatus } from "@octant/contracts/sidebar-thread-status";
import type { SidebarRowPropertyVisibility } from "@octant/contracts/shell";
import type { ProjectViewSwitcherPresentation } from "@octant/contracts/shell";
import type { ProjectViewEnvironment, ProjectViewFilters } from "../code/codeProjectViewModel";
import type { SidebarRowPropertyView } from "../shell/sidebarRowProperties";
import type { SidebarThreadArrangement } from "../shell/activityViewModel";
import {
  OctantMenuCheckboxItem,
  OctantMenuGroup,
  OctantMenuGroupLabel,
  OctantMenuItem as OctantMenuActionItem,
  OctantMenuPopup,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuRadioGroup,
  OctantMenuRadioItem,
  OctantMenuSeparator,
  OctantMenuSub,
  OctantMenuSubPopup,
  OctantMenuSubTrigger,
} from "../ui/base/OctantMenu";

/** What the items read that the sidebar also holds; handed in, so this module imports none of it. */
export interface ProjectViewFilterKit {
  readonly normalizeFilters: (filters: undefined) => ProjectViewFilters;
  readonly rowPropertiesForView: Readonly<
    Record<SidebarRowPropertyView, ReadonlyArray<keyof SidebarRowPropertyVisibility>>
  >;
  readonly rowPropertyLabels: Readonly<Record<keyof SidebarRowPropertyVisibility, string>>;
  readonly rowPropertiesAll: (
    view: SidebarRowPropertyView,
    shown: boolean,
  ) => SidebarRowPropertyVisibility;
  readonly statusOrder: ReadonlyArray<SidebarThreadStatus>;
  readonly statusLabel: Readonly<Record<SidebarThreadStatus, string>>;
  readonly ThreadListViewGroup: (props: {
    readonly arrangement: SidebarThreadArrangement;
    readonly onChange: (arrangement: SidebarThreadArrangement) => void;
  }) => React.ReactNode;
}

const PROJECT_VIEW_LIFECYCLE_OPTIONS = [
  { id: "active", label: "Active" },
  { id: "archived", label: "Archived" },
  { id: "all", label: "All" },
] as const;
const PROJECT_VIEW_GROUPING_OPTIONS = [
  { id: "project", label: "Project" },
  { id: "environment", label: "Environment" },
  { id: "status", label: "Status" },
  { id: "none", label: "None" },
] as const;
const PROJECT_VIEW_SORTING_OPTIONS = [
  { id: "recency", label: "Recency" },
  { id: "alphabetical", label: "Alphabetical" },
  { id: "created", label: "Created time" },
  { id: "status", label: "Status" },
] as const;
const PROJECT_VIEW_ACTIVITY_OPTIONS = [
  { id: "all", label: "Any activity" },
  { id: "today", label: "Today" },
  { id: "3-days", label: "Last 3 days" },
  { id: "7-days", label: "Last 7 days" },
  { id: "14-days", label: "Last 14 days" },
  { id: "30-days", label: "Last 30 days" },
  { id: "custom", label: "Custom range" },
] as const;

const SIDEBAR_ROW_PROPERTY_VIEW_LABELS: Readonly<Record<SidebarRowPropertyView, string>> = {
  projects: "Shown on Projects rows",
  activity: "Shown on Activity rows",
};

/**
 * The Project view filter menu's items, loaded when the menu first opens
 * rather than with the sidebar.
 */
export function ProjectViewFilterMenuItems(props: {
  readonly kit: ProjectViewFilterKit;
  readonly activeCount: number;
  readonly environmentOptions: ReadonlyArray<ProjectViewEnvironment>;
  readonly filters: ProjectViewFilters;
  readonly onChange: (filters: ProjectViewFilters) => void;
  readonly onRangeOpen: () => void;
  readonly presentation: ProjectViewSwitcherPresentation;
  readonly onPresentationChange?: (presentation: ProjectViewSwitcherPresentation) => void;
  readonly arrangement?: SidebarThreadArrangement;
  readonly onArrangementChange?: (arrangement: SidebarThreadArrangement) => void;
  readonly onRowPropertiesChange: (properties: SidebarRowPropertyVisibility) => void;
  readonly rowProperties: SidebarRowPropertyVisibility;
  readonly rowPropertyView: SidebarRowPropertyView;
}) {
  const environmentSelection = props.filters.environmentIds;
  function update(change: Partial<ProjectViewFilters>): void {
    props.onChange({ ...props.filters, ...change });
  }

  function toggleEnvironment(id: string): void {
    if (environmentSelection.length === 0) {
      update({ environmentIds: [id] });
      return;
    }
    const next = environmentSelection.includes(id)
      ? environmentSelection.filter((candidate) => candidate !== id)
      : [...environmentSelection, id];
    update({ environmentIds: next });
  }
  return (
    <OctantMenuPortal>
      <OctantMenuPositioner align="end" className="outline-none window-no-drag" side="bottom">
        <OctantMenuPopup aria-label="Project view filters" className="min-w-[14rem]">
          {props.arrangement === undefined || props.onArrangementChange === undefined ? null : (
            <>
              <props.kit.ThreadListViewGroup
                arrangement={props.arrangement}
                onChange={props.onArrangementChange}
              />
              <OctantMenuSeparator />
            </>
          )}
          <OctantMenuGroup>
            <OctantMenuGroupLabel>Filters</OctantMenuGroupLabel>
            <FilterRadioSubmenu
              label="Lifecycle"
              onValueChange={(value) => {
                const option = PROJECT_VIEW_LIFECYCLE_OPTIONS.find(
                  (candidate) => candidate.id === value,
                );
                if (option !== undefined) update({ lifecycle: option.id });
              }}
              options={PROJECT_VIEW_LIFECYCLE_OPTIONS}
              value={props.filters.lifecycle}
            />
            <OctantMenuSub>
              <OctantMenuSubTrigger>Environment</OctantMenuSubTrigger>
              <OctantMenuSubPopup>
                <OctantMenuCheckboxItem
                  checked={environmentSelection.length === 0}
                  onCheckedChange={(checked) => {
                    if (checked) update({ environmentIds: [] });
                  }}
                >
                  All environments
                </OctantMenuCheckboxItem>
                {props.environmentOptions.map((option) => (
                  <OctantMenuCheckboxItem
                    checked={environmentSelection.includes(option.id)}
                    key={option.id}
                    onCheckedChange={() => toggleEnvironment(option.id)}
                  >
                    {option.name}
                  </OctantMenuCheckboxItem>
                ))}
              </OctantMenuSubPopup>
            </OctantMenuSub>
            <OctantMenuCheckboxItem
              checked={props.filters.showEmptyProjects}
              onCheckedChange={(checked) => update({ showEmptyProjects: checked })}
            >
              Show empty Projects
            </OctantMenuCheckboxItem>
          </OctantMenuGroup>
          <OctantMenuSeparator />
          <OctantMenuGroup>
            <FilterRadioSubmenu
              label="Group by"
              onValueChange={(value) => {
                const option = PROJECT_VIEW_GROUPING_OPTIONS.find(
                  (candidate) => candidate.id === value,
                );
                if (option !== undefined) update({ grouping: option.id });
              }}
              options={PROJECT_VIEW_GROUPING_OPTIONS}
              value={props.filters.grouping}
            />
            <FilterRadioSubmenu
              label="Sort by"
              onValueChange={(value) => {
                const option = PROJECT_VIEW_SORTING_OPTIONS.find(
                  (candidate) => candidate.id === value,
                );
                if (option !== undefined) update({ sorting: option.id });
              }}
              options={PROJECT_VIEW_SORTING_OPTIONS}
              value={props.filters.sorting}
            />
            {props.onPresentationChange === undefined ? null : (
              <FilterRadioSubmenu
                label="Show views as"
                onValueChange={(value) => {
                  const option = PROJECT_VIEW_PRESENTATION_OPTIONS.find(
                    (candidate) => candidate.id === value,
                  );
                  if (option !== undefined) props.onPresentationChange?.(option.id);
                }}
                options={PROJECT_VIEW_PRESENTATION_OPTIONS}
                value={props.presentation}
              />
            )}
          </OctantMenuGroup>
          <OctantMenuSeparator />
          <SidebarRowPropertyMenu
            kit={props.kit}
            onChange={props.onRowPropertiesChange}
            view={props.rowPropertyView}
            visibility={props.rowProperties}
          />
          <OctantMenuSeparator />
          <ProjectViewStatusMenu
            kit={props.kit}
            onChange={(statuses) => update({ statuses })}
            statuses={props.filters.statuses}
          />
          <OctantMenuSub>
            <OctantMenuSubTrigger>Activity</OctantMenuSubTrigger>
            <OctantMenuSubPopup>
              <OctantMenuRadioGroup
                onValueChange={(value) => {
                  const option = PROJECT_VIEW_ACTIVITY_OPTIONS.find(
                    (candidate) => candidate.id === value,
                  );
                  if (option !== undefined) update({ activity: option.id });
                }}
                value={props.filters.activity}
              >
                {PROJECT_VIEW_ACTIVITY_OPTIONS.map((option) => (
                  <OctantMenuRadioItem
                    closeOnClick
                    key={option.id}
                    value={option.id}
                    onClick={() => {
                      if (option.id === "custom") props.onRangeOpen();
                    }}
                  >
                    {option.label}
                  </OctantMenuRadioItem>
                ))}
              </OctantMenuRadioGroup>
            </OctantMenuSubPopup>
          </OctantMenuSub>
          {props.activeCount === 0 ? null : (
            <>
              <OctantMenuSeparator />
              <OctantMenuActionItem
                onClick={() => props.onChange(props.kit.normalizeFilters(undefined))}
              >
                Reset filters
              </OctantMenuActionItem>
            </>
          )}
        </OctantMenuPopup>
      </OctantMenuPositioner>
    </OctantMenuPortal>
  );
}

/**
 * Which properties the rows of the view you are looking at carry.
 *
 * The submenu edits one view at a time, the one on screen, and says which in
 * its own label: turning Pull request off in the Activity feed leaves the
 * Project tree exactly as it was.
 */
function SidebarRowPropertyMenu(props: {
  readonly kit: ProjectViewFilterKit;
  readonly onChange: (properties: SidebarRowPropertyVisibility) => void;
  readonly view: SidebarRowPropertyView;
  readonly visibility: SidebarRowPropertyVisibility;
}) {
  const supported = props.kit.rowPropertiesForView[props.view];
  const anyShown = supported.some((property) => props.visibility[property]);
  return (
    <OctantMenuSub>
      <OctantMenuSubTrigger>Property visibility</OctantMenuSubTrigger>
      <OctantMenuSubPopup>
        <OctantMenuGroup>
          <OctantMenuGroupLabel>
            {SIDEBAR_ROW_PROPERTY_VIEW_LABELS[props.view]}
          </OctantMenuGroupLabel>
          {supported.map((property) => (
            <OctantMenuCheckboxItem
              checked={props.visibility[property]}
              key={property}
              onCheckedChange={(checked) =>
                props.onChange({ ...props.visibility, [property]: checked })
              }
            >
              {props.kit.rowPropertyLabels[property]}
            </OctantMenuCheckboxItem>
          ))}
        </OctantMenuGroup>
        <OctantMenuSeparator />
        <OctantMenuActionItem
          closeOnClick={false}
          onClick={() => props.onChange(props.kit.rowPropertiesAll(props.view, !anyShown))}
        >
          {anyShown ? "Hide all" : "Show all"}
        </OctantMenuActionItem>
      </OctantMenuSubPopup>
    </OctantMenuSub>
  );
}

/**
 * Which thread statuses a saved view lists.
 *
 * Nothing ticked means no constraint rather than nothing shown, the same way
 * this menu's environment filter reads, so a reader who opens the submenu and
 * closes it again has not quietly emptied their sidebar. "Any status" is the
 * way back to that state without unticking each word.
 */
function ProjectViewStatusMenu(props: {
  readonly kit: ProjectViewFilterKit;
  readonly onChange: (statuses: ReadonlyArray<SidebarThreadStatus>) => void;
  readonly statuses: ReadonlyArray<SidebarThreadStatus> | undefined;
}) {
  const selected = props.statuses ?? [];
  return (
    <OctantMenuSub>
      <OctantMenuSubTrigger>Status</OctantMenuSubTrigger>
      <OctantMenuSubPopup>
        <OctantMenuGroup>
          <OctantMenuGroupLabel>Thread status</OctantMenuGroupLabel>
          {props.kit.statusOrder.map((status) => (
            <OctantMenuCheckboxItem
              checked={selected.includes(status)}
              key={status}
              onCheckedChange={(checked) =>
                props.onChange(
                  checked
                    ? props.kit.statusOrder.filter(
                        (candidate) => candidate === status || selected.includes(candidate),
                      )
                    : selected.filter((candidate) => candidate !== status),
                )
              }
            >
              {props.kit.statusLabel[status]}
            </OctantMenuCheckboxItem>
          ))}
        </OctantMenuGroup>
        <OctantMenuSeparator />
        <OctantMenuActionItem closeOnClick={false} onClick={() => props.onChange([])}>
          Any status
        </OctantMenuActionItem>
      </OctantMenuSubPopup>
    </OctantMenuSub>
  );
}

/** The same two choices Settings › Code offers for the Project view switcher. */
const PROJECT_VIEW_PRESENTATION_OPTIONS = [
  { id: "dropdown", label: "Dropdown" },
  { id: "inline", label: "Buttons" },
] as const satisfies ReadonlyArray<{
  readonly id: ProjectViewSwitcherPresentation;
  readonly label: string;
}>;

function FilterRadioSubmenu(props: {
  readonly label: string;
  readonly onValueChange: (value: string) => void;
  readonly options: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  readonly value: string;
}) {
  return (
    <OctantMenuSub>
      <OctantMenuSubTrigger>{props.label}</OctantMenuSubTrigger>
      <OctantMenuSubPopup>
        <OctantMenuRadioGroup
          onValueChange={(value) => {
            if (typeof value === "string") props.onValueChange(value);
          }}
          value={props.value}
        >
          {props.options.map((option) => (
            <OctantMenuRadioItem closeOnClick={false} key={option.id} value={option.id}>
              {option.label}
            </OctantMenuRadioItem>
          ))}
        </OctantMenuRadioGroup>
      </OctantMenuSubPopup>
    </OctantMenuSub>
  );
}
