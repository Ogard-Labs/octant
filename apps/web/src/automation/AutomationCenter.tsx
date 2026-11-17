import { OctantCollapsible } from "../ui/base/OctantCollapsible";
import { OctantEmpty } from "../ui/base/OctantEmpty";
import type {
  AutomationEventSourceChoice,
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationNotificationDeliveryQueryResponse,
  AutomationNotificationDeliveryReceipt,
  AutomationRun,
  AutomationSummary,
} from "@octant/contracts";
import type { AutomationClient, AutomationClientCommand } from "@octant/client-runtime";
import type { AutomationNotificationClient } from "@octant/client-runtime/automation-notification-client";
import { environmentLabel as sharedEnvironmentLabel } from "@octant/client-runtime/environment-selection";
import {
  arrangeItems,
  DEFAULT_LIST_ARRANGEMENT,
  LIST_GROUPING_LABELS,
  LIST_SORT_LABELS,
  LIST_STATUS_LABELS,
  matchesListStatus,
  type ArrangeableItem,
  type ListArrangement,
  type ListGrouping,
  type ListSort,
  type ListStatusFilter,
} from "@octant/client-runtime/list-arrangement";
import {
  CalendarClock,
  Ellipsis,
  FolderInput,
  History,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Webhook,
  type IconComponent,
} from "../ui/icons";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import {
  automationTotalsLine,
  nextRunCell,
  runStripCells,
  runStripSummary,
} from "./automationTable";
import { RoutineCalendar } from "./RoutineCalendar";
import { RoutineComposer } from "./RoutineComposer";
import { ROUTINE_REQUEST_SUGGESTIONS, type RoutineRequestDraft } from "./routineRequestDraft";
import { routineHasCompleted, routineScheduleLabel } from "./routinePresentation";
import { useEffect, useRef, useState } from "react";
import { FilterMenu, FilterMenuGroup } from "../surface/FilterMenu";
import { Surface, SurfaceHeader, SurfaceSection } from "../surface/SurfaceHeader";
import { OctantButton, octantButtonClassName } from "../ui/base/OctantButton";
import {
  OctantMenu,
  OctantMenuCheckboxItem,
  OctantMenuSeparator,
  OctantMenuRoot,
  OctantMenuTrigger,
  OctantMenuPortal,
  OctantMenuPositioner,
  OctantMenuPopup,
  OctantMenuItem,
} from "../ui/base/OctantMenu";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { AutomationFileSourceStatus } from "./AutomationFileSourceStatus";
import { AutomationEventSourceStatus } from "./AutomationEventSourceStatus";
import { routineFileSourceLabel } from "./routineFileSourcePresentation";
import { AutomationDefinitionEditor } from "./AutomationDefinitionEditor";
import {
  automationAuthoritySummary,
  automationBlockReasonLabel,
  automationLifecycleLabel,
  automationMissedRunPolicyLabel,
  automationModeLabel,
  automationNextRunLabel,
  automationRunResultLabel,
  automationRunStatusLabel,
  automationRunThreadTarget,
  automationTriggerSummary,
  formatAutomationInstant,
  type AutomationEditorCatalog,
  type AutomationFormatOptions,
  type AutomationThreadTarget,
} from "./automationCenterModel";
import {
  useAutomationCenterController,
  type AutomationCenterController,
  type AutomationCenterFilter,
} from "./useAutomationCenterController";
import { OctantAlert } from "../ui/base/OctantAlert";

/**
 * The shared Automation Center: one host-owned surface for Work and Code
 * automations. The default view is a compact scan path (search, mode filters,
 * rows, one primary create action); everything else lives behind row overflow
 * and detail disclosure. Waiting/failure/completion rows navigate to the
 * ordinary thread once a thread-creation receipt exists.
 */
export interface AutomationCenterProps {
  readonly client: AutomationClient;
  readonly catalog: AutomationEditorCatalog;
  readonly notificationClient?: AutomationNotificationClient;
  readonly onOpenThread?: (target: AutomationThreadTarget & { readonly title: string }) => void;
  readonly onClose?: () => void;
  /** Narrow layouts show one full-height detail view and preserve list state. */
  readonly narrow?: boolean;
  /** IANA timezone for display instants; defaults to the viewer's local zone. */
  readonly displayTimeZone?: string;
  /** Injectable strict-UTC clock for deterministic confirmation instants. */
  readonly now?: () => string;
  /** Injectable UUID source for command request identifiers. */
  readonly generateId?: () => string;
  /**
   * What each connected host is called, and which one is this machine. A
   * routine is owned and run by exactly one host, so a row that does not say
   * which is a row you cannot act on from the wrong machine.
   */
  readonly environmentNames?: ReadonlyMap<string, string>;
  readonly localHostId?: string;
  /** A routine to open when the center is shown, e.g. from a thread's Environment. */
  readonly focusAutomationId?: string;
}

type EditorState =
  | { readonly kind: "closed" }
  | { readonly kind: "create"; readonly requestDraft?: RoutineRequestDraft }
  | { readonly kind: "edit" };

const ACTIVE_RUN_LIFECYCLES = new Set([
  "queued",
  "dispatching",
  "recovering-dispatch",
  "running",
  "waiting",
]);

const STATUS_OPTIONS = (
  [
    "any",
    "active",
    "needs-attention",
    "finished",
  ] as const satisfies ReadonlyArray<ListStatusFilter>
).map((value) => ({ value, label: LIST_STATUS_LABELS[value] }));
const GROUPING_OPTIONS = (
  ["none", "environment", "project"] as const satisfies ReadonlyArray<ListGrouping>
).map((value) => ({ value, label: LIST_GROUPING_LABELS[value] }));
const SORT_OPTIONS = (["recent", "name"] as const satisfies ReadonlyArray<ListSort>).map(
  (value) => ({ value, label: LIST_SORT_LABELS[value] }),
);

