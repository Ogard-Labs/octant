import type {
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationMissedRunPolicy,
  AutomationMode,
  AutomationTrigger,
} from "@octant/contracts";
import { environmentLabel } from "@octant/client-runtime/environment-selection";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantNativeSelect } from "../ui/base/OctantSelect";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import {
  automationAuthoritySummary,
  automationModeLabel,
  buildAutomationDraft,
  type AutomationAuthorityProfileOption,
  type AutomationEditorCatalog,
  type AutomationExecutionProfileOption,
  type AutomationProjectOption,
  type AutomationTriggerFormValue,
} from "./automationCenterModel";
import type { RoutineRequestDraft } from "./routineRequestDraft";

/**
 * Create/edit form for one Automation definition. Every choice is an exact
 * server-provided fact (host, mode, Project binding, profile receipts); the
 * form assembles the strict A1 draft, pre-validates it client-side, and the
 * server remains the final authority through the A2 command route.
 */
export interface AutomationDefinitionEditorProps {
  readonly catalog: AutomationEditorCatalog;
  /** Which host this window runs on, so its row reads "Local" like everywhere else. */
  readonly localHostId?: string;
  /** Present when editing an existing definition. */
  readonly initial?: AutomationDefinition;
  /** Parsed values carried forward from the routine composer. */
  readonly initialRequestDraft?: RoutineRequestDraft;
  readonly onCancel: () => void;
  /** Returns a bounded failure message to display, or undefined on success. */
  readonly onSubmit: (draft: AutomationDefinitionDraft) => Promise<string | undefined>;
  /** Injectable strict-UTC clock for deterministic confirmation instants. */
  readonly now?: () => string;
  /** Injectable UUID source for delivery-target revision identifiers. */
  readonly generateId?: () => string;
}

const FULL_ACCESS_NOTE =
  "Full access profiles are not eligible for automations. Choose an approval-gated profile.";

export function utcInstantFromLocalInput(value: string): string | undefined {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

export function localInputFromUtcInstant(instant: string): string {
  const date = new Date(instant);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

const weekdayOptions = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
] as const;

function supportedTimeZones(): readonly string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [];
  }
}

function executionProfileEligible(
  option: AutomationExecutionProfileOption,
  hostId: string,
  mode: AutomationMode,
  projectId: string,
): boolean {
  return (
    option.receipt.executionPolicy !== "full-access" &&
    String(option.receipt.hostId) === hostId &&
    option.receipt.mode === mode &&
    (projectId === "" || String(option.receipt.projectId) === projectId)
  );
}

function authorityProfileEligible(
  option: AutomationAuthorityProfileOption,
  mode: AutomationMode,
): boolean {
  const { requested, effective } = option.receipt;
  if (requested.executionPolicy === "full-access" || effective.executionPolicy === "full-access") {
    return false;
  }
  return mode !== "work" || (!effective.shell && !effective.git);
}

interface TriggerFormState {
  readonly kind: AutomationTriggerFormValue["kind"];
  readonly onceLocal: string;
  readonly anchorLocal: string;
  readonly intervalMinutes: string;
  readonly weekdays: ReadonlySet<number>;
  readonly localTime: string;
  readonly timeZone: string;
}

function initialTriggerState(initial: AutomationTrigger | undefined): TriggerFormState {
  const base: TriggerFormState = {
    kind: "once",
    onceLocal: "",
    anchorLocal: "",
    intervalMinutes: "60",
    weekdays: new Set<number>(),
    localTime: "09:00",
    timeZone: "",
  };
  if (initial === undefined) return base;
  switch (initial.kind) {
    case "once":
      return {
        ...base,
        kind: "once",
        onceLocal: localInputFromUtcInstant(initial.scheduledAt),
      };
    case "interval":
      return {
        ...base,
        kind: "interval",
        anchorLocal: localInputFromUtcInstant(initial.anchorAt),
        intervalMinutes: String(initial.intervalMinutes),
      };
    case "weekly-local":
      return {
        ...base,
        kind: "weekly-local",
        weekdays: new Set(initial.weekdays),
        localTime: initial.localTime,
        timeZone: initial.timeZone,
      };
  }
}

