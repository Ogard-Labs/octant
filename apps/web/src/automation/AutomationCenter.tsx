import type {
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
  matchesListStatus,
  type ArrangeableItem,
  type ListArrangement,
} from "@octant/client-runtime/list-arrangement";
import { ChevronDown, Plus, Search } from "lucide-react";
import { RoutineCalendar } from "./RoutineCalendar";
import { RoutineComposer } from "./RoutineComposer";
import {
  routineCadence,
  routineCadenceLabel,
  routineHasCompleted,
  routineScheduleLine,
} from "./routinePresentation";
import { useEffect, useRef, useState } from "react";
import { ShellState } from "../shell/ShellState";
import { ListArrangementMenu } from "../shell/ListArrangementMenu";
import { OctantButton } from "../ui/base/OctantButton";
import { AutomationDefinitionEditor } from "./AutomationDefinitionEditor";
import {
  automationAuthoritySummary,
  automationBlockReasonLabel,
  automationLifecycleLabel,
  automationMissedRunPolicyLabel,
  automationModeLabel,
  automationNextRunLabel,
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
}

type EditorState =
  | { readonly kind: "closed" }
  | { readonly kind: "create" }
  | { readonly kind: "edit" };

const ACTIVE_RUN_LIFECYCLES = new Set([
  "queued",
  "dispatching",
  "recovering-dispatch",
  "running",
  "waiting",
]);

const FILTERS: readonly { readonly value: AutomationCenterFilter; readonly label: string }[] = [
  { value: "all", label: "All" },
  { value: "work", label: "Work" },
  { value: "code", label: "Code" },
];

