import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import type { ProjectId } from "@octant/contracts/projects";
import type { ModelPickerSelection, PickerGroup } from "@octant/domain";
import { Check } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantDialog } from "../ui/base/OctantDialog";
import {
  projectsForMode,
  resolveFirstRunHandoff,
  type FirstRunHandoffProject,
  type FirstRunHandoffSetupTarget,
  type FirstRunTaskMode,
} from "./firstRunHandoffModel";
import { FirstRunModelStep } from "./FirstRunModelStep";
import { FirstRunProjectStep } from "./FirstRunProjectStep";
import { FirstRunProviderStep } from "./FirstRunProviderStep";
import { FirstRunReadinessStep } from "./FirstRunReadinessStep";
import type { FirstRunDiscoveryNotice, FirstRunReadinessSummary } from "./firstRunReadinessModel";
import {
  buildFirstRunSteps,
  nextFirstRunStep,
  previousFirstRunStep,
  type FirstRunStepId,
} from "./firstRunStepModel";
import type { FirstRunOnboardingController } from "./useFirstRunOnboardingController";
// The blocks this surface is built from — the section object, the group, the
// row — are defined in this sheet, and it ships with Settings, a lazy route
// first run never reaches. Without it the same class names picked up the
// design system's older reading of them, so a first-run row and a Settings row
// were two different objects wearing one name. First run is itself lazy, so
// nothing else pays for the import.
import "../styles/settings.css";
import "./first-run.css";

export interface FirstRunModelChoice {
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
}

const MODE_LABEL: Record<FirstRunTaskMode, string> = {
  work: "Work",
  code: "Code",
};

export interface FirstRunOnboardingProps {
  readonly controller: FirstRunOnboardingController;
  readonly readiness: FirstRunReadinessSummary;
  readonly discoveryNotice?: FirstRunDiscoveryNotice;
  readonly onOpenProviderSettings: () => void;
  readonly onRescan: () => void;
  readonly scanning: boolean;
  /**
   * Turn a discovered provider on or off without leaving the wizard.
   *
   * The promise is the answer landing on the host: first run waits for it
   * before recording its outcome, the same as every other answer here.
   */
  readonly onSetProviderEnabled?: (
    instanceId: ProviderInstanceId,
    enabled: boolean,
  ) => Promise<boolean>;

  /** Whether Work is offered. Code is always available. */
  readonly workEnabled: boolean;
  readonly workModelGroups: ReadonlyArray<PickerGroup>;
  readonly codeModelGroups: ReadonlyArray<PickerGroup>;
  /** The model a new task in each mode starts with today, when one was chosen. */
  readonly workModel?: FirstRunModelChoice | undefined;
  readonly codeModel?: FirstRunModelChoice | undefined;
  readonly onSelectModel: (
    mode: FirstRunTaskMode,
    selection: ModelPickerSelection,
  ) => Promise<boolean>;

  readonly projects: ReadonlyArray<FirstRunHandoffProject>;
  /** Open the Project create surface — the same Choose a folder flow the shell uses. */
  readonly onCreateProject: (mode: FirstRunTaskMode) => void;
  /** Open the new-task composer for this Project. It creates no thread by itself. */
  readonly onStartThread: (input: {
    readonly mode: FirstRunTaskMode;
    readonly projectId: ProjectId;
  }) => void;
}

/**
 * Octant's first-run surface.
 *
 * It exists to get a new user from a clean launch to a real task without a
 * hidden prerequisite. Three setup steps — providers, a Project folder, a
 * model — then a readiness view that reports provider, Project, and a
 * mode-valid model separately, and one primary action, Start a task, that
 * opens the new-task composer in that Project. Every step can be walked past;
 * the handoff does not invent readiness they skipped.
 *
 * Answers are recorded as they are made, so quitting mid-way keeps what was
 * already chosen; only the first-run *outcome* is recorded at the end.
 * Dismissing the dialog records the same durable "skipped" outcome as the
 * button, so first run never silently repeats.
 *
 * Sending the user to provider settings or Project create conceals this
 * surface without answering. Closing that destination returns to the same
 * draft, because a modal left open over the destination traps focus, and
 * recording skip would hide first run from someone who simply backed out.
 */
