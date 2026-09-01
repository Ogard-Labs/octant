import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts";
import type { OctantMode } from "@octant/contracts/modes";
import type { NavigatorAssistantModelRef } from "@octant/contracts/navigator-assistant";
import type { UserProfile } from "@octant/contracts/user-profile";
import type { ModelPickerSelection, PickerGroup } from "@octant/domain";
import { enabledModes, isNamed, isProfileConfigured } from "@octant/domain";
import { Check } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { ProfileEditor } from "../profile/ProfileEditor";
import type { AvatarImageEnvironment } from "../profile/avatarImage";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import {
  resolveFirstRunHandoff,
  type FirstRunHandoffProject,
  type FirstRunHandoffSetupTarget,
} from "./firstRunHandoffModel";
import { FirstRunModelStep } from "./FirstRunModelStep";
import { FirstRunProviderStep } from "./FirstRunProviderStep";
import { FirstRunReadinessStep } from "./FirstRunReadinessStep";
import type { FirstRunDiscoveryNotice, FirstRunReadinessSummary } from "./firstRunReadinessModel";
import { FirstRunWorkspaceStep } from "./FirstRunWorkspaceStep";
import {
  buildFirstRunSteps,
  isWorkspaceConfigured,
  nextFirstRunStep,
  previousFirstRunStep,
  type FirstRunStepId,
  type WorkspaceChoices,
} from "./firstRunStepModel";
import type { FirstRunOnboardingController } from "./useFirstRunOnboardingController";
import "./first-run.css";

export interface FirstRunChatDefault {
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
}

export interface FirstRunOnboardingProps {
  readonly controller: FirstRunOnboardingController;
  readonly readiness: FirstRunReadinessSummary;
  readonly discoveryNotice?: FirstRunDiscoveryNotice;
  readonly onOpenProviderSettings: () => void;
  readonly onRescan: () => void;
  readonly scanning: boolean;

  /** The profile the host currently holds. The step edits a draft of it. */
  readonly profile: UserProfile;
  /** Persist the edited profile. Called when the profile step is left, not per keystroke. */
  readonly onSaveProfile: SetupWrite<UserProfile>;
  readonly avatarEnvironment?: AvatarImageEnvironment;

  readonly chatModelGroups: ReadonlyArray<PickerGroup>;
  readonly workModelGroups?: ReadonlyArray<PickerGroup>;
  readonly codeModelGroups?: ReadonlyArray<PickerGroup>;
  readonly chatDefault?: FirstRunChatDefault | undefined;
  readonly onSelectChatDefault: SetupWrite<ModelPickerSelection>;
  readonly projects: ReadonlyArray<FirstRunHandoffProject>;
  readonly onCreateProject: (mode: OctantMode) => void;
  readonly onStartThread: (input: {
    readonly mode: OctantMode;
    readonly projectId: FirstRunHandoffProject["id"];
  }) => void;

  readonly navigatorModelGroups: ReadonlyArray<PickerGroup>;
  readonly navigatorDefault?: NavigatorAssistantModelRef | undefined;
  readonly onSelectNavigatorDefault: SetupWrite<ModelPickerSelection>;
  readonly onClearNavigatorDefault: () => Promise<boolean>;

  readonly workspace: WorkspaceChoices;
  readonly onSelectColorScheme: SetupWrite<"system" | "light" | "dark">;
  readonly onToggleChat: SetupWrite<boolean>;
  readonly onToggleWork: SetupWrite<boolean>;
  readonly onSelectModeSwitcher: SetupWrite<"buttons" | "dropdown">;
}

/**
 * A setup answer written straight through to the settings that own it.
 *
 * Each resolves to whether the host accepted the write. First run's own
 * outcome is durable and hides this surface for good, so it may only be
 * recorded once every answer taken here has actually landed.
 */
type SetupWrite<Answer> = (answer: Answer) => Promise<boolean>;