export function AutomationCenter(props: AutomationCenterProps) {
  const controller = useAutomationCenterController({ client: props.client });
  const [editor, setEditor] = useState<EditorState>({ kind: "closed" });
  const [openMenuId, setOpenMenuId] = useState<string | undefined>(undefined);
  const [pendingFocusId, setPendingFocusId] = useState<string | undefined>(undefined);
  const [deliveryStatus, setDeliveryStatus] = useState<
    AutomationNotificationDeliveryQueryResponse["status"] | undefined
  >(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const [includeCompleted, setIncludeCompleted] = useState(false);
  const [view, setView] = useState<"list" | "calendar">("list");
  const [calendarMonth, setCalendarMonth] = useState<string | undefined>(undefined);
  const [arrangement, setArrangement] = useState<ListArrangement>(DEFAULT_LIST_ARRANGEMENT);
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
    setOpenMenuId(undefined);
    await controller.execute(command, successNotice);
  }

  function selectRow(automationId: string) {
    setEditor({ kind: "closed" });
    controller.select(automationId);
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

  return (
    <section
      aria-label="Automation Center"
      className="automation-center"
      data-narrow={props.narrow === true}
    >
      <header className="automation-center__header">
        <div>
          <h2 className="automation-center__title">Automation Center</h2>
          <p className="automation-center__subtitle">
            Scheduled Work and Code work that runs as ordinary threads.
          </p>
        </div>
        {props.onClose === undefined ? null : (
          <OctantButton onClick={props.onClose} type="button" variant="secondary">
            Back to workspace
          </OctantButton>
        )}
      </header>

      {controller.notice === undefined ? null : (
        <div className="automation-center__notice" role="status">
          <span>{controller.notice}</span>
          <OctantButton onClick={controller.clearNotice} type="button" variant="ghost">
            Dismiss
          </OctantButton>
        </div>
      )}

      {deliveryStatus === undefined ? null : (
        <p
          className="automation-center__notice"
          data-delivery-enabled={deliveryStatus.deliveryEnabled ? "true" : "false"}
          role="status"
        >
          {deliveryStatus.providerDelivery === "unavailable"
            ? "Notification delivery is unavailable until APNs/FCM credentials are configured."
            : deliveryStatus.deliveryEnabled
              ? "Notification delivery is enabled for this host."
              : "Notification delivery is currently unavailable."}
        </p>
      )}

      <div className="automation-center__body">
        {hideListForNarrow ? null : (
          <div className="automation-center__list-pane">
            <RoutineComposer
              now={nowInstant}
              onConfirm={() => {
                // The draft opens the ordinary editor, which is where a
                // routine is checked and saved. The composer proposes; it
                // never creates.
                controller.select(undefined);
                setEditor({ kind: "create" });
              }}
              timeZone={props.displayTimeZone ?? "UTC"}
            />
            <div
              aria-label="Automation controls"
              className="automation-center__toolbar"
              role="group"
            >
              <label className="automation-center__search">
                <span className="sr-only">Search automations</span>
                <Search aria-hidden="true" size={14} strokeWidth={1.8} />
                <input
                  onChange={(event) => controller.setSearch(event.target.value)}
                  placeholder="Search automations"
                  type="search"
                  value={controller.search}
                />
              </label>
              <ListArrangementMenu arrangement={arrangement} onChange={setArrangement} />
              <fieldset className="automation-center__views">
                <legend className="sr-only">Choose a view</legend>
                {(["list", "calendar"] as const).map((candidate) => (
                  <label className="automation-center__view" key={candidate}>
                    <input
                      checked={view === candidate}
                      name="automation-center-view"
                      onChange={() => setView(candidate)}
                      type="radio"
                      value={candidate}
                    />
                    <span>{candidate === "list" ? "List" : "Calendar"}</span>
                  </label>
                ))}
              </fieldset>
              <label className="automation-center__completed">
                <input
                  checked={includeCompleted}
                  onChange={(event) => setIncludeCompleted(event.target.checked)}
                  type="checkbox"
                />
                <span>Show completed</span>
              </label>
              <fieldset className="automation-center__filters">
                <legend className="sr-only">Filter by mode</legend>
                {FILTERS.map((filter) => (
                  <label className="automation-center__filter" key={filter.value}>
                    <input
                      checked={controller.filter === filter.value}
                      name="automation-center-filter"
                      onChange={() => controller.setFilter(filter.value)}
                      type="radio"
                      value={filter.value}
                    />
                    <span>{filter.label}</span>
                  </label>
                ))}
              </fieldset>
              <OctantButton
                className="automation-center__create"
                onClick={() => {
                  controller.select(undefined);
                  setEditor({ kind: "create" });
                }}
                type="button"
                variant="default"
              >
                <Plus aria-hidden="true" size={14} strokeWidth={1.8} />
                <span>New automation</span>
              </OctantButton>
            </div>

            {view === "calendar" && controller.list.status === "ready" ? (
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
                openMenuId={openMenuId}
                projectNames={projectNames}
                environmentLabel={environmentLabel}
                {...(props.localHostId === undefined ? {} : { localHostId: props.localHostId })}
                now={nowInstant}
                includeCompleted={includeCompleted}
                generateId={generateId}
                setOpenMenuId={setOpenMenuId}
              />
            )}
          </div>
        )}

        {editor.kind === "create" ? (
          <div className="automation-center__detail-pane">
            <AutomationDefinitionEditor
              catalog={props.catalog}
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
              catalog={props.catalog}
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
    </section>
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
  readonly openMenuId: string | undefined;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly environmentLabel: (hostId: string) => string;
  readonly localHostId?: string;
  readonly arrangement: ListArrangement;
  readonly now: string;
  readonly includeCompleted: boolean;
  readonly generateId: () => string;
  readonly setOpenMenuId: (automationId: string | undefined) => void;
}) {
  const { controller } = props;
  if (controller.list.status === "loading") {
    return (
      <ShellState
        eyebrow="Automation Center"
        message="Loading automations."
        state="loading"
        title="Loading"
      />
    );
  }
  if (controller.list.status === "unavailable") {
    return (
      <ShellState
        action={{ label: "Retry", onClick: controller.retryList }}
        eyebrow="Automation Center"
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
      <div className="automation-center__empty" role="status">
        <p>No automations match the current filters.</p>
        <p>Nothing was deleted; adjust the filters or create a new automation.</p>
      </div>
    );
  }
  return (
    <div className="automation-center__groups" ref={props.listRef}>
      {groups.map((group) => (
        <section className="automation-center__group" key={group.heading}>
          {group.heading === "" ? null : (
            <h3 className="automation-center__group-heading">{group.heading}</h3>
          )}
          <ul
            aria-label={group.heading === "" ? "Automations" : `Automations in ${group.heading}`}
            className="automation-center__rows"
          >
            {group.items.map((summary) => (
              <li
                aria-label={summary.displayName}
                className="automation-row"
                key={String(summary.id)}
              >
                <button
                  className="automation-row__open"
                  data-automation-row={String(summary.id)}
                  onClick={() => props.onSelect(String(summary.id))}
                  type="button"
                >
                  <span className="automation-row__name">{summary.displayName}</span>
                </button>
                <div className="automation-row__meta">
                  <span className="automation-row__project">
                    {props.projectNames.get(String(summary.projectId)) ?? "Project"}
                  </span>
                  <span className="automation-row__mode">{automationModeLabel(summary.mode)}</span>
                  <span className="automation-row__schedule">
                    {routineScheduleLine(
                      summary.trigger,
                      summary.nextDueAt,
                      props.now,
                      props.format,
                    )}
                  </span>
                  <span
                    className="automation-row__cadence"
                    data-cadence={routineCadence(summary.trigger)}
                  >
                    {routineCadenceLabel(routineCadence(summary.trigger))}
                  </span>
                  {String(summary.hostId) === props.localHostId ? null : (
                    // Only a routine that belongs somewhere else is badged. Badging
                    // every row would make the machine you are sitting at look like
                    // one more remote environment.
                    <span className="automation-row__environment">
                      {props.environmentLabel(String(summary.hostId))}
                    </span>
                  )}
                  <span className="automation-row__state" data-lifecycle={summary.lifecycle}>
                    {automationLifecycleLabel(summary.lifecycle)}
                  </span>
                  {summary.latestRunLifecycle === undefined ? null : (
                    <span
                      className="automation-row__status"
                      data-run-lifecycle={summary.latestRunLifecycle}
                    >
                      {`Last run: ${automationRunStatusLabel(summary.latestRunLifecycle)}`}
                    </span>
                  )}
                </div>
                <div className="automation-row__menu-wrap">
                  <OctantButton
                    aria-expanded={props.openMenuId === String(summary.id)}
                    aria-haspopup="true"
                    aria-label={`Actions for ${summary.displayName}`}
                    className="automation-row__menu-toggle"
                    onClick={() =>
                      props.setOpenMenuId(
                        props.openMenuId === String(summary.id) ? undefined : String(summary.id),
                      )
                    }
                    type="button"
                    variant="ghost"
                  >
                    <span>Actions</span>
                    <ChevronDown aria-hidden="true" size={13} strokeWidth={1.8} />
                  </OctantButton>
                  {props.openMenuId !== String(summary.id) ? null : (
                    <div className="automation-row__menu">
                      {summary.lifecycle === "enabled" ? (
                        <OctantButton
                          onClick={() =>
                            void props.onRunCommand(
                              summary,
                              {
                                kind: "pause-automation",
                                automationId: summary.id,
                                expectedVersion: summary.version,
                              },
                              "Automation paused.",
                            )
                          }
                          type="button"
                          variant="ghost"
                        >
                          Pause
                        </OctantButton>
                      ) : summary.lifecycle === "paused" ? (
                        <OctantButton
                          onClick={() =>
                            void props.onRunCommand(
                              summary,
                              {
                                kind: "resume-automation",
                                automationId: summary.id,
                                expectedVersion: summary.version,
                              },
                              "Automation resumed.",
                            )
                          }
                          type="button"
                          variant="ghost"
                        >
                          Resume
                        </OctantButton>
                      ) : null}
                      {summary.lifecycle === "archived" ? null : (
                        <>
                          <OctantButton
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
                            type="button"
                            variant="ghost"
                          >
                            Run now
                          </OctantButton>
                          <OctantButton
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
                            type="button"
                            variant="ghost"
                          >
                            Archive
                          </OctantButton>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </li>
            ))}
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
      <ShellState
        eyebrow="Automation Center"
        message="Loading the automation."
        state="loading"
        title="Loading"
      />
    );
  }
  if (controller.detail.status === "unavailable") {
    return (
      <ShellState
        action={{ label: "Retry", onClick: controller.retryDetail }}
        eyebrow="Automation Center"
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
          {automation.nextDueAt === null
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
              <ThreadLink
                automationName={automation.displayName}
                {...(props.onOpenThread === undefined ? {} : { onOpenThread: props.onOpenThread })}
                run={latestRun}
              />
            </dd>
          </div>
        )}
      </dl>

      <details className="automation-detail__advanced">
        <summary>
          <span>Advanced</span>
          <ChevronDown aria-hidden="true" size={13} strokeWidth={1.8} />
        </summary>
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
      </details>

      <details
        className="automation-detail__history"
        onToggle={(event) => {
          if (
            (event.target as HTMLDetailsElement).open &&
            controller.history.status === "collapsed"
          ) {
            void controller.expandHistory();
          }
        }}
      >
        <summary>
          <span>Run history</span>
          <ChevronDown aria-hidden="true" size={13} strokeWidth={1.8} />
        </summary>
        <AutomationHistoryBody
          automation={automation}
          automationName={automation.displayName}
          controller={controller}
          format={props.format}
          {...(props.notificationClient === undefined
            ? {}
            : { notificationClient: props.notificationClient })}
          {...(props.onOpenThread === undefined ? {} : { onOpenThread: props.onOpenThread })}
        />
      </details>
    </section>
  );
}

function AutomationHistoryBody(props: {
  readonly automation: AutomationDefinition;
  readonly automationName: string;
  readonly controller: AutomationCenterController;
  readonly format: AutomationFormatOptions;
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
    return <p role="status">Loading run history.</p>;
  }
  if (controller.history.status === "unavailable") {
    return (
      <div role="alert">
        <p>{controller.history.message}</p>
        <OctantButton
          onClick={() => void controller.expandHistory()}
          type="button"
          variant="secondary"
        >
          Retry history
        </OctantButton>
      </div>
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
                {run.occurrence.kind === "manual" ? "Manual run" : "Scheduled run"}
              </span>
              {run.failure === undefined ? null : (
                <span className="automation-history__failure">{run.failure.message}</span>
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