export function FirstRunOnboarding(props: FirstRunOnboardingProps) {
  const titleId = useId();
  const { controller } = props;
  const [step, setStep] = useState<FirstRunStepId>("providers");
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [selectedMode, setSelectedMode] = useState<FirstRunTaskMode>("code");
  const [chosenProjectId, setChosenProjectId] = useState<ProjectId>();
  const [knownProjects, setKnownProjects] = useState(props.projects);
  const [resolving, setResolving] = useState(false);
  const unsettledWrites = useRef<Array<Promise<boolean>>>([]);
  const answerLost = useRef(false);
  const [answerRefused, setAnswerRefused] = useState(false);
  const providerAction = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const blocked = controller.blockedMessage !== undefined;

  const mode: FirstRunTaskMode = props.workEnabled ? selectedMode : "code";

  // A folder chosen through Project create arrives as a new Project while this
  // surface is concealed. It is the folder the user just picked, so it becomes
  // the first task's Project rather than whichever one happens to be listed
  // first.
  if (knownProjects !== props.projects) {
    setKnownProjects(props.projects);
    const known = new Set(knownProjects.map((project) => String(project.id)));
    const added = projectsForMode(props.projects, mode).find(
      (project) => !known.has(String(project.id)),
    );
    if (added !== undefined) setChosenProjectId(added.id);
  }

  const busy = controller.submitting !== undefined || resolving;
  const modeGroups = mode === "work" ? props.workModelGroups : props.codeModelGroups;
  const modeModel = mode === "work" ? props.workModel : props.codeModel;
  const handoff = useMemo(
    () =>
      resolveFirstRunHandoff({
        mode,
        providerOverall: props.readiness.overall,
        providerHeadline: props.readiness.headline,
        projects: props.projects,
        preferredProjectId: chosenProjectId,
        groups: modeGroups,
        ...(modeModel === undefined ? {} : { preferredDefault: modeModel }),
      }),
    [
      mode,
      modeGroups,
      modeModel,
      chosenProjectId,
      props.projects,
      props.readiness.headline,
      props.readiness.overall,
    ],
  );

  // The panel is one scroller shared by every step, so a step opened after a
  // long one started scrolled past its own header.
  useEffect(() => {
    panel.current?.scrollTo?.({ top: 0 });
  }, [step, handoffOpen]);

  if (!controller.visible) return null;

  const steps = buildFirstRunSteps({
    current: step,
    providersReady: props.readiness.overall === "ready",
    projectReady: handoff.project !== undefined,
    modelChosen: modeModel !== undefined,
  }).map((descriptor) => ({ ...descriptor, current: descriptor.current && !handoffOpen }));
  const currentStepIndex = Math.max(
    0,
    steps.findIndex((descriptor) => descriptor.id === step),
  );
  const currentStep = steps[currentStepIndex];

  // Enabling a provider is an answer like any other, so first run waits for
  // it before recording its outcome; a discarded promise let the wizard close
  // against a host that had not accepted the choice yet.
  function setProviderEnabled(instanceId: ProviderInstanceId, enabled: boolean): void {
    const write = props.onSetProviderEnabled;
    if (write === undefined) return;
    track(write(instanceId, enabled));
  }

  /**
   * Collect a setup write so the outcome can be withheld if it does not land.
   *
   * Deliberately not held in render state: a write that disabled the buttons
   * would swallow a click made in the same gesture as the answer.
   */
  function track(write: Promise<boolean>): void {
    setAnswerRefused(false);
    unsettledWrites.current.push(write.catch(() => false));
  }

  /**
   * Wait for every answer written since the last attempt, and report whether
   * all of them landed.
   *
   * The list is drained whether or not they did, so a user who answers again
   * after a conflict is not held by the write the conflict discarded. What a
   * rejection leaves behind is the refusal itself: only the footer is disabled
   * while this runs, so an answer given during the wait appends its write
   * afterwards, and clicking again without answering again must not read the
   * emptied list as consent until the user has been told (`resolveWith` does
   * that, once).
   */
  async function settleWrites(): Promise<boolean> {
    let settled = false;
    let landed = true;
    while (unsettledWrites.current.length > 0) {
      const writes = unsettledWrites.current;
      unsettledWrites.current = [];
      settled = true;
      const results = await Promise.all(writes);
      landed = landed && results.every((accepted) => accepted);
    }
    if (settled) answerLost.current = !landed;
    return !answerLost.current;
  }

  function goTo(target: FirstRunStepId) {
    setHandoffOpen(false);
    setStep(target);
  }

  // The outcome is recorded last, and only once every answer has been
  // accepted. A rejected write is recovered by reloading the host, which
  // leaves the surface able to record an outcome against state that never
  // took the answer — and because the outcome is durable, the user would
  // never be asked again. So the first press that meets a rejected answer says
  // so and records nothing; the user may answer again or press once more to go
  // on without it. Refusing every press silently left Skip setup dead for as
  // long as the host kept refusing, with no way out and no reason given.
  function finish() {
    if (!handoffOpen) {
      setHandoffOpen(true);
      return;
    }
    const primary = handoff.primary;
    if (primary.kind === "setup") {
      openSetup(primary.target);
      return;
    }
    void resolveWith(controller.complete, () => {
      props.onStartThread({ mode, projectId: primary.projectId });
    });
  }

  function skip() {
    void resolveWith(controller.skip);
  }

  async function resolveWith(record: () => void, after?: () => void) {
    if (resolving) return;
    setResolving(true);
    const accepted = await settleWrites();
    setResolving(false);
    if (!accepted) {
      // Said once, then let go: the host already reloaded past the refused
      // answer, so what this surface shows is what it holds, and a button that
      // refuses again with no reason is a dead end. The next press is the
      // user choosing to go on without that answer.
      answerLost.current = false;
      setAnswerRefused(true);
      return;
    }
    record();
    after?.();
  }

  function openSetup(target: FirstRunHandoffSetupTarget) {
    if (target === "providers") {
      props.onOpenProviderSettings();
      return;
    }
    if (target === "project") {
      props.onCreateProject(mode);
      return;
    }
    goTo("model");
  }

  function leaveForProviderSettings() {
    openSetup("providers");
  }

  const back = previousFirstRunStep(step);
  const forward = nextFirstRunStep(step);

  return (
    <OctantDialog
      className="first-run"
      initialFocus={providerAction}
      label="Welcome to Octant"
      labelledBy={titleId}
      onClose={skip}
      open
    >
      <div className="first-run__body">
        <nav aria-label="Setup steps" className="first-run__rail">
          <h2 className="first-run__title" id={titleId}>
            Welcome to Octant
          </h2>
          <ol className="first-run__rail-list">
            {steps.map((descriptor, index) => (
              <li key={descriptor.id}>
                <OctantButton
                  aria-current={descriptor.current ? "step" : undefined}
                  className="first-run__rail-step"
                  data-configured={descriptor.configured}
                  data-progress={
                    descriptor.current ? "current" : descriptor.configured ? "completed" : "pending"
                  }
                  onClick={() => goTo(descriptor.id)}
                  type="button"
                  variant={descriptor.current ? "secondary" : "ghost"}
                >
                  <span className="first-run__rail-marker" aria-hidden>
                    {descriptor.configured && !descriptor.current ? (
                      <Check size={14} />
                    ) : (
                      String(index + 1)
                    )}
                  </span>
                  <span className="first-run__rail-title">{descriptor.title}</span>
                  <span className="first-run__rail-summary">{descriptor.summary}</span>
                  {descriptor.configured && !descriptor.current ? (
                    <span className="sr-only">Configured</span>
                  ) : null}
                </OctantButton>
              </li>
            ))}
          </ol>
        </nav>

        <div className="first-run__panel" ref={panel}>
          {handoffOpen ? (
            // The readiness view follows the last counted step and is not
            // another setup step, so it carries a title and no count.
            // Untitled, it read as a page the counter had forgotten.
            <header className="first-run__step-header">
              <h3 className="first-run__step-title">Your first task</h3>
            </header>
          ) : (
            <header className="first-run__step-header">
              <h3 className="first-run__step-title">{currentStep?.title ?? "Setup"}</h3>
              <span className="first-run__step-count">
                Step {String(currentStepIndex + 1)} of {String(steps.length)}
              </span>
            </header>
          )}
          {handoffOpen ? <FirstRunReadinessStep handoff={handoff} onSetup={openSetup} /> : null}

          {handoffOpen || step !== "providers" ? null : (
            <FirstRunProviderStep
              onOpenProviderSettings={leaveForProviderSettings}
              onRescan={props.onRescan}
              readiness={props.readiness}
              ref={providerAction}
              scanning={props.scanning}
              {...(props.onSetProviderEnabled === undefined
                ? {}
                : { onSetProviderEnabled: setProviderEnabled })}
              {...(props.discoveryNotice === undefined
                ? {}
                : { discoveryNotice: props.discoveryNotice })}
            />
          )}

          {handoffOpen || step !== "project" ? null : (
            <FirstRunProjectStep
              mode={mode}
              onChooseFolder={() => openSetup("project")}
              onSelectMode={setSelectedMode}
              onSelectProject={setChosenProjectId}
              projects={projectsForMode(props.projects, mode)}
              selectedProjectId={handoff.project?.id}
              workEnabled={props.workEnabled}
            />
          )}

          {handoffOpen || step !== "model" ? null : (
            <FirstRunModelStep
              ariaLabel={`Model for new ${MODE_LABEL[mode]} tasks`}
              groups={modeGroups}
              intro={`New ${MODE_LABEL[mode]} tasks start with this model. You can change it in the composer for any task, and existing threads keep whatever they were given.`}
              onOpenProviderSettings={leaveForProviderSettings}
              onSelect={(selection) => track(props.onSelectModel(mode, selection))}
              unsetNote="No model is chosen. Octant will start with a ready model and show you which one it chose."
              {...(modeModel === undefined
                ? {}
                : {
                    selectedModelId: modeModel.modelId,
                    selectedProviderInstanceId: modeModel.providerInstanceId,
                  })}
            />
          )}
        </div>

        {controller.blockedMessage === undefined ? null : (
          <OctantAlert className="first-run__notice" tone="warning">
            {controller.blockedMessage}
          </OctantAlert>
        )}
        {controller.blockedMessage !== undefined || !answerRefused ? null : (
          <OctantAlert className="first-run__notice" tone="warning">
            The host did not keep one of your answers, so setup shows what it holds. Answer again,
            or press the button again to continue without it.
          </OctantAlert>
        )}
        {controller.blockedMessage !== undefined || !controller.refused ? null : (
          <OctantAlert className="first-run__notice" tone="warning">
            The host did not record that. Press the button again; setup is still open until it does.
          </OctantAlert>
        )}

        <footer className="first-run__actions">
          <div className="first-run__buttons">
            {handoffOpen || back !== undefined ? (
              <OctantButton
                onClick={() => {
                  if (handoffOpen) {
                    setHandoffOpen(false);
                    return;
                  }
                  if (back !== undefined) goTo(back);
                }}
                type="button"
                variant="ghost"
              >
                Back
              </OctantButton>
            ) : null}
            <OctantButton disabled={busy || blocked} onClick={skip} type="button" variant="ghost">
              {controller.submitting === "skipped" ? "Skipping…" : "Skip setup"}
            </OctantButton>
            {handoffOpen ? (
              <OctantButton disabled={busy || blocked} onClick={finish} type="button">
                {controller.submitting === "completed" ? "Saving…" : handoff.primary.label}
              </OctantButton>
            ) : (
              <OctantButton
                onClick={() => {
                  if (forward === undefined) setHandoffOpen(true);
                  else goTo(forward);
                }}
                type="button"
              >
                Continue
              </OctantButton>
            )}
          </div>
        </footer>
      </div>
    </OctantDialog>
  );
}