export function AutomationDefinitionEditor(props: AutomationDefinitionEditorProps) {
  const { catalog, initial } = props;
  const ids = {
    name: useId(),
    task: useId(),
    host: useId(),
    project: useId(),
    execution: useId(),
    authority: useId(),
    schedule: useId(),
    onceAt: useId(),
    anchorAt: useId(),
    interval: useId(),
    time: useId(),
    timeZone: useId(),
    timeZoneList: useId(),
    missed: useId(),
    target: useId(),
    confirm: useId(),
  };

  const [displayName, setDisplayName] = useState(
    initial?.displayName ?? props.initialRequestDraft?.name ?? "",
  );
  const [taskPrompt, setTaskPrompt] = useState(
    initial?.taskPrompt ?? props.initialRequestDraft?.prompt ?? "",
  );
  const [hostId, setHostId] = useState(
    initial === undefined
      ? catalog.hosts.length === 1
        ? String(catalog.hosts[0]!.hostId)
        : ""
      : String(initial.hostId),
  );
  const [mode, setMode] = useState<AutomationMode>(initial?.mode ?? "work");
  const [projectId, setProjectId] = useState(
    initial === undefined ? "" : String(initial.projectId),
  );
  const [executionProfileId, setExecutionProfileId] = useState(
    initial === undefined ? "" : String(initial.executionProfile.profileId),
  );
  const [authorityProfileId, setAuthorityProfileId] = useState(
    initial === undefined ? "" : String(initial.authorityProfile.profileId),
  );
  const [trigger, setTrigger] = useState<TriggerFormState>(() =>
    initialTriggerState(initial?.trigger ?? props.initialRequestDraft?.trigger),
  );
  const [missedRunPolicy, setMissedRunPolicy] = useState<AutomationMissedRunPolicy>(
    initial?.missedRunPolicy ?? "skip",
  );
  const [targetSummary, setTargetSummary] = useState(initial?.deliveryTarget.summary ?? "");
  // Editing always requires an explicit fresh confirmation; never carry it over.
  const [targetConfirmed, setTargetConfirmed] = useState(false);
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [serverMessage, setServerMessage] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const projectOptions = useMemo(() => {
    const matching = catalog.projects.filter((project) => project.mode === mode);
    if (
      initial !== undefined &&
      initial.mode === mode &&
      !matching.some((project) => String(project.projectId) === String(initial.projectId))
    ) {
      const fromDefinition: AutomationProjectOption = {
        projectId: initial.projectId,
        name: "Current Project",
        mode: initial.mode,
        projectVersion: initial.projectVersion,
        binding: initial.binding,
      };
      return [fromDefinition, ...matching];
    }
    return matching;
  }, [catalog.projects, initial, mode]);

  const executionOptions = useMemo(() => {
    const eligible = catalog.executionProfiles.filter((option) =>
      executionProfileEligible(option, hostId, mode, projectId),
    );
    if (
      initial !== undefined &&
      executionProfileEligible(
        { label: "", receipt: initial.executionProfile },
        hostId,
        mode,
        projectId,
      ) &&
      !eligible.some(
        (option) => String(option.receipt.profileId) === String(initial.executionProfile.profileId),
      )
    ) {
      return [
        { label: "Current execution profile", receipt: initial.executionProfile },
        ...eligible,
      ];
    }
    return eligible;
  }, [catalog.executionProfiles, hostId, initial, mode, projectId]);

  const authorityOptions = useMemo(() => {
    const eligible = catalog.authorityProfiles.filter((option) =>
      authorityProfileEligible(option, mode),
    );
    if (
      initial !== undefined &&
      authorityProfileEligible({ label: "", receipt: initial.authorityProfile }, mode) &&
      !eligible.some(
        (option) => String(option.receipt.profileId) === String(initial.authorityProfile.profileId),
      )
    ) {
      return [
        { label: "Current authority profile", receipt: initial.authorityProfile },
        ...eligible,
      ];
    }
    return eligible;
  }, [catalog.authorityProfiles, initial, mode]);

  const anyFullAccessExcluded = useMemo(
    () =>
      catalog.executionProfiles.some(
        (option) => option.receipt.executionPolicy === "full-access",
      ) ||
      catalog.authorityProfiles.some(
        (option) =>
          option.receipt.requested.executionPolicy === "full-access" ||
          option.receipt.effective.executionPolicy === "full-access",
      ),
    [catalog.authorityProfiles, catalog.executionProfiles],
  );

  const selectedProject = projectOptions.find((project) => String(project.projectId) === projectId);
  const selectedExecution = executionOptions.find(
    (option) => String(option.receipt.profileId) === executionProfileId,
  );
  const selectedAuthority = authorityOptions.find(
    (option) => String(option.receipt.profileId) === authorityProfileId,
  );

  function changeMode(nextMode: AutomationMode) {
    if (nextMode === mode) return;
    setMode(nextMode);
    setProjectId("");
    setExecutionProfileId("");
    setAuthorityProfileId("");
  }

  function triggerFormValue(): AutomationTriggerFormValue {
    switch (trigger.kind) {
      case "once":
        return { kind: "once", scheduledAt: utcInstantFromLocalInput(trigger.onceLocal) ?? "" };
      case "interval":
        return {
          kind: "interval",
          anchorAt: utcInstantFromLocalInput(trigger.anchorLocal) ?? "",
          intervalMinutes: Number(trigger.intervalMinutes),
        };
      case "weekly-local":
        return {
          kind: "weekly-local",
          weekdays: [...trigger.weekdays],
          localTime: trigger.localTime,
          timeZone: trigger.timeZone.trim(),
        };
    }
  }

  async function submit() {
    setServerMessage(undefined);
    const result = buildAutomationDraft({
      displayName,
      taskPrompt,
      hostId,
      mode,
      project: selectedProject,
      executionProfile: selectedExecution?.receipt,
      authorityProfile: selectedAuthority?.receipt,
      trigger: triggerFormValue(),
      missedRunPolicy,
      deliveryTargetSummary: targetSummary,
      deliveryTargetConfirmed: targetConfirmed,
      ...(initial === undefined
        ? {}
        : { previousDeliveryTargetRevision: initial.deliveryTarget.revision }),
      actorId: catalog.actorId,
      now: (props.now ?? (() => new Date().toISOString()))(),
      generateId: props.generateId ?? (() => crypto.randomUUID()),
    });
    if (result.kind === "invalid") {
      setIssues(result.issues);
      return;
    }
    setIssues([]);
    setSubmitting(true);
    try {
      const failure = await props.onSubmit(result.draft);
      if (failure !== undefined) setServerMessage(failure);
    } finally {
      setSubmitting(false);
    }
  }

  const editing = initial !== undefined;
  const hasProblems = issues.length > 0 || serverMessage !== undefined;

  return (
    <form
      aria-label={editing ? "Edit automation" : "New automation"}
      className="automation-editor"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="automation-editor__title">{editing ? "Edit automation" : "New automation"}</h3>

      {hasProblems ? (
        <div className="automation-editor__problems" role="alert">
          {serverMessage === undefined ? null : <p>{serverMessage}</p>}
          {issues.length === 0 ? null : (
            <ul>
              {issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <div className="automation-editor__field">
        <label htmlFor={ids.name}>Name</label>
        <OctantInput
          className="input"
          id={ids.name}
          onChange={(event) => setDisplayName(event.target.value)}
          ref={nameRef}
          type="text"
          value={displayName}
        />
      </div>

      <div className="automation-editor__field">
        <label htmlFor={ids.task}>Task for each run</label>
        <OctantTextarea
          className="textarea"
          id={ids.task}
          onChange={(event) => setTaskPrompt(event.target.value)}
          rows={3}
          value={taskPrompt}
        />
      </div>

      <div className="automation-editor__field">
        {/*
          The environment that will own and run this routine. It is chosen
          before anything else because everything below it — the Projects, the
          profiles, the bindings — is a fact of that host and not of this
          window. The names come from the shared environment vocabulary, so the
          machine you are sitting at reads "Local" here exactly as it does in
          the filter and on a row.
        */}
        <label htmlFor={ids.host}>Environment</label>
        <OctantNativeSelect
          className="select"
          id={ids.host}
          onChange={(event) => setHostId(event.target.value)}
          value={hostId}
        >
          {catalog.hosts.length === 0 ? <option value="">No environments available</option> : null}
          {catalog.hosts.map((host) => (
            <option key={String(host.hostId)} value={String(host.hostId)}>
              {environmentLabel({
                hostId: String(host.hostId),
                hostDisplayName: host.label,
                ...(props.localHostId === undefined ? {} : { localHostId: props.localHostId }),
              })}
            </option>
          ))}
        </OctantNativeSelect>
      </div>

      <div className="automation-editor__field automation-editor__mode">
        <span>Mode</span>
        <OctantToggleGroup<AutomationMode>
          aria-label="Mode"
          onValueChange={(value) => {
            const next = value[0];
            if (next !== undefined) changeMode(next);
          }}
          value={[mode]}
        >
          {(["work", "code"] as const).map((option) => (
            <OctantToggleGroupItem
              className="automation-editor__mode-option"
              key={option}
              value={option}
            >
              {automationModeLabel(option)}
            </OctantToggleGroupItem>
          ))}
        </OctantToggleGroup>
      </div>

      <div className="automation-editor__field">
        <label htmlFor={ids.project}>Project</label>
        <OctantNativeSelect
          className="select"
          id={ids.project}
          onChange={(event) => {
            setProjectId(event.target.value);
            setExecutionProfileId("");
          }}
          value={projectId}
        >
          <option value="">Choose a Project</option>
          {projectOptions.map((project) => (
            <option key={String(project.projectId)} value={String(project.projectId)}>
              {project.name}
            </option>
          ))}
        </OctantNativeSelect>
        {projectOptions.length === 0 ? (
          <p className="automation-editor__note" role="status">
            No {automationModeLabel(mode)} Projects are available on this host.
          </p>
        ) : null}
      </div>

      <div className="automation-editor__field">
        <label htmlFor={ids.execution}>Execution profile</label>
        <OctantNativeSelect
          className="select"
          id={ids.execution}
          onChange={(event) => setExecutionProfileId(event.target.value)}
          value={executionProfileId}
        >
          <option value="">Choose an execution profile</option>
          {executionOptions.map((option) => (
            <option key={String(option.receipt.profileId)} value={String(option.receipt.profileId)}>
              {option.label}
            </option>
          ))}
        </OctantNativeSelect>
        {executionOptions.length === 0 ? (
          <p className="automation-editor__note" role="status">
            No eligible execution profiles are available for this selection.
          </p>
        ) : null}
      </div>

      <div className="automation-editor__field">
        <label htmlFor={ids.authority}>Authority profile</label>
        <OctantNativeSelect
          className="select"
          id={ids.authority}
          onChange={(event) => setAuthorityProfileId(event.target.value)}
          value={authorityProfileId}
        >
          <option value="">Choose an authority profile</option>
          {authorityOptions.map((option) => (
            <option key={String(option.receipt.profileId)} value={String(option.receipt.profileId)}>
              {option.label}
            </option>
          ))}
        </OctantNativeSelect>
        {selectedAuthority === undefined ? null : (
          <p className="automation-editor__note">
            {automationAuthoritySummary(selectedAuthority.receipt)}
          </p>
        )}
        {authorityOptions.length === 0 ? (
          <p className="automation-editor__note" role="status">
            No eligible authority profiles are available for this selection.
          </p>
        ) : null}
        {anyFullAccessExcluded ? (
          <p className="automation-editor__note">{FULL_ACCESS_NOTE}</p>
        ) : null}
      </div>

      <div className="automation-editor__field">
        <label htmlFor={ids.schedule}>Schedule</label>
        <OctantNativeSelect
          className="select"
          id={ids.schedule}
          onChange={(event) =>
            setTrigger((previous) => ({
              ...previous,
              kind: event.target.value as TriggerFormState["kind"],
            }))
          }
          value={trigger.kind}
        >
          <option value="once">Run once</option>
          <option value="interval">Repeat on an interval</option>
          <option value="weekly-local">Weekly on chosen days</option>
        </OctantNativeSelect>
      </div>

      {trigger.kind === "once" ? (
        <div className="automation-editor__field">
          <label htmlFor={ids.onceAt}>Run at</label>
          <OctantInput
            className="input"
            id={ids.onceAt}
            onChange={(event) =>
              setTrigger((previous) => ({ ...previous, onceLocal: event.target.value }))
            }
            type="datetime-local"
            value={trigger.onceLocal}
          />
        </div>
      ) : null}

      {trigger.kind === "interval" ? (
        <>
          <div className="automation-editor__field">
            <label htmlFor={ids.anchorAt}>Starts at</label>
            <OctantInput
              className="input"
              id={ids.anchorAt}
              onChange={(event) =>
                setTrigger((previous) => ({ ...previous, anchorLocal: event.target.value }))
              }
              type="datetime-local"
              value={trigger.anchorLocal}
            />
          </div>
          <div className="automation-editor__field">
            <label htmlFor={ids.interval}>Repeat every (minutes)</label>
            <OctantInput
              className="input"
              id={ids.interval}
              min={15}
              max={43_200}
              onChange={(event) =>
                setTrigger((previous) => ({ ...previous, intervalMinutes: event.target.value }))
              }
              type="number"
              value={trigger.intervalMinutes}
            />
          </div>
        </>
      ) : null}

      {trigger.kind === "weekly-local" ? (
        <>
          <fieldset className="automation-editor__field automation-editor__weekdays">
            <legend>Weekdays</legend>
            {weekdayOptions.map((weekday) => (
              <label className="automation-editor__weekday check" key={weekday.value}>
                <OctantCheckbox
                  checked={trigger.weekdays.has(weekday.value)}
                  onChange={(event) =>
                    setTrigger((previous) => {
                      const weekdays = new Set(previous.weekdays);
                      if (event.target.checked) weekdays.add(weekday.value);
                      else weekdays.delete(weekday.value);
                      return { ...previous, weekdays };
                    })
                  }
                />
                <span>{weekday.label}</span>
              </label>
            ))}
          </fieldset>
          <div className="automation-editor__field">
            <label htmlFor={ids.time}>Time of day</label>
            <OctantInput
              className="input"
              id={ids.time}
              onChange={(event) =>
                setTrigger((previous) => ({ ...previous, localTime: event.target.value }))
              }
              type="time"
              value={trigger.localTime}
            />
          </div>
          <div className="automation-editor__field">
            <label htmlFor={ids.timeZone}>Timezone</label>
            <OctantInput
              className="input"
              id={ids.timeZone}
              list={ids.timeZoneList}
              onChange={(event) =>
                setTrigger((previous) => ({ ...previous, timeZone: event.target.value }))
              }
              placeholder="Europe/Oslo"
              type="text"
              value={trigger.timeZone}
            />
            <datalist id={ids.timeZoneList}>
              {supportedTimeZones().map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </div>
        </>
      ) : null}

      <div className="automation-editor__field">
        <label htmlFor={ids.missed}>Missed runs</label>
        <OctantNativeSelect
          className="select"
          id={ids.missed}
          onChange={(event) => setMissedRunPolicy(event.target.value as AutomationMissedRunPolicy)}
          value={missedRunPolicy}
        >
          <option value="skip">Skip missed runs</option>
          <option value="run-once">Run the newest missed occurrence once</option>
        </OctantNativeSelect>
      </div>

      <div className="automation-editor__field">
        <label htmlFor={ids.target}>Delivery target</label>
        <OctantTextarea
          className="textarea"
          id={ids.target}
          onChange={(event) => setTargetSummary(event.target.value)}
          rows={2}
          value={targetSummary}
        />
        <p className="automation-editor__note">
          Every run creates a new thread with this exact user-confirmed Done boundary.
        </p>
      </div>

      <div className="automation-editor__field automation-editor__confirmation">
        <OctantCheckbox
          checked={targetConfirmed}
          id={ids.confirm}
          onChange={(event) => setTargetConfirmed(event.target.checked)}
        />
        <label htmlFor={ids.confirm}>I confirm this delivery target for every scheduled run</label>
      </div>

      <div className="automation-editor__actions">
        <OctantButton disabled={submitting} type="submit" variant="default">
          {submitting ? "Saving…" : editing ? "Save changes" : "Save automation"}
        </OctantButton>
        <OctantButton onClick={props.onCancel} type="button" variant="secondary">
          Cancel
        </OctantButton>
      </div>
    </form>
  );
}