/**
 * Octant's first-run surface (`BOOT-01`).
 *
 * It exists to get a new user from a clean launch to a real thread without a
 * hidden prerequisite. Five setup steps — profile, workspace, providers,
 * default model, Navigator — then a readiness view that reports provider,
 * Project, and a mode-valid default model separately. Setup steps except the
 * name can be walked past; the handoff does not invent readiness they skipped.
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
  const { controller } = props;
  const [step, setStep] = useState<FirstRunStepId>("profile");
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [selectedMode, setSelectedMode] = useState<OctantMode>(() =>
    props.workspace.chatEnabled ? "chat" : "code",
  );
  const [profileDraft, setProfileDraft] = useState<UserProfile>(props.profile);
  const [profileEdited, setProfileEdited] = useState(false);
  const [syncedProfile, setSyncedProfile] = useState<UserProfile>(props.profile);
  const [importing, setImporting] = useState(false);
  const [resolving, setResolving] = useState(false);
  const unsettledWrites = useRef<Array<Promise<boolean>>>([]);
  const answerLost = useRef(false);
  const nameField = useRef<HTMLInputElement>(null);
  const providerAction = useRef<HTMLButtonElement>(null);
  const blocked = controller.blockedMessage !== undefined;

  // This surface mounts before the host's own settings have arrived, so the
  // draft it started from can be the empty profile of a store that in fact
  // holds a name from a launch the user quit part-way through. Adopting the
  // real one late is what keeps that answer from being overwritten; an edit
  // already in progress outranks it, because the user is looking at that.
  if (syncedProfile !== props.profile) {
    setSyncedProfile(props.profile);
    if (!profileEdited) setProfileDraft(props.profile);
  }

  // An avatar import reports its result as a later change, and the answers
  // themselves are written by three independent controllers rather than one
  // queue. Resolving first run while any of that is in flight would drop a
  // picture or a model the user explicitly chose, so an answer stays busy from
  // the click until the last of those writes has been accepted.
  const busy = controller.submitting !== undefined || importing || resolving;
  // The one answer first run does not walk past. Everything the app says about
  // the reader — the sidebar, a thread, a shared surface — needs something to
  // call them, and it reads the draft rather than the saved profile so a name
  // just typed unblocks the step whether or not its write has landed yet.
  const unnamed = !isNamed(profileDraft);
  const availableModes = enabledModes({
    chatEnabled: props.workspace.chatEnabled,
    workEnabled: props.workspace.workEnabled,
  });
  const mode = availableModes.includes(selectedMode) ? selectedMode : (availableModes[0] ?? "code");
  const modeGroups =
    mode === "chat"
      ? props.chatModelGroups
      : mode === "work"
        ? (props.workModelGroups ?? [])
        : (props.codeModelGroups ?? []);
  const handoff = useMemo(
    () =>
      resolveFirstRunHandoff({
        mode,
        providerOverall: props.readiness.overall,
        providerHeadline: props.readiness.headline,
        projects: props.projects ?? [],
        groups: modeGroups,
        ...(mode === "chat" && props.chatDefault !== undefined
          ? { preferredDefault: props.chatDefault }
          : {}),
      }),
    [
      mode,
      modeGroups,
      props.chatDefault,
      props.projects,
      props.readiness.headline,
      props.readiness.overall,
    ],
  );

  if (!controller.visible) return null;

  const steps = buildFirstRunSteps({
    current: step,
    profileConfigured: isProfileConfigured(profileDraft),
    workspaceConfigured: isWorkspaceConfigured(props.workspace),
    providersReady: props.readiness.overall === "ready",
    chatDefaultConfigured: props.chatDefault !== undefined,
    navigatorConfigured: props.navigatorDefault !== undefined,
  }).map((descriptor) => ({ ...descriptor, current: descriptor.current && !handoffOpen }));
  const currentStepIndex = Math.max(
    0,
    steps.findIndex((descriptor) => descriptor.id === step),
  );
  const currentStep = steps[currentStepIndex];

  /**
   * Collect a setup write so the outcome can be withheld if it does not land.
   *
   * Deliberately not held in render state: the blur that settles a field
   * issues its write in the same gesture as the click on Skip, so a write that
   * disabled the buttons would swallow the very click it needs to wait for.
   */
  function track(write: Promise<boolean>): void {
    unsettledWrites.current.push(write.catch(() => false));
  }

  /**
   * Wait for every answer written since the last attempt, and report whether
   * all of them landed.
   *
   * The list is drained whether or not they did, so a user who answers again
   * after a conflict is not held by the write the conflict discarded. What a
   * rejection leaves behind is the refusal itself: only the footer is disabled
   * while this runs, so a field settled during the wait appends its write
   * afterwards, and clicking again without answering again must not read the
   * emptied list as consent. The outcome waits for an answer that is accepted.
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

  /**
   * Commit the draft, once, if there is anything to commit.
   *
   * Writing on every keystroke would journal a settings replacement per
   * character; writing only at the very end would lose the name of someone who
   * quits on step three. So the draft is flushed whenever the profile step is
   * left and whenever first run is answered — including when it is *skipped*,
   * because a name the user typed is a name they gave, and dropping it would
   * make skipping the rest destroy an answer they already made.
   */
  function flushProfile() {
    if (!profileEdited) return;
    setProfileEdited(false);
    track(props.onSaveProfile(profileDraft));
  }

  function goTo(target: FirstRunStepId) {
    // Leaving the profile step flushes its draft, so walking away mid-import
    // would flush the profile without the picture and unmount the editor that
    // was going to report it.
    if (importing) return;
    if (unnamed && target !== "profile") return;
    if (step === "profile" && target !== "profile") flushProfile();
    setHandoffOpen(false);
    setStep(target);
  }

  function openHandoff() {
    if (importing || unnamed) return;
    if (step === "profile") flushProfile();
    setHandoffOpen(true);
  }

  // Every way out is guarded, not just the buttons. An import reports its
  // picture as a later change, and once this surface is gone that change has
  // nowhere to land — so Escape, a backdrop press, and the conceal that sends
  // the user to provider settings all wait for it too.
  //
  // The outcome is recorded last, and only once every answer has been
  // accepted. A rejected write is recovered by reloading the host, which
  // leaves the surface able to record an outcome against state that never
  // took the answer — and because the outcome is durable, the user would
  // never be asked again. Leaving first run pending is the honest result:
  // the surface returns on the next launch, still holding the question.
  function finish() {
    if (!handoffOpen) {
      openHandoff();
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
    if (importing || resolving || unnamed) return;
    flushProfile();
    setResolving(true);
    const accepted = await settleWrites();
    setResolving(false);
    if (!accepted) return;
    record();
    after?.();
  }

  function openSetup(target: FirstRunHandoffSetupTarget) {
    if (importing) return;
    if (target === "providers") {
      props.onOpenProviderSettings();
      return;
    }
    if (target === "project") {
      props.onCreateProject(mode);
      return;
    }
    goTo("default-model");
  }

  function leaveForProviderSettings() {
    openSetup("providers");
  }

  const back = previousFirstRunStep(step);
  const forward = nextFirstRunStep(step);

  return (
    <OctantDialog
      className="first-run"
      initialFocus={step === "profile" ? nameField : providerAction}
      label="Welcome to Octant"
      onClose={skip}
      open
    >
      <div className="first-run__body">
        <nav aria-label="Setup steps" className="first-run__rail">
          <h2 className="first-run__title">Welcome to Octant</h2>
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
                  disabled={importing || (unnamed && descriptor.id !== "profile")}
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

        <div className="first-run__panel">
          {handoffOpen ? null : (
            <header className="first-run__step-header">
              <h3 className="first-run__step-title">{currentStep?.title ?? "Setup"}</h3>
              <span className="first-run__step-count">
                Step {String(currentStepIndex + 1)} of {String(steps.length)}
              </span>
            </header>
          )}
          {handoffOpen ? (
            <FirstRunReadinessStep
              handoff={handoff}
              onSelectMode={setSelectedMode}
              onSetup={openSetup}
              selectedMode={mode}
              workspace={props.workspace}
            />
          ) : null}

          {handoffOpen || step !== "profile" ? null : (
            <div className="first-run__step">
              <p className="first-run__intro">
                Octant has no account and signs you in to nothing. Choose the name and avatar shown
                inside the app. Everything except your name is optional and stays on this Mac.
              </p>
              <ProfileEditor
                nameRef={nameField}
                onBusyChange={setImporting}
                onChange={(next) => {
                  setProfileEdited(true);
                  setProfileDraft(next);
                }}
                // Quitting the app is not one of this dialog's exits, so an
                // answer that waited for one would be lost by someone who
                // typed their name and then closed the window. A settled edit
                // is a blur or a chosen avatar, not a keystroke, so persisting
                // it here costs a handful of writes rather than one per
                // character.
                onCommit={(next) => {
                  setProfileEdited(false);
                  track(props.onSaveProfile(next));
                }}
                profile={profileDraft}
                requiredNameMessage="Enter a name to continue."
                {...(props.avatarEnvironment === undefined
                  ? {}
                  : { environment: props.avatarEnvironment })}
              />
            </div>
          )}

          {handoffOpen || step !== "workspace" ? null : (
            <FirstRunWorkspaceStep
              choices={props.workspace}
              onSelectColorScheme={(scheme) => track(props.onSelectColorScheme(scheme))}
              onSelectModeSwitcher={(presentation) =>
                track(props.onSelectModeSwitcher(presentation))
              }
              onToggleChat={(enabled) => track(props.onToggleChat(enabled))}
              onToggleWork={(enabled) => track(props.onToggleWork(enabled))}
            />
          )}

          {handoffOpen || step !== "providers" ? null : (
            <FirstRunProviderStep
              onOpenProviderSettings={leaveForProviderSettings}
              onRescan={props.onRescan}
              readiness={props.readiness}
              ref={providerAction}
              scanning={props.scanning}
              {...(props.discoveryNotice === undefined
                ? {}
                : { discoveryNotice: props.discoveryNotice })}
            />
          )}

          {handoffOpen || step !== "default-model" ? null : (
            <FirstRunModelStep
              ariaLabel="Default model for new Chat threads"
              groups={props.chatModelGroups}
              intro="New Chat threads start with this model. Existing threads always keep whatever they were given."
              onOpenProviderSettings={leaveForProviderSettings}
              onSelect={(selection) => track(props.onSelectChatDefault(selection))}
              unsetNote="No default is set. Octant will pick a ready model for each new thread and show you which one it chose."
              {...(props.chatDefault === undefined
                ? {}
                : {
                    selectedModelId: props.chatDefault.modelId,
                    selectedProviderInstanceId: props.chatDefault.providerInstanceId,
                  })}
            />
          )}

          {handoffOpen || step !== "navigator" ? null : (
            <FirstRunModelStep
              ariaLabel="Navigator default model"
              clearLabel="Leave Navigator off"
              groups={props.navigatorModelGroups}
              intro="Navigator is the optional assistant from the profile control. It answers questions about Octant itself and never changes anything without asking you first."
              onClear={() => track(props.onClearNavigatorDefault())}
              onOpenProviderSettings={leaveForProviderSettings}
              onSelect={(selection) => track(props.onSelectNavigatorDefault(selection))}
              unsetNote="Navigator stays unavailable until a model is chosen. Nothing else is affected, and you can turn it on later in Settings."
              {...(props.navigatorDefault === undefined
                ? {}
                : {
                    selectedModelId: props.navigatorDefault.modelId,
                    selectedProviderInstanceId: props.navigatorDefault.providerInstanceId,
                  })}
            />
          )}
        </div>

        {controller.blockedMessage === undefined ? null : (
          <p className="first-run__notice callout" data-tone="attention" role="alert">
            {controller.blockedMessage}
          </p>
        )}

        <footer className="first-run__actions">
          <div className="first-run__buttons">
            {handoffOpen || back !== undefined ? (
              <OctantButton
                disabled={importing}
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
            <OctantButton
              disabled={busy || blocked || unnamed}
              onClick={skip}
              type="button"
              variant="ghost"
            >
              {controller.submitting === "skipped" ? "Skipping…" : "Skip for now"}
            </OctantButton>
            {handoffOpen ? (
              <OctantButton disabled={busy || blocked || unnamed} onClick={finish} type="button">
                {controller.submitting === "completed"
                  ? "Saving…"
                  : importing
                    ? "Finishing your picture…"
                    : handoff.primary.label}
              </OctantButton>
            ) : (
              <OctantButton
                disabled={importing || unnamed}
                onClick={() => (forward === undefined ? openHandoff() : goTo(forward))}
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