const FILTERS: readonly { readonly value: AutomationCenterFilter; readonly label: string }[] = [
  { value: "all", label: "All" },
  { value: "chat", label: "Chat" },
  { value: "work", label: "Work" },
  { value: "code", label: "Code" },
];

export function AutomationCenter(props: AutomationCenterProps) {
  const controller = useAutomationCenterController({ client: props.client });
  const [editor, setEditor] = useState<EditorState>({ kind: "closed" });
  const [eventSources, setEventSources] = useState<ReadonlyArray<AutomationEventSourceChoice>>([]);
  useEffect(() => {
    if (editor.kind === "closed" || props.client.eventSources === undefined) return;
    const controller = new AbortController();
    void props.client
      .eventSources(controller.signal)
      .then((choices) => {
        if (!controller.signal.aborted) setEventSources(choices);
      })
      .catch(() => {
        if (!controller.signal.aborted) setEventSources([]);
      });
    return () => controller.abort();
  }, [editor.kind, props.client]);
  const [describeRequest, setDescribeRequest] = useState<string>();
  const [pendingFocusId, setPendingFocusId] = useState<string | undefined>(undefined);
  const [deliveryStatus, setDeliveryStatus] = useState<
    AutomationNotificationDeliveryQueryResponse["status"] | undefined
  >(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [view, setView] = useState<"list" | "calendar">("list");
  const [calendarMonth, setCalendarMonth] = useState<string | undefined>(undefined);
  const [arrangement, setArrangement] = useState<ListArrangement>(DEFAULT_LIST_ARRANGEMENT);
  const filterCount =
    (arrangement.status === DEFAULT_LIST_ARRANGEMENT.status ? 0 : 1) +
    (arrangement.grouping === DEFAULT_LIST_ARRANGEMENT.grouping ? 0 : 1) +
    (arrangement.sort === DEFAULT_LIST_ARRANGEMENT.sort ? 0 : 1) +
    (controller.filter === "all" ? 0 : 1) +
    (includeCompleted ? 1 : 0);
  const resetFilters = () => {
    setArrangement(DEFAULT_LIST_ARRANGEMENT);
    controller.setFilter("all");
    setIncludeCompleted(false);
  };
  const generateId = props.generateId ?? (() => crypto.randomUUID());
  const format: AutomationFormatOptions =
    props.displayTimeZone === undefined ? {} : { timeZone: props.displayTimeZone };
  // Read once per render rather than per row, so every row on a page agrees
  // about what "tomorrow" means.
  const nowInstant = (props.now ?? (() => new Date().toISOString()))();
  // One vocabulary for what an environment is called, shared with the sidebar
  // filter, so a row and the filter above it never disagree about a host's name.
  const environmentLabel = (hostId: string): string => {
    const named = props.environmentNames?.get(hostId);
    return sharedEnvironmentLabel({
      hostId,
      ...(named === undefined ? {} : { hostDisplayName: named }),
      ...(props.localHostId === undefined ? {} : { localHostId: props.localHostId }),
    });
  };

  const projectNames = new Map(
    props.catalog.projects.map((project) => [String(project.projectId), project.name]),
  );

  useEffect(() => {
    if (props.notificationClient === undefined) return;
    let cancelled = false;
    void props.notificationClient
      .status()
      .then((status) => {
        if (!cancelled) setDeliveryStatus(status);
      })
      .catch(() => {
        if (!cancelled) {
          setDeliveryStatus({
            preferences: {
              enabled: false,
              waiting: true,
              approvalNeeded: true,
              failure: true,
              completion: true,
              version: 0 as never,
              updatedAt: "1970-01-01T00:00:00.000Z" as never,
            },
            providerDelivery: "unavailable",
            registeredDestinationCount: 0,
            deliveryEnabled: false,
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.notificationClient]);

  useEffect(() => {
    if (pendingFocusId === undefined || controller.selectedId !== undefined) return;
    const row = listRef.current?.querySelector<HTMLButtonElement>(
      `[data-automation-row="${pendingFocusId}"]`,
    );
    row?.focus();
    setPendingFocusId(undefined);
  }, [pendingFocusId, controller.selectedId]);

  const detailOpen = controller.selectedId !== undefined || editor.kind !== "closed";
  const hideListForNarrow = props.narrow === true && detailOpen;

  async function runSummaryCommand(
    summary: AutomationSummary,
    command: AutomationClientCommand,
    successNotice: string,
  ) {
    await controller.execute(command, successNotice);
  }

  const { focusAutomationId } = props;
  const { select: selectAutomation } = controller;
  useEffect(() => {
    if (focusAutomationId !== undefined) selectAutomation(focusAutomationId);
  }, [focusAutomationId, selectAutomation]);

  function selectRow(automationId: string) {
    setEditor({ kind: "closed" });
    const summary =
      controller.list.status === "ready" || controller.list.status === "refreshing"
        ? controller.list.items.find((item) => String(item.id) === automationId)
        : undefined;
    controller.select(
      automationId,
      summary?.trigger.kind === "file-arrival" ? { fileSourceReview: true } : undefined,
    );
  }

  function backToList() {
    const focusId = controller.selectedId;
    setEditor({ kind: "closed" });
    controller.select(undefined);
    if (focusId !== undefined) setPendingFocusId(focusId);
  }

  async function submitEditor(draft: AutomationDefinitionDraft): Promise<string | undefined> {
    const command: AutomationClientCommand =
      editor.kind === "edit" && controller.detail.status === "ready"
        ? ({
            kind: "update-automation",
            automationId: controller.detail.automation.id,
            expectedVersion: controller.detail.automation.version,
            definition: draft,
          } as AutomationClientCommand)
        : ({
            kind: "create-automation",
            automationId: generateId(),
            expectedVersion: 0,
            definition: draft,
          } as unknown as AutomationClientCommand);
    const outcome = await controller.execute(
      command,
      editor.kind === "edit" ? "Automation updated." : "Automation created.",
    );
    if (outcome.kind === "automation-created" || outcome.kind === "automation-updated") {
      setEditor({ kind: "closed" });
      return undefined;
    }
    if (
      outcome.kind === "automation-command-failed" ||
      outcome.kind === "automation-transport-failed"
    ) {
      return outcome.message;
    }
    return "The automation was not saved.";
  }

  const listTotals =
    controller.list.status === "ready" || controller.list.status === "refreshing"
      ? controller.list.totals
      : undefined;
  return (
    <Surface ariaLabel="Automations" className="automation-center" measure="wide">
      <SurfaceHeader
        actions={
          <OctantMenu
            items={[
              {
                value: "describe",
                label: "Describe with Octant",
                description: "Start with the work and schedule in your own words.",
                icon: <Sparkles aria-hidden="true" size={14} />,
              },
              {
                value: "manual",
                label: "Create manually",
                description: "Configure the trigger, task, environment, and approval policy.",
                icon: <Pencil aria-hidden="true" size={14} />,
              },
            ]}
            onValueChange={(value) => {
              if (value === "describe") {
                setDescribeRequest("");
                return;
              }
              controller.select(undefined);
              setEditor({ kind: "create" });
            }}
            selectionMode="action"
            trigger={
              <>
                <Plus aria-hidden="true" size={12} />
                New automation
              </>
            }
            triggerClassName={octantButtonClassName({ variant: "default", size: "sm" })}
            triggerLabel="New automation"
            value=""
          />
        }
        title="Automations"
        {...(props.onClose === undefined ? {} : { onBack: props.onClose })}
      />

      {controller.notice === undefined ? null : (
        <div className="automation-center__notice" role="status">
          <span>{controller.notice}</span>
          <OctantButton onClick={controller.clearNotice} type="button" variant="ghost">
            Dismiss
          </OctantButton>
        </div>
      )}

      <div
        className="automation-center__body"
        data-detail-open={detailOpen ? "true" : "false"}
        data-narrow={props.narrow === true}
      >
        {hideListForNarrow ? null : (
          <div className="automation-center__list-pane">
            {describeRequest === undefined ? null : (
              <RoutineComposer
                initialRequest={describeRequest}
                key={describeRequest}
                now={nowInstant}
                onConfirm={(requestDraft) => {
                  controller.select(undefined);
                  setDescribeRequest(undefined);
                  setEditor({ kind: "create", requestDraft });
                }}
                timeZone={props.displayTimeZone ?? "UTC"}
              />
            )}

            {controller.list.status === "ready" &&
            controller.list.items.length === 0 &&
            describeRequest === undefined ? (
              <SurfaceSection label="Suggested automations">
                <div className="automation-center__suggestion-grid">
                  {ROUTINE_REQUEST_SUGGESTIONS.map((suggestion) => (
                    <OctantButton
                      className="automation-center__suggestion"
                      key={suggestion.label}
                      onClick={() => setDescribeRequest(suggestion.request)}
                      type="button"
                      variant="bare"
                    >
                      <strong>{suggestion.label}</strong>
                      <span>{suggestion.request}</span>
                    </OctantButton>
                  ))}
                </div>
              </SurfaceSection>
            ) : null}
            {controller.list.status === "ready" && controller.list.items.length === 0 ? null : (
              <div aria-label="Automation controls" className="surface-toolbar" role="group">
                <label className="surface-toolbar__search automation-center__search">
                  <span className="sr-only">Search automations</span>
                  <Search aria-hidden="true" size={14} />
                  <OctantInput
                    onChange={(event) => controller.setSearch(event.target.value)}
                    placeholder="Search automations"
                    type="search"
                    value={controller.search}
                  />
                </label>
                {listTotals === undefined ? null : (
                  <span className="oct-meta automation-center__totals">
                    {automationTotalsLine(listTotals)}
                  </span>
                )}
                <OctantToggleGroup<typeof view>
                  aria-label="Choose a view"
                  className="automation-center__views segmented"
                  onValueChange={(value) => {
                    const next = value[0];
                    if (next !== undefined) setView(next);
                  }}
                  value={[view]}
                >
                  <OctantToggleGroupItem className="automation-center__view segment" value="list">
                    List
                  </OctantToggleGroupItem>
                  <OctantToggleGroupItem
                    className="automation-center__view segment"
                    value="calendar"
                  >
                    Calendar
                  </OctantToggleGroupItem>
                </OctantToggleGroup>
                <FilterMenu count={filterCount} onReset={resetFilters}>
                  <FilterMenuGroup<ListStatusFilter>
                    label="Status"
                    onChange={(status) => setArrangement({ ...arrangement, status })}
                    options={STATUS_OPTIONS}
                    value={arrangement.status}
                  />
                  <FilterMenuGroup<ListGrouping>
                    label="Group"
                    onChange={(grouping) => setArrangement({ ...arrangement, grouping })}
                    options={GROUPING_OPTIONS}
                    separated
                    value={arrangement.grouping}
                  />
                  <FilterMenuGroup<ListSort>
                    label="Sort"
                    onChange={(sort) => setArrangement({ ...arrangement, sort })}
                    options={SORT_OPTIONS}
                    separated
                    value={arrangement.sort}
                  />
                  <FilterMenuGroup<AutomationCenterFilter>
                    label="Mode"
                    onChange={controller.setFilter}
                    options={FILTERS}
                    separated
                    value={controller.filter}
                  />
                  <OctantMenuSeparator />
                  <OctantMenuCheckboxItem
                    checked={includeCompleted}
                    closeOnClick={false}
                    label="Show completed"
                    onCheckedChange={setIncludeCompleted}
                  >
                    Show completed
                  </OctantMenuCheckboxItem>
                </FilterMenu>
              </div>
            )}

            {controller.list.status === "ready" &&
            controller.list.items.length === 0 ? null : view === "calendar" &&
              controller.list.status === "ready" ? (
              <RoutineCalendar
                month={calendarMonth ?? nowInstant}
                now={nowInstant}
                onMonthChange={setCalendarMonth}
                onSelect={selectRow}
                // The calendar draws what the list would draw: the same search,
                // the same filters, the same status, the same completed rows
                // hidden or shown. Two views of one set that disagreed about
                // which routines exist would be two answers to one question.
                routines={controller.list.items.filter(
                  (summary) =>
                    (includeCompleted ||
                      !routineHasCompleted(summary.trigger, summary.nextDueAt)) &&
                    matchesListStatus(arrangeableRoutine(summary, undefined), arrangement.status),
                )}
                timeZone={props.displayTimeZone ?? "UTC"}
              />
            ) : (
              <AutomationListBody
                arrangement={arrangement}
                controller={controller}
                format={format}
                listRef={listRef}
                onRunCommand={runSummaryCommand}
                onSelect={selectRow}
                projectNames={projectNames}
                environmentLabel={environmentLabel}
                {...(props.localHostId === undefined ? {} : { localHostId: props.localHostId })}
                now={nowInstant}
                includeCompleted={includeCompleted}
                generateId={generateId}
              />
            )}
          </div>
        )}

        {editor.kind === "create" ? (
          <div className="automation-center__detail-pane">
            <AutomationDefinitionEditor
              catalog={{ ...props.catalog, eventSources }}
              {...(editor.requestDraft === undefined
                ? {}
                : { initialRequestDraft: editor.requestDraft })}
              {...(props.localHostId === undefined ? {} : { localHostId: props.localHostId })}
              onCancel={() => setEditor({ kind: "closed" })}
              onSubmit={submitEditor}
              {...(props.now === undefined ? {} : { now: props.now })}
              {...(props.generateId === undefined ? {} : { generateId: props.generateId })}
            />
          </div>
        ) : editor.kind === "edit" && controller.detail.status === "ready" ? (
          <div className="automation-center__detail-pane">
            <AutomationDefinitionEditor
              catalog={{ ...props.catalog, eventSources }}
              {...(props.localHostId === undefined ? {} : { localHostId: props.localHostId })}
              initial={controller.detail.automation}
              onCancel={() => setEditor({ kind: "closed" })}
              onSubmit={submitEditor}
              {...(props.now === undefined ? {} : { now: props.now })}
              {...(props.generateId === undefined ? {} : { generateId: props.generateId })}
            />
          </div>
        ) : controller.selectedId === undefined ? null : (
          <div className="automation-center__detail-pane">
            <AutomationDetail
              controller={controller}
              format={format}
              generateId={generateId}
              narrow={props.narrow === true}
              onBack={backToList}
              onEdit={() => setEditor({ kind: "edit" })}
              {...(props.notificationClient === undefined
                ? {}
                : { notificationClient: props.notificationClient })}
              {...(props.onOpenThread === undefined ? {} : { onOpenThread: props.onOpenThread })}
              projectNames={projectNames}
            />
          </div>
        )}
      </div>
      {deliveryStatus === undefined ? null : (
        <p
          className="oct-meta automation-center__delivery"
          data-delivery-enabled={deliveryStatus.deliveryEnabled ? "true" : "false"}
          role="status"
        >
          {deliveryStatus.providerDelivery === "unavailable"
            ? "Notifications need push credentials. Add them to turn this on."
            : deliveryStatus.deliveryEnabled
              ? "Notification delivery is enabled for this host."
              : "Notification delivery is currently unavailable."}
        </p>
      )}
    </Surface>
  );
}

function AutomationListBody(props: {
  readonly controller: AutomationCenterController;
  readonly format: AutomationFormatOptions;
  readonly listRef: React.RefObject<HTMLDivElement | null>;
  readonly onRunCommand: (
    summary: AutomationSummary,
    command: AutomationClientCommand,
    successNotice: string,
  ) => Promise<void>;
  readonly onSelect: (automationId: string) => void;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly environmentLabel: (hostId: string) => string;
  readonly localHostId?: string;
  readonly arrangement: ListArrangement;
  readonly now: string;
  readonly includeCompleted: boolean;
  readonly generateId: () => string;
}) {
  const { controller } = props;
  const [switching, setSwitching] = useState<ReadonlySet<string>>(() => new Set());
  const switchRoutine = async (id: string, command: () => Promise<void>) => {
    setSwitching((current) => new Set([...current, id]));
    try {
      await command();
    } finally {
      setSwitching((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };
  if (controller.list.status === "loading") {
    return (
      <OctantEmpty
        eyebrow="Automations"
        message="Loading automations."
        state="loading"
        title="Loading"
      />
    );
  }
  if (controller.list.status === "unavailable") {
    return (
      <OctantEmpty
        action={{ label: "Retry", onClick: controller.retryList }}
        eyebrow="Automations"
        message={controller.list.message}
        role="alert"
        state="disconnected"
        title="Automations are unavailable"
      />
    );
  }
  const groups = arrangeRoutines({
    summaries: controller.list.items,
    arrangement: props.arrangement,
    includeCompleted: props.includeCompleted,
    projectNames: props.projectNames,
    environmentLabel: props.environmentLabel,
  });
  if (groups.length === 0) {
    return (
      <OctantEmpty
        layout="line"
        action={
          <OctantButton
            onClick={() => {
              controller.setFilter("all");
              controller.setSearch("");
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Clear filters
          </OctantButton>
        }
        detail="Clear or change the filters to see other automations."
        icon={<CalendarClock size={20} />}
        title="No automations match these filters"
      />
    );
  }
  return (
    <div
      aria-busy={controller.list.status === "refreshing"}
      className="automation-center__groups"
      ref={props.listRef}
    >
      {/* The column names, drawn once over every group. Each row says the
          same things in its own accessible name, so this line is for the eye. */}
      <div aria-hidden="true" className="automation-table__head">
        <span>Automation</span>
        <span>Last 7 runs</span>
        <span>Next run</span>
        <span>On</span>
        <span />
      </div>
      {groups.map((group) => (
        <section className="automation-center__group" key={group.heading}>
          {group.heading === "" ? null : (
            <h3 className="oct-section-label automation-center__group-heading">{group.heading}</h3>
          )}
          <ul
            aria-label={group.heading === "" ? "Automations" : `Automations in ${group.heading}`}
            className="automation-center__rows"
          >
            {group.items.map((summary) => {
              const KindIcon = triggerKindIcon(summary.trigger);
              const rowId = `automation-row-${String(summary.id)}`;
              const cells = runStripCells(summary.recentRuns);
              const next = nextRunCell(summary, props.now, props.format);
              const projectName = props.projectNames.get(String(summary.projectId)) ?? "Project";
              const sentence =
                summary.trigger.kind === "file-arrival"
                  ? `${routineFileSourceLabel(summary.fileSource)} · ${String(
                      summary.fileSource?.remainingStarts ?? summary.trigger.automaticStartLimit,
                    )} starts remaining`
                  : routineScheduleLabel(summary.trigger, props.format);
              return (
                <li
                  aria-label={summary.displayName}
                  className="automation-row"
                  data-lifecycle={summary.lifecycle}
                  key={String(summary.id)}
                >
                  <OctantButton
                    // Named for the routine alone; what it runs on, how its last
                    // runs went and when it runs next are its description, so a
                    // screen reader hears the name first and the rest after.
                    aria-describedby={`${rowId}-schedule ${rowId}-runs ${rowId}-next`}
                    aria-label={summary.displayName}
                    className="automation-row__open"
                    data-automation-row={String(summary.id)}
                    onClick={() => props.onSelect(String(summary.id))}
                    type="button"
                    variant="bare"
                  >
                    <span className="automation-row__routine">
                      <span aria-hidden="true" className="automation-row__kind">
                        <KindIcon size={16} />
                      </span>
                      <span className="automation-row__text">
                        <span className="automation-row__name">{summary.displayName}</span>
                        <span className="automation-row__schedule" id={`${rowId}-schedule`}>
                          {`${sentence} · ${projectName}`}
                          {String(summary.hostId) === props.localHostId ? null : (
                            // Only a routine that belongs somewhere else names its
                            // machine; naming every row's would make the machine you
                            // sit at look like one more remote environment.
                            <span className="automation-row__environment">
                              {` · ${props.environmentLabel(String(summary.hostId))}`}
                            </span>
                          )}
                        </span>
                      </span>
                    </span>
                    <span
                      aria-label={runStripSummary(summary.recentRuns)}
                      className="automation-row__runs"
                      id={`${rowId}-runs`}
                      role="img"
                    >
                      {cells.map((cell, index) => (
                        <span
                          className="automation-row__run"
                          data-tone={cell.tone}
                          // The cells have no identity beyond their place.
                          // oxlint-disable-next-line react/no-array-index-key
                          key={index}
                          {...(cell.lifecycle === undefined || cell.at === undefined
                            ? {}
                            : {
                                title: `${automationRunStatusLabel(cell.lifecycle)} · ${formatAutomationInstant(cell.at, props.format)}`,
                              })}
                        />
                      ))}
                    </span>
                    <span
                      className="automation-row__next"
                      data-tone={next.tone}
                      id={`${rowId}-next`}
                    >
                      <span className="automation-row__next-primary">{next.primary}</span>
                      <span className="automation-row__next-secondary">{next.secondary ?? ""}</span>
                    </span>
                  </OctantButton>
                  <span className="automation-row__toggle">
                    {/* Only a routine that is on or paused can be switched: a
                        finished one-time routine or an archived one has
                        nothing to resume, and a stray click must not re-arm
                        it. The switch rests while its command is in flight, so
                        a quick second press cannot send a stale version. */}
                    {summary.lifecycle !== "enabled" && summary.lifecycle !== "paused" ? null : (
                      <OctantSwitch
                        checked={summary.lifecycle === "enabled"}
                        disabled={switching.has(String(summary.id))}
                        label={`${summary.displayName} on`}
                        onCheckedChange={(on) =>
                          void switchRoutine(String(summary.id), () =>
                            props.onRunCommand(
                              summary,
                              on
                                ? {
                                    kind: "resume-automation",
                                    automationId: summary.id,
                                    expectedVersion: summary.version,
                                  }
                                : {
                                    kind: "pause-automation",
                                    automationId: summary.id,
                                    expectedVersion: summary.version,
                                  },
                              on ? "Automation resumed." : "Automation paused.",
                            ),
                          )
                        }
                      />
                    )}
                  </span>
                  <div className="automation-row__menu-wrap">
                    <OctantMenuRoot>
                      <OctantMenuTrigger
                        aria-label={`Actions for ${summary.displayName}`}
                        className="automation-row__menu-toggle"
                      >
                        <Ellipsis aria-hidden="true" size={16} />
                      </OctantMenuTrigger>
                      <OctantMenuPortal>
                        <OctantMenuPositioner align="end">
                          <OctantMenuPopup aria-label={`Actions for ${summary.displayName}`}>
                            <OctantMenuItem onClick={() => props.onSelect(String(summary.id))}>
                              Open details
                            </OctantMenuItem>
                            {summary.lifecycle === "archived" ? null : (
                              <>
                                <OctantMenuItem
                                  onClick={() =>
                                    void props.onRunCommand(
                                      summary,
                                      {
                                        kind: "run-now-automation",
                                        automationId: summary.id,
                                        expectedVersion: summary.version,
                                        runNowRequestId: props.generateId(),
                                      } as unknown as AutomationClientCommand,
                                      "Run requested.",
                                    )
                                  }
                                >
                                  Run now
                                </OctantMenuItem>
                                <OctantMenuSeparator />
                                <OctantMenuItem
                                  destructive
                                  onClick={() =>
                                    void props.onRunCommand(
                                      summary,
                                      {
                                        kind: "archive-automation",
                                        automationId: summary.id,
                                        expectedVersion: summary.version,
                                      },
                                      "Automation archived.",
                                    )
                                  }
                                >
                                  Archive
                                </OctantMenuItem>
                              </>
                            )}
                          </OctantMenuPopup>
                        </OctantMenuPositioner>
                      </OctantMenuPortal>
                    </OctantMenuRoot>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * The routines a list shows, arranged.
 *
 * The include-completed toggle runs first because it answers a different
 * question from the status filter: one is about a one-time routine whose day
 * has passed, the other about how a routine is doing.
 */
function arrangeRoutines(input: {
  readonly summaries: ReadonlyArray<AutomationSummary>;
  readonly arrangement: ListArrangement;
  readonly includeCompleted: boolean;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly environmentLabel: (hostId: string) => string;
}): ReadonlyArray<{
  readonly heading: string;
  readonly items: ReadonlyArray<AutomationSummary>;
}> {
  const visible = input.summaries.filter(
    (summary) => input.includeCompleted || !routineHasCompleted(summary.trigger, summary.nextDueAt),
  );
  const byId = new Map(visible.map((summary) => [String(summary.id), summary]));
  const arranged = arrangeItems(
    visible.map((summary) =>
      arrangeableRoutine(summary, input.projectNames.get(String(summary.projectId))),
    ),
    input.arrangement,
    { environmentLabel: input.environmentLabel },
  );
  return arranged.map((group) => ({
    heading: group.heading,
    items: group.items.flatMap((item) => {
      const summary = byId.get(item.id);
      return summary === undefined ? [] : [summary];
    }),
  }));
}

/**
 * One routine as an arranging view sees it.
 *
 * Shared by the list and the calendar so the status filter means the same
 * thing in both. Two views of one set that disagreed about which routines
 * exist would be two answers to one question.
 */
function arrangeableRoutine(
  summary: AutomationSummary,
  projectName: string | undefined,
): ArrangeableItem {
  return {
    id: String(summary.id),
    hostId: String(summary.hostId),
    name: summary.displayName,
    status: routineListStatus(summary),
    ...(projectName === undefined ? {} : { groupName: projectName }),
    updatedAt: summary.updatedAt,
  };
}

/**
 * What a routine's row says about how it is doing.
 *
 * A failed last run outranks being enabled: "this is on" is not the useful
 * sentence when the last thing it did went wrong.
 */
function routineListStatus(summary: AutomationSummary): "active" | "needs-attention" | "finished" {
  if (
    summary.trigger.kind === "file-arrival" &&
    (summary.fileSource?.phase === "held" ||
      summary.fileSource?.phase === "unavailable" ||
      (summary.fileSource?.phase === "needs-rearm" &&
        summary.fileSource.reason !== "known-activity"))
  )
    return "needs-attention";
  if (summary.latestRunLifecycle === "failed" || summary.latestRunLifecycle === "interrupted") {
    return "needs-attention";
  }
  return summary.lifecycle === "enabled" ? "active" : "finished";
}

function AutomationDetail(props: {
  readonly controller: AutomationCenterController;
  readonly format: AutomationFormatOptions;
  readonly generateId: () => string;
  readonly narrow: boolean;
  readonly notificationClient?: AutomationNotificationClient;
  readonly onBack: () => void;
  readonly onEdit: () => void;
  readonly onOpenThread?: (target: AutomationThreadTarget & { readonly title: string }) => void;
  readonly projectNames: ReadonlyMap<string, string>;
}) {
  const { controller } = props;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const detailReady = controller.detail.status === "ready";

  useEffect(() => {
    if (props.narrow && detailReady) headingRef.current?.focus();
  }, [props.narrow, detailReady]);

  if (controller.detail.status === "loading" || controller.detail.status === "idle") {
    return (
      <OctantEmpty
        eyebrow="Automations"
        message="Loading the automation."
        state="loading"
        title="Loading"
      />
    );
  }
  if (controller.detail.status === "unavailable") {
    return (
      <OctantEmpty
        action={{ label: "Retry", onClick: controller.retryDetail }}
        eyebrow="Automations"
        message={controller.detail.message}
        role="alert"
        state="disconnected"
        title="This automation is unavailable"
      />
    );
  }

  const automation = controller.detail.automation;
  const runs = controller.detail.runs;
  const latestRun = runs[0];
  const activeRun = runs.find((run) => ACTIVE_RUN_LIFECYCLES.has(run.lifecycle));

  return (
    <section aria-label="Automation details" className="automation-detail">
      <header className="automation-detail__header">
        <h3 className="automation-detail__title" ref={headingRef} tabIndex={-1}>
          {automation.displayName}
        </h3>
        {props.narrow ? (
          <OctantButton onClick={props.onBack} type="button" variant="secondary">
            Back to list
          </OctantButton>
        ) : (
          <OctantButton onClick={props.onBack} type="button" variant="ghost">
            Close details
          </OctantButton>
        )}
      </header>

      <p className="automation-detail__state">
        <span data-lifecycle={automation.lifecycle}>
          {automationLifecycleLabel(automation.lifecycle)}
        </span>
        <span>
          {automation.trigger.kind === "file-arrival"
            ? "Runs on settled file changes"
            : automation.nextDueAt === null
              ? "Not scheduled"
              : `Next run: ${automationNextRunLabel(automation.nextDueAt, props.format)}`}
        </span>
      </p>
      {automation.blockedReason === undefined ? null : (
        <p className="automation-detail__blocked" role="status">
          {automationBlockReasonLabel(automation.blockedReason)}
        </p>
      )}

      <div className="automation-detail__actions">
        <OctantButton onClick={props.onEdit} type="button" variant="secondary">
          Edit
        </OctantButton>
        {automation.lifecycle === "enabled" ? (
          <OctantButton
            onClick={() =>
              void controller.execute(
                {
                  kind: "pause-automation",
                  automationId: automation.id,
                  expectedVersion: automation.version,
                },
                "Automation paused.",
              )
            }
            type="button"
            variant="secondary"
          >
            Pause
          </OctantButton>
        ) : automation.lifecycle === "paused" ? (
          <OctantButton
            onClick={() =>
              void controller.execute(
                {
                  kind: "resume-automation",
                  automationId: automation.id,
                  expectedVersion: automation.version,
                },
                "Automation resumed.",
              )
            }
            type="button"
            variant="secondary"
          >
            Resume
          </OctantButton>
        ) : null}
        {automation.lifecycle === "archived" ? null : (
          <>
            <OctantButton
              onClick={() =>
                void controller.execute(
                  {
                    kind: "run-now-automation",
                    automationId: automation.id,
                    expectedVersion: automation.version,
                    runNowRequestId: props.generateId(),
                  } as unknown as AutomationClientCommand,
                  "Run requested.",
                )
              }
              type="button"
              variant="secondary"
            >
              Run now
            </OctantButton>
            <OctantButton
              onClick={() =>
                void controller.execute(
                  {
                    kind: "archive-automation",
                    automationId: automation.id,
                    expectedVersion: automation.version,
                  },
                  "Automation archived.",
                )
              }
              type="button"
              variant="secondary"
            >
              Archive
            </OctantButton>
          </>
        )}
        {activeRun === undefined ? null : (
          <OctantButton
            onClick={() =>
              void controller.execute(
                {
                  kind: "cancel-current-automation-run",
                  automationId: automation.id,
                  expectedVersion: automation.version,
                  runId: activeRun.id,
                  cancelRunRequestId: props.generateId(),
                  expectedRunVersion: activeRun.version,
                } as unknown as AutomationClientCommand,
                "Run cancellation requested.",
              )
            }
            type="button"
            variant="secondary"
          >
            Cancel current run
          </OctantButton>
        )}
      </div>

      {automation.trigger.kind === "file-arrival" ? (
        <AutomationFileSourceStatus
          automation={automation}
          source={controller.detail.fileSource}
          execute={controller.execute}
          refresh={controller.retryDetail}
        />
      ) : null}

      {automation.trigger.kind === "integration-event" ? (
        <AutomationEventSourceStatus
          automation={automation}
          source={controller.detail.eventSource}
          execute={controller.execute}
          refresh={controller.retryDetail}
        />
      ) : null}

      <dl className="automation-detail__facts">
        <div>
          <dt>Schedule</dt>
          <dd>{automationTriggerSummary(automation.trigger, props.format)}</dd>
        </div>
        <div>
          <dt>Host</dt>
          <dd>{String(automation.hostId)}</dd>
        </div>
        <div>
          <dt>Project</dt>
          <dd>{props.projectNames.get(String(automation.projectId)) ?? "Project"}</dd>
        </div>
        <div>
          <dt>Mode</dt>
          <dd>{automationModeLabel(automation.mode)}</dd>
        </div>
        <div>
          <dt>Execution profile</dt>
          <dd>{`${String(automation.executionProfile.modelId)} · ${automation.executionProfile.executionPolicy}`}</dd>
        </div>
        <div>
          <dt>Delivery target</dt>
          <dd>
            {automation.deliveryTarget.summary}
            <span className="automation-detail__confirmed">
              {` Confirmed ${formatAutomationInstant(
                automation.deliveryTarget.confirmedAt,
                props.format,
              )}`}
            </span>
          </dd>
        </div>
        {latestRun === undefined ? null : (
          <div>
            <dt>Latest run</dt>
            <dd>
              {`${automationRunStatusLabel(latestRun.lifecycle)} · ${formatAutomationInstant(
                latestRun.claimedAt,
                props.format,
              )}`}
              {latestRun.reportedResult === undefined
                ? null
                : ` · ${automationRunResultLabel(latestRun.reportedResult.outcome)}`}
              <ThreadLink
                automationName={automation.displayName}
                {...(props.onOpenThread === undefined ? {} : { onOpenThread: props.onOpenThread })}
                run={latestRun}
              />
            </dd>
          </div>
        )}
      </dl>

      <OctantCollapsible
        chevron="end"
        className="automation-detail__advanced"
        summary={<span>Advanced</span>}
      >
        <dl className="automation-detail__facts">
          <div>
            <dt>Authority</dt>
            <dd>{automationAuthoritySummary(automation.authorityProfile)}</dd>
          </div>
          <div>
            <dt>Missed runs</dt>
            <dd>{automationMissedRunPolicyLabel(automation.missedRunPolicy)}</dd>
          </div>
          <div>
            <dt>Definition revision</dt>
            <dd>{String(automation.definitionRevision)}</dd>
          </div>
        </dl>
      </OctantCollapsible>

      <OctantCollapsible
        chevron="end"
        className="automation-detail__history"
        onToggle={(event) => {
          if (event.currentTarget.open && controller.history.status === "collapsed") {
            void controller.expandHistory();
          }
        }}
        summary={<span>Run history</span>}
      >
        <AutomationHistoryBody
          automation={automation}
          automationName={automation.displayName}
          controller={controller}
          generateId={props.generateId}
          format={props.format}
          {...(props.notificationClient === undefined
            ? {}
            : { notificationClient: props.notificationClient })}
          {...(props.onOpenThread === undefined ? {} : { onOpenThread: props.onOpenThread })}
        />
      </OctantCollapsible>
    </section>
  );
}

function AutomationHistoryBody(props: {
  readonly automation: AutomationDefinition;
  readonly automationName: string;
  readonly controller: AutomationCenterController;
  readonly format: AutomationFormatOptions;
  readonly generateId: () => string;
  readonly notificationClient?: AutomationNotificationClient;
  readonly onOpenThread?: (target: AutomationThreadTarget & { readonly title: string }) => void;
}) {
  const { controller } = props;
  const [receiptsByRun, setReceiptsByRun] = useState<
    ReadonlyMap<string, ReadonlyArray<AutomationNotificationDeliveryReceipt>>
  >(new Map());

  useEffect(() => {
    if (props.notificationClient === undefined) return;
    if (controller.history.status !== "ready") return;
    let cancelled = false;
    void props.notificationClient
      .deliveries({
        automationId: String(props.automation.id),
        projectId: String(props.automation.projectId),
      })
      .then((query) => {
        if (cancelled) return;
        const next = new Map<string, AutomationNotificationDeliveryReceipt[]>();
        for (const receipt of query.receipts) {
          const key = String(receipt.runId);
          const existing = next.get(key) ?? [];
          existing.push(receipt);
          next.set(key, existing);
        }
        setReceiptsByRun(next);
      })
      .catch(() => {
        if (!cancelled) setReceiptsByRun(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [
    controller.history.status,
    props.automation.id,
    props.automation.projectId,
    props.notificationClient,
  ]);

  if (controller.history.status === "collapsed" || controller.history.status === "loading") {
    return <p role="status">Loading run history…</p>;
  }
  if (controller.history.status === "unavailable") {
    return (
      <OctantAlert tone="warning">
        <p>{controller.history.message}</p>
        <OctantButton
          onClick={() => void controller.expandHistory()}
          type="button"
          variant="secondary"
        >
          Retry history
        </OctantButton>
      </OctantAlert>
    );
  }
  if (controller.history.runs.length === 0) {
    return <p role="status">This automation has not run yet.</p>;
  }
  return (
    <>
      <ul aria-label="Run history" className="automation-history">
        {controller.history.runs.map((run) => {
          const delivery = receiptsByRun.get(String(run.id))?.[0];
          return (
            <li className="automation-history__entry" key={String(run.id)}>
              <span className="automation-history__status" data-run-lifecycle={run.lifecycle}>
                {automationRunStatusLabel(run.lifecycle)}
              </span>
              <span className="automation-history__time">
                {formatAutomationInstant(run.claimedAt, props.format)}
              </span>
              <span className="automation-history__occurrence">
                {run.occurrence.kind === "manual"
                  ? run.occurrence.retryOfRunId === undefined
                    ? "Manual run"
                    : "Retry"
                  : run.occurrence.kind === "file-arrival"
                    ? "File arrival"
                    : "Scheduled run"}
              </span>
              {run.failure === undefined ? null : (
                <span className="automation-history__failure">{run.failure.message}</span>
              )}
              {run.reportedResult === undefined ? null : (
                <span
                  className="automation-history__result"
                  data-run-result={run.reportedResult.outcome}
                >
                  {`${automationRunResultLabel(run.reportedResult.outcome)}. ${run.reportedResult.summary}`}
                </span>
              )}
              {delivery === undefined ? null : (
                <span
                  className="automation-history__delivery"
                  data-delivery-outcome={delivery.outcome}
                >
                  Notification: {deliveryOutcomeLabel(delivery)}
                </span>
              )}
              <ThreadLink
                automationName={props.automationName}
                {...(props.onOpenThread === undefined ? {} : { onOpenThread: props.onOpenThread })}
                run={run}
              />
              {props.automation.lifecycle === "enabled" &&
              props.automation.targetPolicy === "new-thread" &&
              ["failed", "interrupted", "cancelled"].includes(run.lifecycle) &&
              run.definitionSnapshot.definitionRevision === props.automation.definitionRevision ? (
                <OctantButton
                  type="button"
                  variant="secondary"
                  onClick={() =>
                    void controller.execute(
                      {
                        kind: "run-now-automation",
                        automationId: props.automation.id,
                        expectedVersion: props.automation.version,
                        retryRunId: run.id,
                        runNowRequestId: props.generateId(),
                      } as AutomationClientCommand,
                      "Retry requested as a new run.",
                    )
                  }
                >
                  Retry run
                </OctantButton>
              ) : null}
            </li>
          );
        })}
      </ul>
      {controller.history.nextCursor === undefined ? null : (
        <OctantButton
          disabled={controller.history.loadingMore}
          onClick={() => void controller.loadMoreHistory()}
          type="button"
          variant="secondary"
        >
          Load more runs
        </OctantButton>
      )}
    </>
  );
}

function deliveryOutcomeLabel(receipt: AutomationNotificationDeliveryReceipt): string {
  if (receipt.outcome === "delivered") return "delivered";
  if (receipt.outcome === "failed" || receipt.outcome === "exhausted") {
    return receipt.failureCategory === "provider-unavailable"
      ? "unavailable (credentials)"
      : receipt.outcome;
  }
  if (receipt.outcome.startsWith("skipped-"))
    return receipt.outcome.replace("skipped-", "skipped ");
  return receipt.outcome;
}

function ThreadLink(props: {
  readonly automationName: string;
  readonly onOpenThread?: (target: AutomationThreadTarget & { readonly title: string }) => void;
  readonly run: AutomationRun;
}) {
  const target = automationRunThreadTarget(props.run);
  if (target === undefined || props.onOpenThread === undefined) return null;
  const openThread = props.onOpenThread;
  return (
    <OctantButton
      className="automation-history__thread"
      onClick={() => openThread({ ...target, title: props.automationName })}
      type="button"
      variant="ghost"
    >
      Open thread
    </OctantButton>
  );
}

export type { AutomationDefinition };

/** What starts the routine, as the mark leading its row: a time, an event, or files. */
function triggerKindIcon(trigger: AutomationSummary["trigger"]): IconComponent {
  if (trigger.kind === "integration-event") return Webhook;
  if (trigger.kind === "file-arrival") return FolderInput;
  return trigger.kind === "once" ? CalendarClock : History;
}
