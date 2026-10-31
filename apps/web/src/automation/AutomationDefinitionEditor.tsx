import type {
  AutomationDefinition,
  AutomationDefinitionDraft,
  AutomationMissedRunPolicy,
  AutomationMode,
} from "@octant/contracts";
import { environmentLabel } from "@octant/client-runtime/environment-selection";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantCheckbox } from "../ui/base/OctantCheckbox";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantSelectField } from "../ui/base/OctantSelect";
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
} from "./automationCenterModel";
import type { RoutineRequestDraft } from "./routineRequestDraft";
import {
  initialRoutineScheduleState,
  RoutineScheduleFields,
  routineScheduleFormValue,
  type RoutineScheduleFormState,
} from "./RoutineScheduleFields";

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

export { localInputFromUtcInstant, utcInstantFromLocalInput } from "./RoutineScheduleFields";

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
  // Every Work turn holds the shell and Git, so a Work routine runs only under
  // a profile that grants them; one without them would never run.
  return mode !== "work" || (effective.shell && effective.git);
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
    target: useId(),
    confirm: useId(),
  };

  const [displayName, setDisplayName] = useState(
    initial?.displayName ?? props.initialRequestDraft?.name ?? "",
  );
  const [taskPrompt, setTaskPrompt] = useState(
    initial?.taskPrompt ?? props.initialRequestDraft?.prompt ?? "",
  );
  const [firstHost] = catalog.hosts;
  const [hostId, setHostId] = useState(
    initial === undefined
      ? catalog.hosts.length === 1 && firstHost !== undefined
        ? String(firstHost.hostId)
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
  const [trigger, setTrigger] = useState<RoutineScheduleFormState>(() =>
    initialRoutineScheduleState(initial?.trigger ?? props.initialRequestDraft?.trigger),
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
      trigger: routineScheduleFormValue(trigger),
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
        /* ui-boundary-exception: inline-field-error */
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
        <OctantSelectField
          className="select"
          id={ids.host}
          onValueChange={setHostId}
          options={[
            ...(catalog.hosts.length === 0 ? [{ id: "", label: "No environments available" }] : []),
            ...catalog.hosts.map((host) => ({
              id: String(host.hostId),
              label: environmentLabel({
                hostId: String(host.hostId),
                hostDisplayName: host.label,
                ...(props.localHostId === undefined ? {} : { localHostId: props.localHostId }),
              }),
            })),
          ]}
          value={hostId}
        />
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
        <OctantSelectField
          className="select"
          id={ids.project}
          onValueChange={(value) => {
            setProjectId(value);
            setExecutionProfileId("");
          }}
          options={[
            { id: "", label: "Choose a Project" },
            ...projectOptions.map((project) => ({
              id: String(project.projectId),
              label: project.name,
            })),
          ]}
          value={projectId}
        />
        {projectOptions.length === 0 ? (
          <p className="automation-editor__note" role="status">
            No {automationModeLabel(mode)} Projects are available on this host.
          </p>
        ) : null}
      </div>

      <div className="automation-editor__field">
        <label htmlFor={ids.execution}>Execution profile</label>
        <OctantSelectField
          className="select"
          id={ids.execution}
          onValueChange={setExecutionProfileId}
          options={[
            { id: "", label: "Choose an execution profile" },
            ...executionOptions.map((option) => ({
              id: String(option.receipt.profileId),
              label: option.label,
            })),
          ]}
          value={executionProfileId}
        />
        {executionOptions.length === 0 ? (
          <p className="automation-editor__note" role="status">
            No eligible execution profiles are available for this selection.
          </p>
        ) : null}
      </div>

      <div className="automation-editor__field">
        <label htmlFor={ids.authority}>Authority profile</label>
        <OctantSelectField
          className="select"
          id={ids.authority}
          onValueChange={setAuthorityProfileId}
          options={[
            { id: "", label: "Choose an authority profile" },
            ...authorityOptions.map((option) => ({
              id: String(option.receipt.profileId),
              label: option.label,
            })),
          ]}
          value={authorityProfileId}
        />
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

      <RoutineScheduleFields
        missedRunPolicy={missedRunPolicy}
        onMissedRunPolicyChange={setMissedRunPolicy}
        onTriggerChange={setTrigger}
        trigger={trigger}
      />

      <div className="automation-editor__field">
        <label htmlFor={ids.target}>Delivery</label>
        <OctantTextarea
          className="textarea"
          id={ids.target}
          onChange={(event) => setTargetSummary(event.target.value)}
          rows={2}
          value={targetSummary}
        />
        <p className="automation-editor__note">
          {mode === "work"
            ? "Every run starts a new thread with this delivery target. It is Done when you mark it Done."
            : "Every run starts a new thread with this delivery target. It is Done when the target is met."}
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
